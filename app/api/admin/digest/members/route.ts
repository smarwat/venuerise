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
 * GET /api/admin/digest/members?venue_id=<optional uuid>  (Phase 8Y)
 *
 * Lists owner/admin members of the venue + their resolved emails so
 * the DigestPreferencesCard "Send manual digest" picker can target
 * another admin/owner without the operator having to type a UUID.
 *
 * ── WHY OWNER/ADMIN ONLY ──────────────────────────────────────────────────
 * The Phase 8R operator-activity-digest cron only delivers to owner +
 * admin members (the rest of the role tree — sales_manager,
 * coordinator, viewer — never receives digests). The picker MUST mirror
 * that constraint, otherwise an operator could think they're sending a
 * manual digest to a viewer and then puzzle over the resulting 404 from
 * `/api/admin/digest/send` (which collapses non-admin targets to 404 to
 * prevent per-role enumeration).
 *
 * ── PII POSTURE ───────────────────────────────────────────────────────────
 *   - Returns each member's auth.users.email so the picker can render a
 *     human-readable label. Admin-only surface; the same operator
 *     already has access to billing/team management which exposes the
 *     same emails.
 *   - `can_receive_digest` is `false` when email is null OR the auth
 *     lookup failed — surfaced so the picker can disable that row
 *     instead of silently dropping it. Members with auth-lookup
 *     failures are returned with `email: null` and `can_receive_digest:
 *     false` rather than omitted, so the operator sees the gap.
 *   - `is_current_user` is true for the calling user's own row, used
 *     by the picker to mark the default selection.
 *
 * ── RATE LIMIT ────────────────────────────────────────────────────────────
 * `admin:digest-members:{userId}` — distinct from preview / send / sends
 * so a noisy picker reload doesn't push the manual-send limiter into
 * deny-all.
 */

const QuerySchema = z.object({
  venue_id: z.string().uuid().optional(),
})

interface MemberItem {
  user_id: string
  role: 'owner' | 'admin'
  email: string | null
  can_receive_digest: boolean
  is_current_user: boolean
}

// Hard cap — the Phase 8U cron caps fan-out at 10 recipients per
// venue. Surfacing the same cap here so the picker and the underlying
// delivery surface stay in lockstep; venues with > 10 admins/owners
// see the first 10 by created_at (same order as the cron).
const MAX_MEMBERS_PER_VENUE = 10
const LOOKUP_CONCURRENCY = 5

export async function GET(request: NextRequest): Promise<Response> {
  const requestId = getOrCreateRequestId(request)
  const reqLog = log.child({
    requestId,
    route: '/api/admin/digest/members',
    op: 'admin.digest_members',
  })
  const respond = <T extends Response>(r: T) => withRequestIdHeader(r, requestId)

  // 1. Auth.
  const admin = await requireAdmin()
  if (!admin.ok) {
    return respond(NextResponse.json({ error: admin.code }, { status: admin.status }))
  }
  const { user, venueId: callerVenueId } = admin

  // 2. Rate limit per caller.
  const rl = await rateLimitUserAction(request, `admin:digest-members:${user.id}`)
  if (!rl.allowed) {
    reqLog.warn({ userId: user.id, retryMs: rl.retryAfterMs }, 'rate_limit.blocked')
    return respond(rateLimitedResponse(rl))
  }

  // 3. Query params.
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

  // 4. Tenant bind for cross-venue. Same collapse-to-404 posture as
  // the rest of the admin surface (preview / send / etc).
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

  // 5. Pull owner/admin rows in cron-order so the picker's default
  // ordering matches what the cron itself processes (helps QA).
  const svc = createServiceClient()
  const { data: rows, error: memberErr } = await svc
    .from('venue_members')
    .select('user_id, role')
    .eq('venue_id', targetVenueId)
    .in('role', ['owner', 'admin'])
    .order('created_at', { ascending: true })
    .limit(MAX_MEMBERS_PER_VENUE)

  if (memberErr) {
    reqLog.error(
      { err: memberErr, venueId: targetVenueId },
      'admin.digest_members.lookup_failed'
    )
    captureApiError(memberErr, {
      requestId,
      route: '/api/admin/digest/members',
      userId: user.id,
      venueId: targetVenueId,
    })
    return respond(NextResponse.json({ error: 'unexpected_error' }, { status: 500 }))
  }

  const memberRows = (rows ?? []) as Array<{ user_id: string; role: 'owner' | 'admin' }>

  // 6. Bounded-concurrency email resolution. Mirrors the Phase 8V
  // cron pool — bounded so a venue with 10 members doesn't spend 10
  // serial round-trips to Supabase Auth, but capped so we don't hammer
  // the auth admin under a misclick loop.
  const items: MemberItem[] = new Array(memberRows.length)
  let cursor = 0
  async function worker(): Promise<void> {
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
          'admin.digest_members.email_lookup_failed'
        )
      }
      items[idx] = {
        user_id: row.user_id,
        role: row.role,
        email,
        can_receive_digest: Boolean(email),
        is_current_user: row.user_id === user.id,
      }
    }
  }
  const workers = Array.from(
    { length: Math.min(LOOKUP_CONCURRENCY, memberRows.length) },
    () => worker()
  )
  await Promise.allSettled(workers)

  reqLog.info(
    { venueId: targetVenueId, memberCount: items.length },
    'admin.digest_members.listed'
  )

  return respond(
    NextResponse.json({
      venue_id: targetVenueId,
      items,
    })
  )
}
