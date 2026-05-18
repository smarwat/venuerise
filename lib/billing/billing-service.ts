import 'server-only'
import type Stripe from 'stripe'
import { createServiceClient } from '@/lib/supabase/service'
import { log } from '@/lib/log'
import { captureApiError } from '@/lib/observability/sentry'
import { stripe } from './stripe'

/**
 * Phase 7C — billing service.
 *
 * Wraps the Stripe Checkout / Customer Portal / subscription-sync calls
 * the route layer needs. Stripe is the source of truth — local Postgres
 * tables (billing_customers + subscriptions) are a cache populated by the
 * webhook handler and the customer-create lazily-on-demand path here.
 *
 * AUTHORIZATION:
 *   Route handlers must already have:
 *     1. `requireUser()` → authenticated session
 *     2. `requireVenueRole(user, venue, ADMIN_ROLES)` → owner or admin only
 *   This service does NOT re-check; it trusts its callers to gate access.
 *
 * SERVICE-ROLE USAGE:
 *   `billing_customers` + `subscriptions` are RLS-gated to ADMIN_ROLES for
 *   SELECT and have no INSERT/UPDATE/DELETE policy at all. All writes here
 *   go through the service-role client. This module is `server-only` so
 *   the service-role import cannot leak.
 *
 * IDEMPOTENCY:
 *   - getOrCreateStripeCustomer races safely: if two requests miss the
 *     cache simultaneously and both try to insert, the second sees a
 *     unique-violation and re-reads the winning row.
 *   - syncSubscriptionFromStripeSubscription is an UPSERT on
 *     stripe_subscription_id, so webhook redeliveries don't duplicate rows.
 */

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type BillingErrorCode =
  | 'billing_not_configured'
  | 'billing_customer_not_found'
  | 'price_id_missing'
  | 'venue_not_found'
  | 'stripe_failed'
  | 'sync_failed'

export class BillingError extends Error {
  constructor(
    public readonly code: BillingErrorCode,
    public readonly status: 400 | 404 | 500 | 503,
    public readonly detail?: unknown
  ) {
    super(code)
    this.name = 'BillingError'
  }
}

// ---------------------------------------------------------------------------
// getOrCreateStripeCustomer
// ---------------------------------------------------------------------------

export interface GetOrCreateCustomerArgs {
  userId: string
  userEmail: string | null
  venueId: string
  requestId?: string
}

export async function getOrCreateStripeCustomer(
  args: GetOrCreateCustomerArgs
): Promise<string> {
  const { userId, userEmail, venueId, requestId } = args
  const reqLog = log.child({
    requestId,
    userId,
    venueId,
    op: 'billing.get_or_create_customer',
  })

  const svc = createServiceClient()

  // Path A — cache hit.
  const { data: existing, error: lookupErr } = await svc
    .from('billing_customers')
    .select('stripe_customer_id')
    .eq('venue_id', venueId)
    .maybeSingle()

  if (lookupErr) {
    reqLog.error({ err: lookupErr }, 'billing.customer.lookup_failed')
    captureApiError(lookupErr, { requestId, route: 'billing.getOrCreateCustomer', userId, venueId })
    throw new BillingError('stripe_failed', 500, lookupErr.message)
  }
  if (existing) {
    return (existing as { stripe_customer_id: string }).stripe_customer_id
  }

  // Path B — create the customer in Stripe.
  let customer: Stripe.Customer
  try {
    customer = await stripe().customers.create({
      email: userEmail ?? undefined,
      metadata: { venue_id: venueId, user_id: userId },
    })
  } catch (err) {
    reqLog.error({ err }, 'billing.customer.stripe_create_failed')
    captureApiError(err, { requestId, route: 'billing.getOrCreateCustomer', userId, venueId })
    throw new BillingError('stripe_failed', 500, err instanceof Error ? err.message : 'stripe_create_failed')
  }

  // Path C — cache the mapping. On unique-violation, re-read and use the winner.
  const { error: insertErr } = await svc
    .from('billing_customers')
    .insert({ venue_id: venueId, stripe_customer_id: customer.id })

  if (insertErr) {
    // 23505 = Postgres unique_violation. Could be: another request raced us,
    // or we already had a customer mapped (rare — Path A would have caught it).
    if (insertErr.code === '23505') {
      const { data: winner } = await svc
        .from('billing_customers')
        .select('stripe_customer_id')
        .eq('venue_id', venueId)
        .maybeSingle()
      if (winner) {
        reqLog.warn(
          { discardedCustomerId: customer.id },
          'billing.customer.race_resolved'
        )
        return (winner as { stripe_customer_id: string }).stripe_customer_id
      }
    }
    reqLog.error({ err: insertErr }, 'billing.customer.cache_insert_failed')
    captureApiError(insertErr, {
      requestId,
      route: 'billing.getOrCreateCustomer',
      userId,
      venueId,
    })
    throw new BillingError('stripe_failed', 500, insertErr.message)
  }

  reqLog.info({ stripeCustomerId: customer.id }, 'billing.customer.created')
  return customer.id
}

