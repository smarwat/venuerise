import 'server-only'
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { NextResponse, type NextRequest } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import {
  rateLimitUserAction,
  extractIp,
  rateLimitedResponse,
} from '@/lib/rate-limit'
import { log } from '@/lib/log'
import { captureApiError } from '@/lib/observability/sentry'
import {
  getOrCreateRequestId,
  withRequestIdHeader,
} from '@/lib/observability/request-id'
import { recordTourStatusEvent } from '@/lib/integrations/tour-status-events'

// NOTE on import shape: `sendTourNotificationEmail` lives in
// `tour-notifications.ts`, which itself imports from this file
// (`tryBuildTourActionUrls`, `tourActionSecretConfigured`,
// `TourActionTokenError`). To avoid a true circular dependency at module
// evaluation, we don't statically import the notification sender — the
// route handler `handleTourActionRequest` uses a lazy `await import()`
// for it instead. The cycle would resolve fine in practice (TypeScript
// only cares about live references during top-level evaluation), but a
// dynamic import keeps the dependency direction clear: token defines the
// primitives, notifications consume them.

/**
 * Phase 8K — short-lived signed tokens for lead-facing tour actions.
 *
 * Lets a lead confirm or cancel a tour by clicking a one-click link in
 * an outbound email (Phase 8G/8J `created`, `rescheduled`, `reminder_24h`,
 * `reminder_2h`) WITHOUT needing a dashboard account.
 *
 * ── DESIGN ─────────────────────────────────────────────────────────────────
 * Pure HMAC-SHA256 over a compact JSON payload, both halves base64url-
 * encoded:
 *
 *     <base64url(JSON payload)>.<base64url(HMAC bytes)>
 *
 * Verification is a constant-time compare via `timingSafeEqual`. We pull
 * the secret from `TOUR_ACTION_SECRET` (server-only, never bundled).
 *
 * ── NO DB STORAGE ─────────────────────────────────────────────────────────
 * This phase is migration-free. We do NOT persist tokens, nonces, or
 * "used" markers. Single-use cannot be perfectly enforced — instead, the
 * route handlers (`app/tour/confirm`, `app/tour/cancel`) implement
 * idempotent state transitions: a token clicked twice flips the tour
 * once and then no-ops with `already_handled`. A future migration will
 * add a `tour_action_events` table for true single-use + audit.
 *
 * ── PAYLOAD ───────────────────────────────────────────────────────────────
 *   {
 *     tour_id: string  // uuid
 *     action:  'confirm' | 'cancel'
 *     exp:     number   // unix ms — same epoch as Date.now()
 *     nonce:   string   // 16 hex chars (8 random bytes)
 *   }
 *
 * `nonce` does NOT enforce single-use; it's there so the same (tour, action,
 * exp) tuple can be re-issued with a fresh signature on every email send.
 * Without it, two emails sent in the same minute for the same lifecycle
 * stage would generate identical URLs — a small leakage risk if logs
 * surface URLs in two different places.
 *
 * ── LOGGING POSTURE ───────────────────────────────────────────────────────
 * Never log the full token. Route handlers should call `redactTourToken()`
 * before any structured-log emission so a leaked log line can't be replayed.
 */

const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000 // 7 days
const HMAC_ALGORITHM = 'sha256'

export type TourAction = 'confirm' | 'cancel'

export interface TourActionTokenPayload {
  tour_id: string
  action: TourAction
  exp: number
  nonce: string
}

// ============================================================================
// Errors
// ============================================================================

export type TourActionTokenErrorCode =
  | 'secret_missing'         // TOUR_ACTION_SECRET unset — caller should fail soft
  | 'malformed_token'        // wrong shape / not two parts / non-base64url
  | 'invalid_signature'      // HMAC mismatch (tamper)
  | 'expired'                // exp < now
  | 'invalid_payload'        // JSON decoded but fields missing/wrong type

export class TourActionTokenError extends Error {
  constructor(public readonly code: TourActionTokenErrorCode) {
    super(code)
    this.name = 'TourActionTokenError'
  }
}

// ============================================================================
// Base64url helpers — Node's built-in `'base64url'` encoding is RFC-4648
// compliant, but explicit wrappers make the intent obvious at call sites.
// ============================================================================

function b64uEncode(buf: Buffer): string {
  return buf.toString('base64url')
}

function b64uDecode(s: string): Buffer {
  // Reject anything outside the base64url alphabet so a stray `+` or `/`
  // can't sneak in via a copy-paste from a regular base64 source.
  if (!/^[A-Za-z0-9_-]*$/.test(s)) {
    throw new TourActionTokenError('malformed_token')
  }
  return Buffer.from(s, 'base64url')
}

