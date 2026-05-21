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
import { recordAuditEvent } from '@/lib/enterprise/audit-events'
import { AUDIT_ACTIONS } from '@/lib/enterprise/audit-actions'
import { getVenueSubscriptionStatus } from '@/lib/billing/subscription-status'

/**
 * Phase 9Q — audit metadata caller hint. The PaymentMethodsCard posts
 * `{ source: 'payment_methods_card' }` so admins can see in
 * EnterpriseAuditEventsCard which surface the portal session was opened
 * from. Other callers (legacy BillingStatusCard) post no body — we treat
 * `source` as optional with a default of `'billing_status_card'`.
 *
 * Anything beyond `source` is ignored deliberately — the portal route
 * never echoes operator-supplied data into Stripe.
 */
const PORTAL_SOURCES: ReadonlySet<string> = new Set([
  'payment_methods_card',
  'billing_status_card',
  'billing_banner',
  'unknown',
])

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

  // Phase 9Q — optional client-supplied `source` hint. We don't
  // surface this to Stripe; it lives purely in the audit row so
  // admins can tell PaymentMethodsCard apart from BillingStatusCard
  // in EnterpriseAuditEventsCard.
  const body = await request.json().catch(() => null)
  const rawSource =
    body && typeof body === 'object' && 'source' in body
      ? String((body as { source: unknown }).source)
      : 'billing_status_card'
  const source: string = PORTAL_SOURCES.has(rawSource) ? rawSource : 'unknown'

  // Phase 9Q — pre-call subscription snapshot for audit metadata.
  // `getVenueSubscriptionStatus` is request-memoized, never throws on
  // missing-subscription, and is what BillingStatusCard already reads.
  // We fail-open on read errors so the portal still opens — the audit
  // row just records `subscription_status: 'unknown'`.
  let subscriptionStatusKind: string = 'unknown'
  try {
    const snapshot = await getVenueSubscriptionStatus(venue.venueId)
    subscriptionStatusKind = snapshot.kind
  } catch {
    // Swallow — audit-only field. The actual session creation below
    // will surface a real BillingError if Stripe / Postgres is down.
  }

  try {
    const result = await createBillingPortalSession({
      userId: user.id,
      venueId: venue.venueId,
      requestId,
    })
    // Phase 9B — enterprise audit. The portal URL is short-lived
    // + per-session; the audit row captures operator intent only.
    // Phase 9Q — extended metadata: subscription_status, stripe
    // customer presence (implicit — createBillingPortalSession
    // throws billing_customer_not_found when missing), and the
    // surface that opened the session. No raw Stripe payload, no
    // payment method id, no client secret.
    void recordAuditEvent({
      venueId: venue.venueId,
      actorUserId: user.id,
      actorKind: 'operator',
      route: '/api/billing/portal',
      action: AUDIT_ACTIONS.BILLING_PORTAL_SESSION_CREATE,
      targetTable: 'subscriptions',
      targetId: null,
      requestId,
      ip: request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
      userAgent: request.headers.get('user-agent'),
      metadata: {
        session_url_returned: typeof result.url === 'string' && result.url.length > 0,
        stripe_customer_present: true,
        subscription_status: subscriptionStatusKind,
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
    reqLog.error({ err }, 'billing.portal.unexpected')
    captureApiError(err, { requestId, route: '/api/billing/portal', userId: user.id })
    return respond(NextResponse.json({ error: 'unexpected_error' }, { status: 500 }))
  }
}
