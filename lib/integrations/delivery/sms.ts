import 'server-only'
import { log } from '@/lib/log'

/**
 * Phase 8BR — Outbound SMS delivery wrapper.
 *
 * Mirrors `lib/integrations/delivery/email.ts` (Phase 8BN) for
 * Twilio. We POST directly to Twilio's REST API rather than
 * pull in the official `twilio` npm package — saves ~250kB on
 * the bundle for one HTTP call, keeps the secret handling
 * narrow, and avoids a server-startup-cost dependency.
 *
 * ── WHAT THIS HELPER OWNS ────────────────────────────────────────────────
 *   - Kill-switch + config gate (`OUTBOUND_SMS_DELIVERY_ENABLED`).
 *   - Phone-number normalization to E.164.
 *   - Body-length cap (configurable via OUTBOUND_SMS_MAX_LENGTH).
 *   - Twilio HTTP call with Basic auth (SID:auth_token).
 *   - Safe error mapping — no raw Twilio errors leak into UI.
 *   - Never throws.
 *
 * ── HONESTY CONTRACT ──────────────────────────────────────────────────────
 *   - Returns `ok: true, deliveryStatus: 'accepted' | 'queued' | 'sent'`
 *     only when Twilio returned a 2xx + Message SID. Twilio's
 *     immediate API response says "queued" / "accepted" — we
 *     never claim "delivered" without a separate status callback
 *     (out of scope for this phase).
 *   - Returns `ok: false, deliveryStatus: 'skipped'` when delivery
 *     is intentionally not attempted (kill switch off, missing
 *     env). The composer route uses this to keep the pill on
 *     "Saved in VenueRise only" softly.
 *   - Returns `ok: false, deliveryStatus: 'failed'` on a real
 *     send error — invalid phone, body too long, Twilio rejection,
 *     network. Safe `errorCode` + sanitized `safeError` for the UI.
 *   - Never logs the message body at error level.
 *   - Never returns the Twilio auth token or raw provider response.
 *
 * ── CONSENT / TCPA ───────────────────────────────────────────────────────
 * VenueRise does not currently store an `sms_opt_in` /
 * `sms_consent` field on leads. Production SMS rollouts must
 * respect TCPA (US) and equivalent consent regulations. This
 * helper does NOT verify consent — the operator's explicit
 * Send click is the only authorization. The feature is gated
 * by `OUTBOUND_SMS_DELIVERY_ENABLED=0` by default specifically
 * so a pilot operator must enable it deliberately AND own the
 * compliance posture. See `docs/OUTBOUND-SMS-DELIVERY.md`.
 */

const FALSE_VALUES = new Set(['', '0', 'false', 'no', 'off'])

const DEFAULT_MAX_BODY = 1200

function envEnabled(): boolean {
  const raw = process.env.OUTBOUND_SMS_DELIVERY_ENABLED
  if (raw == null) return false
  return !FALSE_VALUES.has(raw.trim().toLowerCase())
}

export function isOutboundSmsConfigured(): boolean {
  if (!envEnabled()) return false
  return (
    !!process.env.TWILIO_ACCOUNT_SID &&
    !!process.env.TWILIO_AUTH_TOKEN &&
    !!process.env.OUTBOUND_SMS_FROM
  )
}

/**
 * Phase 8BU — Twilio outbound status callback. Returns the
 * public URL we want Twilio to POST status updates to, or
 * null if the callback isn't enabled / no public URL is set.
 *
 * Twilio webhooks require an absolute https URL. NEXT_PUBLIC_APP_URL
 * is the project convention (already used by 8BO inbound URL
 * reconstruction). When unset (local dev without a tunnel),
 * we omit the callback rather than sending Twilio a bogus
 * localhost URL that would 404.
 */
function isStatusCallbackEnabled(): boolean {
  const raw = process.env.TWILIO_SMS_STATUS_CALLBACK_ENABLED
  if (raw == null) return false
  return !FALSE_VALUES.has(raw.trim().toLowerCase())
}

function statusCallbackUrl(): string | null {
  if (!isStatusCallbackEnabled()) return null
  const appUrl = (process.env.NEXT_PUBLIC_APP_URL ?? '').trim().replace(/\/+$/, '')
  if (!appUrl) return null
  // Twilio rejects non-https callback URLs in production; the
  // env-set base URL is expected to be https in deployed
  // environments. Local dev usually leaves the kill switch off.
  return `${appUrl}/api/twilio/sms/status`
}