// ---------------------------------------------------------------------------
// createCheckoutSession
// ---------------------------------------------------------------------------

export interface CreateCheckoutArgs {
  userId: string
  userEmail: string | null
  venueId: string
  priceId: string | null | undefined
  requestId?: string
}

export interface CreateCheckoutResult {
  url: string
  sessionId: string
}

export async function createCheckoutSession(
  args: CreateCheckoutArgs
): Promise<CreateCheckoutResult> {
  const { userId, userEmail, venueId, requestId } = args
  const reqLog = log.child({
    requestId,
    userId,
    venueId,
    op: 'billing.create_checkout_session',
  })

  const priceId = args.priceId || process.env.STRIPE_DEFAULT_PRICE_ID
  if (!priceId) {
    throw new BillingError('price_id_missing', 400, 'no price_id in body and STRIPE_DEFAULT_PRICE_ID is unset')
  }

  const customerId = await getOrCreateStripeCustomer({
    userId,
    userEmail,
    venueId,
    requestId,
  })

  const appUrl = (process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000').replace(/\/$/, '')
  const successUrl = `${appUrl}/dashboard/settings?billing=success`
  const cancelUrl = `${appUrl}/dashboard/settings?billing=cancelled`

  let session: Stripe.Checkout.Session
  try {
    session = await stripe().checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: successUrl,
      cancel_url: cancelUrl,
      // Top-level metadata makes the session itself searchable in Stripe.
      metadata: { venue_id: venueId, user_id: userId },
      // subscription_data.metadata propagates onto the resulting subscription
      // so the webhook can resolve venue_id even if billing_customers lags.
      subscription_data: {
        metadata: { venue_id: venueId, user_id: userId },
      },
      // Idempotency: include venue_id so a quick double-click doesn't create
      // two Stripe sessions. Date hour bucket keeps it from blocking legitimate
      // retries an hour later.
      // (Stripe lets us pass an idempotency key via request options.)
    }, {
      idempotencyKey: `checkout:${venueId}:${Math.floor(Date.now() / (60 * 60 * 1000))}`,
    })
  } catch (err) {
    reqLog.error({ err }, 'billing.checkout.stripe_failed')
    captureApiError(err, {
      requestId,
      route: 'billing.createCheckoutSession',
      userId,
      venueId,
    })
    throw new BillingError('stripe_failed', 500, err instanceof Error ? err.message : 'stripe_failed')
  }

  if (!session.url) {
    throw new BillingError('stripe_failed', 500, 'Stripe returned a checkout session without a URL')
  }

  reqLog.info({ sessionId: session.id }, 'billing.checkout.created')
  return { url: session.url, sessionId: session.id }
}

// ---------------------------------------------------------------------------
// createBillingPortalSession
// ---------------------------------------------------------------------------

export interface CreatePortalArgs {
  userId: string
  venueId: string
  requestId?: string
}

export interface CreatePortalResult {
  url: string
}

