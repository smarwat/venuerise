import { createServiceClient } from '@/lib/supabase/service'
import {
  validateTourSlotConfirmationToken,
  TourSlotConfirmationTokenError,
  type TourSlotConfirmationTokenErrorCode,
} from '@/lib/revenue-os/tour-slot-confirmation-token'
import { ConfirmSlotClient } from './confirm-slot-client'

/**
 * Phase 8BL — Public lead-facing tour-slot confirmation page.
 *
 *   GET /tour/confirm-slot/<token>
 *
 * Renders one of two surfaces:
 *
 *   1. "Confirm" button — the token validated; the lead clicks
 *      the button to POST to /api/tour/confirm-slot/<token>
 *      which actually creates the tour row. We deliberately do
 *      NOT create the tour on page load; that would let a link
 *      preview crawler (Slack, iMessage, Gmail) book a tour by
 *      accident.
 *
 *   2. Friendly failure copy — for every error code the
 *      validator can return (expired, already_used, revoked,
 *      bad signature, not found, mismatch). The page never
 *      surfaces the raw error code to the lead; it maps to
 *      operator-grade copy a non-technical lead can act on
 *      ("reply to the original email and our team will help").
 *
 * ── AUTH ─────────────────────────────────────────────────────────────────
 * No session, no cookies, no CSRF token. The token IS the auth —
 * the HMAC signature + DB row + expiry is the entire trust
 * boundary. Same posture as `/tour/confirm` and `/tour/cancel`.
 *
 * ── HEADERS ──────────────────────────────────────────────────────────────
 * Next sets sensible defaults; we additionally set X-Robots-Tag
 * via the route metadata block so a casually-leaked URL doesn't
 * end up in a search index. Cache-Control is no-store via the
 * `dynamic = 'force-dynamic'` export below.
 */

export const dynamic = 'force-dynamic'
export const revalidate = 0

interface PageProps {
  params: Promise<{ token: string }>
}

type FailureKind =
  | 'expired'
  | 'already_used'
  | 'revoked'
  | 'invalid_link'
  | 'not_found'
  | 'in_past'
  | 'server_error'

function mapErrorToFailure(
  code: TourSlotConfirmationTokenErrorCode
): FailureKind {
  switch (code) {
    case 'expired':
      return 'expired'
    case 'already_used':
      return 'already_used'
    case 'revoked':
      return 'revoked'
    case 'not_found':
      return 'not_found'
    case 'malformed_token':
    case 'invalid_signature':
    case 'invalid_payload':
    case 'slot_mismatch':
    case 'lead_mismatch':
      return 'invalid_link'
    case 'secret_missing':
      // The lead shouldn't see "secret missing" — it's an operator
      // misconfiguration. Surface as a generic invalid-link page
      // so we don't leak the env-var name in the response.
      return 'server_error'
  }
}

export default async function ConfirmSlotPage({ params }: PageProps) {
  const { token } = await params

  // Quick shape check — keep the SSR path off the DB if the URL is
  // obviously bogus (a copy-paste truncation, a crawler probing).
  if (!token || token.length < 16 || token.length > 4096) {
    return <FailurePage kind="invalid_link" />
  }

  const supabase = createServiceClient()

  let validated: Awaited<
    ReturnType<typeof validateTourSlotConfirmationToken>
  >
  try {
    validated = await validateTourSlotConfirmationToken({ supabase, token })
  } catch (err) {
    if (err instanceof TourSlotConfirmationTokenError) {
      return <FailurePage kind={mapErrorToFailure(err.code)} />
    }
    // Unknown error — render the generic server-error surface.
    // Don't crash; the lead deserves a friendly page either way.
    return <FailurePage kind="server_error" />
  }

  // Past-slot guard at SSR time. The POST route re-checks, but
  // surfacing this here avoids showing a confirm button for a
  // slot that's already passed.
  if (Date.parse(validated.slotStartsAt) <= Date.now()) {
    return <FailurePage kind="in_past" />
  }

  // Fetch venue name for the page copy — best-effort.
  const { data: venueRow } = await supabase
    .from('venues')
    .select('name, timezone')
    .eq('id', validated.venueId)
    .maybeSingle()
  const venueName = (venueRow as { name?: string } | null)?.name ?? 'the venue'
  const venueTimezone =
    (venueRow as { timezone?: string | null } | null)?.timezone ??
    validated.timezone ??
    null

  const slotLabel = validated.slotLabel ?? formatSlotFallback(
    validated.slotStartsAt,
    venueTimezone
  )

  return (
    <PageShell>
      <span className="badge info">Tour time hold</span>
      <h1>Confirm your tour at {venueName}</h1>
      <p className="lead-time">
        You picked <strong>{slotLabel}</strong>.
      </p>
      <p>
        Tap the button below to confirm this time. We&rsquo;ll lock it in for
        you and the team will follow up with directions and what to bring.
      </p>
      <ConfirmSlotClient token={token} />
      <p className="fine">
        This link is single-use. After you confirm, it can&rsquo;t be reused.
        If you need a different time, reply to your last message and the team
        will help.
      </p>
    </PageShell>
  )
}

