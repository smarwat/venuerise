/**
 * Phase 8BP — Canonical email delivery status model.
 *
 * Pure module. No I/O. No React. Used by:
 *
 *   - DeliveryStatusPill (UI) to pick label + tone + helper copy
 *   - /api/resend/webhook to map provider event names onto the
 *     canonical status
 *   - /api/messages/[id]/retry-email to gate retryability
 *   - /api/messages/[id]/mark-fallback to flip to manual_fallback
 *
 * ── HONESTY CONTRACT ──────────────────────────────────────────────────────
 *   - "Accepted by Email" is what we say when the provider acknowledged
 *     the send (Resend `email.sent`). It does NOT mean the recipient's
 *     mail server delivered it to the inbox.
 *   - "Delivered" is reserved for an explicit provider delivery event
 *     (Resend `email.delivered`). When unconfirmed, we stay on
 *     "Accepted by Email".
 *   - "Bounced" / "Marked as spam" / "Email failed" are loud — they
 *     mean the operator must act. Retry only when the failure mode is
 *     transient (failed / bounced-with-confirmation), never for
 *     complaints.
 *   - "Saved in VenueRise" is the only honest claim when no provider
 *     send was attempted (kill switch off, suppression, no config).
 *   - "Manual fallback" is the only honest claim when the operator
 *     handled delivery outside VenueRise after a failure — we never
 *     pretend VenueRise delivered it.
 */

export type EmailDeliveryStatus =
  | 'pending'           // saved + attempting provider send
  | 'accepted'          // provider acknowledged the send
  | 'sent'              // alias of accepted — preserved for back-compat with 8BN
  | 'delivered'         // provider confirmed mailbox delivery
  | 'bounced'           // recipient mail server rejected
  | 'complained'        // recipient marked as spam / abuse complaint
  | 'failed'            // provider rejected or transport failed
  | 'skipped'           // not attempted (kill switch / suppression / no config)
  | 'manual_fallback'   // operator handled outside VenueRise after a failure
  | 'unknown'           // legacy or unrecognized

const KNOWN: ReadonlySet<EmailDeliveryStatus> = new Set([
  'pending',
  'accepted',
  'sent',
  'delivered',
  'bounced',
  'complained',
  'failed',
  'skipped',
  'manual_fallback',
  'unknown',
])

/**
 * Normalize whatever shape arrived (db row, provider event name,
 * legacy metadata) into a canonical status.
 *
 * Provider event aliases:
 *   - `email.sent`     → `accepted` (provider accepted; not yet delivered)
 *   - `email.delivered`→ `delivered`
 *   - `email.bounced`  → `bounced`
 *   - `email.complained` → `complained`
 *   - `email.failed`   → `failed`
 *   - `email.delivery_delayed` → `pending` (still trying)
 */
export function normalizeEmailDeliveryStatus(input: unknown): EmailDeliveryStatus {
  if (typeof input !== 'string') return 'unknown'
  const raw = input.trim().toLowerCase()
  if (!raw) return 'unknown'
  if (KNOWN.has(raw as EmailDeliveryStatus)) return raw as EmailDeliveryStatus
  // Provider event aliases.
  switch (raw) {
    case 'email.sent':
    case 'queued':
      return 'accepted'
    case 'email.delivered':
      return 'delivered'
    case 'email.bounced':
      return 'bounced'
    case 'email.complained':
      return 'complained'
    case 'email.failed':
    case 'provider_failed':
      return 'failed'
    case 'email.delivery_delayed':
      return 'pending'
    case 'suppressed':
      return 'skipped'
    default:
      return 'unknown'
  }
}

/** Maps an `outbound_messages.status` value → canonical message status. */
export function outboundRowStatusToMessageStatus(
  rowStatus: string | null | undefined
): EmailDeliveryStatus {
  if (!rowStatus) return 'unknown'
  switch (rowStatus.toLowerCase()) {
    case 'queued':
      return 'accepted'
    case 'delivered':
      return 'delivered'
    case 'bounced':
      return 'bounced'
    case 'complained':
      return 'complained'
    case 'failed':
      return 'failed'
    case 'suppressed':
      return 'skipped'
    default:
      return normalizeEmailDeliveryStatus(rowStatus)
  }
}

export type StatusTone =
  | 'neutral'
  | 'info'
  | 'success'
  | 'warning'
  | 'danger'

export interface EmailDeliveryDisplay {
  label: string
  helper: string
  tone: StatusTone
  isTerminal: boolean
  canRetry: boolean
  canMarkManual: boolean
}

/**
 * Return display props for a status. Copy lives here so the
 * webhook, retry route, pill, and any future surface (digest,
 * audit drawer, billing card) read from one source.
 *
 * `canRetry` is the conservative answer — the retry route still
 * enforces its own preconditions (configured, not suppressed,
 * has destination). UI uses this to decide visibility.
 *
 * `canMarkManual` lets the UI surface a "Mark handled manually"
 * affordance for terminal-failure states.
 */
