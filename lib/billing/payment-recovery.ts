import 'server-only'
import { createServiceClient } from '@/lib/supabase/service'
import { sendEmail } from '@/lib/integrations/email'
import { appendSubscriptionMetadataArray } from '@/lib/billing/subscription-metadata'
import { log } from '@/lib/log'
import { captureApiError } from '@/lib/observability/sentry'

/**
 * Phase 7M — payment recovery email.
 *
 * Sent ONCE when a venue's subscription transitions from `past_due` back
 * to `active` / `trialing`. The dispatcher detects the transition via the
 * widened `syncSubscriptionFromStripeSubscription` return shape and calls
 * us; we own the idempotency check and the email send.
 *
 * ── IDEMPOTENCY ────────────────────────────────────────────────────────────
 * Uses `subscriptions.metadata.recovery_sent` (jsonb array, same pattern
 * as Phase 7H / 7K). Key shape:
 *
 *   recovery:<venue_id>:<current_period_end YYYY-MM-DD or unknown-period>
 *
 * Including the period date means a customer who bounces past_due → active
 * → past_due → active in the SAME billing period gets ONE recovery email;
 * if it spans into a new period, a fresh key arms a new send. We never
 * double-fire.
 *
 * The atomic append (Phase 7L) closes the race against Stripe webhook
 * resyncs.
 *
 * ── RETURN SHAPE ───────────────────────────────────────────────────────────
 * Never throws for normal skips (already-sent / no-owner / not-delivered)
 * — returns `{ sent, skipped, reason? }` so the dispatcher can include
 * the outcome in its result and the webhook can surface it without
 * try/catch. Unexpected DB errors during the initial metadata read still
 * return a `skipped: false, sent: false, reason: '…'` rather than throw —
 * recovery is best-effort, never blocks the webhook.
 *
 * ── PRIVACY ────────────────────────────────────────────────────────────────
 * No raw emails in log lines. We log `venueId`, `subscriptionId`, the
 * idempotency key, and the high-level outcome only.
 */

const REMINDER_KIND = 'payment_recovered' as const

export interface SendPaymentRecoveryEmailArgs {
  venueId: string
  subscriptionId: string
  currentPeriodEnd: string | null
  requestId?: string
}

export interface SendPaymentRecoveryEmailResult {
  sent: boolean
  skipped: boolean
  reason?: string
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10)
}

function buildRecoveryKey(venueId: string, currentPeriodEnd: string | null): string {
  const datePart = currentPeriodEnd ? isoDate(new Date(currentPeriodEnd)) : 'unknown-period'
  return `recovery:${venueId}:${datePart}`
}

interface RecoverySentEntry {
  kind: string
  key: string
}

function alreadyRecorded(
  metadata: Record<string, unknown> | null | undefined,
  key: string
): boolean {
  if (!metadata) return false
  const raw = (metadata as { recovery_sent?: unknown }).recovery_sent
  if (!Array.isArray(raw)) return false
  return (raw as RecoverySentEntry[]).some(
    (e) => e && typeof e === 'object' && 'key' in e && (e as { key: unknown }).key === key
  )
}

// ---------------------------------------------------------------------------
// Owner lookup (mirrors the Phase 7H + 7K shape — earliest owner)
// ---------------------------------------------------------------------------

interface OwnerInfo {
  userId: string
  email: string
}

