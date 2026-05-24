import 'server-only'
import {
  emailConfigured,
  sendEmail,
  type SendEmailResult,
} from '@/lib/integrations/email'

/**
 * Phase 8BN — Outbound email delivery wrapper for the operator
 * composer ("Reply Method = Email · Direct" path).
 *
 * ── WHY A SEPARATE WRAPPER ────────────────────────────────────────────────
 * `lib/integrations/email.ts` (`sendEmail`) is the platform-wide
 * Resend helper used by digest, tour notifications, trial
 * reminders, etc. It owns suppression checks, the
 * `outbound_messages` audit row, Resend webhook tag plumbing,
 * and the unsubscribe footer. We deliberately reuse it instead
 * of opening a second integration surface.
 *
 * This wrapper adds the policy bits the composer needs on top:
 *
 *   1. A separate kill switch (`OUTBOUND_EMAIL_DELIVERY_ENABLED`)
 *      so a venue can turn off operator-initiated sends without
 *      breaking transactional emails (digests, tour reminders).
 *      Direct sending only activates when this is "1"/"true" AND
 *      Resend is fully configured.
 *
 *   2. A composer-shaped result envelope (`OutboundEmailResult`)
 *      that matches the metadata the conversation route stamps
 *      onto the message row (`delivery_status` / `delivery_provider`
 *      / `provider_message_id` / `delivery_error_code` /
 *      `delivery_safe_error`).
 *
 *   3. Recipient validation BEFORE we hit Resend — keeps the
 *      "failed" code surface meaningful for the UI pill.
 *
 * ── HONESTY CONTRACT ──────────────────────────────────────────────────────
 *   - Returns `ok: true, deliveryStatus: 'sent'` only when Resend
 *     accepted the message AND returned a provider id. "Sent" here
 *     means "handed to Resend" — webhook-confirmed delivery is
 *     tracked separately on the `outbound_messages` row by the
 *     existing webhook surface.
 *   - Returns `ok: false, deliveryStatus: 'skipped'` when delivery
 *     is intentionally not attempted (kill switch off, missing
 *     env, suppression). The composer route uses this to flip the
 *     pill to "Saved in VenueRise only" without surfacing a
 *     scary "Failed" error.
 *   - Returns `ok: false, deliveryStatus: 'failed'` on a real
 *     send error — bad recipient, provider rejection, network.
 *     The composer route stores a safe (non-PII) error code +
 *     short reason so the operator can act.
 *   - Never throws. Errors collapse to a `failed` result.
 *   - Never logs the message body as an error payload.
 *   - Never returns the Resend API key or full provider response.
 */

const FALSE_VALUES = new Set(['', '0', 'false', 'no', 'off'])

/**
 * Operator-composer direct email delivery is gated on TWO things:
 *
 *   1. `OUTBOUND_EMAIL_DELIVERY_ENABLED` (this kill switch).
 *      Defaults to off — opt-in per environment.
 *   2. `emailConfigured()` (Resend keys + FROM address present).
 *      Reuses the platform-wide helper.
 *
 * If either is missing, the resolver keeps `deliveryMode:
 * 'internal_only'` for email and the composer renders "Saved in
 * VenueRise only".
 */
export function isOutboundEmailConfigured(): boolean {
  const raw = process.env.OUTBOUND_EMAIL_DELIVERY_ENABLED
  if (raw == null) return false
  const normalized = raw.trim().toLowerCase()
  if (FALSE_VALUES.has(normalized)) return false
  return emailConfigured()
}

export interface OutboundEmailInput {
  /** Recipient email — validated before calling the provider. */
  to: string
  /** Display name for the recipient (used in subject context if present). */
  toName?: string | null
  /** Plain-text body. Required. The platform helper auto-derives HTML. */
  text: string
  /** Optional rich HTML override. Most composer sends don't need this. */
  html?: string | null
  /** Subject line. Pass null and the wrapper picks a safe default. */
  subject?: string | null
  /** Venue display name — used to humanize the default subject. */
  venueName?: string | null
  /** Required for outbound_messages logging. */
  venueId: string
  /** Required so the row can be joined back to the source thread. */
  conversationId: string
  /** Optional — when present, lets the audit row index by lead. */
  leadId?: string | null
  /** Optional — the messages.id we're paired with so audit can join. */
  messageId?: string | null
  /** Optional Reply-To override. Falls back to RESEND_REPLY_TO_EMAIL. */
  replyTo?: string | null
}

