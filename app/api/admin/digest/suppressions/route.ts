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

/**
 * GET /api/admin/digest/suppressions?venue_id=<optional uuid>  (Phase 8Z)
 *
 * Triage surface: which owner/admin members of this venue have an
 * email currently sitting on the global suppression list?
 *
 * The `DigestPreferencesCard` "Send sample" and "Send manual digest"
 * buttons both return `409 suppressed` when the target's address is
 * suppressed; the cron silently skips with
 * `operator_digest.skipped_suppressed`. None of those surfaces
 * proactively tells the operator "this is going to keep failing
 * until you remove the suppression". This endpoint + the
 * `DigestSuppressionsCallout` component close that gap.
 *
 * ── TABLE MAPPING ─────────────────────────────────────────────────────────
 * The existing suppression list lives in `public.email_suppressions`
 * (migration 003), NOT `public.suppressions`. Columns:
 *   email      citext unique
 *   reason     text  ∈ bounce_hard | complaint | manual | unsubscribe
 *   source     text
 *   created_at timestamptz
 *
 * We map `bounce_hard → bounce` in the response so the JSON contract
 * matches the prompt's vocabulary; everything else is passed through
 * (unknown values collapse to `unknown`).
 *
 * ── PII POSTURE ───────────────────────────────────────────────────────────
 *   - Response NEVER includes a raw email address; always masked
 *     (`o***@example.com`). The audit feed already follows this rule
 *     (Phase 8Y) — this endpoint extends the same posture.
 *   - Logs include user_id, venue_id, and count only. No raw email.
 *   - Cross-tenant access requires `requireVenueRole(ADMIN_ROLES)`;
 *     forbidden collapses to 404 to prevent venue enumeration.
 *
 * ── RATE LIMIT ────────────────────────────────────────────────────────────
 * `admin:digest-suppressions:{userId}` — distinct budget from
 * preview / send / sends / members so a noisy callout reload doesn't
 * push any other limiter into deny-all.
 */

const QuerySchema = z.object({
  venue_id: z.string().uuid().optional(),
})

const MAX_MEMBERS_PER_VENUE = 10
const LOOKUP_CONCURRENCY = 5

// Reason mapping. `bounce_hard` is the canonical migration-003
// vocabulary; the response surfaces the friendlier `bounce`. Unknown
// values collapse to `unknown` rather than echoing arbitrary text.
function mapReason(raw: string | null | undefined): 'bounce' | 'complaint' | 'manual' | 'unknown' {
  switch (raw) {
    case 'bounce_hard':
      return 'bounce'
    case 'complaint':
      return 'complaint'
    case 'manual':
      return 'manual'
    // The `unsubscribe` reason is intentionally collapsed to
    // 'unknown' rather than surfaced as its own kind — a member who
    // unsubscribed via the Phase 8S link flipped a digest-cadence
    // preference, NOT a delivery suppression. Surfacing
    // 'unsubscribe' here would conflate two distinct opt-out paths.
    case 'unsubscribe':
      return 'unknown'
    default:
      return 'unknown'
  }
}

function maskEmail(addr: string): string | null {
  if (!addr || typeof addr !== 'string') return null
  const at = addr.indexOf('@')
  if (at < 1) return null
  const local = addr.slice(0, at)
  const domain = addr.slice(at)
  const head = local.slice(0, 1)
  return `${head}***${domain}`
}

interface SuppressionItem {
  user_id: string
  role: 'owner' | 'admin'
  email_masked: string | null
  reason: 'bounce' | 'complaint' | 'manual' | 'unknown'
  created_at: string | null
}

