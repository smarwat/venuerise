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
  createCheckoutSession,
  BillingError,
} from '@/lib/billing/billing-service'
import { BillingNotConfiguredError } from '@/lib/billing/stripe'
import { CheckoutSessionSchema } from '@/lib/billing/billing-schema'

/**
 * POST /api/billing/checkout
 *
 * Returns a Stripe Checkout Session URL. Caller must be owner or admin of
 * a venue; if `price_id` is omitted, falls back to STRIPE_DEFAULT_PRICE_ID.
 *
 * Response:  { url: "https://checkout.stripe.com/..." }
 */
export async function POST(request: NextRequest) {
  const requestId = getOrCreateRequestId(request)
  const reqLog = log.child({ requestId, route: '/api/billing/checkout' })
  const respond = <T extends Response>(r: T) => withRequestIdHeader(r, requestId)

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return respond(NextResponse.json({ error: 'unauthorized' }, { status: 401 }))

  const rl = await rateLimitUserAction(request, `billing:checkout:${user.id}`)
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

  const body = await request.json().catch(() => ({}))
  const parsed = CheckoutSessionSchema.safeParse(body ?? {})
  if (!parsed.success) {
    return respond(
      NextResponse.json(
        { error: 'validation_failed', detail: parsed.error.flatten() },
        { status: 400 }
      )
    )
  }

  try {
    const result = await createCheckoutSession({
      userId: user.id,
      userEmail: user.email ?? null,
      venueId: venue.venueId,
      priceId: parsed.data.price_id ?? null,
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
    reqLog.error({ err }, 'billing.checkout.unexpected')
    captureApiError(err, { requestId, route: '/api/billing/checkout', userId: user.id })
    return respond(NextResponse.json({ error: 'unexpected_error' }, { status: 500 }))
  }
}
