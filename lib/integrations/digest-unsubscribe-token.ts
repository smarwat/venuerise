import 'server-only'
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

/**
 * Phase 8S → 8W — HMAC-signed tokens for the operator-activity-digest
 * email surface.
 *
 * Originally only signed venue-level unsubscribe tokens (Phase 8S). Phase
 * 8W extends the payload with two optional fields:
 *
 *   - `action`   ∈ 'unsubscribe' | 'resubscribe' (defaults to
 *                  'unsubscribe' for back-compat with any Phase 8S
 *                  token still in flight when 8W ships)
 *   - `user_id`  required for resubscribe tokens (per-user re-enable);
 *                ignored by venue-level unsubscribe
 *
 * Same crypto, same base64url encoding, same constant-time compare as
 * the Phase 8K `tour-action-token.ts`. Uses its own secret so a leaked
 * tour-action key can't be replayed against either digest surface.
 *
 * ── TOKEN PAYLOAD (Phase 8W) ──────────────────────────────────────────────
 *   {
 *     venue_id: string,           // always
 *     exp:      number (unix ms), // always
 *     nonce:    string,           // always
 *     action?:  'unsubscribe' | 'resubscribe',  // absent ⇒ 'unsubscribe'
 *     user_id?: string            // required when action === 'resubscribe'
 *   }
 *
 * Single-use is NOT enforced — both actions are idempotent:
 *   - Unsubscribe: flipping `subscriptions.metadata.digest_disabled = true`
 *     twice is a no-op.
 *   - Resubscribe: writing `venue_members.metadata.digest_cadence = 'daily'`
 *     twice is a no-op.
 * The nonce ensures every issued URL is unique even when the cron sends
 * two digests in the same minute.
 *
 * ── SECRET ────────────────────────────────────────────────────────────────
 * Read from `DIGEST_UNSUBSCRIBE_SECRET`. If unset/short (<16 chars),
 * treat as missing — the digest sender falls back to a link-less email
 * with a one-shot warn. Both actions share the same secret; rotating
 * invalidates every issued token of either kind.
 *
 * ── PRIVACY ───────────────────────────────────────────────────────────────
 * No PII in the token payload — venue_id + user_id (UUIDs) only. Never
 * log the full token; use `redactDigestUnsubscribeToken()` (short
 * head…tail) for structured log correlation.
 */

const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000 // 30 days
const HMAC_ALGORITHM = 'sha256'

export type DigestTokenAction = 'unsubscribe' | 'resubscribe'

/**
 * Phase 8S shape (kept exported for back-compat with the unsubscribe
 * route). Phase 8W introduces the optional `action` + `user_id` fields
 * inside `DigestTokenPayload`; `verifyDigestUnsubscribeToken` returns
 * the original narrow shape so existing call sites are unchanged.
 */
export interface DigestUnsubscribeTokenPayload {
  venue_id: string
  exp: number
  nonce: string
}

/** Phase 8W full payload — superset of the Phase 8S shape. */
export interface DigestTokenPayload {
  venue_id: string
  exp: number
  nonce: string
  action: DigestTokenAction
  /** Required when action === 'resubscribe'; absent for unsubscribe. */
  user_id?: string
}

// ============================================================================
// Errors
// ============================================================================

export type DigestUnsubscribeTokenErrorCode =
  | 'secret_missing'
  | 'malformed_token'
  | 'invalid_signature'
  | 'expired'
  | 'invalid_payload'
  // Phase 8W — added so callers can distinguish "right shape, wrong
  // action" (e.g. an unsubscribe token presented at the resubscribe
  // route) without leaking which dimension failed in the HTML response.
  | 'action_mismatch'

export class DigestUnsubscribeTokenError extends Error {
  constructor(public readonly code: DigestUnsubscribeTokenErrorCode) {
    super(code)
    this.name = 'DigestUnsubscribeTokenError'
  }
}

// ============================================================================
// base64url helpers (Node's `.toString('base64url')` is RFC-4648 compliant)
// ============================================================================

