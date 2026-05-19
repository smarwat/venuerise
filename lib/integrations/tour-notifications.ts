import 'server-only'
import { sendEmail } from '@/lib/integrations/email'
import {
  buildTourActionUrl,
  tourActionSecretConfigured,
  TourActionTokenError,
} from '@/lib/integrations/tour-action-token'
import { log, type Logger } from '@/lib/log'
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
  // Phase 8J — the 15-min reminder cron also routes through this helper
  // so the lead-facing visual identity stays consistent across the full
  // tour comms surface (create → confirm → reminder → cancel/reschedule).
  | 'reminder_24h'
  | 'reminder_2h'

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
  /**
   * Phase 8J — optional venue display name. Reminder bodies surface this
   * so the lead instantly recognizes which venue is calling. The four
   * non-reminder kinds work fine without it (the email comes from the
   * venue's domain anyway).
   */
  venueName?: string | null
  /**
   * Phase 8K — optional signed action URLs. When present (caller has
   * `TOUR_ACTION_SECRET` configured), the body builder appends "Confirm
   * your tour" / "Need to cancel?" lines to the four lead-action-relevant
   * kinds: `created`, `rescheduled`, `reminder_24h`, `reminder_2h`. The
   * `confirmed` and `cancelled` notifications never include links —
   * either action is a no-op after the email is sent.
   */
  confirmUrl?: string | null
  cancelUrl?: string | null
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

/**
 * Phase 8J — exported as a pure function so the tour-reminders cron can
 * build the same body shape WITHOUT going through `sendTourNotificationEmail`
 * (which has its own ai_actions / flag-flip needs the cron handles
 * separately). The four lifecycle kinds (create/confirm/reschedule/cancel)
 * still route through the helper; the cron uses this directly because it
 * needs to branch on suppression / console-fallback / provider-error
 * separately from the helper's swallow-and-go semantics.
 */
/**
 * Phase 8K — kinds that can carry signed confirm/cancel action links.
 * `confirmed` and `cancelled` are excluded because the action would be a
 * no-op or a contradiction at that point in the lifecycle.
 */
const ACTION_LINK_KINDS: ReadonlySet<TourNotificationKind> = new Set([
  'created',
  'rescheduled',
  'reminder_24h',
  'reminder_2h',
])

function buildActionBlock(
  kind: TourNotificationKind,
  confirmUrl: string | null | undefined,
  cancelUrl: string | null | undefined
): string {
  if (!ACTION_LINK_KINDS.has(kind)) return ''
  const lines: string[] = []
  if (confirmUrl) lines.push(`Confirm your tour: ${confirmUrl}`)
  if (cancelUrl) lines.push(`Need to cancel? ${cancelUrl}`)
  if (lines.length === 0) return ''
  return `\n${lines.join('\n')}\n`
}

export function buildTourNotificationBody(args: TourNotificationArgs): SubjectAndBody {
  const greeting = `Hi ${args.leadName?.trim() || 'there'},`
  const when = formatScheduledAt(args.scheduledAt)
  const durationLine = args.durationMinutes
    ? `Duration: ${args.durationMinutes} minutes\n`
    : ''
  const locationLine = args.locationNotes
    ? `Location notes: ${args.locationNotes}\n`
    : ''
  const venueLine = args.venueName?.trim()
    ? `Venue: ${args.venueName.trim()}\n`
    : ''
  const sign = `If anything changed on your side, just reply to this email and our team will help.`
  const actionBlock = buildActionBlock(args.kind, args.confirmUrl, args.cancelUrl)

  switch (args.kind) {
    case 'created':
      return {
        subject: 'Your venue tour is scheduled',
        text:
          `${greeting}\n\n` +
          `Your venue tour is on the calendar.\n\n` +
          venueLine +
          `When: ${when}\n` +
          durationLine +
          locationLine +
          actionBlock +
          `\nWe'll send a reminder closer to the date.\n\n${sign}`,
      }
    case 'rescheduled':
      return {
        subject: 'Your venue tour has been updated',
        text:
          `${greeting}\n\n` +
          `We've updated the details for your venue tour.\n\n` +
          venueLine +
          `New time: ${when}\n` +
          durationLine +
          locationLine +
          actionBlock +
          `\n${sign}`,
      }
    case 'confirmed':
      return {
        subject: 'Your venue tour is confirmed',
        text:
          `${greeting}\n\n` +
          `Just confirming — we're all set for your venue tour.\n\n` +
          venueLine +
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
          venueLine +
          `We're sorry for the inconvenience. Reply to this email and we'll help find a new time that works.`,
      }
    case 'reminder_24h':
      return {
        subject: args.venueName?.trim()
          ? `Tomorrow: your tour at ${args.venueName.trim()}`
          : 'Tomorrow: your venue tour',
        text:
          `${greeting}\n\n` +
          `Quick reminder — your venue tour is tomorrow.\n\n` +
          venueLine +
          `When: ${when}\n` +
          durationLine +
          locationLine +
          actionBlock +
          `\nLooking forward to showing you around. ${sign}`,
      }
    case 'reminder_2h':
      return {
        subject: args.venueName?.trim()
          ? `In 2 hours: your tour at ${args.venueName.trim()}`
          : 'In 2 hours: your venue tour',
        text:
          `${greeting}\n\n` +
          `Heads up — your venue tour starts in about 2 hours.\n\n` +
          venueLine +
          `When: ${when}\n` +
          durationLine +
          locationLine +
          actionBlock +
          `\nSee you soon! ${sign}`,
      }
  }
}