export async function GET(request: NextRequest): Promise<Response> {
  const requestId = getOrCreateRequestId(request)
  const reqLog = log.child({
    requestId,
    route: '/api/admin/digest/suppressions',
    op: 'admin.digest_suppressions',
  })
  const respond = <T extends Response>(r: T) => withRequestIdHeader(r, requestId)

  const admin = await requireAdmin()
  if (!admin.ok) {
    return respond(NextResponse.json({ error: admin.code }, { status: admin.status }))
  }
  const { user, venueId: callerVenueId } = admin

  const rl = await rateLimitUserAction(request, `admin:digest-suppressions:${user.id}`)
  if (!rl.allowed) {
    reqLog.warn({ userId: user.id, retryMs: rl.retryAfterMs }, 'rate_limit.blocked')
    return respond(rateLimitedResponse(rl))
  }

  const url = new URL(request.url)
  const parsed = QuerySchema.safeParse({
    venue_id: url.searchParams.get('venue_id') ?? undefined,
  })
  if (!parsed.success) {
    return respond(
      NextResponse.json(
        { error: 'validation_failed', detail: parsed.error.flatten() },
        { status: 400 }
      )
    )
  }
  const targetVenueId = parsed.data.venue_id ?? callerVenueId

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

  // 1. Load owner/admin members for the venue. Same cap + concurrency
  // as the picker so the two surfaces share the same notion of "who
  // the digest cron actually targets".
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
      'admin.digest_suppressions.member_lookup_failed'
    )
    captureApiError(memberErr, {
      requestId,
      route: '/api/admin/digest/suppressions',
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
      'admin.digest_suppressions.no_members'
    )
    return respond(NextResponse.json({ venue_id: targetVenueId, items: [] }))
  }

  // 2. Resolve emails for each member (bounded concurrency 5). We
  // need the raw email locally to look up the suppression row, but
  // we NEVER surface it in the response — only the masked form.
  interface MemberWithEmail {
    user_id: string
    role: 'owner' | 'admin'
    email: string
  }
  const resolved: MemberWithEmail[] = new Array(memberRows.length)
  let cursor = 0
  async function worker(): Promise<void> {
    while (true) {
      const idx = cursor++
      if (idx >= memberRows.length) return
      const row = memberRows[idx]
      try {
        const { data: userRes } = await svc.auth.admin.getUserById(row.user_id)
        const email = userRes.user?.email
        if (!email) continue
        resolved[idx] = { user_id: row.user_id, role: row.role, email }
      } catch (err) {
        // Log the failure with user_id only — never the email.
        reqLog.warn(
          { err, userId: row.user_id, venueId: targetVenueId },
          'admin.digest_suppressions.email_lookup_failed'
        )
      }
    }
  }
  const workers = Array.from(
    { length: Math.min(LOOKUP_CONCURRENCY, memberRows.length) },
    () => worker()
  )
  await Promise.allSettled(workers)
  const resolvedDense = resolved.filter(
    (r): r is MemberWithEmail => r !== undefined
  )

  if (resolvedDense.length === 0) {
    return respond(NextResponse.json({ venue_id: targetVenueId, items: [] }))
  }

  // 3. Probe email_suppressions for the resolved set. `email` is
  // citext-unique on that table so a single `in` is enough; no JOIN
  // required.
  const emailSet = resolvedDense.map((r) => r.email)
  const { data: suppRowsRaw, error: suppErr } = await svc
    .from('email_suppressions')
    .select('email, reason, created_at')
    .in('email', emailSet)

  if (suppErr) {
    reqLog.error(
      { err: suppErr, venueId: targetVenueId },
      'admin.digest_suppressions.suppression_lookup_failed'
    )
    captureApiError(suppErr, {
      requestId,
      route: '/api/admin/digest/suppressions',
      userId: user.id,
      venueId: targetVenueId,
    })
    return respond(NextResponse.json({ error: 'unexpected_error' }, { status: 500 }))
  }

  const suppRows = (suppRowsRaw ?? []) as Array<{
    email: string
    reason: string
    created_at: string | null
  }>

  // 4. Intersect — for each suppressed email, attach the member row
  // it belongs to. Members without a suppression row are dropped.
  // citext equality is case-insensitive at the DB; we mirror that
  // here so a casing mismatch on the local side doesn't drop hits.
  const suppByEmail = new Map(suppRows.map((r) => [r.email.toLowerCase(), r]))
  const items: SuppressionItem[] = []
  for (const member of resolvedDense) {
    const hit = suppByEmail.get(member.email.toLowerCase())
    if (!hit) continue
    items.push({
      user_id: member.user_id,
      role: member.role,
      email_masked: maskEmail(member.email),
      reason: mapReason(hit.reason),
      created_at: hit.created_at,
    })
  }

  reqLog.info(
    {
      venueId: targetVenueId,
      memberCount: resolvedDense.length,
      suppressedCount: items.length,
    },
    'admin.digest_suppressions.listed'
  )

  return respond(
    NextResponse.json({
      venue_id: targetVenueId,
      items,
    })
  )
}