function b64uEncode(buf: Buffer): string {
  return buf.toString('base64url')
}

function b64uDecode(s: string): Buffer {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) {
    throw new DigestUnsubscribeTokenError('malformed_token')
  }
  return Buffer.from(s, 'base64url')
}

// ============================================================================
// Secret access
// ============================================================================

function readSecret(): string {
  const s = process.env.DIGEST_UNSUBSCRIBE_SECRET
  if (!s || s.length < 16) {
    // Short secrets (<16 chars) are treated as missing — same posture as
    // Phase 8K's TOUR_ACTION_SECRET. Prevents demo-grade values from
    // leaking to prod.
    throw new DigestUnsubscribeTokenError('secret_missing')
  }
  return s
}

/**
 * Pure presence check — no client construction, no throw. Used by the
 * digest cron to decide whether to embed an unsubscribe link in the
 * outgoing email (we don't want to email a link that immediately fails
 * verify on click).
 */
export function digestUnsubscribeSecretConfigured(): boolean {
  const s = process.env.DIGEST_UNSUBSCRIBE_SECRET
  return Boolean(s && s.length >= 16)
}

// ============================================================================
// Internal — sign + verify
// ============================================================================

interface SignArgs {
  venueId: string
  action: DigestTokenAction
  userId?: string
  ttlMs?: number
}

function signToken(args: SignArgs): string {
  const secret = readSecret()
  if (!args.venueId || typeof args.venueId !== 'string') {
    throw new DigestUnsubscribeTokenError('invalid_payload')
  }
  if (args.action === 'resubscribe') {
    if (!args.userId || typeof args.userId !== 'string') {
      throw new DigestUnsubscribeTokenError('invalid_payload')
    }
  }
  const payload: DigestTokenPayload = {
    venue_id: args.venueId,
    exp: Date.now() + (args.ttlMs ?? DEFAULT_TTL_MS),
    nonce: randomBytes(16).toString('hex'),
    action: args.action,
    ...(args.action === 'resubscribe' && args.userId
      ? { user_id: args.userId }
      : {}),
  }
  const json = JSON.stringify(payload)
  const payloadPart = b64uEncode(Buffer.from(json, 'utf8'))
  const sigPart = b64uEncode(
    createHmac(HMAC_ALGORITHM, secret).update(payloadPart).digest()
  )
  return `${payloadPart}.${sigPart}`
}

/**
 * Phase 8W — single source of truth for verify. Returns the full
 * payload (including action + optional user_id). Public callers should
 * prefer `verifyDigestToken` (Phase 8W) or the narrow Phase 8S
 * `verifyDigestUnsubscribeToken` for the existing unsubscribe route.
 *
 * Constant-time signature compare via `timingSafeEqual`. Strict
 * base64url alphabet validation. Length cap protects against silly
 * inputs / DoS.
 */
