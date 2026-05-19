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
 * POST /api/admin/digest/suppressions/remove  (Phase 8AA)
 *
 * Resolves a suppression removal request submitted from the
 * `DigestSuppressionsCallout` "Remove suppression" button.
 *
 * ── WHY SERVER-SIDE EMAIL RESOLUTION ──────────────────────────────────────
 * The client never sends an email address. The client sends a
 * `(venue_id, user_id)` pair; this route:
 *
 *   1. Re-confirms the target is an owner/admin member of the venue.
 *   2. Resolves the email via Supabase Auth admin.
 *   3. Deletes from `public.email_suppressions` by the resolved email.
 *
 * This defends against:
 *   - A malicious client sending an arbitrary email (mass-clearing
 *     suppressions for unrelated accounts).
 *   - A stale UI sending a previously-correct email after the user
 *     changed it in Supabase Auth (we'd delete the wrong row).
 *   - The callout being fooled by a tampered DOM into POSTing an
 *     email it never displayed (the masked form makes this hard, but
 *     "hard" isn't "impossible").
 *
 * ── PII POSTURE ───────────────────────────────────────────────────────────
 *   - Request body: never includes email. Just `venue_id` + `user_id`.
 *   - Response: returns the masked email only (`o***@example.com`).
 *   - Logs: `userId`, `venueId`, `targetUserId`, `removed`, `reason` —
 *     never the raw email at any verbosity. Sentry context follows
 *     the same posture.
 *
 * ── AUDIT TRAIL ───────────────────────────────────────────────────────────
 * No new audit table — `billing_events_log` is reserved for Stripe
 * webhook events (migration 008) and overloading it would muddy the
 * existing schema's `provider`/`event_type` semantics. Structured log
 * lines (`admin.digest_suppression_remove.completed` etc.) carry the
 * forensic trail: requestId, venueId, targetUserId, removed flag,
 * outcome reason. Future phase can introduce a dedicated digest
 * audit table if frequency justifies it.
 */

const BodySchema = z.object({
  venue_id: z.string().uuid().optional(),
  user_id: z.string().uuid(),
  reason: z.string().max(240).optional(),
})

function maskEmail(addr: string | null): string | null {
  if (!addr || typeof addr !== 'string') return null
  const at = addr.indexOf('@')
  if (at < 1) return null
  const local = addr.slice(0, at)
  const domain = addr.slice(at)
  return `${local.slice(0, 1)}***${domain}`
}

export async function POST(request: NextRequest): Promise<Response> {
  const requestId = getOrCreateRequestId(request)
  const reqLog = log.child({
    requestId,
    route: '/api/admin/digest/suppressions/remove',
    op: 'admin.digest_suppression_remove',
  })
  const respond = <T extends Response>(r: T) => withRequestIdHeader(r, requestId)

  // 1. Auth.
  const admin = await requireAdmin()
  if (!admin.ok) {
    return respond(NextResponse.json({ error: admin.code }, { status: admin.status }))
  }
  const { user, venueId: callerVenueId } = admin

  // 2. Rate limit per caller. Distinct key prefix so a noisy remove
  // loop doesn't push the existing suppressions/sends limiters into
  // deny-all.
  const rl = await rateLimitUserAction(
    request,
    `admin:digest-suppressions-remove:${user.id}`
  )
  if (!rl.allowed) {
    reqLog.warn({ userId: user.id, retryMs: rl.retryAfterMs }, 'rate_limit.blocked')
    return respond(rateLimitedResponse(rl))
  }

  // 3. Parse body.
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
  const { venue_id: bodyVenueId, user_id: targetUserId, reason } = parsed.data

  // 4. Resolve target venue + tenant bind. Mirror the rest of the
  // admin digest surface.
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

  // 5. Re-confirm target is owner/admin member of THIS venue.
  // Same 404 collapse as the rest of the digest surface so the route
  // can't be used to probe per-role distribution.
  const svc = createServiceClient()
  const { data: memberRow, error: memberErr } = await svc
    .from('venue_members')
    .select('id, role')
    .eq('venue_id', targetVenueId)
    .eq('user_id', targetUserId)
    .maybeSingle()

  if (memberErr) {
    reqLog.error(
      { err: memberErr, venueId: targetVenueId, targetUserId },
      'admin.digest_suppression_remove.member_lookup_failed'
    )
    captureApiError(memberErr, {
      requestId,
      route: '/api/admin/digest/suppressions/remove',
      userId: user.id,
      venueId: targetVenueId,
    })
    return respond(NextResponse.json({ error: 'unexpected_error' }, { status: 500 }))
  }
  if (!memberRow) {
    reqLog.info(
      { venueId: targetVenueId, targetUserId },
      'admin.digest_suppression_remove.no_membership'
    )
    return respond(NextResponse.json({ error: 'not_found' }, { status: 404 }))
  }
  const member = memberRow as { id: string; role: string }
  if (!(ADMIN_ROLES as ReadonlyArray<string>).includes(member.role)) {
    reqLog.info(
      { venueId: targetVenueId, targetUserId, role: member.role },
      'admin.digest_suppression_remove.target_not_admin'
    )
    return respond(NextResponse.json({ error: 'not_found' }, { status: 404 }))
  }

  // 6. Resolve email server-side. Never trust the client to supply it.
  let targetEmail: string | null = null
  try {
    const { data: userRes } = await svc.auth.admin.getUserById(targetUserId)
    targetEmail = userRes.user?.email ?? null
  } catch (err) {
    reqLog.error(
      { err, venueId: targetVenueId, targetUserId },
      'admin.digest_suppression_remove.email_lookup_failed'
    )
    captureApiError(err, {
      requestId,
      route: '/api/admin/digest/suppressions/remove',
      userId: user.id,
      venueId: targetVenueId,
    })
    return respond(NextResponse.json({ error: 'unexpected_error' }, { status: 500 }))
  }
  if (!targetEmail) {
    reqLog.info(
      { venueId: targetVenueId, targetUserId },
      'admin.digest_suppression_remove.no_email'
    )
    return respond(
      NextResponse.json({ error: 'recipient_email_missing' }, { status: 400 })
    )
  }
  const emailMasked = maskEmail(targetEmail)

  // 7. Delete the suppression row (if any). `email_suppressions.email`
  // is citext-unique so a single eq + delete is sufficient. We use
  // `select('id')` to find out whether a row existed BEFORE the
  // delete — Supabase's `.delete()` doesn't return affected-row count
  // in the version we're pinned to without an explicit `select()`.
  const { data: deletedRows, error: delErr } = await svc
    .from('email_suppressions')
    .delete()
    .eq('email', targetEmail)
    .select('id')

  if (delErr) {
    reqLog.error(
      { err: delErr, venueId: targetVenueId, targetUserId },
      'admin.digest_suppression_remove.delete_failed'
    )
    captureApiError(delErr, {
      requestId,
      route: '/api/admin/digest/suppressions/remove',
      userId: user.id,
      venueId: targetVenueId,
    })
    return respond(NextResponse.json({ error: 'unexpected_error' }, { status: 500 }))
  }

  const removedCount = Array.isArray(deletedRows) ? deletedRows.length : 0
  const removed = removedCount > 0

  // Audit breadcrumb — `reason` is an optional free-text the operator
  // can pass to explain the removal (e.g. "verified with recipient"
  // or "domain reconfigured"). Capped at 240 chars by the Zod schema.
  reqLog.info(
    {
      venueId: targetVenueId,
      targetUserId,
      removed,
      removedCount,
      operatorReason: reason ?? null,
    },
    'admin.digest_suppression_remove.completed'
  )

  // Phase 8AC — best-effort audit write. Failures here MUST NOT fail
  // the HTTP request; the suppression delete has already committed
  // and the caller deserves their success response.
  await recordDigestAuditEvent({
    venueId: targetVenueId,
    actorKind: 'operator',
    action: removed ? 'suppression_remove' : 'suppression_remove_noop',
    actorUserId: user.id,
    targetUserId,
    targetEmailMasked: emailMasked,
    reason,
    metadata: {
      removed,
      route: 'single',
    },
    requestId,
  })

  if (!removed) {
    return respond(
      NextResponse.json({
        success: true,
        removed: false,
        reason: 'not_suppressed',
        venue_id: targetVenueId,
        user_id: targetUserId,
        email_masked: emailMasked,
      })
    )
  }

  return respond(
    NextResponse.json({
      success: true,
      removed: true,
      venue_id: targetVenueId,
      user_id: targetUserId,
      email_masked: emailMasked,
    })
  )
}
