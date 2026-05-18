import 'server-only'
import { randomUUID } from 'node:crypto'

/**
 * Request correlation IDs (Phase 5B).
 *
 * Every API route accepts an inbound `x-request-id` header from a client or
 * proxy. If present, we reuse it; if missing or malformed, we generate a
 * fresh UUIDv4. The id is:
 *   - attached to every log line in the request scope (via `log.child`)
 *   - propagated into job event payloads (Inngest / local fallback)
 *   - echoed back on every response as `X-Request-Id`
 *
 * This lets an operator paste a single id into a log explorer and see the
 * full multi-module trace — widget POST → job enqueue → orchestrator →
 * Anthropic call → email send → webhook update.
 *
 * `server-only` because it has no client use and uses Node crypto.
 */

export const REQUEST_ID_HEADER = 'x-request-id' as const

/** Max chars to accept from an untrusted inbound header. */
const MAX_INBOUND_LENGTH = 128

/**
 * Safe characters for inbound request IDs. Deliberately strict — matches the
 * intersection of common formats (UUID, ULID, Sentry trace ids) and avoids
 * anything that needs URL/log escaping.
 */
const SAFE_REQUEST_ID_RE = /^[A-Za-z0-9_\-.:]+$/

function isAcceptableInbound(value: string): boolean {
  if (!value) return false
  if (value.length > MAX_INBOUND_LENGTH) return false
  return SAFE_REQUEST_ID_RE.test(value)
}

/**
 * Resolve a request id for the given request: trust the inbound header iff
 * it passes the safety check, otherwise mint a new UUID.
 */
export function getOrCreateRequestId(req: Request): string {
  const inbound = req.headers.get(REQUEST_ID_HEADER)
  if (inbound && isAcceptableInbound(inbound)) {
    return inbound
  }
  return randomUUID()
}

/**
 * Set `X-Request-Id` on a Response (or NextResponse — both share the Headers
 * API). Mutates and returns the same object so callers can wrap inline:
 *
 *   return withRequestIdHeader(NextResponse.json(body), requestId)
 */
export function withRequestIdHeader<T extends Response>(response: T, requestId: string): T {
  response.headers.set('X-Request-Id', requestId)
  return response
}
