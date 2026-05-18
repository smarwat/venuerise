import { NextRequest, NextResponse } from 'next/server'
import type Stripe from 'stripe'
import { log } from '@/lib/log'
import { getOrCreateRequestId, withRequestIdHeader } from '@/lib/observability/request-id'
import { captureWebhookError } from '@/lib/observability/sentry'
import {
  stripe,
  constructWebhookEvent,
  BillingNotConfiguredError,
} from '@/lib/billing/stripe'
import { syncSubscriptionFromStripeSubscription } from '@/lib/billing/billing-service'
import {
  logStripeEventReceived,
  markStripeEventHandled,
} from '@/lib/billing/billing-events-log'

/**
 * POST /api/stripe/webhook
 *
 * Stripe → us. We never trust an event body until the signature verifies.
 *
 * Critical implementation notes:
 *   1. We MUST read the RAW body (await request.text()) and pass it to
 *      Stripe's `constructEvent`. Calling `request.json()` first would
 *      parse + re-stringify and the signature would never match.
 *   2. Signature header name is exactly `stripe-signature` (lowercase),
 *      surfaced by Node's `Headers` API as case-insensitive.
 *   3. Missing/invalid signature → 401 (so Stripe will retry — they
 *      treat 4xx/5xx as transient if returned within their retry window).
 *   4. Missing webhook secret env → 503 (server misconfig, not the
 *      sender's fault; Stripe will retry).
 *   5. Unknown event types → 200, log, no error. Lets Stripe stop
 *      retrying and lets us add handlers without redeploying-and-retrying.
 *   6. Successfully handled events → 200 even if downstream sync had
 *      partial failures — those are logged + Sentry-captured but never
 *      block Stripe's progress. (Re-syncing is idempotent; the next event
 *      will replay state.)
 *   7. We DELIBERATELY do not log the full event payload — only event id,
 *      type, and the resource ids needed for diagnostics.
 *
 * This route is exempt from the user-facing rate limiter. Stripe controls
 * its own retry cadence; throttling them just makes our metrics noisier.
 */

const HANDLED_EVENTS = new Set<Stripe.Event['type']>([
  'checkout.session.completed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'invoice.payment_succeeded',
  'invoice.payment_failed',
])

