import 'server-only'
import type Stripe from 'stripe'
import { createServiceClient } from '@/lib/supabase/service'
import { log } from '@/lib/log'
import { captureApiError } from '@/lib/observability/sentry'

/**
 * Phase 7F — Stripe webhook event audit log.
 *
 * Every event Stripe sends us is recorded BEFORE we dispatch it to the
 * subscription sync, then updated AFTER the handler runs (or fails). The
 * log is a forensic cache: Stripe stays the source of truth, but we can
 * answer "what did Stripe tell us, when, and did we cope?" without a
 * round-trip to Stripe's API.
 *
 * IDEMPOTENCY
 *   Stripe retries on 5xx and sometimes sends duplicates on flaky network.
 *   The UNIQUE constraint on `stripe_event_id` means our INSERT errors
 *   with code 23505 on a redelivery; we treat that as the signal to
 *   short-circuit (don't re-handle) and bump `duplicate_count` instead.
 *
 * PAYLOAD PRIVACY
 *   We store the full Stripe event payload so post-hoc debugging doesn't
 *   require Stripe API access. Stripe payloads can contain PII (customer
 *   email, billing address, partial card details). The table is RLS-gated
 *   to ADMIN_ROLES and never exposed via product APIs — only forensic /
 *   admin surfaces. Don't echo payload fields into customer-facing logs.
 *
 * FAILURE POSTURE
 *   This is observability, not enforcement. If the audit log write fails
 *   (DB outage, RLS misconfig, anything), we log + Sentry-capture but
 *   never throw to the webhook handler. The webhook MUST stay responsive
 *   to Stripe — a 5xx here triggers Stripe's retry machine, which would
 *   double-fire downstream side effects.
 *
 * `server-only` so the service-role import can't leak.
 */

const TABLE = 'billing_events_log'

// ---------------------------------------------------------------------------
// logStripeEventReceived
// ---------------------------------------------------------------------------

export interface LogStripeEventArgs {
  event: Stripe.Event
  requestId?: string
}

export interface LogStripeEventResult {
  /** Row id of the log row. `null` when the audit-log write failed entirely. */
  logId: string | null
  /** True iff Stripe redelivered an event we'd already logged. */
  duplicate: boolean
}

/**
 * Pull surfaced ids out of the event so we can index by them.
 *
 * Stripe events nest the relevant resource under `data.object` and the
 * customer / subscription references are present on most billing events.
 * We extract best-effort — null fields are fine.
 */
function extractIds(event: Stripe.Event): {
  stripeCustomerId: string | null
  stripeSubscriptionId: string | null
  venueIdFromMetadata: string | null
} {
  // Stripe's discriminated `event.data.object` union doesn't overlap with
  // Record<string, unknown> by TypeScript's strict comparability rules, so
  // we widen via `unknown` first.
  const obj = event.data?.object as unknown as Record<string, unknown> | undefined
  const customer = obj?.customer
  const subscription = (obj as { subscription?: unknown })?.subscription
  // Subscription objects nest customer directly; subscription_id is the obj.id.
  const isSubObject = (obj as { object?: string })?.object === 'subscription'

  const stripeCustomerId =
    typeof customer === 'string'
      ? customer
      : customer && typeof customer === 'object' && 'id' in customer
        ? String((customer as { id: unknown }).id)
        : null

  const stripeSubscriptionId = isSubObject
    ? String((obj as { id?: unknown })?.id ?? '') || null
    : typeof subscription === 'string'
      ? subscription
      : subscription && typeof subscription === 'object' && 'id' in subscription
        ? String((subscription as { id: unknown }).id)
        : null

  // Some events carry venue_id in metadata (we set it on subscription_data
  // when creating Checkout sessions — see lib/billing/billing-service.ts).
  const metadata = (obj as { metadata?: Record<string, unknown> })?.metadata
  const metaVenue = metadata && typeof metadata.venue_id === 'string' ? metadata.venue_id : null

  return {
    stripeCustomerId,
    stripeSubscriptionId,
    venueIdFromMetadata: metaVenue,
  }
}

