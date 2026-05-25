/**
 * Phase 8BR — Canonical SMS delivery status model.
 *
 * Parallel to `email-status.ts` (Phase 8BP). Kept as a separate
 * module rather than merged because the lifecycle semantics
 * differ (no "complained" / "bounced" for SMS; instead
 * "undelivered" with a provider error code). One dictionary,
 * shared by the operator route + DeliveryStatusPill.
 *
 * ── HONESTY CONTRACT ──────────────────────────────────────────────────────
 *   - "Accepted by SMS" / "SMS sent" are what we show when
 *     Twilio returned a 2xx + Message SID. They do NOT mean
 *     the carrier delivered the message to the handset.
 *   - "Delivered" is reserved for a future Twilio status
 *     callback that confirms carrier delivery. Until that
 *     callback ships (separate phase), this status will not
 *     appear in production.
 *   - "Undelivered" is the SMS-equivalent of email's "bounced"
 *     — the carrier accepted the message from Twilio but
 *     couldn't get it to the recipient. Requires the status
 *     callback to detect.
 *   - "Saved in VenueRise" is the only honest claim when no
 *     provider send was attempted.
 *   - "Manual fallback" — the operator handled the reply
 *     outside VenueRise after a delivery issue. We never
 *     pretend VenueRise delivered it.
 */

export type SmsDeliveryStatus =
  | 'pending'         // saved + attempting provider send
  | 'queued'          // Twilio accepted (waiting to send)
  | 'accepted'        // Twilio accepted (synonym; some API responses use this)
  | 'sending'         // Phase 8BU — Twilio's "sending" transient state
  | 'sent'            // Twilio handed off to carrier
  | 'delivered'       // carrier confirmed handset delivery
  | 'undelivered'     // carrier could not deliver
  | 'failed'          // Twilio rejected or transport failed
  | 'skipped'         // not attempted (kill switch / config / consent)
  | 'manual_fallback' // operator handled outside VenueRise
  | 'unknown'

const KNOWN: ReadonlySet<SmsDeliveryStatus> = new Set([
  'pending',
  'queued',
  'accepted',
  'sending',
  'sent',
  'delivered',
  'undelivered',
  'failed',
  'skipped',
  'manual_fallback',
  'unknown',
])

export function normalizeSmsDeliveryStatus(input: unknown): SmsDeliveryStatus {
  if (typeof input !== 'string') return 'unknown'
  const raw = input.trim().toLowerCase()
  if (!raw) return 'unknown'
  if (KNOWN.has(raw as SmsDeliveryStatus)) return raw as SmsDeliveryStatus
  // Twilio raw event aliases.
  switch (raw) {
    case 'receiving':
    case 'received':
      // Inbound-side Twilio statuses; ignored for outbound callback.
      return 'unknown'
    default:
      return 'unknown'
  }
}

/**
 * Phase 8BU — Map a raw Twilio `MessageStatus` / `SmsStatus` field
 * onto our canonical SmsDeliveryStatus. Defensive: Twilio
 * occasionally returns `Sent` with a capital S; we lowercase
 * first.
 */
export function normalizeTwilioRawStatus(raw: string | null | undefined): SmsDeliveryStatus {
  if (!raw) return 'unknown'
  return normalizeSmsDeliveryStatus(raw)
}

/**
 * Phase 8BU — out-of-order webhook protection. Mirrors the email
 * equivalent (`shouldOverwriteStatus` in email-status.ts).
 *
 * Twilio callbacks can arrive out of order — a late `sent`
 * event after we've already received `delivered` must NOT
 * downgrade the bubble. Failure events (`failed`/`undelivered`)
 * are honored even when arriving after success states because
 * they reflect real carrier outcomes.
 */
const SMS_TERMINAL_SUCCESS: ReadonlySet<SmsDeliveryStatus> = new Set([
  'delivered',
])
const SMS_TERMINAL_FAILURE: ReadonlySet<SmsDeliveryStatus> = new Set([
  'failed',
  'undelivered',
])
const SMS_PRE_SENT: ReadonlySet<SmsDeliveryStatus> = new Set([
  'pending',
  'queued',
  'accepted',
  'sending',
])

/**
 * Phase 8BU — Statuses the SMS retry route accepts. UI may
 * surface the button on a wider set per `canRetry`, but the
 * route re-checks here.
 */
const SMS_RETRYABLE: ReadonlySet<SmsDeliveryStatus> = new Set([
  'failed',
  'undelivered',
  'skipped',
])

export function isSmsStatusRetryable(status: SmsDeliveryStatus): boolean {
  return SMS_RETRYABLE.has(status)
}

