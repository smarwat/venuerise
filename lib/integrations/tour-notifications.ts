import 'server-only'
import { sendEmail } from '@/lib/integrations/email'
import { log } from '@/lib/log'
import { captureApiError } from '@/lib/observability/sentry'

/**
 * Phase 8G — lead-facing tour status notifications.
 *
 * Reused by `POST /api/tours` (create) and `PATCH /api/tours/[id]`
 * (reschedule / confirm / cancel) to drop a plain-text email to the
 * lead whenever a tour event happens.
 *
 * ── DESIGN ─────────────────────────────────────────────────────────────────
 * Best-effort. Never throws. The tour write succeeds whether or not the
 * email goes out — operators won't tolerate a Resend hiccup blocking
 * lead-facing scheduling. Failures (provider error, send threw,
 * suppression) are logged + Sentry-captured but swallowed from the
 * caller's perspective. Suppression handling rides on the existing
 * `sendEmail` logic so an unsubscribed lead doesn't get re-spammed.
 *
 * ── KIND DETECTION ────────────────────────────────────────────────────────
 * The two routes call this with different signals (POST always = created,
 * PATCH inspects status transitions). Rather than re-deriving the kind
 * here, callers pass it in explicitly. That keeps the helper testable in
 * isolation and avoids tangling tour business logic with the email layer.
 *
 * ── PII POSTURE ───────────────────────────────────────────────────────────
 * Log lines include `tourId`, `leadId`, `venueId`, `kind`, and the email
 * provider outcome but never the lead's email address — `sendEmail`'s
 * own redaction handles delivery-level observability.
 */

export type TourNotificationKind =
  | 'created'
  | 'rescheduled'
  | 'confirmed'
  | 'cancelled'

export interface TourNotificationArgs {
  kind: TourNotificationKind
  tourId: string
  venueId: string
  leadId: string
  /** Lead's email. If null/empty we skip — no logging spam, no failure. */
  leadEmail: string | null
  /** Lead's name for the email greeting. Falls back to "there" when missing. */
  leadName: string | null
  /** Tour scheduled_at as ISO string. */
  scheduledAt: string
  durationMinutes: number | null
  locationNotes: string | null
  requestId?: string
}

interface SubjectAndBody {
  subject: string
  text: string
}

function formatScheduledAt(iso: string): string {
  // Locale-free format so it's deterministic across server timezones and
  // easy to read in any inbox. Example: "Tue, 12 Aug 2026 · 14:30 UTC".
  try {
    const d = new Date(iso)
    const dateStr = d.toUTCString().replace(/ GMT$/, ' UTC')
    return dateStr
  } catch {
    return iso
  }
}

function buildBody(args: TourNotificationArgs): SubjectAndBody {
  const greeting = `Hi ${args.leadName?.trim() || 'there'},`
  const when = formatScheduledAt(args.scheduledAt)
  const durationLine = args.durationMinutes
    ? `Duration: ${args.durationMinutes} minutes\n`
    : ''
  const locationLine = args.locationNotes
    ? `Location notes: ${args.locationNotes}\n`
    : ''
  const sign = `If you need to change anything, just reply to this email and our team will help.`

  switch (args.kind) {
    case 'created':
      return {
        subject: 'Your venue tour is scheduled',
        text:
          `${greeting}\n\n` +
          `Your venue tour is on the calendar.\n\n` +
          `When: ${when}\n` +
          durationLine +
          locationLine +
          `\nWe'll send a reminder closer to the date.\n\n${sign}`,
      }
    case 'rescheduled':
      return {
        subject: 'Your venue tour has been updated',
        text:
          `${greeting}\n\n` +
          `We've updated the details for your venue tour.\n\n` +
          `New time: ${when}\n` +
          durationLine +
          locationLine +
          `\n${sign}`,
      }
    case 'confirmed':
      return {
        subject: 'Your venue tour is confirmed',
        text:
          `${greeting}\n\n` +
          `Just confirming — we're all set for your venue tour.\n\n` +
          `When: ${when}\n` +
          durationLine +
          locationLine +
          `\nLooking forward to seeing you. ${sign}`,
      }
    case 'cancelled':
      return {
        subject: 'Your venue tour was cancelled',
        text:
          `${greeting}\n\n` +
          `We had to cancel your venue tour originally scheduled for ${when}.\n\n` +
          `We're sorry for the inconvenience. Reply to this email and we'll help find a new time that works.`,
      }
  }
}

/**
 * Send the notification. Returns a small outcome object for the caller
 * to include in its structured logs, but failure does NOT propagate —
 * the calling route handler should NOT await + branch on the result.
 *
 * Fire-and-forget pattern in the caller:
 *
 *   sendTourNotificationEmail({ ... }).catch(() => {})
 *
 * The `.catch(() => {})` is defense in depth — this function already
 * swallows internally, but a forgotten await would otherwise unhandled-
 * reject. Net behavior: the tour API response is never blocked by email.
 */
export async function sendTourNotificationEmail(
  args: TourNotificationArgs
): Promise<{ sent: boolean; skipped: boolean; reason?: string }> {
  const reqLog = log.child({
    requestId: args.requestId,
    venueId: args.venueId,
    leadId: args.leadId,
    tourId: args.tourId,
    kind: args.kind,
    op: 'tour.notification',
  })

  // 1. Skip silently when we have nowhere to send. We don't log a warn
  // — leads created via the widget always have an email, but legacy /
  // manually-created leads sometimes don't, and that's expected.
  if (!args.leadEmail || args.leadEmail.trim().length === 0) {
    return { sent: false, skipped: true, reason: 'no_lead_email' }
  }

  const { subject, text } = buildBody(args)

  let result
  try {
    result = await sendEmail({
      to: args.leadEmail,
      subject,
      text,
      venueId: args.venueId,
      leadId: args.leadId,
      relatedTable: 'tours',
      relatedId: args.tourId,
      metadata: { tour_notification_kind: args.kind },
    })
  } catch (err) {
    reqLog.error({ err }, 'tour.notification.send_threw')
    captureApiError(err, {
      requestId: args.requestId,
      route: 'tour.sendTourNotificationEmail',
      venueId: args.venueId,
      leadId: args.leadId,
    })
    return { sent: false, skipped: false, reason: 'send_threw' }
  }

  if (!result.delivered) {
    reqLog.warn(
      { provider: result.provider, errorMessage: result.error },
      result.error
        ? 'tour.notification.send_failed'
        : 'tour.notification.console_fallback'
    )
    if (result.error) {
      // Note: suppression / opt-out is included here as `suppressed:<reason>`
      // — sendEmail handles the surface. We don't Sentry-capture that
      // case; it's an expected outcome, not a fault.
      if (!result.error.startsWith('suppressed:')) {
        captureApiError(new Error(result.error), {
          requestId: args.requestId,
          route: 'tour.sendTourNotificationEmail',
          venueId: args.venueId,
          leadId: args.leadId,
        })
      }
    }
    return { sent: false, skipped: false, reason: result.error ?? 'not_delivered' }
  }

  reqLog.info(
    { provider: result.provider, messageId: result.messageId },
    'tour.notification.sent'
  )
  return { sent: true, skipped: false }
}
