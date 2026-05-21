/**
 * Phase 8BF — Meta webhook signature verification.
 *
 * Implements the `X-Hub-Signature-256` HMAC verification Meta
 * (Facebook / Instagram / Graph) requires on every webhook
 * delivery. Pure function — no I/O, no logging — so it can be
 * unit-tested without spinning up a request.
 *
 * Contract:
 *   - Raw body must be the EXACT bytes Meta sent. Do not
 *     re-serialize after JSON.parse; the HMAC is computed over
 *     the raw transport payload.
 *   - `signatureHeader` is the literal `X-Hub-Signature-256`
 *     value, e.g. `sha256=<hex>`.
 *   - Constant-time comparison via `crypto.timingSafeEqual` so
 *     a mismatch doesn't leak signature byte-by-byte.
 *
 * Honesty contract:
 *   - NEVER logs the signature, the secret, or the body.
 *   - Returns a discriminated union so the caller can
 *     translate to a safe HTTP status without leaking which
 *     part of verification failed in the response body.
 */

import 'server-only'
import { createHmac, timingSafeEqual } from 'node:crypto'

export type MetaSignatureFailure =
  | 'missing_secret'
  | 'missing_signature'
  | 'bad_format'
  | 'invalid_signature'

export type MetaSignatureResult =
  | { ok: true }
  | { ok: false; reason: MetaSignatureFailure }

const SIGNATURE_PREFIX = 'sha256='

function hexToBuffer(hex: string): Buffer | null {
  if (hex.length === 0 || hex.length % 2 !== 0) return null
  if (!/^[0-9a-f]+$/i.test(hex)) return null
  return Buffer.from(hex, 'hex')
}

export function verifyMetaSignature(
  rawBody: string | Buffer,
  signatureHeader: string | null | undefined,
  appSecret: string | undefined | null
): MetaSignatureResult {
  if (!appSecret || typeof appSecret !== 'string' || appSecret.length === 0) {
    return { ok: false, reason: 'missing_secret' }
  }
  if (!signatureHeader || typeof signatureHeader !== 'string') {
    return { ok: false, reason: 'missing_signature' }
  }
  if (!signatureHeader.startsWith(SIGNATURE_PREFIX)) {
    return { ok: false, reason: 'bad_format' }
  }
  const hex = signatureHeader.slice(SIGNATURE_PREFIX.length).trim()
  const provided = hexToBuffer(hex)
  if (!provided) {
    return { ok: false, reason: 'bad_format' }
  }

  const bodyBuf: Buffer =
    typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : rawBody

  const computed = createHmac('sha256', appSecret).update(bodyBuf).digest()
  // timingSafeEqual throws when lengths differ; the hex check
  // above already validates length parity but defend explicitly
  // so an attacker can't probe by sending a short signature.
  if (computed.length !== provided.length) {
    return { ok: false, reason: 'invalid_signature' }
  }
  if (!timingSafeEqual(computed, provided)) {
    return { ok: false, reason: 'invalid_signature' }
  }
  return { ok: true }
}
