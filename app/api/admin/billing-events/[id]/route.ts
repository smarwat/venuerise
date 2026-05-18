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
 * GET /api/admin/billing-events/[id]
 *
 * Returns ONE row from `public.billing_events_log` INCLUDING the full
 * `payload`. Owner/admin only. This is the only product surface that
 * exposes Stripe payloads — operators use it for forensic debugging
 * (replay decisions, customer support, post-mortem).
 *
 * AUTHORIZATION
 *   1. requireAdmin() — caller is owner/admin of *some* venue.
 *   2. Row lookup — service role, by primary key.
 *   3. Tenant binding — the row's `venue_id` must match the caller's
 *      admin venue, OR the caller must hold ADMIN_ROLES on the row's
 *      venue (re-verified via requireVenueRole).
 *   4. Rows with `venue_id IS NULL` (events we couldn't resolve) are
 *      forensic-only and returned as 404 here. Operator inspects via
 *      service-role SQL.
 *
 * 404 IS THE EXISTENCE BOUNDARY
 *   "Not found", "row exists but venue_id null", and "row exists but you
 *   don't admin its venue" all collapse to the same 404 — admins shouldn't
 *   learn about events in tenants they don't admin.
 *
 * NEVER LOG THE PAYLOAD
 *   Sentry capture + log lines include event id, event type, and venue id
 *   only. The payload is returned in the response body but is not echoed
 *   to any log sink.
 */

const ParamsSchema = z.object({
  id: z.string().uuid(),
})

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const requestId = getOrCreateRequestId(request)
  const reqLog = log.child({ requestId, route: '/api/admin/billing-events/[id]' })
  const respond = <T extends Response>(r: T) => withRequestIdHeader(r, requestId)

  // 1. Auth.
  const admin = await requireAdmin()
  if (!admin.ok) {
    return respond(NextResponse.json({ error: admin.code }, { status: admin.status }))
  }
  const { user, venueId: callerVenueId } = admin

  // 2. Rate limit per caller.
  const rl = await rateLimitUserAction(
    request,
    `admin:billing-event-detail:${user.id}`
  )
  if (!rl.allowed) {
    reqLog.warn({ userId: user.id, retryMs: rl.retryAfterMs }, 'rate_limit.blocked')
    return respond(rateLimitedResponse(rl))
  }

  // 3. Validate the id route param.
  const { id } = await params
  const parsed = ParamsSchema.safeParse({ id })
  if (!parsed.success) {
    // 404 (not 400) to preserve the existence boundary.
    return respond(NextResponse.json({ error: 'not_found' }, { status: 404 }))
  }

  // 4. Look up the row via service role.
  const svc = createServiceClient()
  const { data: rowRaw, error: lookupErr } = await svc
    .from('billing_events_log')
    .select(
      'id, stripe_event_id, event_type, venue_id, stripe_customer_id, ' +
        'stripe_subscription_id, handled, handled_at, handler_error, ' +
        'duplicate_count, payload, received_at'
    )
    .eq('id', parsed.data.id)
    .maybeSingle()

  if (lookupErr) {
    reqLog.error(
      { err: lookupErr, billingEventId: parsed.data.id },
      'admin.billing_events.detail_lookup_failed'
    )
    captureApiError(lookupErr, {
      requestId,
      route: '/api/admin/billing-events/[id]',
      userId: user.id,
    })
    return respond(NextResponse.json({ error: 'unexpected_error' }, { status: 500 }))
  }
  if (!rowRaw) {
    return respond(NextResponse.json({ error: 'not_found' }, { status: 404 }))
  }

  // Supabase JS sometimes types `.select(...).maybeSingle()` as a
  // GenericStringError-style discriminator; widen through `unknown` so
  // the explicit row shape can be applied.
  const row = rowRaw as unknown as {
    id: string
    stripe_event_id: string
    event_type: string
    venue_id: string | null
    stripe_customer_id: string | null
    stripe_subscription_id: string | null
    handled: boolean
    handled_at: string | null
    handler_error: string | null
    duplicate_count: number
    payload: Record<string, unknown>
    received_at: string
  }

  // 5. Tenant binding. Collapse all denials to 404 (don't leak existence).
  if (!row.venue_id) {
    return respond(NextResponse.json({ error: 'not_found' }, { status: 404 }))
  }

  if (row.venue_id !== callerVenueId) {
    try {
      await requireVenueRole(user.id, row.venue_id, ADMIN_ROLES)
    } catch (err) {
      if (err instanceof TenantAccessError) {
        // 403 -> 404 to keep the existence boundary; 401 stays as-is
        // (treated as a session expiry, not a tenant disclosure).
        if (err.status === 403) {
          return respond(NextResponse.json({ error: 'not_found' }, { status: 404 }))
        }
        return respond(NextResponse.json({ error: err.code }, { status: err.status }))
      }
      throw err
    }
  }

  return respond(NextResponse.json({ item: row }))
}
