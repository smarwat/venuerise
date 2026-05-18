import 'server-only'
import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * Internal HMAC signer for service-to-service calls inside VenueRise.
 *
 * Used as a temporary bridge so anonymous flows (e.g. the public widget) can
 * trigger authenticated-only internal pipelines (e.g. /api/ai/qualify)
 * without exposing those pipelines to the open internet.
 *
 * This module is intentionally isolated so it can be replaced cleanly
 * by a real job queue (Inngest / Trigger.dev / BullMQ) later — when that
 * happens, internal HTTP fan-out should disappear and this file with it.
 *
 * Marked `server-only` so an accidental client import fails the build.
 */

export const INTERNAL_SIGNATURE_HEADER = 'x-venuerise-signature' as const

function getSecret(): string {
  const secret = process.env.INTERNAL_API_SECRET
  if (!secret) {
    throw new Error(
      '[internal-hmac] INTERNAL_API_SECRET is not set. ' +
        'Add it to .env.local (generate with `openssl rand -hex 32`).'
    )
  }
  if (secret.length < 32) {
    throw new Error('[internal-hmac] INTERNAL_API_SECRET must be at least 32 characters.')
  }
  return secret
}

/**
 * Stable JSON stringify — keys sorted recursively so the same logical
 * payload always produces the same signature regardless of key order.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']'
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  const parts = keys.map((k) => JSON.stringify(k) + ':' + stableStringify(obj[k]))
  return '{' + parts.join(',') + '}'
}

/** Sign the canonical JSON form of `body` and return a hex digest. */
export function signInternalRequest(body: unknown): string {
  const secret = getSecret()
  const payload = stableStringify(body)
  return createHmac('sha256', secret).update(payload).digest('hex')
}

/**
 * Verify a signature against `body`. Returns false on any failure (missing
 * signature, malformed body, bad signature) — never throws. Uses constant-time
 * compare to avoid timing attacks.
 */
export function verifyInternalRequest(body: unknown, signature: string | null): boolean {
  if (!signature || typeof signature !== 'string') return false

  let expected: string
  try {
    expected = signInternalRequest(body)
  } catch {
    return false
  }

  // Same length required for timingSafeEqual
  if (signature.length !== expected.length) return false

  try {
    return timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex'))
  } catch {
    return false
  }
}