// ============================================================================
// Secret access
// ============================================================================

function readSecret(): string {
  const s = process.env.TOUR_ACTION_SECRET
  if (!s || s.length < 16) {
    // <16 chars is unsafe for HMAC + a clear sign of misconfiguration.
    // Treat short secrets the same as missing so dev never accidentally
    // ships a weak demo value to staging.
    throw new TourActionTokenError('secret_missing')
  }
  return s
}

/**
 * Pure secret-presence check. Lets callers (e.g. the email sender) decide
 * whether to even attempt to build links — keeps the email path clean of
 * try/catch noise when the operator hasn't set the env var yet.
 */
export function tourActionSecretConfigured(): boolean {
  const s = process.env.TOUR_ACTION_SECRET
  return Boolean(s && s.length >= 16)
}

// ============================================================================
// createTourActionToken
// ============================================================================

export interface CreateTourActionTokenArgs {
  tourId: string
  action: TourAction
  /** Override default TTL. Defaults to 7 days. */
  ttlMs?: number
}

export function createTourActionToken(args: CreateTourActionTokenArgs): string {
  const secret = readSecret()
  if (!args.tourId || typeof args.tourId !== 'string') {
    throw new TourActionTokenError('invalid_payload')
  }
  if (args.action !== 'confirm' && args.action !== 'cancel') {
    throw new TourActionTokenError('invalid_payload')
  }
  const payload: TourActionTokenPayload = {
    tour_id: args.tourId,
    action: args.action,
    exp: Date.now() + (args.ttlMs ?? DEFAULT_TTL_MS),
    // Phase 8L — widened from 8 bytes (16 hex) to 16 bytes (32 hex).
    // The nonce is now also the single-use claim in `tour_action_events`
    // (unique on (tour_id, nonce)), so we want a generous birthday-bound.
    // At 16 bytes a collision within one tour is computationally impossible.
    nonce: randomBytes(16).toString('hex'),
  }
  const json = JSON.stringify(payload)
  const payloadPart = b64uEncode(Buffer.from(json, 'utf8'))
  const sig = createHmac(HMAC_ALGORITHM, secret).update(payloadPart).digest()
  const sigPart = b64uEncode(sig)
  return `${payloadPart}.${sigPart}`
}

// ============================================================================
// verifyTourActionToken
// ============================================================================

export function verifyTourActionToken(token: string): TourActionTokenPayload {
  const secret = readSecret()
  if (typeof token !== 'string' || token.length === 0 || token.length > 4096) {
    // 4096 is a generous upper bound — real tokens are ~200 chars. Anything
    // larger is either a copy-paste mistake or a denial-of-service attempt.
    throw new TourActionTokenError('malformed_token')
  }
  const parts = token.split('.')
  if (parts.length !== 2) {
    throw new TourActionTokenError('malformed_token')
  }
  const [payloadPart, sigPart] = parts

  // Recompute the HMAC over the payload half and constant-time compare.
  const expectedSig = createHmac(HMAC_ALGORITHM, secret).update(payloadPart).digest()
  let providedSig: Buffer
  try {
    providedSig = b64uDecode(sigPart)
  } catch {
    throw new TourActionTokenError('malformed_token')
  }
  if (providedSig.length !== expectedSig.length) {
    // `timingSafeEqual` throws on length mismatch — we surface our own
    // typed error instead of letting the crypto layer leak through.
    throw new TourActionTokenError('invalid_signature')
  }
  if (!timingSafeEqual(providedSig, expectedSig)) {
    throw new TourActionTokenError('invalid_signature')
  }

  // Signature verified — now parse the payload + validate shape.
  let decoded: unknown
  try {
    decoded = JSON.parse(b64uDecode(payloadPart).toString('utf8'))
  } catch {
    throw new TourActionTokenError('malformed_token')
  }
  if (!decoded || typeof decoded !== 'object') {
    throw new TourActionTokenError('invalid_payload')
  }
  const d = decoded as Record<string, unknown>
  if (typeof d.tour_id !== 'string' || d.tour_id.length === 0) {
    throw new TourActionTokenError('invalid_payload')
  }
  if (d.action !== 'confirm' && d.action !== 'cancel') {
    throw new TourActionTokenError('invalid_payload')
  }
  if (typeof d.exp !== 'number' || !Number.isFinite(d.exp)) {
    throw new TourActionTokenError('invalid_payload')
  }
  if (typeof d.nonce !== 'string' || d.nonce.length === 0) {
    throw new TourActionTokenError('invalid_payload')
  }

  if (d.exp < Date.now()) {
    throw new TourActionTokenError('expired')
  }

  return {
    tour_id: d.tour_id,
    action: d.action,
    exp: d.exp,
    nonce: d.nonce,
  }
}

