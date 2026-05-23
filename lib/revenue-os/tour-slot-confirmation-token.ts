import 'server-only'
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { log } from '@/lib/log'

/**
 * Phase 8BL — Lead-Side Tour Confirmation Tokens.
 *
 * When the AI offers concrete tour slots in a reply, the
 * orchestrator calls `createTourSlotConfirmationToken` once per
 * offered slot. The lead clicks the link; the public POST route
 * calls `validateTourSlotConfirmationToken`, re-checks slot
 * availability, creates a `tours` row, then calls
 * `markTourSlotConfirmationTokenUsed` to flip the token to `used`.
 *
 * ── DESIGN: TWO LAYERS OF DEFENSE ─────────────────────────────────────────
 * 1. HMAC-SHA256 signature over a compact JSON payload — proves the
 *    token was issued by us and not synthesized by an attacker.
 * 2. DB row keyed by SHA-256 hash of the raw token — single-use
 *    enforcement, expiry, and a venue/lead/slot context the route
 *    re-checks against (defense against a re-encoded but valid
 *    signature attempting to book a different slot).
 *
 * Both layers must pass for the link to redeem. Either failing
 * short-circuits to an "invalid link" surface.
 *
 * ── PAYLOAD ───────────────────────────────────────────────────────────────
 *   {
 *     token_id: string  // uuid (matches the row's id column)
 *     venue_id: string  // uuid
 *     lead_id:  string  // uuid
 *     slot_starts_at: string  // ISO UTC
 *     exp: number   // unix ms — same epoch as Date.now()
 *     nonce: string  // 32 hex chars (16 random bytes)
 *   }
 *
 * The fields are intentionally minimal: enough to fast-fail an
 * obviously-malformed click, but the DB row is the source of truth
 * for venue, lead, slot times, and status.
 *
 * ── NO RAW TOKEN STORAGE ──────────────────────────────────────────────────
 * The raw token is returned ONCE from `createTourSlotConfirmationToken`
 * and embedded in the URL the AI hands to the lead. We never log it,
 * never put it in audit metadata, never persist it. The DB row holds
 * the SHA-256 hash; comparing a provided token against the hash uses
 * a constant-time compare to defeat timing oracles.
 *
 * ── SECRET MANAGEMENT ─────────────────────────────────────────────────────
 * Reuses `TOUR_ACTION_SECRET` (the same env that backs Phase 8K).
 * Operators only need to set ONE secret to enable both lead-action
 * links and slot-confirmation links. Treated as `secret_missing`
 * (typed error) when unset or shorter than 16 chars.
 */

const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000 // 7 days
const HMAC_ALGORITHM = 'sha256'

export type TourSlotConfirmationTokenStatus =
  | 'active'
  | 'used'
  | 'expired'
  | 'revoked'

export type TourSlotConfirmationTokenErrorCode =
  | 'secret_missing'       // TOUR_ACTION_SECRET unset — caller should fail soft
  | 'malformed_token'      // wrong shape / not two parts / non-base64url
  | 'invalid_signature'    // HMAC mismatch (tamper)
  | 'expired'              // payload exp < now OR DB row past expires_at
  | 'invalid_payload'      // JSON decoded but fields missing/wrong type
  | 'not_found'            // signature valid + payload sane, but no DB row
  | 'already_used'         // DB row exists but status is 'used'
  | 'revoked'              // DB row exists but status is 'revoked'
  | 'slot_mismatch'        // payload claims a slot the DB row doesn't have
  | 'lead_mismatch'        // payload claims a lead the DB row doesn't have

export class TourSlotConfirmationTokenError extends Error {
  constructor(public readonly code: TourSlotConfirmationTokenErrorCode) {
    super(code)
    this.name = 'TourSlotConfirmationTokenError'
  }
}

// ============================================================================
// Base64url helpers (mirror lib/integrations/tour-action-token.ts conventions)
// ============================================================================

function b64uEncode(buf: Buffer): string {
  return buf.toString('base64url')
}

function b64uDecode(s: string): Buffer {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) {
    throw new TourSlotConfirmationTokenError('malformed_token')
  }
  return Buffer.from(s, 'base64url')
}

// ============================================================================
// Secret access
// ============================================================================

function readSecret(): string {
  const s = process.env.TOUR_ACTION_SECRET
  if (!s || s.length < 16) {
    throw new TourSlotConfirmationTokenError('secret_missing')
  }
  return s
}

