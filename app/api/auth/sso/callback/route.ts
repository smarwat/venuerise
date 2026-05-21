// AUDIT_EXEMPT: SSO callback is an anonymous vendor-initiated POST.
// Its forensic record lives in `sso_login_events` (migration 030)
// — same row shape as audit_events but with SSO-specific columns
// (outcome, reason, connection_id, provider, protocol). Duplicating
// into `audit_events` would create noise without forensic value;
// the SsoLoginEventsCard reads from sso_login_events directly.
// Documented in docs/AUDIT-COVERAGE.md.
import { NextRequest, NextResponse } from 'next/server'
import { rateLimitSsoAuth, rateLimitedResponse } from '@/lib/rate-limit'
import { log } from '@/lib/log'
import {
  getOrCreateRequestId,
  withRequestIdHeader,
} from '@/lib/observability/request-id'
import { maskIpForAudit } from '@/lib/enterprise/audit-events'
import { recordSsoLoginEvent } from '@/lib/enterprise/sso/audit'

/**
 * POST /api/auth/sso/callback  (Phase 9G — readiness)
 *
 * Vendor callback sink. Today this is a SCAFFOLD: it records a
 * `sso_login_events` row with `outcome='failed'` /
 * `reason='callback_not_configured'` and returns a structured
 * `SSO_CALLBACK_NOT_CONFIGURED` response. No user is created. No
 * session is issued.
 *
 * Future:
 *   - parse the vendor's POSTed payload
 *   - resolve the connection from a state/relay-state param
 *   - call `adapter.handleCallback({ rawBody, query, ... })`
 *   - on success, JIT-provision the user with `default_role` from
 *     the connection (always lowest-privilege), set the session,
 *     redirect to `/dashboard`.
 *
 * GET support: deferred. SAML POST-binding is the default; OIDC
 * uses an `authorization_code` GET that we'll add when the first
 * real adapter ships. Until then, GET returns 405.
 *
 * ── PRIVACY POSTURE ─────────────────────────────────────────────────────
 *   - Body is NEVER logged in full. Only its presence + size.
 *   - Query params are NOT logged (could carry state tokens).
 *   - IP is salted-SHA-256 fingerprinted before storage.
 */

export async function POST(request: NextRequest): Promise<Response> {
  const requestId = getOrCreateRequestId(request)
  const reqLog = log.child({
    requestId,
    route: '/api/auth/sso/callback',
    op: 'auth.sso.callback',
  })
  const respond = <T extends Response>(r: T) =>
    withRequestIdHeader(r, requestId)
  const ipRaw = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null
  const ipHash = maskIpForAudit(ipRaw)

  // 1. Rate-limit per IP. We can't include a domain here — the
  // callback identifier isn't extractable without parsing the
  // vendor's payload, and we want the limiter to fire BEFORE
  // any parse work.
  const rl = await rateLimitSsoAuth(request, undefined, {
    route: '/api/auth/sso/callback',
    method: 'POST',
    requestId,
  })
  if (!rl.allowed) {
    reqLog.warn({ retryMs: rl.retryAfterMs }, 'rate_limit.blocked')
    void recordSsoLoginEvent({
      outcome: 'blocked',
      reason: 'rate_limited',
      ipHash,
      requestId,
    })
    return respond(rateLimitedResponse(rl))
  }

  // 2. Sniff the request shape so we can record a useful audit row
  // WITHOUT logging body content. Just presence + size.
  let bodySize = 0
  try {
    const text = await request.text()
    bodySize = text.length
  } catch {
    // Ignore — we'll just record bodySize=0.
  }
  const queryKeys = Array.from(new URL(request.url).searchParams.keys())

  reqLog.info(
    { bodySize, queryKeyCount: queryKeys.length },
    'auth.sso.callback.received_placeholder'
  )

  // 3. Placeholder outcome. Real adapter swap goes here.
  void recordSsoLoginEvent({
    outcome: 'failed',
    reason: 'callback_not_configured',
    ipHash,
    requestId,
    metadata: {
      body_size: bodySize,
      query_key_count: queryKeys.length,
    },
  })

  return respond(
    NextResponse.json(
      {
        ok: false,
        code: 'SSO_CALLBACK_NOT_CONFIGURED',
        message:
          'SSO callback handler is not configured yet. SSO is in readiness mode (Phase 9G).',
      },
      { status: 503 }
    )
  )
}

/**
 * GET handler — Method Not Allowed. The future OIDC `authorization_code`
 * flow will use GET; until a real adapter lands we return 405 so
 * misconfigured vendor redirects fail loud + obvious.
 */
export async function GET(request: NextRequest): Promise<Response> {
  const requestId = getOrCreateRequestId(request)
  const respond = <T extends Response>(r: T) =>
    withRequestIdHeader(r, requestId)
  return respond(
    NextResponse.json(
      {
        ok: false,
        code: 'SSO_CALLBACK_NOT_CONFIGURED',
        message: 'GET binding not configured. POST callback is the placeholder.',
      },
      { status: 405, headers: { Allow: 'POST' } }
    )
  )
}
