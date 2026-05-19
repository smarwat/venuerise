import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import {
  verifyDigestToken,
  redactDigestUnsubscribeToken,
  DigestUnsubscribeTokenError,
  type DigestUnsubscribeTokenErrorCode,
} from '@/lib/integrations/digest-unsubscribe-token'
import { ADMIN_ROLES } from '@/lib/auth/roles'
import { log } from '@/lib/log'
import {
  getOrCreateRequestId,
  withRequestIdHeader,
} from '@/lib/observability/request-id'
import { captureApiError } from '@/lib/observability/sentry'
import {
  rateLimitUserAction,
  extractIp,
} from '@/lib/rate-limit'

/**
 * GET /api/digest/resubscribe?venue_id=<uuid>&user_id=<uuid>&token=<signed>
 * (Phase 8W)
 *
 * Public route — no session required. Mirrors the Phase 8K
 * /tour/confirm + /tour/cancel + Phase 8S /api/digest/unsubscribe
 * pattern: the HMAC-signed token IS the auth.
 *
 * On a verified resubscribe-action token + matching URL params:
 *   - Look up the (venue_id, user_id) row in `venue_members` via the
 *     service-role client.
 *   - If the membership exists AND the role is owner/admin, merge
 *     `digest_cadence = 'daily'` into the existing
 *     `venue_members.metadata` jsonb (preserves every other key).
 *   - Render a small confirmation HTML page.
 *
 * The Phase 8U operator-activity-digest cron's per-recipient loop reads
 * the same row to resolve the effective cadence; the member preference
 * wins over the subscription-level fallback per the Phase 8U effective-
 * preference resolver. We intentionally do NOT modify
 * `subscriptions.metadata` — the per-user override is enough to re-
 * enable this individual admin regardless of the venue-level legacy
 * `digest_disabled` flag.
 *
 * ── SECURITY POSTURE ──────────────────────────────────────────────────────
 *   - HMAC token via `DIGEST_UNSUBSCRIBE_SECRET` (≥16 chars enforced).
 *   - Token MUST have `action: 'resubscribe'` — a leaked unsubscribe
 *     token presented here returns 400 with neutral copy (Phase 8W
 *     `action_mismatch` code).
 *   - Token MUST contain `venue_id` matching the URL `venue_id` and
 *     `user_id` matching the URL `user_id` — defends against an attacker
 *     swapping query params to re-enable a different user.
 *   - We only flip the cadence for owner/admin members. A viewer or
 *     coordinator membership returns 404 (same response shape as "no
 *     membership exists") so the route can't be used to enumerate
 *     per-role distribution.
 *   - Per-IP rate limit via the existing Upstash user-action limiter.
 *   - Tamper attempts (`invalid_signature`) → warn + Sentry capture.
 *   - Expired / malformed / mismatched → 400 HTML with neutral copy.
 *   - `X-Robots-Tag: noindex, nofollow` on every response.
 *   - Never logs the full token; uses `redactDigestUnsubscribeToken`.
 *   - Never includes raw token values in Sentry context.
 */