// ============================================================================
// buildTourActionUrl
// ============================================================================

export interface BuildTourActionUrlArgs {
  tourId: string
  action: TourAction
  /** Optional TTL override forwarded to createTourActionToken. */
  ttlMs?: number
  /** Override the deploy URL — useful for tests. Defaults to NEXT_PUBLIC_APP_URL. */
  appUrl?: string
}

/**
 * Builds the fully-qualified public action URL the lead clicks on.
 * Format: `<appUrl>/tour/{confirm|cancel}?token=<signed>`.
 *
 * Throws `TourActionTokenError('secret_missing')` if the env secret is
 * absent — the email sender catches this and falls back to a link-less
 * body (see `lib/integrations/tour-notifications.ts`).
 */
export function buildTourActionUrl(args: BuildTourActionUrlArgs): string {
  const token = createTourActionToken({
    tourId: args.tourId,
    action: args.action,
    ttlMs: args.ttlMs,
  })
  const appUrl = (args.appUrl ?? process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000').replace(
    /\/$/,
    ''
  )
  return `${appUrl}/tour/${args.action}?token=${encodeURIComponent(token)}`
}

// ============================================================================
// redactTourToken
// ============================================================================

/**
 * Returns a structured-log-safe fragment of a token. Useful when a
 * structured log line wants to correlate "the same token was clicked
 * twice" without leaking the whole thing.
 *
 * Format: `<first-6-chars-of-payload>…<first-6-chars-of-sig>`. The
 * payload prefix is enough to differentiate tokens for the same tour
 * (the nonce shifts the JSON ordering), but is too short to be replayed
 * on its own.
 */
export function redactTourToken(token: string | undefined | null): string {
  if (!token || typeof token !== 'string') return '<no-token>'
  const parts = token.split('.')
  if (parts.length !== 2) return '<malformed>'
  const head = parts[0].slice(0, 6)
  const tail = parts[1].slice(0, 6)
  return `${head}…${tail}`
}

// ============================================================================
// Phase 8L — IP extraction + CIDR-style masking
// ============================================================================

/**
 * Pulls the source IP from the standard proxy headers in priority order:
 *   1. `x-forwarded-for` (first comma-separated entry — original client)
 *   2. `x-real-ip`
 *   3. null
 *
 * Mirrors the convention `lib/rate-limit.ts::extractIp()` uses, but
 * returns `null` (not `'unknown'`) so the audit row records absence
 * faithfully rather than a placeholder string.
 */
export function readSourceIp(request: { headers: Headers }): string | null {
  const xff = request.headers.get('x-forwarded-for')
  if (xff) {
    const first = xff.split(',')[0]?.trim()
    if (first && first.length > 0) return first
  }
  const xri = request.headers.get('x-real-ip')
  if (xri) {
    const trimmed = xri.trim()
    if (trimmed.length > 0) return trimmed
  }
  return null
}

/**
 * Privacy-preserving CIDR-style mask for the audit table.
 *
 *   IPv4 (192.168.1.42)        → 192.168.1.0
 *   IPv6 (2606:4700:4700::1111) → 2606:4700:4700:0::  (first 4 hextets)
 *   anything else → truncated to ≤ 80 chars
 *
 * The /24 IPv4 mask preserves "same ISP / same household" granularity
 * for repeat-click triage but discards the unique-identifier last octet.
 * The IPv6 mask keeps the routing prefix (typically /64 globally
 * unique) but drops the interface identifier.
 *
 * Exported for tests + the (unlikely) future caller who needs to mask
 * an IP from somewhere other than `handleTourActionRequest`.
 */
export function maskIp(ip: string | null | undefined): string | null {
  if (ip == null) return null
  const trimmed = String(ip).trim()
  if (trimmed.length === 0) return null

  // IPv4 — four dot-separated octets, each 0–255. We don't validate the
  // numeric range tightly; if any segment isn't numeric we fall through
  // to the "uncertain parse" branch.
  const v4 = trimmed.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (v4) {
    const [, a, b, c] = v4
    return `${a}.${b}.${c}.0`
  }

  // IPv6 — split on `:`. Real-world IPv6 has compression (`::`), zone
  // indices (`%eth0`), and embedded v4 (`::ffff:1.2.3.4`). We don't try
  // to handle all of those — we just take the first 4 colon-delimited
  // groups when they look like hextets and re-emit with `::` so the
  // result is still a valid IPv6 prefix string.
  if (trimmed.includes(':')) {
    const groups = trimmed.split(':')
    const hextets = groups
      .filter((g) => g.length > 0 && /^[0-9a-fA-F]{1,4}$/.test(g))
      .slice(0, 4)
    if (hextets.length > 0) {
      return `${hextets.join(':')}::`
    }
  }

  // Uncertain parse — truncate so the audit row stays bounded but the
  // operator still has SOMETHING they can correlate against.
  return trimmed.length > 80 ? trimmed.slice(0, 80) : trimmed
}

