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
import { recordAuditEvent } from '@/lib/enterprise/audit-events'
import { AUDIT_ACTIONS } from '@/lib/enterprise/audit-actions'
import { getPlanStripePriceId } from '@/lib/billing/plans'

/**
 * POST /api/billing/checkout
 *
 * Returns a Stripe Checkout Session URL. Caller must be owner or admin of
 * a venue.
 *
 * Body (all fields optional):
 *   - `plan_id`  Phase 9R — preferred. `'starter' | 'growth' | 'elite'`.
 *                `'enterprise'` returns 400 `enterprise_contact_required`.
 *   - `interval` Phase 9R — `'monthly' | 'annual'` (defaults to monthly).
 *   - `price_id` Legacy — explicit Stripe price id.
 *   - `source`   Phase 9R — audit hint; never echoed to Stripe.
 *
 * Resolution order (first one wins):
 *   1. `plan_id` (Phase 9R)
 *   2. `price_id` (legacy explicit)
 *   3. `STRIPE_DEFAULT_PRICE_ID` env (legacy default)
 *
 * Response:  { url: "https://checkout.stripe.com/..." }
 */

const KNOWN_SOURCES: ReadonlySet<string> = new Set([
  'subscription_plans_card',
  'billing_status_card',
  'billing_banner',
  'unknown',
])

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

  // Phase 9R — resolve the Stripe price id. `plan_id` wins when
  // supplied; otherwise we fall back to the legacy `price_id` / env
  // path. Enterprise is contact-sales only; reject up-front.
  const planId = parsed.data.plan_id ?? null
  const interval = parsed.data.interval ?? 'monthly'
  if (planId === 'enterprise') {
    return respond(
      NextResponse.json(
        { error: 'enterprise_contact_required' },
        { status: 400 }
      )
    )
  }
  let resolvedPriceId: string | null = parsed.data.price_id ?? null
  let stripePriceConfigured = false
  if (planId) {
    const fromPlan = getPlanStripePriceId(planId, interval)
    if (!fromPlan) {
      return respond(
        NextResponse.json(
          { error: 'stripe_price_not_configured', detail: { plan_id: planId, interval } },
          { status: 422 }
        )
      )
    }
    resolvedPriceId = fromPlan
    stripePriceConfigured = true
  }

  // Phase 9R — `source` is a soft hint logged into the audit row only;
  // we don't echo it to Stripe.
  const rawSource = parsed.data.source ?? 'unknown'
  const source: string = KNOWN_SOURCES.has(rawSource) ? rawSource : 'unknown'

  try {
    const result = await createCheckoutSession({
      userId: user.id,
      userEmail: user.email ?? null,
      venueId: venue.venueId,
      priceId: resolvedPriceId,
      planId,
      interval: planId ? interval : null,
      requestId,
    })
    // Phase 9B — enterprise audit. The Stripe session URL itself
    // is short-lived + idempotency-key-derived; we record only the
    // operator intent (which price they requested) + a boolean
    // indicating whether the helper actually returned a URL.
    //
    // Phase 9R — also capture `plan_id`, `interval`,
    // `stripe_price_configured`, and the audit `source` hint so
    // admins can tell SubscriptionPlansCard checkouts apart from
    // legacy BillingStatusCard checkouts in the audit feed.
    void recordAuditEvent({
      venueId: venue.venueId,
      actorUserId: user.id,
      actorKind: 'operator',
      route: '/api/billing/checkout',
      action: AUDIT_ACTIONS.BILLING_CHECKOUT_SESSION_CREATE,
      targetTable: 'subscriptions',
      targetId: null,
      requestId,
      ip: request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
      userAgent: request.headers.get('user-agent'),
      metadata: {
        price_id: parsed.data.price_id ?? null,
        used_default_price: !parsed.data.price_id && !planId,
        session_url_returned: typeof result.url === 'string' && result.url.length > 0,
        plan_id: planId,
        interval: planId ? interval : null,
        stripe_price_configured: stripePriceConfigured || Boolean(resolvedPriceId),
        source,
      },
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
