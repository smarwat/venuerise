// AUDIT_EXEMPT: SSO initiate is anonymous + pre-authentication.
// Its forensic record lives in `sso_login_events` (migration 030)
// — every initiate writes a row keyed on (outcome, reason, domain,
// connection_id) and the SsoLoginEventsCard reads it directly.
// Duplicating into `audit_events` would create noise without
// forensic value. Documented in docs/AUDIT-COVERAGE.md.
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createServiceClient } from '@/lib/supabase/service'
import { rateLimitSsoAuth, rateLimitedResponse } from '@/lib/rate-limit'
import { log } from '@/lib/log'
import {
  getOrCreateRequestId,
  withRequestIdHeader,
} from '@/lib/observability/request-id'
import { maskIpForAudit } from '@/lib/enterprise/audit-events'
import { extractDomainFromEmail } from '@/lib/enterprise/sso/domain'
import { recordSsoLoginEvent } from '@/lib/enterprise/sso/audit'
import { resolveSsoAdapter } from '@/lib/enterprise/sso/provider'
import type {
  SsoConnection,
  SsoProvider,
  SsoProtocol,
  SsoConnectionStatus,
  SsoDefaultRole,
} from '@/lib/enterprise/sso/types'

/**
 * POST /api/auth/sso/initiate  (Phase 9G — readiness)
 *
 * Anonymous entry point for the SSO login flow. Today this is a
 * SCAFFOLD: it looks up the active connection for the email's
 * domain, records an `sso_login_events` row, and returns a
 * structured `SSO_*` error code from the placeholder adapter.
 * No real auth handshake happens yet.
 *
 * The route shape is the future-proof one:
 *   1. Rate-limit per IP+domain so a single attacker can't credential-
 *      stuff one domain across many IPs OR many domains from one IP.
 *   2. Validate email + extract domain.
 *   3. Look up the active connection.
 *   4. Hand off to `resolveSsoAdapter(...).initiate(...)` — the
 *      adapter is the placeholder in 9G; real SDK swap is a single-
 *      file change.
 *   5. Record every outcome (initiated / blocked / failed) in
 *      `sso_login_events` so the operator's SsoLoginEventsCard
 *      shows the full attempt history.
 *
 * ── PRIVACY POSTURE ─────────────────────────────────────────────────────
 * The endpoint is anonymous. We record the typed email in the
 * audit row because operators investigating "why can't this user
 * log in" need the address. IP is salted-SHA-256 fingerprinted
 * before storage. No cookies are read.
 */

const BodySchema = z.object({
  email: z.string().email().max(254),
})