// ============================================================================
// Phase 8K — Public route handler
// ============================================================================

/**
 * Outcomes the public route can render. Each maps to a small inline HTML
 * page (see `renderTourActionPage` below). The exact wording matters less
 * than the operator-facing diagnostic — when a lead complains "the link
 * didn't work", we want them to be able to take a screenshot of the page
 * and have the operator instantly know whether it was expired, tampered,
 * or a duplicate click.
 */
type ActionOutcome =
  | { kind: 'success'; action: TourAction; tourId: string }
  | { kind: 'already_handled'; action: TourAction; currentStatus: string; tourId: string }
  | { kind: 'expired_or_invalid'; reason: TourActionTokenErrorCode | 'action_mismatch' }
  | { kind: 'tour_not_found' }
  | { kind: 'tour_in_past' }
  | { kind: 'rate_limited' }

interface TourRowForAction {
  id: string
  venue_id: string
  lead_id: string | null
  scheduled_at: string
  duration_minutes: number | null
  location_notes: string | null
  status: string
}

interface LeadRowForAction {
  name: string | null
  email: string | null
}

/**
 * Validates and dispatches a `/tour/{confirm|cancel}?token=...` request.
 *
 * Returns a fully-formed `Response` with an HTML body. The route file
 * just spreads its params here — no per-route logic beyond the action
 * label.
 *
 * ── IDEMPOTENCY ───────────────────────────────────────────────────────────
 * Since this phase ships without a `tour_action_events` table, we cannot
 * detect "this exact token has been clicked before". Instead we rely on
 * the tour's terminal status:
 *   - clicking `confirm` on an already-confirmed tour → already_handled OK
 *   - clicking `cancel` on an already-cancelled tour → already_handled OK
 *   - clicking `confirm` on a cancelled tour → status transition rejected
 *   - clicking `cancel` on a confirmed tour → cancel is still allowed
 *     (confirm → cancel is a valid forward transition; the lead changed
 *     their mind after confirming).
 *
 * Concretely, a token clicked twice in a row flips the tour once and
 * then no-ops on the second click with `already_handled`. That covers
 * 99% of real-world double-click scenarios; the remaining 1% (operator
 * scrapes the URL from a log + replays it days later) cannot be
 * prevented without persistence.
 */
