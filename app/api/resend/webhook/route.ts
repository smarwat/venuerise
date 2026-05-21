// webhook route — Resend-initiated callback. Outbound delivery
// state lives on `outbound_messages.status` (provider mutation);
// suppressions write `email_suppressions`. The webhook's own
// pino structured logs are the forensic trail. Per Phase 9A
// "don't touch webhooks" rule, this stays out of `audit_events`.
// Documented in docs/AUDIT-COVERAGE.md.
import { NextRequest, NextResponse } from 'next/server'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { createServiceClient } from '@/lib/supabase/service'
import { addSuppression } from '@/lib/integrations/suppression'
import { log } from '@/lib/log'
import { getOrCreateRequestId, withRequestIdHeader } from '@/lib/observability/request-id'
import { captureWebhookError } from '@/lib/observability/sentry'

/**
 * Resend webhook handler.
 *
 * Resend uses Svix-format signatures. We verify the signature ourselves
 * (no `svix` dep) over the raw body using `RESEND_WEBHOOK_SECRET`.
 *
 * Verification algorithm (Svix v1):
 *   sign_string = `${svix-id}.${svix-timestamp}.${rawBody}`
 *   expected    = base64(HMAC-SHA256(sign_string, base64-decoded(secret_after_whsec_prefix)))
 *   compare timing-safe against each "v1,<sig>" entry in `svix-signature`.
 *
 * Resend's secret is provided in the dashboard as `whsec_<base64-payload>`.
 *
 * ── BEHAVIOR ───────────────────────────────────────────────────────────────
 * - 401 on missing/invalid signature.
 * - 200 on success OR unknown event type (so Resend doesn't retry forever).
 * - Each event type updates the matching `outbound_messages` row by
 *   `provider_message_id` first, then falls back to the `out_id` tag.
 * - Hard bounces + complaints add the recipient to `email_suppressions`.
 * ──────────────────────────────────────────────────────────────────────────
 */

interface ResendEventDataBase {
  email_id?: string
  to?: string | string[]
  from?: string
  subject?: string
  created_at?: string
  bounce?: { type?: string; subType?: string; message?: string }
  tags?: Array<{ name: string; value: string }>
}

interface ResendEvent {
  type: string
  created_at?: string
  data: ResendEventDataBase
}

const SUPPORTED_EVENTS = new Set([
  'email.delivered',
  'email.bounced',
  'email.complained',
  'email.delivery_delayed',
  'email.failed',
  'email.sent', // also seen; harmless
  'email.opened',
  'email.clicked',
])

// ---------------------------------------------------------------------------
// Signature verification (Svix v1, manual)
// ---------------------------------------------------------------------------

function verifySvixSignature(
  rawBody: string,
  headers: { id: string | null; timestamp: string | null; signature: string | null },
  secret: string
): boolean {
  const { id, timestamp, signature } = headers
  if (!id || !timestamp || !signature) return false

  // Reject stale timestamps to defeat replay (5 min window).
  const ts = Number(timestamp)
  if (!Number.isFinite(ts)) return false
  const nowSec = Math.floor(Date.now() / 1000)
  if (Math.abs(nowSec - ts) > 60 * 5) return false

  // Decode secret — strip `whsec_` prefix, then base64-decode.
  const stripped = secret.startsWith('whsec_') ? secret.slice('whsec_'.length) : secret
  let secretBytes: Buffer
  try {
    secretBytes = Buffer.from(stripped, 'base64')
  } catch {
    return false
  }
  if (secretBytes.length === 0) return false

  const signString = `${id}.${timestamp}.${rawBody}`
  const expectedB64 = createHmac('sha256', secretBytes).update(signString).digest('base64')
  const expectedBuf = Buffer.from(expectedB64, 'utf8')

  // signature header may contain space-separated `v1,<sig> v1,<sig>` entries.
  const candidates = signature.split(' ')
  for (const raw of candidates) {
    const [version, sig] = raw.split(',')
    if (version !== 'v1' || !sig) continue
    const candBuf = Buffer.from(sig, 'utf8')
    if (candBuf.length !== expectedBuf.length) continue
    try {
      if (timingSafeEqual(candBuf, expectedBuf)) return true
    } catch {
      // fall through
    }
  }
  return false
}

// ---------------------------------------------------------------------------
// outbound_messages updates
// ---------------------------------------------------------------------------

function getTag(event: ResendEvent, name: string): string | undefined {
  return event.data.tags?.find((t) => t.name === name)?.value
}

function firstAddress(value: string | string[] | undefined): string | null {
  if (!value) return null
  if (Array.isArray(value)) return value[0] ?? null
  return value
}

interface UpdatePayload {
  status: 'delivered' | 'bounced' | 'complained' | 'failed'
  delivered_at?: string
  error?: string | null
}