export async function POST(request: NextRequest): Promise<Response> {
  const requestId = getOrCreateRequestId(request)
  const reqLog = log.child({
    requestId,
    route: '/api/auth/sso/initiate',
    op: 'auth.sso.initiate',
  })
  const respond = <T extends Response>(r: T) =>
    withRequestIdHeader(r, requestId)
  const ipRaw = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null
  const ipHash = maskIpForAudit(ipRaw)

  // 1. Parse body BEFORE rate-limit so we can include the domain
  // in the rate-limit identifier. Bad JSON → 400 before any
  // limiter call; that's fine because malformed payloads aren't
  // the abuse vector we're throttling.
  const body = await request.json().catch(() => null)
  const parsed = BodySchema.safeParse(body ?? {})
  if (!parsed.success) {
    return respond(
      NextResponse.json(
        { ok: false, code: 'validation_failed', detail: parsed.error.flatten() },
        { status: 400 }
      )
    )
  }
  const email = parsed.data.email
  const domain = extractDomainFromEmail(email)
  if (!domain) {
    void recordSsoLoginEvent({
      outcome: 'blocked',
      reason: 'invalid_email',
      email,
      ipHash,
      requestId,
    })
    return respond(
      NextResponse.json(
        { ok: false, code: 'SSO_DOMAIN_NOT_CONFIGURED', message: 'Email domain is not recognized.' },
        { status: 400 }
      )
    )
  }

  // 2. Rate limit per IP+domain. abuseContext fires a row in the
  // Phase 9F AbuseMonitorCard when the limit's hit.
  const rl = await rateLimitSsoAuth(request, domain, {
    route: '/api/auth/sso/initiate',
    method: 'POST',
    requestId,
    metadata: { domain },
  })
  if (!rl.allowed) {
    reqLog.warn({ domain, retryMs: rl.retryAfterMs }, 'rate_limit.blocked')
    void recordSsoLoginEvent({
      outcome: 'blocked',
      reason: 'rate_limited',
      email,
      domain,
      ipHash,
      requestId,
    })
    return respond(rateLimitedResponse(rl))
  }

  // 3. Resolve active connection. The `(venue_id, domain)` unique
  // constraint means at most one connection per (venue, domain);
  // we use `.eq('status', 'active')` to filter draft/disabled
  // ones out at query time.
  const svc = createServiceClient()
  const { data: rowRaw, error: lookupErr } = await svc
    .from('sso_connections')
    .select(
      'id, venue_id, provider, protocol, domain, status, default_role, jit_provisioning_enabled, scim_enabled, metadata, created_by, created_at, updated_at'
    )
    .eq('domain', domain)
    .eq('status', 'active')
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (lookupErr) {
    reqLog.error(
      { err: lookupErr, domain },
      'auth.sso.initiate.lookup_failed'
    )
    void recordSsoLoginEvent({
      outcome: 'failed',
      reason: 'lookup_failed',
      email,
      domain,
      ipHash,
      requestId,
    })
    return respond(
      NextResponse.json(
        { ok: false, code: 'SSO_PROVIDER_ERROR', message: 'Could not resolve SSO connection.' },
        { status: 500 }
      )
    )
  }

  if (!rowRaw) {
    // No active connection for this domain. We deliberately use a
    // SINGLE generic message + code so a probe can't enumerate
    // which domains have SSO configured. Operators see the exact
    // reason in the audit row.
    void recordSsoLoginEvent({
      outcome: 'blocked',
      reason: 'domain_not_configured',
      email,
      domain,
      ipHash,
      requestId,
    })
    return respond(
      NextResponse.json(
        {
          ok: false,
          code: 'SSO_NOT_CONFIGURED',
          message: 'SSO is not configured for this domain yet.',
        },
        { status: 404 }
      )
    )
  }

  // 4. Map DB row to typed connection shape + hand to adapter.
  const row = rowRaw as {
    id: string
    venue_id: string
    provider: SsoProvider
    protocol: SsoProtocol
    domain: string
    status: SsoConnectionStatus
    default_role: SsoDefaultRole
    jit_provisioning_enabled: boolean
    scim_enabled: boolean
    metadata: Record<string, unknown>
    created_by: string | null
    created_at: string
    updated_at: string
  }
  const connection: SsoConnection = {
    id: row.id,
    venueId: row.venue_id,
    provider: row.provider,
    protocol: row.protocol,
    domain: row.domain,
    status: row.status,
    defaultRole: row.default_role,
    jitProvisioningEnabled: row.jit_provisioning_enabled,
    scimEnabled: row.scim_enabled,
    metadata: row.metadata ?? {},
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }

  const adapter = resolveSsoAdapter(connection.provider, connection.protocol)
  const result = await adapter.initiate({
    email,
    domain,
    connection,
    requestId,
    ipHash,
  })

  if (result.ok) {
    // Real adapter path (future). Record initiated outcome + return
    // redirect URL.
    void recordSsoLoginEvent({
      outcome: 'initiated',
      venueId: connection.venueId,
      connectionId: connection.id,
      email,
      domain,
      provider: connection.provider,
      protocol: connection.protocol,
      ipHash,
      requestId,
    })
    return respond(
      NextResponse.json({ ok: true, redirect_url: result.redirectUrl })
    )
  }

  // Placeholder adapter today — record `blocked` with the structured
  // code as the reason. Operator sees this in the audit feed.
  void recordSsoLoginEvent({
    outcome: 'blocked',
    reason: result.code,
    venueId: connection.venueId,
    connectionId: connection.id,
    email,
    domain,
    provider: connection.provider,
    protocol: connection.protocol,
    ipHash,
    requestId,
  })
  return respond(
    NextResponse.json(
      { ok: false, code: result.code, message: result.message },
      { status: 503 }
    )
  )
}
