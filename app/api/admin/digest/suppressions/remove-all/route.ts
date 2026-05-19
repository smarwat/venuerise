import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createServiceClient } from '@/lib/supabase/service'
import { requireAdmin } from '@/lib/auth/require-admin'
import { requireVenueRole, TenantAccessError } from '@/lib/auth/tenant-access'
import { ADMIN_ROLES } from '@/lib/auth/roles'
import { rateLimitUserAction, rateLimitedResponse } from '@/lib/rate-limit'
import { log } from '@/lib/log'
import { getOrCreateRequestId, withRequestIdHeader } from '@/lib/observability/request-id'
import { captureApiError } from '@/lib/observability/sentry'
import { recordDigestAuditEvent } from '@/lib/billing/digest-audit-events'

/**
 * POST /api/admin/digest/suppressions/remove-all  (Phase 8AB)
 *
 * Bulk variant of `/api/admin/digest/suppressions/remove` (Phase 8AA).
 * Iterates every owner/admin member of the target venue, resolves
 * each email server-side, and deletes any matching row from
 * `public.email_suppressions`.
 *
 * Surfaces the same PII + audit posture as the per-row endpoint:
 *   - Client never sends emails.
 *   - Responses only carry masked addresses.
 *   - Logs include user_id / venue_id / counts only.
 *
 * Same 10-member cap as the suppressions endpoint + the cron fan-out
 * — the bulk action covers the same set the cron actually targets.
 *
 * ── RATE LIMIT ────────────────────────────────────────────────────────────
 * `admin:digest-suppressions-remove-all:{userId}` — distinct from the
 * per-row remove key so an operator running both surfaces in
 * succession doesn't drain a shared budget.
 */

const BodySchema = z.object({
  venue_id: z.string().uuid().optional(),
  reason: z.string().max(240).optional(),
})

const MAX_MEMBERS_PER_VENUE = 10
const LOOKUP_CONCURRENCY = 5

interface RemoveDetail {
  user_id: string
  email_masked: string | null
  removed: boolean
  reason?: 'email_missing' | 'not_suppressed' | 'unexpected_error'
}

function maskEmail(addr: string | null): string | null {
  if (!addr || typeof addr !== 'string') return null
  const at = addr.indexOf('@')
  if (at < 1) return null
  return `${addr.slice(0, 1)}***${addr.slice(at)}`
}