type Outcome =
  | { kind: 'success'; venueId: string }
  | { kind: 'invalid' }
  | { kind: 'expired' }
  | { kind: 'mismatch' }
  | { kind: 'not_found' }
  | { kind: 'rate_limited' }
  | { kind: 'server_error' }

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function GET(request: NextRequest): Promise<Response> {
  const requestId = getOrCreateRequestId(request)
  const reqLog = log.child({
    requestId,
    route: '/api/digest/resubscribe',
    op: 'digest.resubscribe',
  })
  const respond = (status: number, html: string): Response =>
    withRequestIdHeader(
      new NextResponse(html, {
        status,
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          'X-Robots-Tag': 'noindex, nofollow',
        },
      }),
      requestId
    )

  // 1. Per-IP rate limit. Same key prefix shape as the unsubscribe
  // route, scoped by action so a noisy resubscribe loop can't push the
  // unsubscribe limiter into deny-all.
  const ip = extractIp(request)
  const rl = await rateLimitUserAction(request, `digest-resubscribe:${ip}`)
  if (!rl.allowed) {
    reqLog.warn({ ip, retryMs: rl.retryAfterMs }, 'digest.resubscribe.rate_limited')
    return respond(429, renderPage({ kind: 'rate_limited' }))
  }

  // 2. URL params — early shape validation. Bad UUIDs short-circuit to
  // the generic invalid page so we don't even bother hitting the HMAC
  // verifier with obvious junk.
  const url = new URL(request.url)
  const venueIdParam = (url.searchParams.get('venue_id') ?? '').trim()
  const userIdParam = (url.searchParams.get('user_id') ?? '').trim()
  const tokenParam = url.searchParams.get('token') ?? ''
  const redacted = redactDigestUnsubscribeToken(tokenParam)

  if (!UUID_RE.test(venueIdParam) || !UUID_RE.test(userIdParam)) {
    reqLog.info(
      { ip, token: redacted },
      'digest.resubscribe.bad_url_params'
    )
    return respond(400, renderPage({ kind: 'invalid' }))
  }

  // 3. Parse + verify the token.
  let payload
  try {
    payload = verifyDigestToken(tokenParam)
  } catch (err) {
    const code: DigestUnsubscribeTokenErrorCode =
      err instanceof DigestUnsubscribeTokenError ? err.code : 'malformed_token'
    if (code === 'invalid_signature') {
      reqLog.warn(
        { ip, token: redacted },
        'digest.resubscribe.invalid_signature'
      )
      captureApiError(new Error('digest_resubscribe_invalid_signature'), {
        requestId,
        route: '/api/digest/resubscribe',
      })
      return respond(400, renderPage({ kind: 'invalid' }))
    }
    if (code === 'expired') {
      reqLog.info({ ip, token: redacted }, 'digest.resubscribe.expired')
      return respond(400, renderPage({ kind: 'expired' }))
    }
    if (code === 'secret_missing') {
      // Operator misconfiguration — `DIGEST_UNSUBSCRIBE_SECRET` was
      // unset/short when the link was clicked. Surface to Sentry; render
      // a generic server-error page so we don't leak config to the user.
      reqLog.error(
        { ip, code, token: redacted },
        'digest.resubscribe.secret_missing'
      )
      captureApiError(new Error('digest_resubscribe_secret_missing'), {
        requestId,
        route: '/api/digest/resubscribe',
      })
      return respond(500, renderPage({ kind: 'server_error' }))
    }
    // `action_mismatch` (e.g. an unsubscribe token clicked at this
    // route), `malformed_token`, `invalid_payload` — all collapse to the
    // neutral "invalid" page so we don't leak which dimension failed.
    reqLog.info(
      { ip, code, token: redacted },
      'digest.resubscribe.token_rejected'
    )
    return respond(400, renderPage({ kind: 'invalid' }))
  }

  // 4. Cross-check: the verifier already enforced action === 'resubscribe'
  // (anything else throws action_mismatch above). Now defend against
  // venue_id / user_id swaps: the URL params must match the signed
  // payload exactly.
  if (
    !payload.userId ||
    payload.venueId !== venueIdParam ||
    payload.userId !== userIdParam
  ) {
    reqLog.warn(
      {
        ip,
        urlVenue: venueIdParam,
        tokenVenue: payload.venueId,
        urlUser: userIdParam,
        tokenUser: payload.userId,
        token: redacted,
      },
      'digest.resubscribe.param_mismatch'
    )
    return respond(400, renderPage({ kind: 'mismatch' }))
  }

  const venueId = payload.venueId
  const userId = payload.userId

  // 5. Locate the membership row + role-gate.
  const svc = createServiceClient()
  const { data: memberRow, error: memberErr } = await svc
    .from('venue_members')
    .select('id, role, metadata')
    .eq('venue_id', venueId)
    .eq('user_id', userId)
    .maybeSingle()

  if (memberErr) {
    reqLog.error(
      { err: memberErr, venueId, userId },
      'digest.resubscribe.member_lookup_failed'
    )
    captureApiError(memberErr, {
      requestId,
      route: '/api/digest/resubscribe',
      venueId,
    })
    return respond(500, renderPage({ kind: 'server_error' }))
  }

  if (!memberRow) {
    // Either no membership exists, or the row was deleted after the
    // link was sent. Neutral "not found" — does NOT leak whether the
    // venue exists.
    reqLog.info({ venueId, userId }, 'digest.resubscribe.no_membership')
    return respond(404, renderPage({ kind: 'not_found' }))
  }

  const member = memberRow as {
    id: string
    role: string
    metadata: Record<string, unknown> | null
  }

  // Role gate — only owners/admins receive the digest (cron filter is
  // `role in ('owner', 'admin')`), so resubscribing a viewer would be a
  // no-op. Collapse to 404 so the route can't be used to probe
  // per-role distribution.
  if (!(ADMIN_ROLES as ReadonlyArray<string>).includes(member.role)) {
    reqLog.info(
      { venueId, userId, role: member.role },
      'digest.resubscribe.member_not_admin'
    )
    return respond(404, renderPage({ kind: 'not_found' }))
  }

  // 6. Flip per-user cadence to 'daily'. Idempotent — re-applying the
  // same value is a no-op, and we preserve any other metadata key the
  // member row carries (e.g. invitation source, future flags).
  const baseMetadata = (member.metadata ?? {}) as Record<string, unknown>
  const nextMetadata: Record<string, unknown> = {
    ...baseMetadata,
    digest_cadence: 'daily',
    // Audit breadcrumb — same shape as the Phase 8S `digest_disabled_at`
    // on the unsubscribe side. Lets ops/QA see when each per-user
    // resubscribe fired without scraping logs.
    digest_resubscribed_at: new Date().toISOString(),
  }

  const { error: updateErr } = await svc
    .from('venue_members')
    .update({ metadata: nextMetadata })
    .eq('id', member.id)
  if (updateErr) {
    reqLog.error(
      { err: updateErr, venueId, userId, memberId: member.id },
      'digest.resubscribe.update_failed'
    )
    captureApiError(updateErr, {
      requestId,
      route: '/api/digest/resubscribe',
      venueId,
    })
    return respond(500, renderPage({ kind: 'server_error' }))
  }

  reqLog.info(
    { venueId, userId, memberId: member.id, token: redacted },
    'digest.resubscribe.completed'
  )
  return respond(200, renderPage({ kind: 'success', venueId }))
}