// Backward-compatible alias for the in-file caller.
const buildBody = buildTourNotificationBody

// ============================================================================
// Phase 8L — HTML template
// ============================================================================

/**
 * Phase 8L — produces a polished, inline-styled HTML body for a tour
 * notification email. The plaintext `buildTourNotificationBody` output
 * remains the canonical fallback; this builder runs alongside it so
 * Resend ships a multipart/alternative with both.
 *
 * Design constraints (per the Phase 8L spec):
 *   - Clean white card on a light-slate background
 *   - Brand blue (#1D4ED8) primary CTA, muted slate secondary
 *   - Mobile-safe width (max-width: 480px)
 *   - Inline CSS only (no <style> blocks at the top — some clients strip them)
 *   - Zero external assets (no images, no web fonts, no tracking pixels)
 *
 * Outlook compatibility: we use table-based layout for the outer
 * scaffold + the CTA button. The system font stack reads well in
 * Outlook, Gmail, Apple Mail, and the major mobile clients without
 * needing web-font fallbacks.
 *
 * The two action kinds (`confirmed`, `cancelled`) intentionally omit
 * the Confirm/Cancel buttons — clicking either action on a tour that's
 * already in that state would be a no-op or a contradiction.
 */
export function buildTourNotificationHtml(args: TourNotificationArgs): string {
  const greetingName = args.leadName?.trim() || 'there'
  const when = formatScheduledAt(args.scheduledAt)
  const venueName = args.venueName?.trim() || null
  const showActions =
    ACTION_LINK_KINDS.has(args.kind) &&
    (Boolean(args.confirmUrl) || Boolean(args.cancelUrl))

  const { headline, lede } = htmlHeadlineCopy(args.kind, venueName)

  // Detail rows. Each one is a small two-column block: label on the
  // left (muted), value on the right (slate-900). We only emit rows we
  // have data for so the email doesn't show empty labels.
  const detailRows: string[] = []
  if (venueName) {
    detailRows.push(htmlDetailRow('Venue', venueName))
  }
  detailRows.push(htmlDetailRow(args.kind === 'rescheduled' ? 'New time' : 'When', when))
  if (args.durationMinutes) {
    detailRows.push(htmlDetailRow('Duration', `${args.durationMinutes} minutes`))
  }
  if (args.locationNotes) {
    detailRows.push(htmlDetailRow('Location notes', args.locationNotes))
  }

  const actionsBlock = showActions
    ? htmlActionButtons(args.confirmUrl ?? null, args.cancelUrl ?? null)
    : ''

  // Sign-off — neutral across kinds, just an invitation to reply.
  const signOff =
    args.kind === 'cancelled'
      ? "We're sorry for the inconvenience. Reply to this email and our team will help you find a new time."
      : 'If anything changed on your side, just reply to this email and our team will help.'

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(headline)}</title>
</head>
<body style="margin:0;padding:0;background:#F4F6FB;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#0F172A;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F4F6FB;padding:32px 16px;">
  <tr>
    <td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#FFFFFF;border:1px solid #E2E8F0;border-radius:20px;box-shadow:0 4px 14px rgba(15,23,42,0.06);">
        <tr>
          <td style="padding:28px 28px 8px 28px;">
            <p style="margin:0 0 4px 0;font-size:13px;color:#64748B;">Hi ${escapeHtml(greetingName)},</p>
            <h1 style="margin:0 0 12px 0;font-size:20px;line-height:1.3;font-weight:600;color:#0F172A;">${escapeHtml(headline)}</h1>
            <p style="margin:0 0 20px 0;font-size:14px;line-height:1.55;color:#475569;">${escapeHtml(lede)}</p>
          </td>
        </tr>
        <tr>
          <td style="padding:0 28px 8px 28px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F8FAFC;border:1px solid #E2E8F0;border-radius:14px;">
              ${detailRows.join('')}
            </table>
          </td>
        </tr>
        ${actionsBlock}
        <tr>
          <td style="padding:8px 28px 28px 28px;">
            <p style="margin:0;font-size:13px;line-height:1.55;color:#64748B;">${escapeHtml(signOff)}</p>
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`
}

function htmlHeadlineCopy(
  kind: TourNotificationKind,
  venueName: string | null
): { headline: string; lede: string } {
  switch (kind) {
    case 'created':
      return {
        headline: 'Your venue tour is scheduled.',
        lede: "Here are the details. We'll send a reminder closer to the date.",
      }
    case 'rescheduled':
      return {
        headline: 'Your venue tour has been updated.',
        lede: "We've changed the time for your tour — the latest details are below.",
      }
    case 'confirmed':
      return {
        headline: 'Your venue tour is confirmed.',
        lede: "We're all set. Looking forward to seeing you.",
      }
    case 'cancelled':
      return {
        headline: 'Your venue tour was cancelled.',
        lede: "We had to cancel — details below for your records.",
      }
    case 'reminder_24h':
      return {
        headline: venueName ? `Tomorrow: your tour at ${venueName}.` : 'Tomorrow: your venue tour.',
        lede: 'Quick reminder — your venue tour is tomorrow.',
      }
    case 'reminder_2h':
      return {
        headline: venueName ? `In 2 hours: your tour at ${venueName}.` : 'In 2 hours: your venue tour.',
        lede: 'Heads up — your venue tour starts in about 2 hours.',
      }
  }
}

function htmlDetailRow(label: string, value: string): string {
  // Each row is its own <tr> so Outlook on Windows doesn't collapse them.
  return `<tr>
  <td style="padding:10px 16px;border-bottom:1px solid #E2E8F0;font-size:12px;color:#64748B;width:38%;">${escapeHtml(label)}</td>
  <td style="padding:10px 16px;border-bottom:1px solid #E2E8F0;font-size:13px;color:#0F172A;font-weight:500;">${escapeHtml(value)}</td>