/**
 * Cheap synchronous check the caller (orchestrator) uses to decide
 * whether to even attempt to mint links. When false, we skip
 * link generation entirely and the AI prompt block falls through
 * to the no-links wording.
 */
export function tourSlotConfirmationSecretConfigured(): boolean {
  const s = process.env.TOUR_ACTION_SECRET
  return Boolean(s && s.length >= 16)
}

// ============================================================================
// Hash helper
// ============================================================================

/**
 * SHA-256 hex of the raw token string. The DB column stores this;
 * the URL carries the raw token. The hash is what the route looks
 * up by — never the raw token — so a snapshot of the table is
 * not actionable.
 */
function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

// ============================================================================
// createTourSlotConfirmationToken
// ============================================================================

export interface CreateTourSlotConfirmationTokenArgs {
  supabase: SupabaseClient
  venueId: string
  leadId: string
  conversationId?: string | null
  offeredByMessageId?: string | null
  slot: {
    startsAt: string  // ISO UTC
    endsAt: string    // ISO UTC
    label?: string | null
    rationale?: string | null
  }
  timezone?: string | null
  /** Override default 7-day TTL. */
  ttlMs?: number
  requestId?: string
}

export interface CreateTourSlotConfirmationTokenResult {
  /** The raw URL-safe token string. Embed in the link the lead receives. */
  token: string
  /** The full confirmation URL (`<APP_URL>/tour/confirm-slot/<token>`). */
  confirmationUrl: string
  /** The DB row id (matches the token payload's `token_id`). */
  tokenId: string
  /** ISO UTC expiry timestamp. */
  expiresAt: string
}

/**
 * Mint a fresh single-use confirmation token for one offered tour
 * slot, store its hash in `tour_slot_confirmation_tokens`, and
 * return the raw URL the AI hands to the lead.
 *
 * Failure modes:
 *   - `TourSlotConfirmationTokenError('secret_missing')`:
 *     `TOUR_ACTION_SECRET` env var not set — orchestrator catches
 *     and skips link generation for this AI reply (the prompt
 *     falls through to "team will confirm" wording).
 *   - Any DB insertion error: propagates after logging. The caller
 *     wraps a try/catch and treats failure as "no link for this
 *     slot" — the lead still gets the textual slot offer, just no
 *     clickable link.
 */
export async function createTourSlotConfirmationToken(
  args: CreateTourSlotConfirmationTokenArgs
): Promise<CreateTourSlotConfirmationTokenResult> {
  const secret = readSecret()
  const reqLog = log.child({
    requestId: args.requestId,
    op: 'tour_slot_confirmation_token.create',
    venueId: args.venueId,
    leadId: args.leadId,
  })

  if (
    typeof args.venueId !== 'string' ||
    args.venueId.length === 0 ||
    typeof args.leadId !== 'string' ||
    args.leadId.length === 0
  ) {
    throw new TourSlotConfirmationTokenError('invalid_payload')
  }
  const startMs = Date.parse(args.slot.startsAt)
  const endMs = Date.parse(args.slot.endsAt)
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    throw new TourSlotConfirmationTokenError('invalid_payload')
  }

  const ttlMs = clampTtl(args.ttlMs ?? DEFAULT_TTL_MS)
  const expiresAtMs = Date.now() + ttlMs
  const expiresAtIso = new Date(expiresAtMs).toISOString()

  // The token's UUID is generated client-side so we can include it
  // in the payload (the route uses it to look up the row directly
  // instead of scanning by hash — both work, but a PK lookup is
  // cheaper and lets us narrow the index plan).
  const tokenId = generateUuid()

  const payload = {
    token_id: tokenId,
    venue_id: args.venueId,
    lead_id: args.leadId,
    slot_starts_at: args.slot.startsAt,
    exp: expiresAtMs,
    nonce: randomBytes(16).toString('hex'),
  }
  const payloadJson = JSON.stringify(payload)
  const payloadPart = b64uEncode(Buffer.from(payloadJson, 'utf8'))
  const sig = createHmac(HMAC_ALGORITHM, secret).update(payloadPart).digest()
  const sigPart = b64uEncode(sig)
  const token = `${payloadPart}.${sigPart}`
  const tokenHash = hashToken(token)

  // Insert the row BEFORE returning the token to the caller. If the
  // insert fails (constraint violation, DB outage) the token is
  // dead-on-arrival and the caller never gets a redeemable string.
  const { error } = await args.supabase
    .from('tour_slot_confirmation_tokens')
    .insert({
      id: tokenId,
      venue_id: args.venueId,
      lead_id: args.leadId,
      conversation_id: args.conversationId ?? null,
      offered_by_message_id: args.offeredByMessageId ?? null,
      token_hash: tokenHash,
      slot_starts_at: args.slot.startsAt,
      slot_ends_at: args.slot.endsAt,
      timezone: args.timezone ?? null,
      status: 'active',
      expires_at: expiresAtIso,
      // Metadata holds operator-visible labels and the rationale
      // string. NEVER persist the raw token or the URL here — both
      // are derivable only with the secret.
      metadata: {
        slot_label: args.slot.label ?? null,
        slot_rationale: args.slot.rationale ?? null,
      },
    })

  if (error) {
    reqLog.error(
      { err: error },
      'tour_slot_confirmation_token.insert_failed'
    )
    throw error
  }

  const appUrl = (process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000')
    .replace(/\/$/, '')
  const confirmationUrl = `${appUrl}/tour/confirm-slot/${encodeURIComponent(token)}`

  return {
    token,
    confirmationUrl,
    tokenId,
    expiresAt: expiresAtIso,
  }
}