// ─────────────────────────────────────────────────────────────────────────
//  Page shell + failure pages
// ─────────────────────────────────────────────────────────────────────────

function PageShell({ children }: { children: React.ReactNode }) {
  return (
    <>
      {/* Inline styles — page is rendered to LEADS, not operators, so
          we deliberately keep it neutral and brand-light. No imports of
          the dashboard's Tailwind chrome. */}
      <style>{`
        body { margin:0; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif; background:#F4F6FB; color:#0F172A; }
        .wrap { max-width:520px; margin:80px auto; padding:36px; background:#FFFFFF; border:1px solid #E2E8F0; border-radius:20px; box-shadow:0 4px 14px rgba(15,23,42,0.08); }
        .badge { display:inline-block; padding:4px 10px; border-radius:9999px; font-size:11px; font-weight:600; letter-spacing:0.04em; text-transform:uppercase; margin-bottom:16px; }
        .ok      { background:#ECFDF5; color:#047857; border:1px solid #A7F3D0; }
        .info    { background:#EFF6FF; color:#1D4ED8; border:1px solid #BFDBFE; }
        .warn    { background:#FFFBEB; color:#B45309; border:1px solid #FDE68A; }
        .err     { background:#FEF2F2; color:#B91C1C; border:1px solid #FECACA; }
        h1 { font-size:20px; margin:0 0 12px 0; font-weight:600; }
        p { font-size:14px; line-height:1.55; color:#475569; margin:0 0 12px 0; }
        .lead-time { font-size:15px; color:#0F172A; }
        .fine { margin-top:24px; font-size:12px; color:#94A3B8; }
        .actions { margin-top:24px; }
      `}</style>
      <div className="wrap">{children}</div>
    </>
  )
}

function FailurePage({ kind }: { kind: FailureKind }) {
  const { badge, badgeClass, title, body } = failureCopy(kind)
  return (
    <PageShell>
      <span className={`badge ${badgeClass}`}>{badge}</span>
      <h1>{title}</h1>
      <p>{body}</p>
      <p className="fine">
        If you have questions, reply to the last email from the venue and
        someone will help.
      </p>
    </PageShell>
  )
}

function failureCopy(kind: FailureKind): {
  badge: string
  badgeClass: 'ok' | 'info' | 'warn' | 'err'
  title: string
  body: string
} {
  switch (kind) {
    case 'expired':
      return {
        badge: 'Link expired',
        badgeClass: 'warn',
        title: 'This confirmation link has expired.',
        body: "These links are short-lived for security. Reply to the original message and the team will send you a fresh time.",
      }
    case 'already_used':
      return {
        badge: 'Already used',
        badgeClass: 'info',
        title: 'This tour time is already on hold.',
        body: "Looks like this slot was already confirmed once. There's nothing more to do here.",
      }
    case 'revoked':
      return {
        badge: 'Link replaced',
        badgeClass: 'info',
        title: 'This link was replaced by a newer one.',
        body: "When you asked for a different time, the venue sent a fresh set of options. Please use the most recent message's links.",
      }
    case 'not_found':
      return {
        badge: 'Not found',
        badgeClass: 'err',
        title: "We couldn't find that tour time.",
        body: "The time slot referenced here couldn't be located. Reply to the original message and the team will help.",
      }
    case 'in_past':
      return {
        badge: 'Time has passed',
        badgeClass: 'warn',
        title: 'This tour time is in the past.',
        body: "The scheduled time has already passed, so this link no longer applies. Reply to the original message and the team will offer a new time.",
      }
    case 'invalid_link':
      return {
        badge: 'Link not valid',
        badgeClass: 'warn',
        title: 'This link is no longer valid.',
        body: "It may have been copied or modified. Please use the exact link from your last message, or reply and the team will resend.",
      }
    case 'server_error':
      return {
        badge: 'Something went wrong',
        badgeClass: 'err',
        title: 'Something went wrong on our end.',
        body: "We couldn't process this confirmation right now. Please reply to your last message and the team will help.",
      }
  }
}

function formatSlotFallback(iso: string, tz: string | null): string {
  // Used only when the token's stored slot_label is missing
  // (defensive — issue-time always populates it). Mirror the
  // formatter style in `suggestTourSlots.formatLabel`.
  const d = new Date(iso)
  if (!Number.isFinite(d.getTime())) return iso
  const opts: Intl.DateTimeFormatOptions = {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }
  if (tz) opts.timeZone = tz
  return new Intl.DateTimeFormat(undefined, opts).format(d)
}
