import 'server-only'
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

/**
 * Phase 8S — HMAC-signed unsubscribe tokens for the operator activity
 * digest email.
 *
 * Mirrors the Phase 8K `tour-action-token.ts` shape (same crypto, same
 * base64url encoding, same constant-time compare), but lives in its own
 * module + uses its own secret so a leaked tour-action key can't be
 * replayed against the digest unsubscribe surface.
 *
 * ── TOKEN PAYLOAD ─────────────────────────────────────────────────────────
 *   { venue_id: string, exp: number (unix ms), nonce: string }
 *
 * Single-use is NOT enforced — the unsubscribe action is idempotent
 * (flipping `subscriptions.metadata.digest_disabled = true` twice is a
 * no-op). The nonce ensures every issued URL is unique even when the
 * cron sends two digests in the same minute.
 *
 * ── SECRET ────────────────────────────────────────────────────────────────
 * Read from `DIGEST_UNSUBSCRIBE_SECRET`. If unset/short (<16 chars),
 * treat as missing — the digest sender falls back to a link-less email
 * with a one-shot warn.
 *
 * ── PRIVACY ───────────────────────────────────────────────────────────────
 * No PII in the token payload — venue_id only. Never log the full
 * token; use `redactDigestUnsubscribeToken()` (short head…tail) for
 * structured log correlation.
 */

const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000 // 30 days
const HMAC_ALGORITHM = 'sha256'

export interface DigestUnsubscribeTokenPayload {
  venue_id: string
  exp: number
  nonce: string
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
// createDigestUnsubscribeUrl
// ============================================================================

export interface CreateDigestUnsubscribeUrlArgs {
  venueId: string
  ttlMs?: number
  /** Override the deploy URL — useful for tests. */
  appUrl?: string
}

/**
 * Builds the fully-qualified public unsubscribe URL. Format:
 *   <appUrl>/api/digest/unsubscribe?venue_id=<uuid>&token=<signed>
 *
 * Throws `DigestUnsubscribeTokenError('secret_missing')` when the env
 * secret is absent — the digest cron catches this and sends a link-less
 * email with a one-shot warn.
 */
export function createDigestUnsubscribeUrl(args: CreateDigestUnsubscribeUrlArgs): string {
  const secret = readSecret()
  if (!args.venueId || typeof args.venueId !== 'string') {
    throw new DigestUnsubscribeTokenError('invalid_payload')
  }
  const payload: DigestUnsubscribeTokenPayload = {
    venue_id: args.venueId,
    exp: Date.now() + (args.ttlMs ?? DEFAULT_TTL_MS),
    nonce: randomBytes(16).toString('hex'),
  }
  const json = JSON.stringify(payload)
  const payloadPart = b64uEncode(Buffer.from(json, 'utf8'))
  const sigPart = b64uEncode(
    createHmac(HMAC_ALGORITHM, secret).update(payloadPart).digest()
  )
  const token = `${payloadPart}.${sigPart}`
  const appUrl = (args.appUrl ?? process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000')
    .replace(/\/$/, '')
  const u = new URL('/api/digest/unsubscribe', appUrl)
  u.searchParams.set('venue_id', args.venueId)
  u.searchParams.set('token', token)
  return u.toString()
}

// ============================================================================
// verifyDigestUnsubscribeToken
// ============================================================================

/**
 * Returns the parsed payload on success. Throws a typed
 * `DigestUnsubscribeTokenError` on any verification failure — the
 * caller (the public unsubscribe route) maps each code to an HTML
 * error page.
 *
 * Constant-time signature compare via `timingSafeEqual`. Strict
 * base64url alphabet validation. Length cap protects against silly
 * inputs / DoS.
 */
export function verifyDigestUnsubscribeToken(
  token: string
): DigestUnsubscribeTokenPayload {
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

  return { venue_id: d.venue_id, exp: d.exp, nonce: d.nonce }
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