// ============================================================================
// validateTourSlotConfirmationToken
// ============================================================================

export interface ValidateTourSlotConfirmationTokenArgs {
  supabase: SupabaseClient
  token: string
  /** Override clock for tests. Defaults to Date.now(). */
  nowMs?: number
}

export interface ValidatedTourSlotConfirmationToken {
  tokenId: string
  venueId: string
  leadId: string
  conversationId: string | null
  offeredByMessageId: string | null
  slotStartsAt: string
  slotEndsAt: string
  timezone: string | null
  expiresAt: string
  slotLabel: string | null
  slotRationale: string | null
}

/**
 * Verify the HMAC signature, then look up the row, then validate
 * status + expiry + slot-field coherence. Returns a clean object
 * the route uses to render the confirm UI + drive the tour-creation
 * branch.
 *
 * Read-only — does NOT flip the row to `used`. Call
 * `markTourSlotConfirmationTokenUsed` from the POST route AFTER
 * the tour row is created.
 */
export async function validateTourSlotConfirmationToken(
  args: ValidateTourSlotConfirmationTokenArgs
): Promise<ValidatedTourSlotConfirmationToken> {
  const secret = readSecret()
  const nowMs = args.nowMs ?? Date.now()

  // ── 1. Shape + signature check (pure crypto) ───────────────────────────
  if (
    typeof args.token !== 'string' ||
    args.token.length === 0 ||
    args.token.length > 4096
  ) {
    throw new TourSlotConfirmationTokenError('malformed_token')
  }
  const parts = args.token.split('.')
  if (parts.length !== 2) {
    throw new TourSlotConfirmationTokenError('malformed_token')
  }
  const [payloadPart, sigPart] = parts

  const expectedSig = createHmac(HMAC_ALGORITHM, secret)
    .update(payloadPart)
    .digest()
  let providedSig: Buffer
  try {
    providedSig = b64uDecode(sigPart)
  } catch {
    throw new TourSlotConfirmationTokenError('malformed_token')
  }
  if (providedSig.length !== expectedSig.length) {
    throw new TourSlotConfirmationTokenError('invalid_signature')
  }
  if (!timingSafeEqual(providedSig, expectedSig)) {
    throw new TourSlotConfirmationTokenError('invalid_signature')
  }

  let payload: {
    token_id: string
    venue_id: string
    lead_id: string
    slot_starts_at: string
    exp: number
    nonce: string
  }
  try {
    const decoded = JSON.parse(b64uDecode(payloadPart).toString('utf8'))
    if (!decoded || typeof decoded !== 'object') {
      throw new TourSlotConfirmationTokenError('invalid_payload')
    }
    const d = decoded as Record<string, unknown>
    if (
      typeof d.token_id !== 'string' ||
      typeof d.venue_id !== 'string' ||
      typeof d.lead_id !== 'string' ||
      typeof d.slot_starts_at !== 'string' ||
      typeof d.exp !== 'number' ||
      typeof d.nonce !== 'string'
    ) {
      throw new TourSlotConfirmationTokenError('invalid_payload')
    }
    payload = {
      token_id: d.token_id,
      venue_id: d.venue_id,
      lead_id: d.lead_id,
      slot_starts_at: d.slot_starts_at,
      exp: d.exp,
      nonce: d.nonce,
    }
  } catch (err) {
    if (err instanceof TourSlotConfirmationTokenError) throw err
    throw new TourSlotConfirmationTokenError('malformed_token')
  }

  if (payload.exp < nowMs) {
    throw new TourSlotConfirmationTokenError('expired')
  }

  // ── 2. DB row lookup ───────────────────────────────────────────────────
  // We look up by token_id (PK) AND token_hash. The hash check is the
  // belt-and-suspenders against a payload whose `token_id` field was
  // tampered with after signature verification (impossible without the
  // secret, but the explicit check makes the safety guarantee local).
  const tokenHash = hashToken(args.token)
  const { data: rowRaw, error } = await args.supabase
    .from('tour_slot_confirmation_tokens')
    .select(
      'id, venue_id, lead_id, conversation_id, offered_by_message_id, slot_starts_at, slot_ends_at, timezone, status, expires_at, metadata'
    )
    .eq('id', payload.token_id)
    .eq('token_hash', tokenHash)
    .maybeSingle()

  if (error) {
    log.error(
      { err: error, tokenId: payload.token_id },
      'tour_slot_confirmation_token.db_lookup_failed'
    )
    throw error
  }
  if (!rowRaw) {
    throw new TourSlotConfirmationTokenError('not_found')
  }

  const row = rowRaw as {
    id: string
    venue_id: string
    lead_id: string
    conversation_id: string | null
    offered_by_message_id: string | null
    slot_starts_at: string
    slot_ends_at: string
    timezone: string | null
    status: string
    expires_at: string
    metadata: Record<string, unknown> | null
  }

  // ── 3. Status checks ───────────────────────────────────────────────────
  if (row.status === 'used') {
    throw new TourSlotConfirmationTokenError('already_used')
  }
  if (row.status === 'revoked') {
    throw new TourSlotConfirmationTokenError('revoked')
  }
  if (row.status === 'expired') {
    throw new TourSlotConfirmationTokenError('expired')
  }
  // DB-side expiry. Belt-and-suspenders for the rare race where the
  // payload's exp is just past now but the row hasn't been swept yet.
  if (Date.parse(row.expires_at) < nowMs) {
    throw new TourSlotConfirmationTokenError('expired')
  }

  // ── 4. Field coherence ────────────────────────────────────────────────
  // The payload was signed by us, but a hostile re-encode + replay
  // could in theory mix payload fields with DB fields. We assert the
  // payload's claims match the DB row. Any mismatch → 'slot_mismatch'
  // or 'lead_mismatch' — render the same "invalid link" surface.
  if (row.lead_id !== payload.lead_id || row.venue_id !== payload.venue_id) {
    throw new TourSlotConfirmationTokenError('lead_mismatch')
  }
  if (row.slot_starts_at !== payload.slot_starts_at) {
    throw new TourSlotConfirmationTokenError('slot_mismatch')
  }

  const meta = (row.metadata ?? {}) as Record<string, unknown>
  return {
    tokenId: row.id,
    venueId: row.venue_id,
    leadId: row.lead_id,
    conversationId: row.conversation_id,
    offeredByMessageId: row.offered_by_message_id,
    slotStartsAt: row.slot_starts_at,
    slotEndsAt: row.slot_ends_at,
    timezone: row.timezone,
    expiresAt: row.expires_at,
    slotLabel: typeof meta.slot_label === 'string' ? meta.slot_label : null,
    slotRationale:
      typeof meta.slot_rationale === 'string' ? meta.slot_rationale : null,
  }
}

