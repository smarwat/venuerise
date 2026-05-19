import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import {
  verifyDigestUnsubscribeToken,
  redactDigestUnsubscribeToken,
  DigestUnsubscribeTokenError,
  type DigestUnsubscribeTokenErrorCode,
} from '@/lib/integrations/digest-unsubscribe-token'
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
 * GET /api/digest/unsubscribe?venue_id=<uuid>&token=<signed>  (Phase 8S)
 *
 * Public route — no session required. Token IS the auth, mirroring the
 * Phase 8K `/tour/confirm` + `/tour/cancel` pattern.
 *
 * On a verified token + matching venue:
 *   - Look up the most-recent subscription for the venue (service-role).
 *   - Merge `digest_disabled = true` + `digest_disabled_at = <ISO>` into
 *     the existing metadata jsonb (preserves every other key).
 *   - Render a small confirmation HTML page.
 *
 * The Phase 8R operator-activity-digest cron's per-venue loop reads the
 * same subscription row before sending; once this route flips the flag
 * the next morning's digest skips the venue cleanly.
 *
 * ── SECURITY POSTURE ──────────────────────────────────────────────────────
 *   - HMAC token via `DIGEST_UNSUBSCRIBE_SECRET` (≥16 chars enforced).
 *   - Token must contain `venue_id` matching the URL `venue_id` —
 *     prevents a token issued for venue A from unsubscribing venue B.
 *   - Per-IP rate limit via the existing Upstash user-action limiter.
 *   - Tamper attempts (`invalid_signature`) → warn + Sentry capture.
 *   - Expired / malformed / mismatched → 400 HTML with neutral copy
 *     (no info disclosure about which dimension failed).
 *   - `X-Robots-Tag: noindex, nofollow` on every response so a leaked
 *     URL doesn't get indexed.
 *   - Never logs the full token; uses `redactDigestUnsubscribeToken`.
 */

type Outcome =
  | { kind: 'success'; venueId: string }
  | { kind: 'invalid' }
  | { kind: 'expired' }
  | { kind: 'mismatch' }
  | { kind: 'not_found' }
  | { kind: 'rate_limited' }
  | { kind: 'server_error' }