export async function logStripeEventReceived(
  args: LogStripeEventArgs
): Promise<LogStripeEventResult> {
  const { event, requestId } = args
  const reqLog = log.child({
    requestId,
    op: 'billing.events_log.received',
    stripeEventId: event.id,
    eventType: event.type,
  })

  const ids = extractIds(event)
  const svc = createServiceClient()

  // Try insert first. On duplicate, the unique constraint fires (code 23505)
  // and we fall through to the bump path.
  const { data: inserted, error: insertErr } = await svc
    .from(TABLE)
    .insert({
      stripe_event_id: event.id,
      event_type: event.type,
      venue_id: ids.venueIdFromMetadata,
      stripe_customer_id: ids.stripeCustomerId,
      stripe_subscription_id: ids.stripeSubscriptionId,
      payload: event as unknown as Record<string, unknown>,
    })
    .select('id')
    .single()

  if (!insertErr && inserted) {
    return { logId: (inserted as { id: string }).id, duplicate: false }
  }

  if (insertErr?.code === '23505') {
    // Duplicate — fetch the existing row and bump its counter.
    const { data: existing } = await svc
      .from(TABLE)
      .select('id, duplicate_count')
      .eq('stripe_event_id', event.id)
      .maybeSingle()

    if (existing) {
      const row = existing as { id: string; duplicate_count: number | null }
      const next = (row.duplicate_count ?? 0) + 1
      const { error: bumpErr } = await svc
        .from(TABLE)
        .update({ duplicate_count: next })
        .eq('id', row.id)
      if (bumpErr) {
        // Best-effort; the duplicate signal is still right.
        reqLog.warn({ err: bumpErr }, 'billing.events_log.bump_failed')
        captureApiError(bumpErr, {
          requestId,
          route: 'billing.events_log.bump',
        })
      }
      reqLog.info({ logId: row.id, duplicateCount: next }, 'billing.events_log.duplicate')
      return { logId: row.id, duplicate: true }
    }

    // 23505 but row not found — shouldn't happen, but don't throw.
    reqLog.warn({}, 'billing.events_log.duplicate_lookup_missed')
    return { logId: null, duplicate: true }
  }

  // Non-duplicate insert error. Surface + Sentry-capture; return null so the
  // webhook keeps moving. We intentionally do not throw — losing audit log
  // coverage is much less bad than re-triggering Stripe retries.
  reqLog.error({ err: insertErr }, 'billing.events_log.insert_failed')
  captureApiError(insertErr, {
    requestId,
    route: 'billing.events_log.insert',
  })
  return { logId: null, duplicate: false }
}

// ---------------------------------------------------------------------------
// markStripeEventHandled
// ---------------------------------------------------------------------------

export interface MarkStripeEventHandledArgs {
  stripeEventId: string
  handled: boolean
  /** Short error string when handled=false. Stored verbatim. */
  error?: string | null
  /** Set after handler resolves the venue (subscription sync resolves this). */
  venueId?: string | null
  requestId?: string
}

export async function markStripeEventHandled(
  args: MarkStripeEventHandledArgs
): Promise<void> {
  const { stripeEventId, handled, error, venueId, requestId } = args
  const reqLog = log.child({
    requestId,
    op: 'billing.events_log.mark_handled',
    stripeEventId,
  })

  const update: Record<string, unknown> = {
    handled,
    handled_at: new Date().toISOString(),
  }
  if (error !== undefined) update.handler_error = error
  if (venueId !== undefined && venueId !== null) update.venue_id = venueId

  const svc = createServiceClient()
  const { error: updateErr } = await svc
    .from(TABLE)
    .update(update)
    .eq('stripe_event_id', stripeEventId)

  if (updateErr) {
    reqLog.warn({ err: updateErr }, 'billing.events_log.mark_handled_failed')
    captureApiError(updateErr, {
      requestId,
      route: 'billing.events_log.mark_handled',
    })
    // Swallow — the handler already ran (success or failure). Audit log
    // staleness is acceptable; webhook responsiveness is not negotiable.
  }
}
