import 'server-only'
import type Stripe from 'stripe'
import { stripe } from './stripe'
import { syncSubscriptionFromStripeSubscription } from './billing-service'
import { log } from '@/lib/log'
import { captureWebhookError } from '@/lib/observability/sentry'

/**
 * Phase 7I — shared Stripe event dispatcher.
 *
 * Previously lived inline in `app/api/stripe/webhook/route.ts`. Extracted
 * so the webhook route AND the admin replay endpoint share one handler
 * surface — if we ever add a third caller (e.g. a backfill script), it
 * picks up the same exact behavior for free.
 *
 * RESPONSIBILITIES
 *   - Dispatch a verified Stripe event to the right downstream sync call.
 *   - Return a structured outcome so callers can update their audit row
 *     without re-implementing the success/failure logic.
 *
 * NOT RESPONSIBILITIES
 *   - Insert/update `billing_events_log`. The caller (webhook or replay
 *     route) owns the audit-row lifecycle. Replay deliberately reuses
 *     the existing row instead of inserting a new one — keeping the
 *     dispatcher audit-log-agnostic lets that just work.
 *   - Stripe signature verification. The webhook route handles that
 *     before invoking the dispatcher; the replay route fetches events
 *     directly via the Stripe API (which is implicitly authenticated by
 *     `STRIPE_SECRET_KEY`).
 *
 * RETURN SHAPE
 *   { handled: true,  ignored: true,  venueId?, handlerError: null }
 *     — known-but-deliberately-ignored event type. Caller marks handled
 *       in the audit log so future "what failed?" queries stay focused
 *       on real failures.
 *   { handled: true,  ignored: false, venueId?, handlerError: null }
 *     — handler ran cleanly. Subscription sync (if it ran) succeeded.
 *   { handled: false, ignored: false, venueId?, handlerError: <string> }
 *     — handler threw. Caller logs, Sentry-captures, marks handled=false.
 *
 * `venueId` is best-effort: extracted from event metadata when present
 * (set by createCheckoutSession on subscription_data.metadata). Falls
 * back to `null` for invoice / checkout events where the subscription
 * has to be retrieved separately — the sync function resolves the venue
 * itself in that case, but we don't surface its decision back to the
 * dispatcher's caller (would require widening `syncSubscriptionFromStripeSubscription`
 * which Phase 7C deliberately keeps `void`-returning).
 */

const HANDLED_EVENTS = new Set<Stripe.Event['type']>([
  'checkout.session.completed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'invoice.payment_succeeded',
  'invoice.payment_failed',
])

export interface DispatchContext {
  requestId?: string
  /**
   * Where the dispatch was triggered from. Used for log tagging only —
   * 'webhook' = Stripe sent us the event; 'admin_replay' = an operator
   * clicked replay on a previously failed audit row.
   */
  source?: 'webhook' | 'admin_replay'
}

export interface DispatchResult {
  handled: boolean
  ignored: boolean
  venueId?: string | null
  handlerError?: string | null
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function venueIdFromMetadata(obj: unknown): string | null {
  if (!obj || typeof obj !== 'object') return null
  const metadata = (obj as { metadata?: unknown }).metadata
  if (!metadata || typeof metadata !== 'object') return null
  const v = (metadata as Record<string, unknown>).venue_id
  return typeof v === 'string' && v.length > 0 ? v : null
}

function invoiceSubscriptionId(invoice: Stripe.Invoice): string | null {
  // Stripe API drift: pre-`dahlia` invoices have `invoice.subscription`;
  // newer shapes nest it under `invoice.parent.subscription_details.subscription`.
  // We support both so a deploy that straddles a Stripe API version doesn't
  // silently lose invoice events.
  const legacy =
    (invoice as unknown as { subscription?: string | Stripe.Subscription | null })
      .subscription ?? null
  const modern =
    (invoice as unknown as {
      parent?: { subscription_details?: { subscription?: string | null } }
    }).parent?.subscription_details?.subscription ?? null
  const ref = legacy ?? modern
  return typeof ref === 'string' ? ref : ref?.id ?? null
}

// ---------------------------------------------------------------------------
// dispatchStripeEvent
// ---------------------------------------------------------------------------

export async function dispatchStripeEvent(
  event: Stripe.Event,
  ctx: DispatchContext = {}
): Promise<DispatchResult> {
  const reqLog = log.child({
    requestId: ctx.requestId,
    op: 'billing.stripe_dispatch',
    source: ctx.source ?? 'webhook',
    eventId: event.id,
    eventType: event.type,
  })

  if (!HANDLED_EVENTS.has(event.type)) {
    reqLog.info({}, 'stripe.dispatch.ignored')
    return { handled: true, ignored: true, venueId: null, handlerError: null }
  }

  try {
    let venueId: string | null = null
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session
        venueId = venueIdFromMetadata(session)
        const ref = session.subscription
        const subscriptionId = typeof ref === 'string' ? ref : ref?.id ?? null
        if (!subscriptionId) {
          reqLog.info({ sessionId: session.id }, 'stripe.dispatch.checkout.no_subscription')
          break
        }
        const sub = await stripe().subscriptions.retrieve(subscriptionId)
        venueId = venueId ?? venueIdFromMetadata(sub)
        await syncSubscriptionFromStripeSubscription(sub, ctx.requestId)
        break
      }

      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted': {
        const sub = event.data.object as Stripe.Subscription
        venueId = venueIdFromMetadata(sub)
        await syncSubscriptionFromStripeSubscription(sub, ctx.requestId)
        break
      }

      case 'invoice.payment_succeeded':
      case 'invoice.payment_failed': {
        const invoice = event.data.object as Stripe.Invoice
        venueId = venueIdFromMetadata(invoice)
        const subscriptionId = invoiceSubscriptionId(invoice)
        if (!subscriptionId) {
          reqLog.info({ invoiceId: invoice.id }, 'stripe.dispatch.invoice.no_subscription')
          break
        }
        const sub = await stripe().subscriptions.retrieve(subscriptionId)
        venueId = venueId ?? venueIdFromMetadata(sub)
        await syncSubscriptionFromStripeSubscription(sub, ctx.requestId)
        break
      }

      default: {
        // Defensive — HANDLED_EVENTS should guard, but if a future Stripe
        // SDK type widens the union and we miss a case, surface it.
        reqLog.warn({}, 'stripe.dispatch.unreachable_default')
      }
    }

    reqLog.info({ venueId }, 'stripe.dispatch.completed')
    return { handled: true, ignored: false, venueId, handlerError: null }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    reqLog.error({ err }, 'stripe.dispatch.failed')
    captureWebhookError('stripe', err, {
      requestId: ctx.requestId,
      route: ctx.source === 'admin_replay' ? '/api/admin/billing-events/[id]/replay' : '/api/stripe/webhook',
    })
    return { handled: false, ignored: false, venueId: null, handlerError: message }
  }
}