export async function POST(request: NextRequest): Promise<Response> {
  const requestId = getOrCreateRequestId(request)
  const reqLog = log.child({
    requestId,
    route: '/api/admin/digest/suppressions/remove-all',
    op: 'admin.digest_suppression_remove_all',
  })
  const respond = <T extends Response>(r: T) => withRequestIdHeader(r, requestId)

  const admin = await requireAdmin()
  if (!admin.ok) {
    return respond(NextResponse.json({ error: admin.code }, { status: admin.status }))
  }
  const { user, venueId: callerVenueId } = admin

  const rl = await rateLimitUserAction(
    request,
    `admin:digest-suppressions-remove-all:${user.id}`
  )
  if (!rl.allowed) {
    reqLog.warn({ userId: user.id, retryMs: rl.retryAfterMs }, 'rate_limit.blocked')
    return respond(rateLimitedResponse(rl))
  }

  const body = await request.json().catch(() => null)
  const parsed = BodySchema.safeParse(body ?? {})
  if (!parsed.success) {
    return respond(
      NextResponse.json(
        { error: 'validation_failed', detail: parsed.error.flatten() },
        { status: 400 }
      )
    )
  }
  const { venue_id: bodyVenueId, reason } = parsed.data

  const targetVenueId = bodyVenueId ?? callerVenueId
  if (targetVenueId !== callerVenueId) {
    try {
      await requireVenueRole(user.id, targetVenueId, ADMIN_ROLES)
    } catch (err) {
      if (err instanceof TenantAccessError) {
        if (err.status === 403) {
          return respond(NextResponse.json({ error: 'not_found' }, { status: 404 }))
        }
        return respond(NextResponse.json({ error: err.code }, { status: err.status }))
      }
      throw err
    }
  }

  const svc = createServiceClient()

  // 1. Resolve owner/admin members for the venue.
  const { data: memberRowsRaw, error: memberErr } = await svc
    .from('venue_members')
    .select('user_id, role')
    .eq('venue_id', targetVenueId)
    .in('role', ['owner', 'admin'])
    .order('created_at', { ascending: true })
    .limit(MAX_MEMBERS_PER_VENUE)

  if (memberErr) {
    reqLog.error(
      { err: memberErr, venueId: targetVenueId },
      'admin.digest_suppression_remove_all.member_lookup_failed'
    )
    captureApiError(memberErr, {
      requestId,
      route: '/api/admin/digest/suppressions/remove-all',
      userId: user.id,
      venueId: targetVenueId,
    })
    return respond(NextResponse.json({ error: 'unexpected_error' }, { status: 500 }))
  }

  const memberRows = (memberRowsRaw ?? []) as Array<{
    user_id: string
    role: 'owner' | 'admin'
  }>

  if (memberRows.length === 0) {
    reqLog.info(
      { venueId: targetVenueId },
      'admin.digest_suppression_remove_all.no_members'
    )
    return respond(
      NextResponse.json({
        success: true,
        venue_id: targetVenueId,
        removed_count: 0,
        details: [],
      })
    )
  }

  // 2. Resolve emails server-side (bounded concurrency 5). Track per-
  // member outcomes so the response can call out which members had
  // gaps even when the overall request succeeded.
  interface MemberWithMaybeEmail {
    user_id: string
    role: 'owner' | 'admin'
    email: string | null
  }
  const resolved: MemberWithMaybeEmail[] = new Array(memberRows.length)
  let cursor = 0
  async function emailWorker(): Promise<void> {
    while (true) {
      const idx = cursor++
      if (idx >= memberRows.length) return
      const row = memberRows[idx]
      let email: string | null = null
      try {
        const { data: userRes } = await svc.auth.admin.getUserById(row.user_id)
        email = userRes.user?.email ?? null
      } catch (err) {
        reqLog.warn(
          { err, userId: row.user_id, venueId: targetVenueId },
          'admin.digest_suppression_remove_all.email_lookup_failed'
        )
      }
      resolved[idx] = {
        user_id: row.user_id,
        role: row.role,
        email,
      }
    }
  }
  const emailWorkers = Array.from(
    { length: Math.min(LOOKUP_CONCURRENCY, memberRows.length) },
    () => emailWorker()
  )
  await Promise.allSettled(emailWorkers)

  // 3. Per-member delete. Sequential — bulk volume is low (≤10) and
  // serial keeps per-failure Sentry attribution clean. Mirrors the
  // per-row remove endpoint's behavior so the two surfaces produce
  // identical per-member outcomes.
  const details: RemoveDetail[] = []
  for (const member of resolved) {
    if (!member) continue
    if (!member.email) {
      details.push({
        user_id: member.user_id,
        email_masked: null,
        removed: false,
        reason: 'email_missing',
      })
      continue
    }
    const { data: deletedRows, error: delErr } = await svc
      .from('email_suppressions')
      .delete()
      .eq('email', member.email)
      .select('id')
    if (delErr) {
      reqLog.warn(
        { err: delErr, userId: member.user_id, venueId: targetVenueId },
        'admin.digest_suppression_remove_all.delete_failed'
      )
      details.push({
        user_id: member.user_id,
        email_masked: maskEmail(member.email),
        removed: false,
        reason: 'unexpected_error',
      })
      continue
    }
    const removed = Array.isArray(deletedRows) && deletedRows.length > 0
    details.push({
      user_id: member.user_id,
      email_masked: maskEmail(member.email),
      removed,
      ...(removed ? {} : { reason: 'not_suppressed' as const }),
    })
  }

  const removedCount = details.filter((d) => d.removed).length

  reqLog.info(
    {
      venueId: targetVenueId,
      removedCount,
      memberCount: memberRows.length,
      operatorReason: reason ?? null,
    },
    'admin.digest_suppression_remove_all.completed'
  )

  // Phase 8AC — audit writes. One summary row capturing the whole
  // operation (attempted / removed counts) plus one per-target row
  // for every member whose suppression actually got removed. We
  // intentionally do NOT write rows for `email_missing` /
  // `not_suppressed` per-member outcomes — those would dominate the
  // audit feed under a routine "is anyone suppressed?" sweep without
  // surfacing operator intent. The summary row carries those counts
  // for forensic reconstruction.
  //
  // Best-effort: failures never fail the HTTP request.
  await recordDigestAuditEvent({
    venueId: targetVenueId,
    actorKind: 'operator',
    action: 'suppression_remove_all',
    actorUserId: user.id,
    reason,
    metadata: {
      removed_count: removedCount,
      attempted_count: memberRows.length,
      route: 'bulk',
    },
    requestId,
  })

  for (const detail of details) {
    if (!detail.removed) continue
    await recordDigestAuditEvent({
      venueId: targetVenueId,
      actorKind: 'operator',
      action: 'suppression_remove',
      actorUserId: user.id,
      targetUserId: detail.user_id,
      targetEmailMasked: detail.email_masked,
      metadata: { route: 'bulk' },
      requestId,
    })
  }

  return respond(
    NextResponse.json({
      success: true,
      venue_id: targetVenueId,
      removed_count: removedCount,
      details,
    })
  )
}