function verifyTokenInternal(token: string): DigestTokenPayload {
  const secret = readSecret()
  if (typeof token !== 'string' || token.length === 0 || token.length > 4096) {
    throw new DigestUnsubscribeTokenError('malformed_token')
  }
  const parts = token.split('.')
  if (parts.length !== 2) {
    throw new DigestUnsubscribeTokenError('malformed_token')
  }
  const [payloadPart, sigPart] = parts

  const expectedSig = createHmac(HMAC_ALGORITHM, secret).update(payloadPart).digest()
  let providedSig: Buffer
  try {
    providedSig = b64uDecode(sigPart)
  } catch {
    throw new DigestUnsubscribeTokenError('malformed_token')
  }
  if (providedSig.length !== expectedSig.length) {
    throw new DigestUnsubscribeTokenError('invalid_signature')
  }
  if (!timingSafeEqual(providedSig, expectedSig)) {
    throw new DigestUnsubscribeTokenError('invalid_signature')
  }

  let decoded: unknown
  try {
    decoded = JSON.parse(b64uDecode(payloadPart).toString('utf8'))
  } catch {
    throw new DigestUnsubscribeTokenError('malformed_token')
  }
  if (!decoded || typeof decoded !== 'object') {
    throw new DigestUnsubscribeTokenError('invalid_payload')
  }
  const d = decoded as Record<string, unknown>
  if (typeof d.venue_id !== 'string' || d.venue_id.length === 0) {
    throw new DigestUnsubscribeTokenError('invalid_payload')
  }
  if (typeof d.exp !== 'number' || !Number.isFinite(d.exp)) {
    throw new DigestUnsubscribeTokenError('invalid_payload')
  }
  if (typeof d.nonce !== 'string' || d.nonce.length === 0) {
    throw new DigestUnsubscribeTokenError('invalid_payload')
  }
  if (d.exp < Date.now()) {
    throw new DigestUnsubscribeTokenError('expired')
  }

  // Phase 8W — action defaults to 'unsubscribe' so any Phase 8S token
  // signed before 8W shipped still verifies and dispatches to the
  // legacy unsubscribe route. New tokens always carry an explicit
  // action.
  let action: DigestTokenAction
  if (d.action === undefined || d.action === null) {
    action = 'unsubscribe'
  } else if (d.action === 'unsubscribe' || d.action === 'resubscribe') {
    action = d.action
  } else {
    throw new DigestUnsubscribeTokenError('invalid_payload')
  }

  let userId: string | undefined
  if (action === 'resubscribe') {
    if (typeof d.user_id !== 'string' || d.user_id.length === 0) {
      throw new DigestUnsubscribeTokenError('invalid_payload')
    }
    userId = d.user_id
  } else if (typeof d.user_id === 'string' && d.user_id.length > 0) {
    // Tolerate a user_id on unsubscribe tokens (forward-compat for any
    // future per-user unsubscribe flow); preserve it on the returned
    // payload so callers can log it if they care.
    userId = d.user_id
  }

  return {
    venue_id: d.venue_id,
    exp: d.exp,
    nonce: d.nonce,
    action,
    ...(userId ? { user_id: userId } : {}),
  }
}

// ============================================================================
// Public — token creation
// ============================================================================

export interface CreateDigestUnsubscribeUrlArgs {
  venueId: string
  ttlMs?: number
  /** Override the deploy URL — useful for tests. */
  appUrl?: string
}

/**
 * Builds the fully-qualified public unsubscribe URL (venue-level).
 * Format:
 *   <appUrl>/api/digest/unsubscribe?venue_id=<uuid>&token=<signed>
 *
 * Phase 8W — the underlying token now carries `action: 'unsubscribe'`
 * explicitly so the new `verifyDigestToken` can dispatch correctly. The
 * URL shape is unchanged.
 *
 * Throws `DigestUnsubscribeTokenError('secret_missing')` when the env
 * secret is absent — the digest cron catches this and sends a link-less
 * email with a one-shot warn.
 */
