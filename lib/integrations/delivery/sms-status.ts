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
  | 'sent'            // Twilio handed off to carrier
  | 'delivered'       // carrier confirmed handset delivery (future)
  | 'undelivered'     // carrier could not deliver
  | 'failed'          // Twilio rejected or transport failed
  | 'skipped'         // not attempted (kill switch / config / consent)
  | 'manual_fallback' // operator handled outside VenueRise
  | 'unknown'

const KNOWN: ReadonlySet<SmsDeliveryStatus> = new Set([
  'pending',
  'queued',
  'accepted',
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
  switch (raw) {
    case 'sending':
      return 'queued'
    default:
      return 'unknown'
  }
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
        label: 'Accepted by SMS',
        helper:
          'The SMS provider accepted the message. Carrier delivery is not yet confirmed.',
        tone: 'success',
        isTerminal: false,
        canRetry: false,
        canMarkManual: false,
      }
    case 'sent':
      return {
        label: 'SMS sent',
        helper:
          'Provider has handed the message to the carrier. We mark Delivered only when the status callback confirms it (not wired this phase).',
        tone: 'success',
        isTerminal: false,
        canRetry: false,
        canMarkManual: false,
      }
    case 'delivered':
      return {
        label: 'Delivered',
        helper: 'Carrier confirmed delivery to the recipient handset.',
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
        canRetry: false,
        canMarkManual: true,
      }
    case 'failed':
      return {
        label: 'SMS failed',
        helper: 'Provider rejected or transport failed.',
        tone: 'danger',
        isTerminal: true,
        canRetry: false,
        canMarkManual: true,
      }
    case 'skipped':
      return {
        label: 'Saved in VenueRise',
        helper:
          'SMS was not attempted (sending disabled, missing configuration, or invalid recipient).',
        tone: 'neutral',
        isTerminal: false,
        canRetry: false,
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