function maxBodyLength(): number {
  const raw = process.env.OUTBOUND_SMS_MAX_LENGTH
  if (!raw) return DEFAULT_MAX_BODY
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_MAX_BODY
  // Hard ceiling — even if a venue cranks the env var, we cap
  // at 1600 chars (the absolute Twilio per-message limit).
  return Math.min(Math.max(160, Math.floor(n)), 1600)
}

/**
 * Normalize a US-style phone string to E.164.
 *
 * VenueRise is currently US-focused. We accept these shapes:
 *   - "+15551231234"     → "+15551231234"
 *   - "15551231234"      → "+15551231234"
 *   - "5551231234"       → "+15551231234"
 *   - "(555) 123-1234"   → "+15551231234"
 *   - "555-123-1234"     → "+15551231234"
 *
 * International numbers must arrive already in E.164 with `+`.
 * We don't guess country codes — that's a recipe for misroutes
 * and double-charging.
 *
 * Returns null when the input is empty / clearly not a phone.
 */
export function normalizePhoneForSms(input: string | null | undefined): string | null {
  if (!input) return null
  const trimmed = input.trim()
  if (!trimmed) return null

  // If it already starts with `+`, trust the explicit E.164.
  if (trimmed.startsWith('+')) {
    const digits = trimmed.slice(1).replace(/\D/g, '')
    if (digits.length < 8 || digits.length > 15) return null
    return `+${digits}`
  }

  const digits = trimmed.replace(/\D/g, '')
  if (digits.length === 10) {
    return `+1${digits}`
  }
  if (digits.length === 11 && digits.startsWith('1')) {
    return `+${digits}`
  }
  // Refuse ambiguous shapes (too few/too many digits, no +).
  return null
}

export interface OutboundSmsInput {
  to: string
  /** From phone (E.164). When omitted, falls back to OUTBOUND_SMS_FROM. */
  from?: string
  body: string
  venueId: string
  conversationId: string
  leadId?: string | null
  messageId?: string | null
}

export type OutboundSmsErrorCode =
  | 'delivery_disabled'
  | 'invalid_phone'
  | 'missing_body'
  | 'message_too_long'
  | 'missing_venue_id'
  | 'missing_from'
  | 'provider_rejected'
  | 'provider_threw'

export type OutboundSmsResult =
  | {
      ok: true
      provider: 'twilio'
      providerMessageId: string | null
      deliveryStatus: 'accepted' | 'queued' | 'sent'
      to: string
    }
  | {
      ok: false
      provider: 'twilio'
      deliveryStatus: 'failed' | 'skipped'
      errorCode: OutboundSmsErrorCode
      safeError: string
    }

/**
 * Map a Twilio API status string onto our composer-shaped
 * deliveryStatus. Twilio's `status` field on a freshly-created
 * Message resource is typically `accepted` / `queued` / `sending`
 * / `sent`; the long-tail (`delivered` / `undelivered` / `failed`)
 * arrives via the optional Status Callback URL (out of scope
 * for this phase).
 */
function mapInitialTwilioStatus(
  raw: string | null | undefined
): 'accepted' | 'queued' | 'sent' {
  if (!raw) return 'queued'
  switch (raw.toLowerCase()) {
    case 'sent':
      return 'sent'
    case 'accepted':
      return 'accepted'
    case 'queued':
    case 'sending':
    default:
      return 'queued'
  }
}

/**
 * Trim a Twilio error message into a UI-safe short form. Twilio
 * errors typically read like "The 'To' number +1555... is not a
 * valid phone number." — we keep the gist, drop secrets.
 */
function safeShortError(raw: string | null | undefined): string {
  if (!raw) return 'Provider rejected the message.'
  return String(raw).replace(/\s+/g, ' ').trim().slice(0, 200)
}

