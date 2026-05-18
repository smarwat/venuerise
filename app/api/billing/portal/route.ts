import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getOrCreateRequestId, withRequestIdHeader } from '@/lib/observability/request-id'
import { captureApiError } from '@/lib/observability/sentry'
import { log } from '@/lib/log'
import { rateLimitUserAction, rateLimitedResponse } from '@/lib/rate-limit'
import {
  getCurrentVenueForUser,
  requireVenueRole,
  TenantAccessError,
} from '@/lib/auth/tenant-access'
import { ADMIN_ROLES } from '@/lib/auth/roles'
import {
  createBillingPortalSession,
  BillingError,
} from '@/lib/billing/billing-service'
import { BillingNotConfiguredError } from '@/lib/billing/stripe'

/**
 * POST /api/billing/portal
 *
 * Returns a Stripe Billing Portal session URL for the caller's venue.
 * Caller must be owner or admin.
 *
 * Returns 404 `billing_customer_not_found` if the venue has never been to
 * checkout. The intended UX is: the dashboard shows "Manage billing" only
 * when a subscription exists, and "Start subscription" otherwise.
 *
 * Response: { url: "https://billing.stripe.com/..." }
 */
export async function POST(request: NextRequest) {
  const requestId = getOrCreateRequestId(request)
  const reqLog = log.child({ requestId, route: '/api/billing/portal' })
  const respond = <T extends Response>(r: T) => withRequestIdHeader(r, requestId)

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return respond(NextResponse.json({ error: 'unauthorized' }, { status: 401 }))

  const rl = await rateLimitUserAction(request, `billing:portal:${user.id}`)
  if (!rl.allowed) {
    reqLog.warn({ userId: user.id, retryMs: rl.retryAfterMs }, 'rate_limit.blocked')
    return respond(rateLimitedResponse(rl))
  }

  const venue = await getCurrentVenueForUser(user.id)
  if (!venue) return respond(NextResponse.json({ error: 'no_venue' }, { status: 404 }))

  try {
    await requireVenueRole(user.id, venue.venueId, ADMIN_ROLES)
  } catch (err) {
    if (err instanceof TenantAccessError) {
      return respond(NextResponse.json({ error: err.code }, { status: err.status }))
    }
    throw err
  }

  try {
    const result = await createBillingPortalSession({
      userId: user.id,
      venueId: venue.venueId,
      requestId,
    })
    return respond(NextResponse.json({ url: result.url }))
  } catch (err) {
    if (err instanceof BillingNotConfiguredError) {
      reqLog.warn({}, 'billing.not_configured')
      return respond(NextResponse.json({ error: 'billing_not_configured' }, { status: 503 }))
    }
    if (err instanceof BillingError) {
      return respond(
        NextResponse.json({ error: err.code, detail: err.detail }, { status: err.status })
      )
    }
    reqLog.error({ err }, 'billing.portal.unexpected')
    captureApiError(err, { requestId, route: '/api/billing/portal', userId: user.id })
    return respond(NextResponse.json({ error: 'unexpected_error' }, { status: 500 }))
  }
}