export async function POST(request: NextRequest) {
  const requestId = getOrCreateRequestId(request)
  const reqLog = log.child({ requestId, route: '/api/stripe/webhook' })
  const respond = <T extends Response>(r: T) => withRequestIdHeader(r, requestId)

  // 1. Raw body — must come BEFORE any JSON parsing.
  const rawBody = await request.text().catch(() => '')
  const signatureHeader = request.headers.get('stripe-signature')

  // 2. Verify signature.
  let event: Stripe.Event
  try {
    event = constructWebhookEvent(rawBody, signatureHeader)
  } catch (err) {
    if (err instanceof BillingNotConfiguredError) {
      reqLog.warn({}, 'stripe.webhook.not_configured')
      return respond(
        NextResponse.json({ error: 'billing_not_configured' }, { status: 503 })
      )
    }
    // Signature mismatch or missing → 401. Stripe retries.
    reqLog.warn(
      { errMessage: err instanceof Error ? err.message : String(err) },
      'stripe.webhook.signature_invalid'
    )
    return respond(
      NextResponse.json({ error: 'invalid_signature' }, { status: 401 })
    )
  }

  // 3. Phase 7F — audit the event BEFORE dispatch.
  //
  // If Stripe redelivers the same event (e.g. our previous response was
  // a 5xx during a brief Supabase blip), we short-circuit so the handler
  // doesn't run twice. The webhook handlers are idempotent anyway, but
  // skipping the redelivery keeps invoice-payment-succeeded → email-send
  // double-fires off the table for any future side effect.
  //
  // Audit log failures are intentionally silent — the helper logs +
  // Sentry-captures internally and returns `{ logId: null, duplicate: false }`
  // so we keep moving. Losing audit coverage is far less bad than a 5xx
  // back to Stripe (which would retry and re-trigger downstream effects).
  const audit = await logStripeEventReceived({ event, requestId })

  if (audit.duplicate) {
    reqLog.info(
      { type: event.type, id: event.id },
      'stripe.webhook.duplicate'
    )
    return respond(
      NextResponse.json({ received: true, duplicate: true, handled: false })
    )
  }

  // 4. Dispatch (only for known event types).
  if (!HANDLED_EVENTS.has(event.type)) {
    reqLog.info({ type: event.type, id: event.id }, 'stripe.webhook.ignored')
    // Intentionally-ignored events are still "handled" from an audit
    // standpoint — we made a deliberate decision to no-op. This lets the
    // "what failed?" query (handled=false) stay focused on real failures.
    await markStripeEventHandled({
      stripeEventId: event.id,
      handled: true,
      error: null,
      requestId,
    })
    return respond(NextResponse.json({ received: true, handled: false }))
  }

  let handlerError: Error | null = null
  try {
    await dispatch(event, requestId)
  } catch (err) {
    // Log + capture but don't fail the webhook — re-sync is idempotent.
    handlerError = err instanceof Error ? err : new Error(String(err))
    reqLog.error(
      { err, type: event.type, id: event.id },
      'stripe.webhook.handler_failed'
    )
    captureWebhookError('stripe', err, {
      requestId,
      route: '/api/stripe/webhook',
    })
    // 200 so Stripe stops retrying; the operator gets paged via Sentry.
    // Tradeoff documented in lib/billing/billing-events-log.ts: if Stripe
    // retries we'd handle the same event twice, and `subscriptions` is
    // idempotent on stripe_subscription_id but other future side-effects
    // (emails, metrics) might not be.
  }

  // 5. Mark handled status in the audit log.
  await markStripeEventHandled({
    stripeEventId: event.id,
    handled: handlerError === null,
    error: handlerError?.message ?? null,
    requestId,
  })

  return respond(
    NextResponse.json({ received: true, handled: handlerError === null })
  )
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

async function dispatch(event: Stripe.Event, requestId: string): Promise<void> {
  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object as Stripe.Checkout.Session
      const subscriptionRef = session.subscription
      const subscriptionId =
        typeof subscriptionRef === 'string' ? subscriptionRef : subscriptionRef?.id ?? null
      if (!subscriptionId) {
        log.info(
          { requestId, sessionId: session.id, eventId: event.id },
          'stripe.webhook.checkout.no_subscription'
        )
        return
      }
      const sub = await stripe().subscriptions.retrieve(subscriptionId)
      await syncSubscriptionFromStripeSubscription(sub, requestId)
      return
    }

    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      const sub = event.data.object as Stripe.Subscription
      await syncSubscriptionFromStripeSubscription(sub, requestId)
      return
    }

    case 'invoice.payment_succeeded':
    case 'invoice.payment_failed': {
      // Invoices belong to a subscription on subscription mode. Re-sync to
      // pull the latest period dates + status (past_due / unpaid / active).
      const invoice = event.data.object as Stripe.Invoice
      // Stripe types: invoice.subscription was historically a top-level field;
      // newer API versions also expose it via parent.subscription_details.
      const ref =
        (invoice as unknown as { subscription?: string | Stripe.Subscription | null })
          .subscription ??
        (invoice as unknown as {
          parent?: { subscription_details?: { subscription?: string | null } }
        }).parent?.subscription_details?.subscription ??
        null
      const subscriptionId = typeof ref === 'string' ? ref : ref?.id ?? null
      if (!subscriptionId) {
        log.info(
          { requestId, invoiceId: invoice.id, eventId: event.id, type: event.type },
          'stripe.webhook.invoice.no_subscription'
        )
        return
      }
      const sub = await stripe().subscriptions.retrieve(subscriptionId)
      await syncSubscriptionFromStripeSubscription(sub, requestId)
      return
    }

    default: {
      // HANDLED_EVENTS guards against this, but the exhaustiveness check
      // catches future additions to the set that forgot a case branch.
      log.info(
        { requestId, type: event.type, id: event.id },
        'stripe.webhook.unhandled_in_dispatch'
      )
    }
  }
}
