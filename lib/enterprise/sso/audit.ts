import 'server-only'
import { createServiceClient } from '@/lib/supabase/service'
import { log } from '@/lib/log'
import { captureApiError } from '@/lib/observability/sentry'
import { maskIpForAudit } from '@/lib/enterprise/audit-events'
import type {
  SsoLoginOutcome,
  SsoProvider,
  SsoProtocol,
} from '@/lib/enterprise/sso/types'

/**
 * Phase 9G — SSO login event recorder.
 *
 * Best-effort writer to `public.sso_login_events` (migration 030).
 * Captures every initiate / callback attempt — including the ones
 * that get rejected before any auth handshake happens — so an
 * operator investigating "why can't user X log in" can scroll the
 * SsoLoginEventsCard and see the exact rejection path.
 *
 * Posture mirrors the Phase 9A `recordAuditEvent` + Phase 9F
 * `recordAbuseEvent` helpers:
 *   - Wraps every step in try/catch.
 *   - NEVER throws. The originating route's response is unaffected
 *     by audit-write failure.
 *   - Logs structured `sso_login_events.insert_failed` warnings +
 *     Sentry-captures on insert error.
 *   - Reuses `maskIpForAudit` so the ip_hash shape matches
 *     `audit_events.ip_hash` and `abuse_events.ip_hash` —
 *     cross-feed correlation works without ever storing raw IPs.
 *
 * The helper accepts already-hashed `ipHash` (when the caller
 * already computed it) OR a raw `ip` it hashes here. Routes
 * supply whichever they have.
 */

export interface RecordSsoLoginEventArgs {
  outcome: SsoLoginOutcome
  /** Discriminator for why the outcome landed. Operator-readable. */
  reason?: string | null
  venueId?: string | null
  connectionId?: string | null
  userId?: string | null
  email?: string | null
  domain?: string | null
  provider?: SsoProvider | null
  protocol?: SsoProtocol | null
  /** Pre-computed salted-SHA-256 fingerprint, when available. */
  ipHash?: string | null
  /** Raw IP — helper hashes it via maskIpForAudit. */
  ip?: string | null
  /** Phase 9A request id for cross-system correlation. */
  requestId?: string | null
  /** Small structural context. NEVER raw payloads, NEVER secrets. */
  metadata?: Record<string, unknown> | null
}

const VALID_OUTCOMES: ReadonlyArray<SsoLoginOutcome> = [
  'initiated',
  'success',
  'failed',
  'blocked',
]

export async function recordSsoLoginEvent(
  args: RecordSsoLoginEventArgs
): Promise<void> {
  try {
    if (!VALID_OUTCOMES.includes(args.outcome)) {
      log.warn(
        { outcome: args.outcome },
        'sso_login_events.invalid_outcome'
      )
      return
    }

    // Resolve ip_hash from the precomputed value first, then from
    // raw IP, then null. Avoids double-hashing when the caller
    // already invoked maskIpForAudit upstream.
    const ipHash =
      args.ipHash !== undefined
        ? args.ipHash
        : args.ip !== undefined
          ? maskIpForAudit(args.ip)
          : null

    const row = {
      venue_id: args.venueId ?? null,
      connection_id: args.connectionId ?? null,
      user_id: args.userId ?? null,
      email: args.email ?? null,
      domain: args.domain ?? null,
      provider: args.provider ?? null,
      protocol: args.protocol ?? null,
      outcome: args.outcome,
      reason: args.reason ?? null,
      ip_hash: ipHash,
      request_id: args.requestId ?? null,
      metadata:
        args.metadata && typeof args.metadata === 'object'
          ? args.metadata
          : {},
    }

    const svc = createServiceClient()
    const { error } = await svc.from('sso_login_events').insert(row)
    if (error) {
      log.warn(
        {
          err: error,
          outcome: args.outcome,
          reason: args.reason,
          domain: args.domain,
        },
        'sso_login_events.insert_failed'
      )
      captureApiError(error, {
        requestId: args.requestId ?? undefined,
        route: '/lib/enterprise/sso/audit',
        userId: args.userId ?? undefined,
        venueId: args.venueId ?? undefined,
      })
    }
  } catch (err) {
    log.warn(
      { err, outcome: args.outcome, reason: args.reason },
      'sso_login_events.helper_threw'
    )
    captureApiError(err, {
      requestId: args.requestId ?? undefined,
      route: '/lib/enterprise/sso/audit',
      userId: args.userId ?? undefined,
      venueId: args.venueId ?? undefined,
    })
  }
}