export function shouldOverwriteSmsStatus(
  current: SmsDeliveryStatus,
  next: SmsDeliveryStatus
): boolean {
  if (current === next) return false
  // Never overwrite operator-marked manual fallback.
  if (current === 'manual_fallback' && next !== 'manual_fallback') return false
  // Don't accept `unknown` over any concrete state.
  if (next === 'unknown') return false
  // Terminal success (delivered) cannot be downgraded to earlier
  // pre-sent or `sent` states. A subsequent `undelivered`/`failed`
  // IS allowed — carriers can rescind delivery on rare bounces.
  if (SMS_TERMINAL_SUCCESS.has(current)) {
    if (SMS_PRE_SENT.has(next) || next === 'sent') return false
  }
  // Terminal failure cannot be downgraded to pre-sent. A late
  // `delivered` after `failed` is suspicious but Twilio doesn't
  // emit that ordering — we let it through if it ever happens.
  if (SMS_TERMINAL_FAILURE.has(current) && SMS_PRE_SENT.has(next)) {
    return false
  }
  // `sent` cannot be downgraded to pre-sent.
  if (current === 'sent' && SMS_PRE_SENT.has(next)) return false
  return true
}

export type StatusTone =
  | 'neutral'
  | 'info'
  | 'success'
  | 'warning'
  | 'danger'

export interface SmsDeliveryDisplay {
  label: string
  helper: string
  tone: StatusTone
  isTerminal: boolean
  /** Retry support is deferred to a later SMS polish phase. */
  canRetry: boolean
  canMarkManual: boolean
}

export function getSmsDeliveryDisplay(
  status: SmsDeliveryStatus
): SmsDeliveryDisplay {
  switch (status) {
    case 'pending':
      return {
        label: 'Sending…',
        helper: 'Awaiting confirmation from the SMS provider.',
        tone: 'info',
        isTerminal: false,
        canRetry: false,
        canMarkManual: false,
      }
    case 'queued':
    case 'accepted':
      return {
        // Phase 8BW — copy polish. Spec preferred phrasing.
        label: 'Accepted by SMS',
        helper:
          'Twilio accepted this text for delivery. This does not mean the lead read it.',
        tone: 'success',
        isTerminal: false,
        canRetry: false,
        canMarkManual: false,
      }
    case 'sending':
      return {
        label: 'Sending SMS',
        helper: 'Twilio is dispatching this message to the carrier.',
        tone: 'info',
        isTerminal: false,
        canRetry: false,
        canMarkManual: false,
      }
    case 'sent':
      return {
        label: 'SMS sent',
        helper:
          'Twilio sent this text to the carrier. Delivery has not been confirmed yet.',
        tone: 'success',
        isTerminal: false,
        canRetry: false,
        canMarkManual: false,
      }
    case 'delivered':
      return {
        label: 'SMS delivered',
        helper:
          'Twilio received carrier confirmation that the handset received the message.',
        tone: 'success',
        isTerminal: true,
        canRetry: false,
        canMarkManual: false,
      }
    case 'undelivered':
      return {
        label: 'SMS undelivered',
        helper: 'Carrier could not deliver this message.',
        tone: 'danger',
        isTerminal: true,
        // Phase 8BU — retry available; route still re-checks
        // suppression + recipient validity before sending.
        canRetry: true,
        canMarkManual: true,
      }
    case 'failed':
      return {
        label: 'SMS failed',
        helper: 'Provider rejected or transport failed.',
        tone: 'danger',
        isTerminal: true,
        canRetry: true,
        canMarkManual: true,
      }
    case 'skipped':
      return {
        label: 'Saved in VenueRise',
        helper:
          'SMS was not attempted (sending disabled, missing configuration, or invalid recipient).',
        tone: 'neutral',
        isTerminal: false,
        // Retryable once SMS delivery is configured. The retry
        // route re-verifies isOutboundSmsConfigured + a clean
        // destination before sending.
        canRetry: true,
        canMarkManual: true,
      }
    case 'manual_fallback':
      return {
        label: 'Manual fallback',
        helper:
          'Operator handled this reply outside VenueRise after a delivery issue.',
        tone: 'warning',
        isTerminal: true,
        canRetry: false,
        canMarkManual: false,
      }
    case 'unknown':
    default:
      return {
        label: 'Saved in VenueRise',
        helper: 'No SMS delivery information available.',
        tone: 'neutral',
        isTerminal: false,
        canRetry: false,
        canMarkManual: false,
      }
  }
}
