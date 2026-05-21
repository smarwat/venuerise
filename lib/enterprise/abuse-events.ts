import 'server-only'
import { createServiceClient } from '@/lib/supabase/service'
import { log } from '@/lib/log'
import { captureApiError } from '@/lib/observability/sentry'
import { maskIpForAudit } from '@/lib/enterprise/audit-events'

/**
 * Phase 9F — Abuse event helper.
 *
 * One call per rate-limit BLOCK. Writes a row to `public.abuse_events`
 * (migration 029) describing who got throttled, on which route, by
 * which limiter. The helper is BEST-EFFORT — failures log + Sentry
 * but NEVER throw. The originating request has ALREADY been blocked
 * by the rate limiter at the time we're called; we're just recording
 * the fact for the operator's AbuseMonitorCard.
 *
 * ── PRIVACY POSTURE ─────────────────────────────────────────────────────
 *   - Raw IPs are NEVER stored. The helper reads the request's
 *     x-forwarded-for / x-real-ip and immediately runs it through
 *     `maskIpForAudit` (Phase 9A salted-SHA-256).
 *   - No cookies are read.
 *   - User-Agent is NOT captured here (audit_events already carries
 *     that for the WRITE path; abuse_events keeps the row narrow).
 *   - `metadata` carries small structural context only — retry-after
 *     ms, remaining tokens at block time. NEVER raw payloads.
 *
 * ── USAGE ────────────────────────────────────────────────────────────────
 * The four primary rate-limit wrappers (`rateLimitWidget`,
 * `rateLimitAi`, `rateLimitUserAction`, `rateLimitCspReport`) accept
 * an optional `abuseContext` parameter. When supplied AND the limit
 * is hit, the wrapper fires `void recordAbuseEvent(...)` — fire-and-
 * forget, never awaited.
 *
 * Callers don't need to handle the helper's return value; the void
 * cast at the call site discards it.
 */

export interface RecordAbuseEventArgs {
  /** Static route string, e.g. `/api/leads/[id]`. */
  route: string
  /** HTTP method that was blocked. */
  method: string
  /** The EXACT key the rate limiter saw (prefix + identifier). */
  limiterKey: string
  /** Raw IP — helper hashes it. Pass null when no request context. */
  ip: string | null
  /** Authenticated user id, when available. */
  userId?: string | null
  /** Venue id, when available. */
  venueId?: string | null
  /**
   * Discriminator for the block reason. Today: `'rate_limited'` for
   * all callers. Reserved for future expansion (e.g.
   * `'signature_failed'`, `'token_invalid'`) so a single table can
   * carry the full abuse signal.
   */
  reason?: string
  /**
   * Cross-system correlation id. The rate-limit wrappers thread the
   * Phase 9A request id when they have it.
   */
  requestId?: string | null
  /** Small structural context. NEVER raw payloads. */
  metadata?: Record<string, unknown> | null
}

export type AbuseEventActorKind = 'user' | 'anonymous'

const VALID_REASONS: ReadonlyArray<string> = [
  'rate_limited',
  // Reserved future values — keep adding to the allowlist as new
  // signal sources land.
  'signature_failed',
  'token_invalid',
]

export async function recordAbuseEvent(args: RecordAbuseEventArgs): Promise<void> {
  try {
    if (
      typeof args.route !== 'string' ||
      args.route.length === 0 ||
      typeof args.method !== 'string' ||
      args.method.length === 0 ||
      typeof args.limiterKey !== 'string' ||
      args.limiterKey.length === 0
    ) {
      log.warn(
        { route: args.route, method: args.method },
        'abuse_events.invalid_args'
      )
      return
    }
    const reason = args.reason && VALID_REASONS.includes(args.reason)
      ? args.reason
      : 'rate_limited'

    const row = {
      venue_id: args.venueId ?? null,
      user_id: args.userId ?? null,
      route: args.route,
      method: args.method.toUpperCase(),
      limiter_key: args.limiterKey,
      ip_hash: maskIpForAudit(args.ip),
      reason,
      metadata:
        args.metadata && typeof args.metadata === 'object'
          ? args.metadata
          : {},
    }

    const svc = createServiceClient()
    const { error } = await svc.from('abuse_events').insert(row)
    if (error) {
      log.warn(
        {
          err: error,
          route: args.route,
          method: args.method,
          limiterKey: args.limiterKey,
        },
        'abuse_events.insert_failed'
      )
      captureApiError(error, {
        requestId: args.requestId ?? undefined,
        route: args.route,
        userId: args.userId ?? undefined,
        venueId: args.venueId ?? undefined,
      })
    }
  } catch (err) {
    log.warn(
      { err, route: args.route, method: args.method },
      'abuse_events.helper_threw'
    )
    captureApiError(err, {
      requestId: args.requestId ?? undefined,
      route: args.route,
      userId: args.userId ?? undefined,
      venueId: args.venueId ?? undefined,
    })
  }
}
