import 'server-only'
import type { NextRequest } from 'next/server'
import {
  getOrCreateRequestId,
  withRequestIdHeader,
} from '@/lib/observability/request-id'
import { maskIpForAudit } from '@/lib/enterprise/audit-events'
import { log, type Logger } from '@/lib/log'

/**
 * Phase 9A — request context baseline.
 *
 * One place to assemble the `{requestId, route, userId, venueId,
 * operation, ipHash}` block every server route logs + every audit
 * write tags. Adopted incrementally:
 *
 *   - `GET /api/admin/audit-events` uses it end-to-end.
 *   - Routes touched for audit instrumentation use
 *     `getClientIpHash` + `getOrCreateRequestId` so the audit row
 *     and the log line agree on the request id + IP hash.
 *
 * This module deliberately does NOT replace the existing log
 * helper. The pattern is "augment, don't rewrite" — routes that
 * already do `log.child({...})` keep working; new code should
 * prefer `withRouteContext` so the field shape stays uniform.
 */

export interface RouteContext {
  requestId: string
  route: string
  userId?: string | null
  venueId?: string | null
  operation?: string | null
  ipHash?: string | null
}

export interface GetRouteContextOpts {
  route: string
  operation?: string
  userId?: string | null
  venueId?: string | null
}

/**
 * Build a `RouteContext` from a `NextRequest` + the caller-known
 * `route` string + optional `userId`/`venueId`. The request id is
 * pulled (or minted) via the existing `getOrCreateRequestId`
 * helper so logs, audit rows, and response headers all carry the
 * same value.
 */
export function getRequestContext(
  request: NextRequest,
  opts: GetRouteContextOpts
): RouteContext {
  const requestId = getOrCreateRequestId(request)
  const ipHash = getClientIpHash(request)
  return {
    requestId,
    route: opts.route,
    operation: opts.operation ?? null,
    userId: opts.userId ?? null,
    venueId: opts.venueId ?? null,
    ipHash,
  }
}

/**
 * Bind a `RouteContext` onto a base logger. The returned logger
 * is a `log.child(...)` over the input — every log call inherits
 * the structured fields without each line having to spell them
 * out. Existing routes use `log.child({requestId, route, op})`
 * already; this helper just makes the field shape uniform across
 * the codebase.
 */
export function withRouteContext(
  baseLog: Logger,
  context: RouteContext
): Logger {
  return baseLog.child({
    requestId: context.requestId,
    route: context.route,
    op: context.operation ?? undefined,
    userId: context.userId ?? undefined,
    venueId: context.venueId ?? undefined,
    ipHash: context.ipHash ?? undefined,
  })
}

/**
 * Extract a client IP from the request + run it through
 * `maskIpForAudit` so the route never sees the raw value past
 * this helper. The IP read prefers `x-forwarded-for` (proxied
 * deployments) and falls back to `x-real-ip` for direct hits;
 * if neither is present the IP_hash is `null` (audit row will
 * still record action + actor; just without IP linkability).
 */
export function getClientIpHash(request: NextRequest): string | null {
  const raw = pickRawClientIp(request)
  return maskIpForAudit(raw)
}

function pickRawClientIp(request: NextRequest): string | null {
  // `x-forwarded-for` may be a comma-separated list; the first
  // entry is the original client IP per the spec.
  const fwd = request.headers.get('x-forwarded-for')
  if (fwd) {
    const first = fwd.split(',')[0]?.trim()
    if (first && first.length > 0) return first
  }
  const real = request.headers.get('x-real-ip')
  if (real && real.length > 0) return real
  return null
}

// Re-export the request-id surface so callers can adopt
// `request-context` as a single import without dragging in two
// observability modules.
export { getOrCreateRequestId, withRequestIdHeader, log }