// ============================================================================
// markTourSlotConfirmationTokenUsed
// ============================================================================

export interface MarkTokenUsedArgs {
  supabase: SupabaseClient
  tokenId: string
  /**
   * The tours row id the redemption produced. Optional because the
   * route flips status BEFORE creating the tour (so a lost race
   * short-circuits without an orphan tour) and then back-fills
   * `used_tour_id` via a second update once the insert succeeds.
   * Passing null here flips status + used_at only.
   */
  tourId?: string | null
  /** Source IP (already masked) for the audit metadata. */
  maskedIp?: string | null
  /** Truncated UA string for the audit metadata. */
  userAgent?: string | null
}

export interface MarkTokenUsedResult {
  /** True if WE flipped the row. False if it was already used (race lost). */
  flipped: boolean
}

/**
 * Atomically flips the token row from 'active' → 'used'. The
 * `eq('status', 'active')` predicate is the single-use claim — if
 * two concurrent clicks race, exactly one of them updates a row;
 * the other gets `flipped: false` and the route caller falls
 * through to "already used."
 *
 * Idempotent: calling twice is safe. Second call returns
 * `flipped: false` and the audit row isn't double-stamped (the
 * route only writes the audit + creates the tour on `flipped: true`).
 */
export async function markTourSlotConfirmationTokenUsed(
  args: MarkTokenUsedArgs
): Promise<MarkTokenUsedResult> {
  // Deliberately do NOT touch the metadata column here — the
  // issue-time values (slot_label, slot_rationale) must survive
  // redemption. Redemption-side context (masked IP, UA) lands on
  // the audit row written by the route, not on the token row.
  // That keeps this update narrow and avoids needing a jsonb merge.
  const usedAtIso = new Date().toISOString()
  const updatePayload: Record<string, unknown> = {
    status: 'used',
    used_at: usedAtIso,
  }
  if (typeof args.tourId === 'string' && args.tourId.length > 0) {
    updatePayload.used_tour_id = args.tourId
  }
  const { data, error } = await args.supabase
    .from('tour_slot_confirmation_tokens')
    .update(updatePayload)
    // Single-use claim — only flip rows still in 'active'. If two
    // concurrent clicks race, exactly one update affects a row;
    // the loser returns no data and the route falls through to
    // "already used."
    .eq('id', args.tokenId)
    .eq('status', 'active')
    .select('id')
    .maybeSingle()

  if (error) {
    log.error(
      { err: error, tokenId: args.tokenId },
      'tour_slot_confirmation_token.mark_used_failed'
    )
    throw error
  }
  // maskedIp + userAgent are accepted on the signature for symmetry
  // with the eventual audit row written by the route; they're not
  // consumed here today but kept in the API so callers don't have
  // to plumb them through twice.
  void args.maskedIp
  void args.userAgent

  return { flipped: Boolean(data) }
}