export async function sendOutboundSms(
  input: OutboundSmsInput
): Promise<OutboundSmsResult> {
  // 1. Kill-switch + config gate.
  if (!isOutboundSmsConfigured()) {
    return {
      ok: false,
      provider: 'twilio',
      deliveryStatus: 'skipped',
      errorCode: 'delivery_disabled',
      safeError: 'SMS sending is not connected for this workspace.',
    }
  }

  // 2. From-number sanity. We've already confirmed the env var
  //    exists via isOutboundSmsConfigured; this is defense in
  //    depth + lets callers override.
  const fromRaw = input.from ?? process.env.OUTBOUND_SMS_FROM ?? ''
  const from = normalizePhoneForSms(fromRaw)
  if (!from) {
    return {
      ok: false,
      provider: 'twilio',
      deliveryStatus: 'failed',
      errorCode: 'missing_from',
      safeError: 'SMS sender number is not configured correctly.',
    }
  }

  // 3. Recipient validation.
  const to = normalizePhoneForSms(input.to)
  if (!to) {
    return {
      ok: false,
      provider: 'twilio',
      deliveryStatus: 'failed',
      errorCode: 'invalid_phone',
      safeError: 'Lead phone number is missing or invalid.',
    }
  }

  // 4. Body sanity.
  const body = (input.body ?? '').trim()
  if (!body) {
    return {
      ok: false,
      provider: 'twilio',
      deliveryStatus: 'failed',
      errorCode: 'missing_body',
      safeError: 'Reply body was empty.',
    }
  }
  const cap = maxBodyLength()
  if (body.length > cap) {
    return {
      ok: false,
      provider: 'twilio',
      deliveryStatus: 'failed',
      errorCode: 'message_too_long',
      safeError: `SMS body exceeds the ${cap}-character limit.`,
    }
  }

  if (!input.venueId) {
    return {
      ok: false,
      provider: 'twilio',
      deliveryStatus: 'failed',
      errorCode: 'missing_venue_id',
      safeError: 'Internal error — venue context missing.',
    }
  }

  // 5. Provider call. Twilio REST API:
  //      POST https://api.twilio.com/2010-04-01/Accounts/{SID}/Messages.json
  //    Basic auth: SID:auth_token. Form-encoded body.
  const sid = process.env.TWILIO_ACCOUNT_SID!
  const token = process.env.TWILIO_AUTH_TOKEN!
  const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(
    sid
  )}/Messages.json`
  const form = new URLSearchParams()
  form.set('To', to)
  form.set('From', from)
  form.set('Body', body)
  // Phase 8BU — opt-in StatusCallback for the lifecycle events
  // (queued / sent / delivered / undelivered / failed). Omitted
  // when the env kill switch is off OR NEXT_PUBLIC_APP_URL is
  // unset (local dev). Twilio will simply not POST status
  // updates in that case — the bubble pill stays on the
  // immediate response ("Accepted by SMS" / "SMS sent") as it
  // did pre-8BU.
  const callbackUrl = statusCallbackUrl()
  if (callbackUrl) {
    form.set('StatusCallback', callbackUrl)
  }
  // Tag with our context so Twilio's console makes the source
  // obvious during ops. We use the `ProvideFeedback=false` field
  // implicitly; status callback wiring is deferred.

  let providerMessageId: string | null = null
  let providerStatus: string | null = null
  try {
    const auth = Buffer.from(`${sid}:${token}`).toString('base64')
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: form.toString(),
      // 15-second timeout via AbortController — Twilio normally
      // returns in <1s; anything over 15s is a sign of a
      // network/DNS issue and we don't want to hold the operator
      // request open.
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) {
      // Twilio returns a structured error body. We pull `message`
      // (human-readable) + `code` (numeric error code) and drop
      // everything else.
      let providerMessage: string | null = null
      let providerCode: number | null = null
      try {
        const errJson = (await res.json()) as {
          message?: string
          code?: number
        }
        providerMessage = errJson?.message ?? null
        providerCode =
          typeof errJson?.code === 'number' ? errJson.code : null
      } catch {
        // Non-JSON error body — fall through with status text.
        providerMessage = res.statusText || `HTTP ${res.status}`
      }
      log.warn(
        {
          venueId: input.venueId,
          conversationId: input.conversationId,
          status: res.status,
          twilioCode: providerCode,
        },
        'sms.twilio.rejected'
      )
      return {
        ok: false,
        provider: 'twilio',
        deliveryStatus: 'failed',
        errorCode: 'provider_rejected',
        safeError: safeShortError(providerMessage),
      }
    }
    const json = (await res.json()) as { sid?: string; status?: string }
    providerMessageId = json?.sid ?? null
    providerStatus = json?.status ?? null
  } catch (err) {
    const safe = err instanceof Error ? err.message.slice(0, 200) : 'Unknown SMS error'
    log.warn(
      { venueId: input.venueId, conversationId: input.conversationId },
      'sms.twilio.threw'
    )
    return {
      ok: false,
      provider: 'twilio',
      deliveryStatus: 'failed',
      errorCode: 'provider_threw',
      safeError: safe,
    }
  }

  if (!providerMessageId) {
    return {
      ok: false,
      provider: 'twilio',
      deliveryStatus: 'failed',
      errorCode: 'provider_rejected',
      safeError: 'Provider did not return a message id.',
    }
  }

  log.info(
    {
      venueId: input.venueId,
      conversationId: input.conversationId,
      providerMessageId,
      providerStatus,
    },
    'sms.twilio.accepted'
  )

  return {
    ok: true,
    provider: 'twilio',
    providerMessageId,
    deliveryStatus: mapInitialTwilioStatus(providerStatus),
    to,
  }
}