// ============================================================================
// Inline HTML page renderer (matches /api/digest/unsubscribe styling)
// ============================================================================

function renderPage(outcome: Outcome): string {
  const appUrl = (process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000').replace(
    /\/$/,
    ''
  )
  const billingUrl = `${appUrl}/dashboard/settings/billing`
  const { title, body, badgeClass } = outcomeCopy(outcome, billingUrl)
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
<style>
  body { margin:0; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif; background:#F4F6FB; color:#0F172A; }
  .wrap { max-width:480px; margin:80px auto; padding:32px; background:#FFFFFF; border:1px solid #E2E8F0; border-radius:20px; box-shadow:0 4px 14px rgba(15,23,42,0.08); }
  .badge { display:inline-block; padding:4px 10px; border-radius:9999px; font-size:11px; font-weight:600; letter-spacing:0.04em; text-transform:uppercase; margin-bottom:16px; }
  .ok      { background:#ECFDF5; color:#047857; border:1px solid #A7F3D0; }
  .info    { background:#EFF6FF; color:#1D4ED8; border:1px solid #BFDBFE; }
  .warn    { background:#FFFBEB; color:#B45309; border:1px solid #FDE68A; }
  .err     { background:#FEF2F2; color:#B91C1C; border:1px solid #FECACA; }
  h1 { font-size:18px; margin:0 0 12px 0; font-weight:600; }
  p  { font-size:14px; line-height:1.55; color:#475569; margin:0 0 12px 0; }
  a  { color:#1D4ED8; text-decoration:underline; }
  .foot { margin-top:24px; font-size:12px; color:#94A3B8; }
</style>
</head>
<body>
<div class="wrap">
  <span class="badge ${badgeClass}">${escapeHtml(badgeLabel(outcome))}</span>
  <h1>${escapeHtml(title)}</h1>
  ${body}
  <div class="foot">Reply to the original email if you have questions.</div>
</div>
</body>
</html>`
}

function badgeLabel(outcome: Outcome): string {
  switch (outcome.kind) {
    case 'success':
      return 'Re-enabled'
    case 'invalid':
      return 'Link not valid'
    case 'expired':
      return 'Link expired'
    case 'mismatch':
      return 'Link not valid'
    case 'not_found':
      return 'Not found'
    case 'rate_limited':
      return 'Too many requests'
    case 'server_error':
      return 'Error'
  }
}

function outcomeCopy(
  outcome: Outcome,
  billingUrl: string
): { title: string; body: string; badgeClass: 'ok' | 'info' | 'warn' | 'err' } {
  switch (outcome.kind) {
    case 'success':
      return {
        title: 'Digest emails re-enabled.',
        body:
          `<p>You'll receive daily operator digests for this venue again.</p>` +
          `<p>You can change this anytime from your <a href="${escapeHtml(billingUrl)}">Billing Settings</a> dashboard.</p>`,
        badgeClass: 'ok',
      }
    case 'invalid':
    case 'mismatch':
      return {
        title: 'This link is no longer valid.',
        body: `<p>The link you used doesn't verify. Reply to the original email and our team will sort it out.</p>`,
        badgeClass: 'warn',
      }
    case 'expired':
      return {
        title: 'This link has expired.',
        body: `<p>Re-enable links expire after 30 days. Open <a href="${escapeHtml(billingUrl)}">Billing Settings</a> in your dashboard to re-enable digest emails directly.</p>`,
        badgeClass: 'warn',
      }
    case 'not_found':
      return {
        title: "We couldn't find that membership.",
        body: `<p>The account referenced by this link couldn't be located. Reply to the original email and we'll re-enable digests manually.</p>`,
        badgeClass: 'err',
      }
    case 'rate_limited':
      return {
        title: 'Too many requests from this network.',
        body: `<p>You've clicked re-enable links a lot in the last minute. Please wait a moment and try again.</p>`,
        badgeClass: 'warn',
      }
    case 'server_error':
      return {
        title: 'Something went wrong on our end.',
        body: `<p>We logged the failure. Reply to the original email and we'll re-enable your digest manually.</p>`,
        badgeClass: 'err',
      }
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
