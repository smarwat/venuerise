import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { requireAdmin } from '@/lib/auth/require-admin'
import { requireVenueRole, TenantAccessError } from '@/lib/auth/tenant-access'
import { ADMIN_ROLES } from '@/lib/auth/roles'
import { rateLimitUserAction, rateLimitedResponse } from '@/lib/rate-limit'
import { log } from '@/lib/log'
import { getOrCreateRequestId, withRequestIdHeader } from '@/lib/observability/request-id'
import { captureApiError } from '@/lib/observability/sentry'
import { z } from 'zod'

/**
 * GET /api/admin/billing-events
 *
 * Lists rows from `public.billing_events_log` for the caller's venue.
 * Owner/admin only. Read-only inspection of the Phase 7F audit trail.
 *
 * Query params:
 *   - event_type=<string>             — filter by Stripe event type
 *   - handled=true | false | all      — default "all"
 *   - venue_id=<uuid>                 — defaults to caller's primary venue;
 *                                        if supplied AND different from the
 *                                        primary venue, the caller must also
 *                                        hold ADMIN_ROLES on it (defense in
 *                                        depth on top of the table's RLS,
 *                                        even though this route reads via
 *                                        service role for filter efficiency)
 *   - limit=<int>                     — default 50, max 200
 *
 * Response shape (NOT including `payload` — use /[id] for the full event):
 *   { items: [{ id, stripe_event_id, event_type, venue_id,
 *               stripe_customer_id, stripe_subscription_id,
 *               handled, handled_at, handler_error, duplicate_count,
 *               received_at }] }
 *
 * Why service-role reads here:
 *   RLS on billing_events_log (migration 008) allows owner/admin SELECT,
 *   but the helper functions (`has_venue_role`) work per-row and don't
 *   gracefully support cross-venue paged queries. We gate authorization
 *   at the route layer (requireAdmin + requireVenueRole if venue_id
 *   override is supplied) and use the service-role client to read.
 */

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200

const QuerySchema = z.object({
  event_type: z.string().min(1).max(120).optional(),
  handled: z.enum(['true', 'false', 'all']).optional(),
  venue_id: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).optional(),
})

export async function GET(request: NextRequest) {
  const requestId = getOrCreateRequestId(request)
  const reqLog = log.child({ requestId, route: '/api/admin/billing-events' })
  const respond = <T extends Response>(r: T) => withRequestIdHeader(r, requestId)

  // 1. Auth — owner/admin on at least one venue.
  const admin = await requireAdmin()
  if (!admin.ok) {
    return respond(NextResponse.json({ error: admin.code }, { status: admin.status }))
  }
  const { user, venueId: callerVenueId } = admin

  // 2. Rate limit per caller.
  const rl = await rateLimitUserAction(request, `admin:billing-events:${user.id}`)
  if (!rl.allowed) {
    reqLog.warn({ userId: user.id, retryMs: rl.retryAfterMs }, 'rate_limit.blocked')
    return respond(rateLimitedResponse(rl))
  }

  // 3. Parse + validate query.
  const url = new URL(request.url)
  const parsed = QuerySchema.safeParse({
    event_type: url.searchParams.get('event_type') ?? undefined,
    handled: url.searchParams.get('handled') ?? undefined,
    venue_id: url.searchParams.get('venue_id') ?? undefined,
    limit: url.searchParams.get('limit') ?? undefined,
  })
  if (!parsed.success) {
    return respond(
      NextResponse.json(
        { error: 'invalid_query', detail: parsed.error.flatten() },
        { status: 400 }
      )
    )
  }

  // 4. Resolve target venue.
  //    - No override → use caller's primary venue (requireAdmin already
  //      proved they're owner/admin of it).
  //    - Override → must hold ADMIN_ROLES on the requested venue.
  let targetVenueId = callerVenueId
  if (parsed.data.venue_id && parsed.data.venue_id !== callerVenueId) {
    try {
      await requireVenueRole(user.id, parsed.data.venue_id, ADMIN_ROLES)
      targetVenueId = parsed.data.venue_id
    } catch (err) {
      if (err instanceof TenantAccessError) {
        return respond(NextResponse.json({ error: err.code }, { status: err.status }))
      }
      throw err
    }
  }

  const limit = parsed.data.limit ?? DEFAULT_LIMIT

  // 5. Build query. Service-role read scoped by application-level venue_id.
  //    `payload` is INTENTIONALLY omitted from the projection — list users
  //    should never need it, and slimmer rows keep the response cheap.
  const svc = createServiceClient()
  let query = svc
    .from('billing_events_log')
    .select(
      'id, stripe_event_id, event_type, venue_id, stripe_customer_id, ' +
        'stripe_subscription_id, handled, handled_at, handler_error, ' +
        'duplicate_count, received_at, ' +
        // Phase 7J — `replay_count` + `replayed_at` so the list can show
        // an at-a-glance "this row has been replayed N times" without a
        // detail fetch. We deliberately omit `replayed_by` to keep the
        // list payload slim (and to avoid leaking operator user ids into
        // wider tooling); detail endpoint surfaces it for forensics.
        'replay_count, replayed_at'
    )
    .eq('venue_id', targetVenueId)
    .order('received_at', { ascending: false })
    .limit(limit)

  if (parsed.data.event_type) query = query.eq('event_type', parsed.data.event_type)
  if (parsed.data.handled === 'true') query = query.eq('handled', true)
  if (parsed.data.handled === 'false') query = query.eq('handled', false)
  // handled === 'all' or undefined → no filter

  const { data, error } = await query
  if (error) {
    reqLog.error({ err: error, venueId: targetVenueId }, 'admin.billing_events.list_failed')
    captureApiError(error, {
      requestId,
      route: '/api/admin/billing-events',
      userId: user.id,
      venueId: targetVenueId,
    })
    return respond(NextResponse.json({ error: 'unexpected_error' }, { status: 500 }))
  }

  return respond(NextResponse.json({ items: data ?? [] }))
}