export type OutboundEmailResult =
  | {
      ok: true
      provider: 'resend'
      providerMessageId: string | null
      outboundMessageId: string | null
      deliveryStatus: 'sent'
    }
  | {
      ok: false
      provider: 'resend'
      deliveryStatus: 'failed' | 'skipped'
      errorCode:
        | 'delivery_disabled'
        | 'invalid_recipient'
        | 'missing_body'
        | 'missing_venue_id'
        | 'provider_rejected'
        | 'provider_threw'
        | 'suppressed'
      safeError: string
      outboundMessageId?: string | null
    }

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function safeSubject(input: { subject?: string | null; venueName?: string | null }): string {
  const provided = (input.subject ?? '').trim()
  if (provided) return provided.slice(0, 180)
  const venue = (input.venueName ?? '').trim()
  if (venue) return `Re: Your inquiry with ${venue.slice(0, 80)}`
  return 'Re: Your wedding venue inquiry'
}

/**
 * Attempt to deliver an operator-composed reply to the lead via
 * email. Never throws. Always returns a result the caller can
 * stamp onto the source message row.
 *
 * Insert-then-patch ordering is enforced by the caller, not here —
 * this helper is stateless w.r.t. the messages table.
 */
export async function sendOutboundEmail(
  input: OutboundEmailInput
): Promise<OutboundEmailResult> {
  // 1. Kill-switch + config gate. Returns `skipped` so the UI
  //    can show "Saved in VenueRise only" instead of a red
  //    "Failed" pill — the operator didn't do anything wrong;
  //    the platform just isn't wired here.
  if (!isOutboundEmailConfigured()) {
    return {
      ok: false,
      provider: 'resend',
      deliveryStatus: 'skipped',
      errorCode: 'delivery_disabled',
      safeError: 'Email sending is not connected for this workspace.',
    }
  }

  // 2. Recipient validation. We do this BEFORE the suppression
  //    check inside `sendEmail` because a malformed address would
  //    cost a DB round-trip + still fail at Resend. Better to fail
  //    fast with a clear error code.
  const to = (input.to ?? '').trim()
  if (!to || !EMAIL_RE.test(to)) {
    return {
      ok: false,
      provider: 'resend',
      deliveryStatus: 'failed',
      errorCode: 'invalid_recipient',
      safeError: 'Lead email address is missing or invalid.',
    }
  }

  // 3. Body sanity. Empty body is a client bug — the composer
  //    already gates the send button, but defense in depth.
  const text = (input.text ?? '').trim()
  if (!text) {
    return {
      ok: false,
      provider: 'resend',
      deliveryStatus: 'failed',
      errorCode: 'missing_body',
      safeError: 'Reply body was empty.',
    }
  }

  if (!input.venueId) {
    return {
      ok: false,
      provider: 'resend',
      deliveryStatus: 'failed',
      errorCode: 'missing_venue_id',
      safeError: 'Internal error — venue context missing.',
    }
  }

  const subject = safeSubject(input)
  // Tags must be string-valued (Resend constraint). We pass the
  // conversation + composer-origin tags so observability tooling
  // can split composer sends from digest sends.
  const tags: Record<string, string> = {
    surface: 'operator_composer',
    conversation_id: input.conversationId,
  }
  if (input.messageId) tags.message_id = input.messageId

  let result: SendEmailResult
  try {
    result = await sendEmail({
      to,
      subject,
      text,
      html: input.html ?? undefined,
      replyTo: input.replyTo ?? undefined,
      metadata: tags,
      venueId: input.venueId,
      leadId: input.leadId ?? null,
      relatedTable: 'messages',
      relatedId: input.messageId ?? null,
    })
  } catch (err) {
    const safe = err instanceof Error ? err.message.slice(0, 200) : 'Unknown delivery error'
    return {
      ok: false,
      provider: 'resend',
      deliveryStatus: 'failed',
      errorCode: 'provider_threw',
      safeError: safe,
    }
  }

  if (result.delivered) {
    return {
      ok: true,
      provider: 'resend',
      providerMessageId: result.messageId ?? null,
      outboundMessageId: result.outboundMessageId ?? null,
      deliveryStatus: 'sent',
    }
  }

  // Suppression and any other non-delivery surface from the platform
  // helper. Distinguish "suppressed" so the UI can show a softer
  // message ("Recipient previously opted out") rather than a generic
  // failure.
  const errStr = (result.error ?? '').toLowerCase()
  const suppressed = errStr.startsWith('suppressed:')
  return {
    ok: false,
    provider: 'resend',
    deliveryStatus: suppressed ? 'skipped' : 'failed',
    errorCode: suppressed ? 'suppressed' : 'provider_rejected',
    safeError: suppressed
      ? 'Recipient previously opted out — email not sent.'
      : (result.error ?? 'Provider rejected the message.').slice(0, 200),
    outboundMessageId: result.outboundMessageId ?? null,
  }
}