// ============================================================================
// revokeActiveTokensForLead
// ============================================================================

/**
 * Flips every 'active' token for a lead+conversation to 'revoked'.
 * Called by the orchestrator BEFORE issuing fresh tokens in a new
 * AI reply — so stale links from earlier in the conversation don't
 * redeem after the lead picks a new time and the AI offers a
 * different set.
 *
 * Best-effort: failure is logged but never throws back to the
 * caller. Stale links are an annoyance, not a security issue (the
 * worst case is a lead clicks an old link and gets a tour at a
 * time we still consider valid via the recheck), so we don't
 * block the new reply on this update succeeding.
 */
export async function revokeActiveTokensForLead(args: {
  supabase: SupabaseClient
  leadId: string
  conversationId?: string | null
  requestId?: string
}): Promise<void> {
  try {
    let q = args.supabase
      .from('tour_slot_confirmation_tokens')
      .update({ status: 'revoked' })
      .eq('lead_id', args.leadId)
      .eq('status', 'active')
    if (args.conversationId) {
      q = q.eq('conversation_id', args.conversationId)
    }
    const { error } = await q
    if (error) {
      log.warn(
        { err: error, leadId: args.leadId },
        'tour_slot_confirmation_token.revoke_active_failed'
      )
    }
  } catch (err) {
    log.warn(
      { err, leadId: args.leadId },
      'tour_slot_confirmation_token.revoke_active_unexpected'
    )
  }
}

// ============================================================================
// Internals
// ============================================================================

function clampTtl(raw: number): number {
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_TTL_MS
  // Hard ceiling of 30 days to prevent accidental
  // "valid forever" tokens.
  const MAX = 30 * 24 * 60 * 60 * 1000
  return Math.min(raw, MAX)
}

/**
 * RFC-4122-shaped UUID v4 via Node crypto. Avoiding pulling in
 * the `uuid` npm package keeps this helper self-contained.
 */
function generateUuid(): string {
  const bytes = randomBytes(16)
  bytes[6] = (bytes[6] & 0x0f) | 0x40 // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80 // RFC 4122 variant
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/**
 * Returns a logging-safe short fragment of a token. Use this in
 * any structured log line that needs to correlate clicks without
 * leaking the raw token.
 */
export function redactSlotConfirmationToken(
  token: string | undefined | null
): string {
  if (!token || typeof token !== 'string') return '<no-token>'
  const parts = token.split('.')
  if (parts.length !== 2) return '<malformed>'
  return `${parts[0].slice(0, 6)}…${parts[1].slice(0, 6)}`
}