</tr>`
}

function htmlActionButtons(
  confirmUrl: string | null,
  cancelUrl: string | null
): string {
  // Render a buttons table even if only one URL is present (defensive —
  // the helper currently always supplies both, but the function shouldn't
  // assume it). Primary CTA gets the brand blue treatment; secondary
  // (cancel) is a muted slate text link, not a button, to set visual
  // hierarchy clearly.
  const confirmButton = confirmUrl
    ? `<a href="${escapeHtml(confirmUrl)}" style="display:inline-block;background:#1D4ED8;color:#FFFFFF;text-decoration:none;font-size:14px;font-weight:600;padding:12px 22px;border-radius:10px;box-shadow:0 2px 6px rgba(29,78,216,0.25);">Confirm tour</a>`
    : ''
  const cancelLink = cancelUrl
    ? `<a href="${escapeHtml(cancelUrl)}" style="display:inline-block;color:#64748B;text-decoration:underline;font-size:13px;padding:12px 6px;">Need to cancel?</a>`
    : ''
  return `<tr>
  <td style="padding:20px 28px 8px 28px;text-align:center;">
    ${confirmButton}
    ${cancelLink ? `<div style="margin-top:8px;">${cancelLink}</div>` : ''}
  </td>
</tr>`
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
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
// Phase 8K — module-level guard so the "TOUR_ACTION_SECRET missing" warn
// fires at most once per process. We deliberately don't gate on
// per-request to keep the signal-to-noise high; an operator who hasn't
// set the secret needs one bright log line, not 50 per cron run.
let _missingSecretWarned = false

/**
 * Phase 8K — best-effort signed action URL builder.
 *
 * Returns a `{ confirm, cancel }` pair when `TOUR_ACTION_SECRET` is
 * configured. Returns `null` when the secret is missing or any other
 * unexpected error occurs — callers fall through to a link-less email.
 *
 * The first time we hit "secret missing" in a process, we emit a single
 * structured warn so operators see the misconfiguration without log
 * spam. Subsequent calls skip the warn.
 */
export function tryBuildTourActionUrls(
  tourId: string,
  childLog: Logger
): { confirm: string; cancel: string } | null {
  if (!tourActionSecretConfigured()) {
    if (!_missingSecretWarned) {
      _missingSecretWarned = true
      childLog.warn(
        { op: 'tour.notification.no_action_secret' },
        'tour.notification.no_action_secret'
      )
    }
    return null
  }
  try {
    return {
      confirm: buildTourActionUrl({ tourId, action: 'confirm' }),
      cancel: buildTourActionUrl({ tourId, action: 'cancel' }),
    }
  } catch (err) {
    // Defense in depth — buildTourActionUrl can only throw secret_missing
    // (already handled above) or invalid_payload (bad tourId). Either way
    // we fall through to a link-less email.
    if (err instanceof TourActionTokenError) {
      childLog.warn(
        { code: err.code },
        'tour.notification.action_url_build_failed'
      )
    } else {
      childLog.warn({ err }, 'tour.notification.action_url_build_failed')
    }
    return null
  }
}

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

  // Phase 8K — build signed action URLs for kinds that carry them, unless
  // the caller already provided them. The four eligible kinds (created,
  // rescheduled, reminder_24h, reminder_2h) get { confirm, cancel } URLs
  // when the secret is configured; the other two (confirmed, cancelled)
  // never include action links — buildActionBlock filters them out.
  let confirmUrl = args.confirmUrl ?? null
  let cancelUrl = args.cancelUrl ?? null
  if (
    ACTION_LINK_KINDS.has(args.kind) &&
    confirmUrl === null &&
    cancelUrl === null
  ) {
    const urls = tryBuildTourActionUrls(args.tourId, reqLog)
    if (urls) {
      confirmUrl = urls.confirm
      cancelUrl = urls.cancel
    }
  }

  const enrichedArgs = { ...args, confirmUrl, cancelUrl }
  const { subject, text } = buildBody(enrichedArgs)
  // Phase 8L — also build the HTML body. Both shapes ship as
  // multipart/alternative; clients that don't render HTML still see the
  // plaintext exactly as before.
  const html = buildTourNotificationHtml(enrichedArgs)

  let result
  try {
    result = await sendEmail({
      to: args.leadEmail,
      subject,
      text,
      html,
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

// ---------------------------------------------------------------------------
// Phase 8H — bounded concurrency helper
// ---------------------------------------------------------------------------

/**
 * Phase 8H — minimal bounded-concurrency runner.
 *
 * Used by `POST /api/admin/tours/bulk-cancel` to fan out lead-facing
 * cancellation emails without:
 *   - blowing past Resend's rate limits (Promise.all over 100 rows would
 *     spike), or
 *   - blocking the API response on serial sends.
 *
 * Semantics:
 *   - Returns AFTER all items have settled (success or failure), in the
 *     SAME order as `items` so callers can correlate results 1:1.
 *   - Never throws — failures are encoded as `{ ok: false, error }` in
 *     the result tuple so the caller's summary logic stays declarative.
 *   - `limit` is clamped to `[1, items.length]` so dumb callers can't
 *     accidentally pass 0 (no progress) or negative.
 *
 * Why not a library? The whole thing is ~25 lines and the alternative
 * (`p-limit`, `p-map`, `bottleneck`) adds dependency surface for a single
 * call site. If a third call site shows up, refactor to a shared util.
 */

export type SettledOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; error: unknown }

export async function runWithConcurrency<I, T>(
  items: readonly I[],
  limit: number,
  fn: (item: I, index: number) => Promise<T>
): Promise<Array<SettledOutcome<T>>> {
  const results: Array<SettledOutcome<T>> = new Array(items.length)
  if (items.length === 0) return results
  const cappedLimit = Math.max(1, Math.min(limit, items.length))

  let cursor = 0
  async function worker(): Promise<void> {
    while (true) {
      const idx = cursor++
      if (idx >= items.length) return
      try {
        const value = await fn(items[idx], idx)
        results[idx] = { ok: true, value }
      } catch (error) {
        results[idx] = { ok: false, error }
      }
    }
  }

  const workers = Array.from({ length: cappedLimit }, () => worker())
  await Promise.all(workers)
  return results
}