export function createDigestUnsubscribeUrl(args: CreateDigestUnsubscribeUrlArgs): string {
  const token = signToken({
    venueId: args.venueId,
    action: 'unsubscribe',
    ttlMs: args.ttlMs,
  })
  const appUrl = (args.appUrl ?? process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000')
    .replace(/\/$/, '')
  const u = new URL('/api/digest/unsubscribe', appUrl)
  u.searchParams.set('venue_id', args.venueId)
  u.searchParams.set('token', token)
  return u.toString()
}

/**
 * Phase 8W — bare token (no URL) for callers that want to embed the
 * token in their own surface (e.g. an alternate unsubscribe path).
 * Most callers should prefer `createDigestUnsubscribeUrl`.
 */
export function createDigestUnsubscribeToken(args: {
  venueId: string
  ttlMs?: number
}): string {
  return signToken({
    venueId: args.venueId,
    action: 'unsubscribe',
    ttlMs: args.ttlMs,
  })
}

export interface CreateDigestResubscribeUrlArgs {
  venueId: string
  userId: string
  ttlMs?: number
  appUrl?: string
}

/**
 * Phase 8W — self-serve resubscribe URL. Per-user; writes
 * `venue_members.metadata.digest_cadence = 'daily'` for the (venue_id,
 * user_id) pair.
 *
 * Format:
 *   <appUrl>/api/digest/resubscribe?venue_id=<uuid>&user_id=<uuid>&token=<signed>
 *
 * The route cross-checks that the URL `venue_id` + `user_id` match the
 * signed payload — a leaked unsubscribe token can NOT be replayed to
 * re-enable a different user, and a leaked resubscribe token can NOT
 * be replayed against a different venue or user.
 */
export function createDigestResubscribeUrl(args: CreateDigestResubscribeUrlArgs): string {
  const token = signToken({
    venueId: args.venueId,
    userId: args.userId,
    action: 'resubscribe',
    ttlMs: args.ttlMs,
  })
  const appUrl = (args.appUrl ?? process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000')
    .replace(/\/$/, '')
  const u = new URL('/api/digest/resubscribe', appUrl)
  u.searchParams.set('venue_id', args.venueId)
  u.searchParams.set('user_id', args.userId)
  u.searchParams.set('token', token)
  return u.toString()
}

/**
 * Phase 8W — bare resubscribe token. Same back-compat trade-off as
 * `createDigestUnsubscribeToken`: most callers want
 * `createDigestResubscribeUrl`.
 */
export function createDigestResubscribeToken(args: {
  venueId: string
  userId: string
  ttlMs?: number
}): string {
  return signToken({
    venueId: args.venueId,
    userId: args.userId,
    action: 'resubscribe',
    ttlMs: args.ttlMs,
  })
}

// ============================================================================
// Public — verification
// ============================================================================

/**
 * Phase 8S — narrow verify for the existing unsubscribe route. Returns
 * the original Phase 8S shape (no action field). Throws
 * `action_mismatch` if the token carries `action: 'resubscribe'` —
 * prevents a leaked resubscribe token from being POSTed at the
 * unsubscribe route to flip the venue-level flag.
 *
 * Existing Phase 8S tokens (no `action` field on the payload) default
 * to 'unsubscribe' inside `verifyTokenInternal`, so they continue to
 * verify here without change.
 */
export function verifyDigestUnsubscribeToken(
  token: string
): DigestUnsubscribeTokenPayload {
  const payload = verifyTokenInternal(token)
  if (payload.action !== 'unsubscribe') {
    throw new DigestUnsubscribeTokenError('action_mismatch')
  }
  return {
    venue_id: payload.venue_id,
    exp: payload.exp,
    nonce: payload.nonce,
  }
}

export interface VerifiedDigestToken {
  venueId: string
  action: DigestTokenAction
  /** Always present when action === 'resubscribe'; may be present on
   *  unsubscribe tokens for forward-compat. */
  userId?: string
  /** Token expiry (unix ms). */
  exp: number
  /** Random per-token nonce — useful for audit log correlation. */
  nonce: string
}

/**
 * Phase 8W — unified verify for callers that want to handle both
 * actions in the same handler. Returns camelCased fields to match the
 * call-site convention used by the public routes.
 *
 * Throws `DigestUnsubscribeTokenError` (with a typed code) on any
 * failure; the route layer maps each code to an HTML page.
 */
export function verifyDigestToken(token: string): VerifiedDigestToken {
  const p = verifyTokenInternal(token)
  return {
    venueId: p.venue_id,
    action: p.action,
    ...(p.user_id ? { userId: p.user_id } : {}),
    exp: p.exp,
    nonce: p.nonce,
  }
}

/**
 * Returns a structured-log-safe fragment of a token: `<head6>…<tail6>`.
 * Never enough to replay — payload prefix alone can't reconstruct the
 * HMAC. Use this in every log line that wants to correlate token
 * activity without leaking the whole value.
 */
export function redactDigestUnsubscribeToken(
  token: string | undefined | null
): string {
  if (!token || typeof token !== 'string') return '<no-token>'
  const parts = token.split('.')
  if (parts.length !== 2) return '<malformed>'
  const head = parts[0].slice(0, 6)
  const tail = parts[1].slice(0, 6)
  return `${head}…${tail}`
}