export async function GET(request: NextRequest): Promise<Response> {
  const requestId = getOrCreateRequestId(request)
  const reqLog = log.child({
    requestId,
    route: '/api/digest/unsubscribe',
    op: 'digest.unsubscribe',
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

  // 1. Per-IP rate limit. Reuses the existing Upstash user-action
  // limiter — public surface, so we key by IP (not by an authenticated
  // identity that doesn't exist here).
  const ip = extractIp(request)
  const rl = await rateLimitUserAction(request, `digest-unsubscribe:${ip}`)
  if (!rl.allowed) {
    reqLog.warn({ ip, retryMs: rl.retryAfterMs }, 'digest.unsubscribe.rate_limited')
    return respond(429, renderPage({ kind: 'rate_limited' }))
  }

  // 2. Parse + verify the token.
  const url = new URL(request.url)
  const venueIdParam = url.searchParams.get('venue_id') ?? ''
  const tokenParam = url.searchParams.get('token') ?? ''
  const redacted = redactDigestUnsubscribeToken(tokenParam)

  let payload
  try {
    payload = verifyDigestUnsubscribeToken(tokenParam)
  } catch (err) {
    const code: DigestUnsubscribeTokenErrorCode =
      err instanceof DigestUnsubscribeTokenError ? err.code : 'malformed_token'
    if (code === 'invalid_signature') {
      reqLog.warn(
        { ip, token: redacted },
        'digest.unsubscribe.invalid_signature'
      )
      captureApiError(new Error('digest_unsubscribe_invalid_signature'), {
        requestId,
        route: '/api/digest/unsubscribe',
      })
      return respond(400, renderPage({ kind: 'invalid' }))
    }
    if (code === 'expired') {
      reqLog.info({ ip, token: redacted }, 'digest.unsubscribe.expired')
      return respond(400, renderPage({ kind: 'expired' }))
    }
    if (code === 'secret_missing') {
      // Operator misconfiguration — `DIGEST_UNSUBSCRIBE_SECRET` was
      // unset/short when the cron tried to sign, OR was rotated away
      // before this click. Surface to Sentry; render the generic
      // invalid page so we don't leak the config gap to the lead.
      reqLog.error(
        { ip, code, token: redacted },
        'digest.unsubscribe.secret_missing'
      )
      captureApiError(new Error('digest_unsubscribe_secret_missing'), {
        requestId,
        route: '/api/digest/unsubscribe',
      })
      return respond(500, renderPage({ kind: 'server_error' }))
    }
    reqLog.info(
      { ip, code, token: redacted },
      'digest.unsubscribe.token_rejected'
    )
    return respond(400, renderPage({ kind: 'invalid' }))
  }

  // 3. Cross-check: URL `venue_id` must match the signed payload.
  // Defends against an attacker swapping the venue_id query param to
  // unsubscribe a different venue using a leaked token for venue A.
  if (!venueIdParam || venueIdParam !== payload.venue_id) {
    reqLog.warn(
      { ip, urlVenue: venueIdParam, tokenVenue: payload.venue_id, token: redacted },
      'digest.unsubscribe.venue_mismatch'
    )
    return respond(400, renderPage({ kind: 'mismatch' }))
  }

  const venueId = payload.venue_id

  // 4. Locate the most-recent subscription row for the venue + merge
  // the opt-out flag into metadata. Same priority order as Phase 7D /
  // 8I (most recently created row wins) so we never accidentally flip
  // a stale canceled subscription instead of the live one.
  const svc = createServiceClient()
  const { data: subRaw, error: subErr } = await svc
    .from('subscriptions')
    .select('id, metadata')
    .eq('venue_id', venueId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (subErr) {
    reqLog.error(
      { err: subErr, venueId },
      'digest.unsubscribe.subscription_lookup_failed'
    )
    captureApiError(subErr, {
      requestId,
      route: '/api/digest/unsubscribe',
      venueId,
    })
    return respond(500, renderPage({ kind: 'server_error' }))
  }

  if (!subRaw) {
    // No subscription exists yet (rare — would mean digest was sent
    // before onboarding completed). We render a friendly "not found"
    // page rather than fabricating a subscription row.
    reqLog.info({ venueId }, 'digest.unsubscribe.no_subscription')
    return respond(404, renderPage({ kind: 'not_found' }))
  }

  const sub = subRaw as { id: string; metadata: Record<string, unknown> | null }
  const baseMetadata = (sub.metadata ?? {}) as Record<string, unknown>
  // Idempotent: re-flipping an already-disabled venue updates the
  // timestamp but doesn't add noise. The flag is the truth signal.
  const nextMetadata: Record<string, unknown> = {
    ...baseMetadata,
    digest_disabled: true,
    digest_disabled_at: new Date().toISOString(),
  }
  const { error: updateErr } = await svc
    .from('subscriptions')
    .update({ metadata: nextMetadata })
    .eq('id', sub.id)
  if (updateErr) {
    reqLog.error(
      { err: updateErr, venueId, subscriptionId: sub.id },
      'digest.unsubscribe.update_failed'
    )
    captureApiError(updateErr, {
      requestId,
      route: '/api/digest/unsubscribe',
      venueId,
    })
    return respond(500, renderPage({ kind: 'server_error' }))
  }

  reqLog.info(
    { venueId, subscriptionId: sub.id, token: redacted },
    'digest.unsubscribe.completed'
  )
  return respond(200, renderPage({ kind: 'success', venueId }))
}

// ============================================================================
// Inline HTML page renderer
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
      return 'Unsubscribed'
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
        title: "You're unsubscribed.",
        body:
          `<p>You'll no longer receive VenueRise daily activity summaries for this venue.</p>` +
          `<p>You can re-enable them anytime from <a href="${escapeHtml(billingUrl)}">your billing settings</a>.</p>`,
        badgeClass: 'ok',
      }
    case 'invalid':
    case 'mismatch':
      return {
        title: 'This link is no longer valid.',
        body: `<p>The link you used doesn't verify. Please reply to the original email and our team will sort it out.</p>`,
        badgeClass: 'warn',
      }
    case 'expired':
      return {
        title: 'This link has expired.',
        body: `<p>Unsubscribe links expire after 30 days. Reply to any recent digest email and we'll unsubscribe you manually.</p>`,
        badgeClass: 'warn',
      }
    case 'not_found':
      return {
        title: "We couldn't find that venue.",
        body: `<p>The venue referenced by this link couldn't be located. Reply to the original email and we'll sort it out.</p>`,
        badgeClass: 'err',
      }
    case 'rate_limited':
      return {
        title: 'Too many requests from this network.',
        body: `<p>You've clicked unsubscribe links a lot in the last minute. Please wait a moment and try again.</p>`,
        badgeClass: 'warn',
      }
    case 'server_error':
      return {
        title: 'Something went wrong on our end.',
        body: `<p>We logged the failure. Please reply to the original email and we'll unsubscribe you manually.</p>`,
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