async function updateOutboundRow(event: ResendEvent, payload: UpdatePayload): Promise<boolean> {
  const supabase = createServiceClient()
  const providerMessageId = event.data.email_id
  const outId = getTag(event, 'out_id')

  let matched = false

  // Try provider_message_id first.
  if (providerMessageId) {
    const { error, data } = await supabase
      .from('outbound_messages')
      .update(payload)
      .eq('provider_message_id', providerMessageId)
      .select('id')
    if (error) {
      log.error(
        { providerMessageId, errorMessage: error.message },
        'resend.webhook.update_by_message_id_failed'
      )
    } else if (data && data.length > 0) {
      matched = true
    }
  }

  // Fall back to out_id tag (handles races where Resend fires before we
  // persisted provider_message_id).
  if (!matched && outId) {
    const { error, data } = await supabase
      .from('outbound_messages')
      .update({ ...payload, provider_message_id: providerMessageId ?? undefined })
      .eq('id', outId)
      .select('id')
    if (error) {
      log.error({ outId, errorMessage: error.message }, 'resend.webhook.update_by_out_id_failed')
    } else if (data && data.length > 0) {
      matched = true
    }
  }

  if (!matched) {
    log.warn(
      { providerMessageId, outId, type: event.type },
      'resend.webhook.no_matching_outbound'
    )
  }
  return matched
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest) {
  const requestId = getOrCreateRequestId(request)
  const reqLog = log.child({ requestId, route: '/api/resend/webhook' })
  const respond = <T extends Response>(r: T) => withRequestIdHeader(r, requestId)

  const secret = process.env.RESEND_WEBHOOK_SECRET
  if (!secret) {
    // Production misconfiguration. Refuse to process — every retry will 401
    // until secret is set. This is loud and safe.
    reqLog.error({}, 'resend.webhook.secret_missing')
    return respond(NextResponse.json({ error: 'webhook_not_configured' }, { status: 401 }))
  }

  const rawBody = await request.text()

  const verified = verifySvixSignature(
    rawBody,
    {
      id: request.headers.get('svix-id'),
      timestamp: request.headers.get('svix-timestamp'),
      signature: request.headers.get('svix-signature'),
    },
    secret
  )
  if (!verified) {
    return respond(NextResponse.json({ error: 'invalid_signature' }, { status: 401 }))
  }

  let event: ResendEvent
  try {
    event = JSON.parse(rawBody) as ResendEvent
  } catch {
    // Body verified but unparseable — still 200 so Resend doesn't retry.
    reqLog.error({}, 'resend.webhook.parse_failed')
    return respond(NextResponse.json({ ok: true, ignored: 'unparseable' }))
  }

  reqLog.info({ type: event.type, emailId: event.data?.email_id }, 'resend.webhook.received')

  if (!event?.type || !SUPPORTED_EVENTS.has(event.type)) {
    if (event?.type) reqLog.info({ type: event.type }, 'resend.webhook.unknown_event')
    return respond(NextResponse.json({ ok: true, ignored: event?.type ?? 'no_type' }))
  }
  reqLog.info({ type: event.type }, 'resend.webhook.verified')

  const recipient = firstAddress(event.data.to)

  try {
    switch (event.type) {
      case 'email.delivered': {
        await updateOutboundRow(event, {
          status: 'delivered',
          delivered_at: new Date().toISOString(),
          error: null,
        })
        break
      }
      case 'email.bounced': {
        const subType = event.data.bounce?.subType ?? event.data.bounce?.type ?? 'unknown'
        const bounceMsg = event.data.bounce?.message ?? 'bounced'
        await updateOutboundRow(event, {
          status: 'bounced',
          error: `bounce:${subType}:${bounceMsg}`.slice(0, 500),
        })
        // Only hard bounces are suppressed. Soft / transient bounces may
        // recover on retry.
        const isHard =
          /hard/i.test(String(event.data.bounce?.type)) ||
          /hard/i.test(String(event.data.bounce?.subType))
        if (isHard && recipient) {
          await addSuppression(recipient, 'bounce_hard', 'resend_webhook')
        }
        break
      }
      case 'email.complained': {
        await updateOutboundRow(event, {
          status: 'complained',
          error: 'complaint',
        })
        if (recipient) {
          await addSuppression(recipient, 'complaint', 'resend_webhook')
        }
        break
      }
      case 'email.failed': {
        await updateOutboundRow(event, {
          status: 'failed',
          error: 'provider_failed',
        })
        break
      }
      case 'email.delivery_delayed': {
        // Leave status='queued'. Just log so the operator can correlate.
        reqLog.info({ emailId: event.data.email_id }, 'resend.webhook.delivery_delayed')
        break
      }
      // email.sent / email.opened / email.clicked — accepted but not tracked.
      default:
        break
    }
  } catch (err) {
    reqLog.error({ err, type: event.type }, 'resend.webhook.failed')
    captureWebhookError('resend', err, { requestId, route: '/api/resend/webhook' })
    // Still 200 — Resend will retry on non-2xx; our partial state is OK.
  }

  return respond(NextResponse.json({ ok: true }))
}
