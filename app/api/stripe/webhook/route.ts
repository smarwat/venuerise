import { NextRequest, NextResponse } from 'next/server'
import type Stripe from 'stripe'
import { log } from '@/lib/log'
import { getOrCreateRequestId, withRequestIdHeader } from '@/lib/observability/request-id'
import {
  constructWebhookEvent,
  BillingNotConfiguredError,
} from '@/lib/billing/stripe'
import {
  logStripeEventReceived,
  markStripeEventHandled,
} from '@/lib/billing/billing-events-log'
import { dispatchStripeEvent } from '@/lib/billing/stripe-event-dispatcher'

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
 *   5. Unknown event types → 200, marked handled (intentionally ignored),
 *      no error. Lets Stripe stop retrying and lets us add handlers
 *      without redeploying-and-retrying.
 *   6. Successfully handled events → 200 even if downstream sync had
 *      partial failures — those are logged + Sentry-captured but never
 *      block Stripe's progress. (Re-syncing is idempotent; the next event
 *      will replay state.)
 *   7. We DELIBERATELY do not log the full event payload — only event id,
 *      type, and the resource ids needed for diagnostics.
 *
 * This route is exempt from the user-facing rate limiter. Stripe controls
 * its own retry cadence; throttling them just makes our metrics noisier.
 *
 * Phase 7I: the actual event → handler switch lives in
 * `lib/billing/stripe-event-dispatcher.ts` so this route + the admin
 * replay endpoint share one source of truth.
 */

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
  // Stripe redelivers on 5xx; the UNIQUE on stripe_event_id + the helper's
  // duplicate detection short-circuits handler execution on redelivery.
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

  // 4. Phase 7I — dispatch via the shared dispatcher. Catches handler
  // errors so we always reach the audit-mark step below, even when the
  // dispatcher itself throws something unexpected.
  let result
  try {
    result = await dispatchStripeEvent(event, { requestId, source: 'webhook' })
  } catch (err) {
    // The dispatcher catches its own dispatch errors and returns a
    // shaped result, so reaching this catch means something more
    // fundamental went wrong (e.g. import-time failure). Treat as
    // handler failure so the audit row reflects reality.
    const message = err instanceof Error ? err.message : String(err)
    reqLog.error({ err }, 'stripe.webhook.dispatcher_threw')
    result = {
      handled: false,
      ignored: false,
      venueId: null,
      handlerError: message,
    }
  }

  // 5. Mark handled status in the audit log.
  await markStripeEventHandled({
    stripeEventId: event.id,
    handled: result.handled,
    error: result.handlerError ?? null,
    venueId: result.venueId ?? undefined,
    requestId,
  })

  // 6. Always 200 to Stripe — handler failure is recorded but doesn't
  // propagate as a 5xx (would retrigger Stripe retries). See
  // SECURITY.md §10e for the tradeoff.
  //
  // Phase 7M — surface the recovery email outcome (if the dispatcher
  // attempted one) so the operator's webhook log shows the full chain
  // from payload → handled → recovery in one row. Optional field,
  // omitted when no recovery email was attempted.
  const responseBody: {
    received: true
    handled: boolean
    ignored: boolean
    recovery_email?: { sent: boolean; skipped: boolean; reason?: string }
  } = {
    received: true,
    handled: result.handled,
    ignored: result.ignored,
  }
  if (result.recoveryEmail) {
    responseBody.recovery_email = result.recoveryEmail
  }
  return respond(NextResponse.json(responseBody))
}