export async function handleTourActionRequest(
  request: NextRequest,
  expectedAction: TourAction
): Promise<Response> {
  const requestId = getOrCreateRequestId(request)
  const reqLog = log.child({
    requestId,
    op: 'tour.action',
    expectedAction,
  })
  const respond = (status: number, html: string): Response =>
    withRequestIdHeader(
      new NextResponse(html, {
        status,
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          // Defense against accidental indexing of the URL by any agent
          // that follows links in plaintext emails.
          'X-Robots-Tag': 'noindex, nofollow',
        },
      }),
      requestId
    )

  // 0. Phase 8L — debug HTML preview for QA / styling work.
  //
  //    GET /tour/confirm?as=html&kind=success    → success page
  //    GET /tour/cancel?as=html&kind=already     → already-handled page
  //    …                                          (kinds: success | already | invalid | expired)
  //
  // Gated to non-production OR explicit `TOUR_ACTION_DEBUG_PREVIEW=1`.
  // The branch reads ZERO data, mutates nothing, and never honors the
  // `?token=` query — so it can't be used to forge a real action.
  // In production without the flag set, the `?as=html` query is silently
  // ignored and the request falls through to the normal flow (which
  // will reject the missing/bogus token with the standard invalid-link
  // page).
  const url = new URL(request.url)
  const previewKindRaw = url.searchParams.get('as') === 'html'
    ? url.searchParams.get('kind')
    : null
  if (previewKindRaw && isPreviewAllowed()) {
    const outcome = previewOutcomeFor(expectedAction, previewKindRaw)
    if (outcome) {
      reqLog.info(
        { previewKind: previewKindRaw },
        'tour.action.debug_preview_rendered'
      )
      const html = renderTourActionPage(outcome)
      return respond(200, html)
    }
    // Unknown kind → fall through silently to the normal flow so we
    // don't surface "valid kinds are …" to a casual caller.
  }

  // 1. Rate-limit per IP. Public surface — protect against scrape /
  // brute-force on token forgeries. We reuse the existing user-action
  // limiter (30/min/key) keyed by client IP; if Upstash isn't configured
  // the limiter fails open with `mode:'disabled'` and logs.
  const ip = extractIp(request)
  const rl = await rateLimitUserAction(request, `tour-action:${ip}`)
  if (!rl.allowed) {
    reqLog.warn({ ip, retryMs: rl.retryAfterMs }, 'tour.action.rate_limited')
    // We don't render the standard JSON 429 body — leads see this page
    // in a browser, not a curl pipeline. Use a small HTML message.
    const html = renderTourActionPage({ kind: 'rate_limited' })
    return respond(429, html)
    // Note: we don't call rateLimitedResponse() because that returns a
    // JSON body. We borrow the same rate-limit decision but render HTML.
    void rateLimitedResponse // keep the import live for parity audits
  }

  // 2. Extract + verify the token. (`url` was constructed in step 0 above.)
  const token = url.searchParams.get('token') ?? ''
  const redacted = redactTourToken(token)

  let payload: TourActionTokenPayload
  try {
    payload = verifyTourActionToken(token)
  } catch (err) {
    const code: TourActionTokenErrorCode =
      err instanceof TourActionTokenError ? err.code : 'malformed_token'
    if (code === 'invalid_signature') {
      // Tamper attempt — structured warn + Sentry. Never include the
      // raw token in the log line; the redacted form is enough to
      // correlate repeated forgeries from one source.
      reqLog.warn(
        { ip, token: redacted },
        'tour.action.invalid_signature'
      )
      captureApiError(new Error('tour_action_invalid_signature'), {
        requestId,
        route: `/tour/${expectedAction}`,
      })
    } else {
      reqLog.warn(
        { ip, code, token: redacted },
        'tour.action.token_rejected'
      )
    }
    const html = renderTourActionPage({ kind: 'expired_or_invalid', reason: code })
    return respond(400, html)
  }

  // 3. Action must match the route. A `cancel` token used at /tour/confirm
  // is treated as expired_or_invalid (we don't leak which dimension the
  // mismatch was on).
  if (payload.action !== expectedAction) {
    reqLog.warn(
      { ip, expectedAction, tokenAction: payload.action, token: redacted },
      'tour.action.action_mismatch'
    )
    const html = renderTourActionPage({
      kind: 'expired_or_invalid',
      reason: 'action_mismatch',
    })
    return respond(400, html)
  }

  // 4. Load the tour. Service-role because this surface is unauthenticated
  // by design — the token IS the auth.
  const svc = createServiceClient()
  const { data: tourRaw, error: tourErr } = await svc
    .from('tours')
    .select(
      'id, venue_id, lead_id, scheduled_at, duration_minutes, location_notes, status'
    )
    .eq('id', payload.tour_id)
    .maybeSingle()

  if (tourErr) {
    reqLog.error(
      { err: tourErr, tourId: payload.tour_id },
      'tour.action.tour_lookup_failed'
    )
    captureApiError(tourErr, {
      requestId,
      route: `/tour/${expectedAction}`,
    })
    const html = renderTourActionPage({ kind: 'tour_not_found' })
    return respond(500, html)
  }
  if (!tourRaw) {
    reqLog.warn({ tourId: payload.tour_id }, 'tour.action.tour_not_found')
    const html = renderTourActionPage({ kind: 'tour_not_found' })
    return respond(404, html)
  }

  const tour = tourRaw as TourRowForAction

  // 5. Tour-in-past guard. We treat "the tour already happened" as a
  // terminal state for action links — confirming or cancelling something
  // in the past is operationally meaningless.
  if (new Date(tour.scheduled_at).getTime() <= Date.now()) {
    reqLog.info(
      { tourId: tour.id, scheduledAt: tour.scheduled_at },
      'tour.action.tour_in_past'
    )
    const html = renderTourActionPage({ kind: 'tour_in_past' })
    return respond(400, html)
  }

  // 6. Idempotent transitions.
  if (expectedAction === 'confirm') {
    if (tour.status === 'confirmed') {
      reqLog.info({ tourId: tour.id }, 'tour.action.already_confirmed')
      const html = renderTourActionPage({
        kind: 'already_handled',
        action: 'confirm',
        currentStatus: tour.status,
        tourId: tour.id,
      })
      return respond(200, html)
    }
    if (tour.status !== 'scheduled') {
      // cancelled / completed / no_show — refuse the confirm.
      reqLog.warn(
        { tourId: tour.id, currentStatus: tour.status },
        'tour.action.confirm_disallowed_status'
      )
      const html = renderTourActionPage({
        kind: 'already_handled',
        action: 'confirm',
        currentStatus: tour.status,
        tourId: tour.id,
      })
      return respond(409, html)
    }
  } else {
    // cancel
    if (tour.status === 'cancelled') {
      reqLog.info({ tourId: tour.id }, 'tour.action.already_cancelled')
      const html = renderTourActionPage({
        kind: 'already_handled',
        action: 'cancel',
        currentStatus: tour.status,
        tourId: tour.id,
      })
      return respond(200, html)
    }
    if (tour.status !== 'scheduled' && tour.status !== 'confirmed') {
      reqLog.warn(
        { tourId: tour.id, currentStatus: tour.status },
        'tour.action.cancel_disallowed_status'
      )
      const html = renderTourActionPage({
        kind: 'already_handled',
        action: 'cancel',
        currentStatus: tour.status,
        tourId: tour.id,
      })
      return respond(409, html)
    }
  }

  // 7. Phase 8L — single-use claim. We INSERT into `tour_action_events`
  // BEFORE the status UPDATE so the unique constraint on
  // (tour_id, token_nonce) atomically defeats replay. The status flip
  // only runs if the claim succeeds; a unique violation means this
  // exact token has been redeemed before, so we short-circuit to the
  // "already handled" page without touching the tour or firing another
  // notification.
  //
  // Status idempotency from step 6 above is preserved as defense in
  // depth — if `tour_action_events` is ever wiped (test reset, manual
  // SQL), the status guards still prevent double-flips.
  const masked = maskIp(readSourceIp(request))
  const userAgent = request.headers.get('user-agent')?.slice(0, 500) ?? null
  const auditPayload = {
    venue_id: tour.venue_id,
    tour_id: tour.id,
    lead_id: tour.lead_id,
    token_nonce: payload.nonce,
    action: payload.action,
    source_ip: masked,
    user_agent: userAgent,
  }
  const { data: auditInserted, error: auditErr } = await svc
    .from('tour_action_events')
    .insert(auditPayload)
    .select('id')
    .single()

  if (auditErr) {
    // Postgres unique-violation code is `23505`. PostgREST surfaces it
    // on `.code` for some adapter versions and on `.message` for others
    // — we sniff both to stay resilient to client-version drift.
    const code = (auditErr as { code?: string }).code ?? ''
    const message = (auditErr as { message?: string }).message ?? ''
    const isUniqueViolation =
      code === '23505' || /duplicate key/i.test(message) || /unique/i.test(message)

    if (isUniqueViolation) {
      reqLog.info(
        { tourId: tour.id, nonce: payload.nonce.slice(0, 8) + '…' },
        'tour.action.single_use_replay_blocked'
      )
      const html = renderTourActionPage({
        kind: 'already_handled',
        action: expectedAction,
        // The DB doesn't tell us what the previous redemption resolved
        // to — we report the action the lead just attempted, which is
        // what they care about.
        currentStatus: tour.status,
        tourId: tour.id,
      })
      return respond(200, html)
    }

    // Real DB error — capture + render the generic error page. We
    // explicitly DO NOT proceed with the status UPDATE because the
    // audit trail would be missing for that flip.
    reqLog.error(
      { err: auditErr, tourId: tour.id },
      'tour.action.audit_insert_failed'
    )
    captureApiError(auditErr, {
      requestId,
      route: `/tour/${expectedAction}`,
    })
    const html = renderTourActionPage({ kind: 'tour_not_found' })
    return respond(500, html)
  }

  // 8. Flip the status. We re-assert the prior status on the UPDATE so
  // two concurrent clicks (rare but possible) can't both succeed —
  // exactly one wins; the loser falls through to the next request which
  // sees the already-handled state and no-ops. With Phase 8L's audit-
  // claim above, this branch is now reached only after winning the
  // single-use claim, so it's effectively "this is the first redemption".
  const newStatus = expectedAction === 'confirm' ? 'confirmed' : 'cancelled'
  const allowedPriorStatuses =
    expectedAction === 'confirm' ? ['scheduled'] : ['scheduled', 'confirmed']

  const { data: updatedRaw, error: updateErr } = await svc
    .from('tours')
    .update({ status: newStatus })
    .eq('id', tour.id)
    .in('status', allowedPriorStatuses)
    .select('id')
    .maybeSingle()

  if (updateErr) {
    reqLog.error(
      { err: updateErr, tourId: tour.id, newStatus },
      'tour.action.update_failed'
    )
    captureApiError(updateErr, {
      requestId,
      route: `/tour/${expectedAction}`,
    })
    const html = renderTourActionPage({ kind: 'tour_not_found' })
    return respond(500, html)
  }
  if (!updatedRaw) {
    // The status was no longer in the allowed set — most likely a
    // concurrent click won the race. Fall through to already_handled.
    reqLog.info(
      { tourId: tour.id, currentStatus: tour.status },
      'tour.action.race_lost'
    )
    const html = renderTourActionPage({
      kind: 'already_handled',
      action: expectedAction,
      currentStatus: newStatus,
      tourId: tour.id,
    })
    return respond(200, html)
  }

  // Phase 8M — unified status-event audit. We write to `tour_status_events`
  // here AFTER both the single-use claim (`tour_action_events` INSERT) and
  // the status UPDATE succeeded — so this row only ever appears for a
  // genuine, completed lead-token redemption. Lead-token actions write to
  // BOTH tables for one release cycle:
  //   - tour_action_events (012) → narrow, owns the unique claim
  //   - tour_status_events (013) → wide, the unified audit feed
  //
  // Failure here NEVER fails the public route — the action has already
  // landed; an audit miss is logged + Sentry-captured by the helper.
  const tokenEventId =
    (auditInserted as { id?: string } | null)?.id ?? null
  await recordTourStatusEvent({
    venueId: tour.venue_id,
    tourId: tour.id,
    leadId: tour.lead_id,
    actorKind: 'lead_token',
    actorId: null,
    action: expectedAction,
    previousStatus: tour.status,
    newStatus,
    sourceIp: masked,
    userAgent,
    metadata: {
      token_event_id: tokenEventId,
      token_redacted: redacted,
      route: `/tour/${expectedAction}`,
    },
    requestId,
  })

  // 9. Best-effort lead notification. Mirrors Phase 8G's fire-and-forget
  // pattern: the route success is independent of email outcome. If
  // sendTourNotificationEmail throws (it shouldn't — the helper swallows
  // internally), the `.catch(() => {})` belt-and-suspenders prevents an
  // unhandled rejection.
  //
  // We use `await import()` instead of a static import to avoid a
  // module-load cycle (see the header note at the top of this file).
  if (tour.lead_id) {
    const { data: leadRaw } = await svc
      .from('leads')
      .select('name, email')
      .eq('id', tour.lead_id)
      .maybeSingle()
    const lead = (leadRaw ?? null) as LeadRowForAction | null
    const notif = await import('@/lib/integrations/tour-notifications')
    void notif
      .sendTourNotificationEmail({
        kind: expectedAction === 'confirm' ? 'confirmed' : 'cancelled',
        tourId: tour.id,
        venueId: tour.venue_id,
        leadId: tour.lead_id,
        leadEmail: lead?.email ?? null,
        leadName: lead?.name ?? null,
        scheduledAt: tour.scheduled_at,
        durationMinutes: tour.duration_minutes,
        locationNotes: tour.location_notes,
        requestId,
      })
      .catch(() => {
        /* swallowed — helper already logs + Sentry-captures */
      })
  }

  reqLog.info(
    { tourId: tour.id, newStatus },
    'tour.action.completed'
  )
  const html = renderTourActionPage({
    kind: 'success',
    action: expectedAction,
    tourId: tour.id,
  })
  return respond(200, html)
}