async function findOwnerEmail(
  supabase: ReturnType<typeof createServiceClient>,
  venueId: string
): Promise<OwnerInfo | null> {
  const { data: memberRow, error: memberErr } = await supabase
    .from('venue_members')
    .select('user_id')
    .eq('venue_id', venueId)
    .eq('role', 'owner')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()

  if (memberErr || !memberRow) return null
  const userId = (memberRow as { user_id: string }).user_id

  try {
    const { data: userRes } = await supabase.auth.admin.getUserById(userId)
    const email = userRes.user?.email
    if (!email) return null
    return { userId, email }
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// sendPaymentRecoveryEmail
// ---------------------------------------------------------------------------

export async function sendPaymentRecoveryEmail(
  args: SendPaymentRecoveryEmailArgs
): Promise<SendPaymentRecoveryEmailResult> {
  const { venueId, subscriptionId, currentPeriodEnd, requestId } = args
  const reqLog = log.child({
    requestId,
    venueId,
    subscriptionId,
    op: 'billing.payment_recovery',
  })

  const key = buildRecoveryKey(venueId, currentPeriodEnd)
  const svc = createServiceClient()

  // 1. Idempotency check — read metadata for this subscription row.
  const { data: subRow, error: subErr } = await svc
    .from('subscriptions')
    .select('id, metadata')
    .eq('id', subscriptionId)
    .maybeSingle()

  if (subErr) {
    reqLog.error({ err: subErr }, 'billing.payment_recovery.lookup_failed')
    captureApiError(subErr, {
      requestId,
      route: 'billing.sendPaymentRecoveryEmail',
      venueId,
    })
    return { sent: false, skipped: false, reason: 'lookup_failed' }
  }
  if (!subRow) {
    reqLog.warn({}, 'billing.payment_recovery.subscription_not_found')
    return { sent: false, skipped: true, reason: 'subscription_not_found' }
  }

  const metadata = (subRow as { metadata: Record<string, unknown> | null }).metadata ?? null
  if (alreadyRecorded(metadata, key)) {
    reqLog.info({ key }, 'billing.payment_recovery.skip_already_sent')
    return { sent: false, skipped: true, reason: 'already_sent' }
  }

  // 2. Owner email.
  const owner = await findOwnerEmail(svc, venueId)
  if (!owner) {
    reqLog.warn({}, 'billing.payment_recovery.skip_no_owner_email')
    return { sent: false, skipped: true, reason: 'no_owner_email' }
  }

  // 3. Email send.
  const appUrl = (process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000').replace(/\/$/, '')
  const billingUrl = `${appUrl}/dashboard/settings/billing`
  const text =
    `Good news — Stripe successfully charged your payment method and your ` +
    `VenueRise account is fully active again.\n\n` +
    `Nothing more to do on your end. Your dashboard, AI replies, tour ` +
    `automations, and team invitations are all available as normal.\n\n` +
    `View your subscription + invoice history:\n${billingUrl}\n\n` +
    `Thanks for sticking with us. If anything else came up during the ` +
    `payment hiccup, just reply to this email.`

  let result
  try {
    result = await sendEmail({
      to: owner.email,
      subject: 'Payment received — your VenueRise account is active',
      text,
      venueId,
      relatedTable: 'subscriptions',
      relatedId: subscriptionId,
    })
  } catch (err) {
    reqLog.error({ err }, 'billing.payment_recovery.send_threw')
    captureApiError(err, {
      requestId,
      route: 'billing.sendPaymentRecoveryEmail',
      venueId,
    })
    return { sent: false, skipped: false, reason: 'send_threw' }
  }

  if (!result.delivered) {
    // Console-fallback OR provider error. Either way we don't append a
    // recovery_sent entry — next webhook resync may retry the send once
    // Resend is configured / the outage clears. Same honesty model as
    // Phase 7H + 7K.
    reqLog.warn(
      { provider: result.provider, errorMessage: result.error },
      result.error
        ? 'billing.payment_recovery.send_failed'
        : 'billing.payment_recovery.console_fallback'
    )
    if (result.error) {
      captureApiError(new Error(result.error), {
        requestId,
        route: 'billing.sendPaymentRecoveryEmail',
        venueId,
      })
    }
    return {
      sent: false,
      skipped: false,
      reason: result.error ?? 'not_delivered',
    }
  }

  // 4. Atomic append (Phase 7L). Closes the race with Stripe webhook
  // resyncs that would otherwise overwrite metadata.
  const updated = await appendSubscriptionMetadataArray({
    subscriptionId,
    arrayKey: 'recovery_sent',
    entry: {
      kind: REMINDER_KIND,
      key,
      sent_at: new Date().toISOString(),
      provider: result.provider ?? 'unknown',
      message_id: result.messageId,
    },
    requestId,
  })

  if (!updated) {
    // Email IS in flight; we just can't record it. Logged + Sentry-captured
    // by the helper. Surface to the caller so the webhook response reflects
    // reality.
    reqLog.error({}, 'billing.payment_recovery.metadata_append_failed')
    return { sent: false, skipped: false, reason: 'metadata_append_failed' }
  }

  reqLog.info(
    { provider: result.provider, messageId: result.messageId, key },
    'billing.payment_recovery.sent'
  )
  return { sent: true, skipped: false }
}