export function getEmailDeliveryDisplay(
  status: EmailDeliveryStatus
): EmailDeliveryDisplay {
  switch (status) {
    case 'pending':
      return {
        label: 'Sending…',
        helper: 'Awaiting confirmation from the email provider.',
        tone: 'info',
        isTerminal: false,
        canRetry: false,
        canMarkManual: false,
      }
    case 'accepted':
    case 'sent':
      return {
        label: 'Accepted by Email',
        helper:
          'The email provider accepted the message. We mark Delivered only when a provider delivery event confirms it.',
        tone: 'success',
        isTerminal: false,
        canRetry: false,
        canMarkManual: false,
      }
    case 'delivered':
      return {
        label: 'Delivered',
        helper: 'Provider confirmed delivery to the recipient mail server.',
        tone: 'success',
        isTerminal: true,
        canRetry: false,
        canMarkManual: false,
      }
    case 'bounced':
      return {
        label: 'Email bounced',
        helper: 'Recipient mail server rejected the message.',
        tone: 'danger',
        isTerminal: true,
        // Bounces are only retried when the operator confirms the
        // recipient address was wrong (e.g. fix it then retry).
        // Default to true; the retry route additionally checks
        // suppression so a hard-bounced address won't actually
        // resend.
        canRetry: true,
        canMarkManual: true,
      }
    case 'complained':
      return {
        label: 'Marked as spam',
        helper: 'Recipient marked the message as spam. Do not resend.',
        tone: 'danger',
        isTerminal: true,
        canRetry: false,
        canMarkManual: true,
      }
    case 'failed':
      return {
        label: 'Email failed',
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
          'Email was not attempted (sending disabled, recipient suppressed, or missing configuration).',
        tone: 'neutral',
        isTerminal: false,
        // Becomes retryable once delivery is configured. The
        // retry route re-checks isOutboundEmailConfigured + the
        // suppression list before actually sending.
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
        helper: 'No delivery information available.',
        tone: 'neutral',
        isTerminal: false,
        canRetry: false,
        canMarkManual: false,
      }
  }
}

/**
 * If a message has been "Sending…" longer than this, surface a
 * "Status delayed" hint so the spinner doesn't run forever.
 * Resend webhooks usually fire within 30s; 5 minutes is a
 * conservative ceiling.
 */
export const STALE_PENDING_AFTER_MS = 5 * 60 * 1000

/**
 * Detect whether a pending row has been stuck long enough that
 * the UI should escalate to "Status delayed". Pure function —
 * the caller passes a Date or millis timestamp (`updated_at`,
 * `delivery_sent_at`, or fallback `created_at`).
 *
 * Returns false for any non-pending status.
 */
export function isStalePending(
  status: EmailDeliveryStatus,
  pendingSinceMs: number | null,
  nowMs: number = Date.now()
): boolean {
  if (status !== 'pending') return false
  if (pendingSinceMs == null || !Number.isFinite(pendingSinceMs)) return false
  return nowMs - pendingSinceMs > STALE_PENDING_AFTER_MS
}

/**
 * Statuses the retry route accepts (server-side gate). The UI
 * may show the button on a wider set per `canRetry`, but the
 * route always re-checks here.
 */
const RETRYABLE: ReadonlySet<EmailDeliveryStatus> = new Set([
  'failed',
  'bounced',
  'skipped',
])

export function isStatusRetryable(status: EmailDeliveryStatus): boolean {
  return RETRYABLE.has(status)
}

/**
 * Set of statuses that legitimately appear after a successful
 * provider acceptance — used by the webhook patcher to avoid
 * downgrading `delivered` back to `accepted` if events arrive
 * out of order.
 */
const TERMINAL_SUCCESS: ReadonlySet<EmailDeliveryStatus> = new Set([
  'delivered',
])

/**
 * Decide whether a new status should overwrite the current one.
 *
 *   - Always allow forward progress: pending → accepted →
 *     delivered.
 *   - Never overwrite `delivered` with `accepted` (out-of-order
 *     webhooks).
 *   - Allow terminal-failure events (bounced / complained /
 *     failed) to overwrite earlier success states — a Resend
 *     bounce arriving after the `sent` event is a real failure.
 *   - Never overwrite `manual_fallback` (operator explicitly
 *     took over) unless the new status is also `manual_fallback`.
 */
export function shouldOverwriteStatus(
  current: EmailDeliveryStatus,
  next: EmailDeliveryStatus
): boolean {
  if (current === next) return false
  if (current === 'manual_fallback' && next !== 'manual_fallback') return false
  if (TERMINAL_SUCCESS.has(current) && next === 'accepted') return false
  if (TERMINAL_SUCCESS.has(current) && next === 'sent') return false
  return true
}