// ============================================================================
// renderTourActionPage — minimal inline HTML
// ============================================================================

/**
 * Inline HTML strings, no React needed. We use a small set of utility
 * classes via inline `<style>` so the page renders even when the user's
 * browser blocks our CSS bundle. Visual identity stays neutral on
 * purpose — this page is rendered to LEADS, not operators, so it
 * shouldn't carry dashboard branding chrome.
 */
function renderTourActionPage(outcome: ActionOutcome): string {
  const { title, body, badgeClass } = outcomeCopy(outcome)
  // We deliberately keep the HTML compact + inline. No external CSS, no
  // JS. The page is a confirmation surface, not an app.
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
<style>
  body { margin:0; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif; background:#F4F6FB; color:#0F172A; }
  .wrap { max-width:480px; margin:80px auto; padding:32px; background:#FFFFFF; border:1px solid #E2E8F0; border-radius:20px; box-shadow:0 4px 14px rgba(15,23,42,0.08); }
  .badge { display:inline-block; padding:4px 10px; border-radius:9999px; font-size:11px; font-weight:600; letter-spacing:0.04em; text-transform:uppercase; margin-bottom:16px; }
  .ok      { background:#ECFDF5; color:#047857; border:1px solid #A7F3D0; }
  .info    { background:#EFF6FF; color:#1D4ED8; border:1px solid #BFDBFE; }
  .warn    { background:#FFFBEB; color:#B45309; border:1px solid #FDE68A; }
  .err     { background:#FEF2F2; color:#B91C1C; border:1px solid #FECACA; }
  h1 { font-size:18px; margin:0 0 12px 0; font-weight:600; }
  p  { font-size:14px; line-height:1.55; color:#475569; margin:0 0 12px 0; }
  .foot { margin-top:24px; font-size:12px; color:#94A3B8; }
</style>
</head>
<body>
<div class="wrap">
  <span class="badge ${badgeClass}">${escapeHtml(outcomeBadgeLabel(outcome))}</span>
  <h1>${escapeHtml(title)}</h1>
  ${body}
  <div class="foot">Reply to the original email if you have questions.</div>
</div>
</body>
</html>`
}

function outcomeBadgeLabel(outcome: ActionOutcome): string {
  switch (outcome.kind) {
    case 'success':
      return outcome.action === 'confirm' ? 'Tour confirmed' : 'Tour cancelled'
    case 'already_handled':
      return 'Already handled'
    case 'expired_or_invalid':
      return 'Link not valid'
    case 'tour_not_found':
      return 'Not found'
    case 'tour_in_past':
      return 'Tour has passed'
    case 'rate_limited':
      return 'Too many requests'
  }
}

function outcomeCopy(outcome: ActionOutcome): {
  title: string
  body: string
  badgeClass: 'ok' | 'info' | 'warn' | 'err'
} {
  switch (outcome.kind) {
    case 'success':
      return outcome.action === 'confirm'
        ? {
            title: 'Your tour is confirmed.',
            body: `<p>We've marked your tour as confirmed and sent a confirmation email to your inbox. See you soon.</p>`,
            badgeClass: 'ok',
          }
        : {
            title: 'Your tour is cancelled.',
            body: `<p>We've cancelled your tour. A cancellation email is on its way. Reply to the original message if you'd like to find a new time.</p>`,
            badgeClass: 'ok',
          }
    case 'already_handled':
      return {
        title:
          outcome.action === 'confirm'
            ? 'This tour is already handled.'
            : 'This tour is already handled.',
        body: `<p>The tour is currently <strong>${escapeHtml(outcome.currentStatus)}</strong>. There's nothing more to do from this link.</p>`,
        badgeClass: 'info',
      }
    case 'expired_or_invalid':
      return {
        title: 'This link is no longer valid.',
        body: `<p>The link you used has expired or doesn't match the action it was issued for. Please reply to the original email and our team will help.</p>`,
        badgeClass: 'warn',
      }
    case 'tour_not_found':
      return {
        title: "We couldn't find that tour.",
        body: `<p>The tour referenced by this link couldn't be located. It may have been removed by the venue team. Reply to the original email and we'll sort it out.</p>`,
        badgeClass: 'err',
      }
    case 'tour_in_past':
      return {
        title: 'This tour has already passed.',
        body: `<p>The scheduled time for this tour is in the past, so the confirm/cancel link no longer applies. Reply to the original email if you'd like to schedule another tour.</p>`,
        badgeClass: 'warn',
      }
    case 'rate_limited':
      return {
        title: 'Too many requests from this network.',
        body: `<p>You've clicked tour links a lot in the last minute. Please wait a moment and try again.</p>`,
        badgeClass: 'warn',
      }
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

// ============================================================================
// Phase 8L — Debug preview gating
// ============================================================================

/**
 * Returns true when the `?as=html` preview branch should be honored.
 * The intent is "QA can preview the page styling without consuming a
 * real token", so we allow it in development by default, and only in
 * production when the operator explicitly sets the env flag.
 *
 * Anything beyond `NODE_ENV !== 'production'` OR `TOUR_ACTION_DEBUG_PREVIEW=1`
 * leaves the branch off. We don't trust the request itself (no header
 * sniffing, no query-string secret) — env-only.
 */
function isPreviewAllowed(): boolean {
  if (process.env.NODE_ENV !== 'production') return true
  return process.env.TOUR_ACTION_DEBUG_PREVIEW === '1'
}

/**
 * Translates the operator-friendly `?kind=` strings into the internal
 * `ActionOutcome` discriminated union. Returns `null` for unknown
 * strings so the caller can fall through to the normal flow.
 *
 * We use a plausible synthetic `tourId` ("preview") rather than a real
 * UUID to make it obvious in any screenshot that this is QA output and
 * not a live event.
 */
function previewOutcomeFor(
  expectedAction: TourAction,
  kind: string
): ActionOutcome | null {
  switch (kind) {
    case 'success':
      return { kind: 'success', action: expectedAction, tourId: 'preview' }
    case 'already':
      return {
        kind: 'already_handled',
        action: expectedAction,
        currentStatus: expectedAction === 'confirm' ? 'confirmed' : 'cancelled',
        tourId: 'preview',
      }
    case 'invalid':
      return { kind: 'expired_or_invalid', reason: 'invalid_signature' }
    case 'expired':
      return { kind: 'expired_or_invalid', reason: 'expired' }
    default:
      return null
  }
}
