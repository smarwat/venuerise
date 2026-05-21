/**
 * Phase 9G — Email domain helpers for the SSO subsystem.
 *
 * Pure functions. NO database access, NO env reads. Used by both
 * the SSO routes (initiate / callback) and the admin connection
 * create endpoint to keep the domain shape consistent across
 * write + lookup paths.
 *
 * Validation is INTENTIONALLY conservative:
 *   - lowercase + trim
 *   - reject empty + whitespace-only
 *   - reject obvious garbage (no dot, includes spaces, starts/ends
 *     with `.` or `-`, contains protocol prefix)
 *
 * We do NOT do full RFC-1035 validation here — the operator-facing
 * mistakes we want to catch are `Acme.com` (case), `acme.com `
 * (whitespace), `@acme.com` (leading @), and `https://acme.com`
 * (pasted URL). True DNS validation belongs at the vendor handshake
 * step, not in our domain normalizer.
 */

const DOMAIN_REGEX = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/
const MAX_DOMAIN_LEN = 253 // per DNS spec

/**
 * Lowercase + trim + strip leading `@` and protocol prefix. Returns
 * `null` when the result fails `isLikelyValidDomain`.
 */
export function normalizeEmailDomain(input: string): string | null {
  if (typeof input !== 'string') return null
  let s = input.trim().toLowerCase()
  if (s.length === 0) return null
  // Strip leading `@` so an operator can paste `@acme.com`.
  if (s.startsWith('@')) s = s.slice(1)
  // Strip protocol prefixes for pasted URLs.
  if (s.startsWith('https://')) s = s.slice('https://'.length)
  else if (s.startsWith('http://')) s = s.slice('http://'.length)
  // Strip trailing path / query if pasted.
  const slashIdx = s.indexOf('/')
  if (slashIdx >= 0) s = s.slice(0, slashIdx)
  // Strip port suffix (`:443`) defensively.
  const colonIdx = s.indexOf(':')
  if (colonIdx >= 0) s = s.slice(0, colonIdx)
  if (!isLikelyValidDomain(s)) return null
  return s
}

/**
 * Pull the domain portion out of an email. Returns `null` for
 * inputs that don't pass minimum email shape checks. Does NOT
 * fully validate the local part (that's a different problem).
 */
export function extractDomainFromEmail(email: string): string | null {
  if (typeof email !== 'string') return null
  const trimmed = email.trim()
  if (trimmed.length === 0) return null
  const atIdx = trimmed.lastIndexOf('@')
  if (atIdx < 1) return null
  // Ensure there's a local part + something after the @.
  if (atIdx === trimmed.length - 1) return null
  const domain = trimmed.slice(atIdx + 1)
  return normalizeEmailDomain(domain)
}

/**
 * Final guard before we accept a domain into the database. Tight
 * regex + length check. NO DNS lookup.
 */
export function isLikelyValidDomain(domain: string): boolean {
  if (typeof domain !== 'string') return false
  if (domain.length === 0 || domain.length > MAX_DOMAIN_LEN) return false
  // No whitespace allowed inside the domain at this point.
  if (/\s/.test(domain)) return false
  // Must match the lowercase domain regex.
  return DOMAIN_REGEX.test(domain)
}