/**
 * Creates a Stripe Billing Portal session for the venue's customer.
 *
 * Behavior when no Stripe customer exists yet: returns
 * `billing_customer_not_found` (HTTP 404). The portal manages an existing
 * subscription / payment method; spinning up an empty customer mid-portal
 * is confusing UX and produces a portal page with nothing to manage. The
 * frontend should send the user through checkout first.
 */
export async function createBillingPortalSession(
  args: CreatePortalArgs
): Promise<CreatePortalResult> {
  const { userId, venueId, requestId } = args
  const reqLog = log.child({
    requestId,
    userId,
    venueId,
    op: 'billing.create_portal_session',
  })

  const svc = createServiceClient()
  const { data: row, error: lookupErr } = await svc
    .from('billing_customers')
    .select('stripe_customer_id')
    .eq('venue_id', venueId)
    .maybeSingle()

  if (lookupErr) {
    reqLog.error({ err: lookupErr }, 'billing.portal.lookup_failed')
    captureApiError(lookupErr, { requestId, route: 'billing.createBillingPortalSession', userId, venueId })
    throw new BillingError('stripe_failed', 500, lookupErr.message)
  }
  if (!row) {
    throw new BillingError('billing_customer_not_found', 404)
  }

  const customerId = (row as { stripe_customer_id: string }).stripe_customer_id
  const appUrl = (process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000').replace(/\/$/, '')

  let portal: Stripe.BillingPortal.Session
  try {
    portal = await stripe().billingPortal.sessions.create({
      customer: customerId,
      return_url: `${appUrl}/dashboard/settings`,
    })
  } catch (err) {
    reqLog.error({ err }, 'billing.portal.stripe_failed')
    captureApiError(err, {
      requestId,
      route: 'billing.createBillingPortalSession',
      userId,
      venueId,
    })
    throw new BillingError('stripe_failed', 500, err instanceof Error ? err.message : 'stripe_failed')
  }

  reqLog.info({ stripeCustomerId: customerId }, 'billing.portal.created')
  return { url: portal.url }
}

// ---------------------------------------------------------------------------
// syncSubscriptionFromStripeSubscription
// ---------------------------------------------------------------------------

function tsToIso(seconds: number | null | undefined): string | null {
  if (!seconds || !Number.isFinite(seconds)) return null
  return new Date(seconds * 1000).toISOString()
}

function pickPriceId(sub: Stripe.Subscription): string | null {
  const item = sub.items?.data?.[0]
  if (!item) return null
  const price = item.price
  if (!price) return null
  return typeof price === 'string' ? price : price.id ?? null
}

async function resolveVenueIdForSubscription(
  sub: Stripe.Subscription,
  requestId: string | undefined
): Promise<string | null> {
  // Path A — venue_id in subscription metadata (set by createCheckoutSession).
  const metaVenue =
    typeof sub.metadata?.venue_id === 'string' && sub.metadata.venue_id.length > 0
      ? sub.metadata.venue_id
      : null
  if (metaVenue) return metaVenue

  // Path B — fall back to the billing_customers cache.
  const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer?.id ?? null
  if (!customerId) return null

  const svc = createServiceClient()
  const { data } = await svc
    .from('billing_customers')
    .select('venue_id')
    .eq('stripe_customer_id', customerId)
    .maybeSingle()

  if (data) return (data as { venue_id: string }).venue_id

  log.warn(
    { requestId, customerId, subscriptionId: sub.id },
    'billing.sync.venue_id_unresolved'
  )
  return null
}

/**
 * Phase 7M — return shape widened from `Promise<void>` to include the
 * before/after status pair + the local row identifiers. Existing callers
 * that ignored the return value (Stripe webhook + admin replay) continue
 * to compile cleanly; new callers (the Phase 7M dispatcher transition
 * detector) use the values to decide whether to fire a recovery email.
 *
 * If the venue can't be resolved (rare — webhook for a customer we don't
 * have a mapping for), the function early-exits with `venueId: null` so
 * the caller can no-op gracefully.
 */
export interface SyncSubscriptionResult {
  venueId: string | null
  previousStatus: string | null
  newStatus: string
  subscriptionId: string | null
  currentPeriodEnd: string | null
}

export async function syncSubscriptionFromStripeSubscription(
  sub: Stripe.Subscription,
  requestId?: string
): Promise<SyncSubscriptionResult> {
  const reqLog = log.child({
    requestId,
    subscriptionId: sub.id,
    op: 'billing.sync_subscription',
  })

  const currentPeriodEnd = tsToIso(
    (sub as unknown as { current_period_end?: number }).current_period_end
  )

  const venueId = await resolveVenueIdForSubscription(sub, requestId)
  if (!venueId) {
    // We deliberately DO NOT throw here — a subscription for an unknown
    // venue probably means we lost the metadata link. Logging is enough;
    // re-sync can be triggered manually once the mapping is repaired.
    reqLog.warn({}, 'billing.sync.skipped_no_venue')
    return {
      venueId: null,
      previousStatus: null,
      newStatus: sub.status,
      subscriptionId: null,
      currentPeriodEnd,
    }
  }

  const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer?.id
  if (!customerId) {
    reqLog.warn({}, 'billing.sync.skipped_no_customer')
    return {
      venueId,
      previousStatus: null,
      newStatus: sub.status,
      subscriptionId: null,
      currentPeriodEnd,
    }
  }

  const svc = createServiceClient()

  // Phase 7M — capture the previous local status BEFORE the upsert so a
  // caller can detect transitions (e.g. past_due → active triggers a
  // recovery email). We also pick up the local row id when present so
  // downstream code can write to subscriptions.metadata atomically.
  let previousStatus: string | null = null
  let previousLocalId: string | null = null
  {
    const { data: prevRow } = await svc
      .from('subscriptions')
      .select('id, status')
      .eq('stripe_subscription_id', sub.id)
      .maybeSingle()
    if (prevRow) {
      previousStatus = (prevRow as { status: string | null }).status ?? null
      previousLocalId = (prevRow as { id: string }).id
    }
  }

  const row = {
    venue_id: venueId,
    stripe_customer_id: customerId,
    stripe_subscription_id: sub.id,
    stripe_price_id: pickPriceId(sub),
    status: sub.status,
    current_period_start: tsToIso((sub as unknown as { current_period_start?: number }).current_period_start),
    current_period_end: currentPeriodEnd,
    cancel_at_period_end: Boolean(sub.cancel_at_period_end),
    canceled_at: tsToIso(sub.canceled_at),
    trial_start: tsToIso(sub.trial_start),
    trial_end: tsToIso(sub.trial_end),
    metadata: (sub.metadata ?? {}) as Record<string, string>,
  }

  const { error: upsertErr } = await svc
    .from('subscriptions')
    .upsert(row, { onConflict: 'stripe_subscription_id' })

  if (upsertErr) {
    reqLog.error({ err: upsertErr }, 'billing.sync.upsert_failed')
    captureApiError(upsertErr, {
      requestId,
      route: 'billing.syncSubscription',
      venueId,
    })
    throw new BillingError('sync_failed', 500, upsertErr.message)
  }

  // Resolve the local row id — necessary for downstream callers that
  // need to read/write `subscriptions.metadata` atomically (e.g. the
  // Phase 7M payment recovery helper, which uses the Phase 7L atomic
  // append RPC and needs a row id).
  let localId = previousLocalId
  if (!localId) {
    const { data: nextRow } = await svc
      .from('subscriptions')
      .select('id')
      .eq('stripe_subscription_id', sub.id)
      .maybeSingle()
    if (nextRow) localId = (nextRow as { id: string }).id
  }

  reqLog.info(
    {
      venueId,
      status: sub.status,
      previousStatus,
      cancelAtPeriodEnd: sub.cancel_at_period_end,
    },
    'billing.sync.completed'
  )

  return {
    venueId,
    previousStatus,
    newStatus: sub.status,
    subscriptionId: localId,
    currentPeriodEnd,
  }
}
