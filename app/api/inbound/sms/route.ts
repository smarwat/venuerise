// public route — Phase 8BS inbound SMS capture.
//
// Twilio HTTP messaging webhook. Twilio POSTs an
// application/x-www-form-urlencoded body containing
// MessageSid + From + To + Body (+ NumMedia + SmsStatus etc.)
// when a lead replies to OUTBOUND_SMS_FROM. We verify the
// Twilio HMAC-SHA1 signature, match to a conversation by
// recent outbound SMS or lead phone, and insert as
// `role:'lead'` for the inbox to render on the left.
//
// AUDIT_EXEMPT: mirrors the rationale of /api/inbound/email
// and the lead-forwarding routes — every captured row writes
// a messages row which constitutes the forensic trail.
// Webhooks stay out of audit_events per the Phase 9A
// "don't touch webhooks" rule (documented in
// docs/AUDIT-COVERAGE.md). Rejected payloads log to pino with
// the request id; abuse signals flow through the rate-limit
// catalog (inboundChannel.inboundSmsReply).
//
// Gated by INBOUND_SMS_ENABLED + TWILIO_AUTH_TOKEN.
//
// Disabled mode: returns 200 + empty TwiML so Twilio doesn't
// retry forever, but logs `inbound.sms.disabled_ignored`.
// Operator notices in their Twilio console that delivery is
// happening but the app has stopped processing — loud-enough
// signal without burning Twilio's retry budget.

import { NextRequest, NextResponse } from 'next/server'
import { rateLimitWidget, rateLimitedResponse } from '@/lib/rate-limit'
import { log } from '@/lib/log'
import {
  getOrCreateRequestId,
  withRequestIdHeader,
} from '@/lib/observability/request-id'
import { captureWebhookError } from '@/lib/observability/sentry'
import {
  isInboundSmsEnabled,
  normalizeInboundSmsPayload,
  processInboundSmsReply,
  verifyTwilioSmsSignature,
} from '@/lib/integrations/inbound/sms'

const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?>\n<Response></Response>'

function twimlResponse(): Response {
  return new Response(EMPTY_TWIML, {
    status: 200,
    headers: { 'Content-Type': 'application/xml; charset=utf-8' },
  })
}

/**
 * Reconstruct the public URL Twilio used. Vercel / proxies
 * rewrite `request.url` to the internal host, so we honor the
 * x-forwarded-* headers Twilio's signature was computed over.
 *
 * Order of preference:
 *   1. `${x-forwarded-proto}://${x-forwarded-host}${pathname}${search}`
 *   2. `NEXT_PUBLIC_APP_URL` + pathname + search
 *   3. `request.url` (last-resort fallback for local dev)
 */
function reconstructPublicUrl(request: NextRequest): string {
  const url = new URL(request.url)
  const fwdProto =
    request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim() ?? null
  const fwdHost =
    request.headers.get('x-forwarded-host')?.split(',')[0]?.trim() ??
    request.headers.get('host') ??
    null
  if (fwdProto && fwdHost) {
    return `${fwdProto}://${fwdHost}${url.pathname}${url.search}`
  }
  const appUrl = process.env.NEXT_PUBLIC_APP_URL
  if (appUrl) {
    return `${appUrl.replace(/\/+$/, '')}${url.pathname}${url.search}`
  }
  return request.url
}

export async function POST(request: NextRequest): Promise<Response> {
  const requestId = getOrCreateRequestId(request)
  const reqLog = log.child({
    requestId,
    route: '/api/inbound/sms',
  })
  const respond = <T extends Response>(r: T) =>
    withRequestIdHeader(r, requestId)

  // 0. Kill switch. Return 200 + empty TwiML so Twilio doesn't
  //    spend its retry budget on a disabled endpoint. The
  //    operator notices because messages arrive at the Twilio
  //    number but never appear in VenueRise.
  if (!isInboundSmsEnabled()) {
    reqLog.info({}, 'inbound.sms.disabled_ignored')
    return respond(twimlResponse())
  }

  // 1. Rate limit by IP. Twilio publishes its egress IP ranges
  //    so a single legitimate webhook stream sits well under
  //    the widget bucket (10/min/IP). Shared with other
  //    anonymous public webhooks.
  const rl = await rateLimitWidget(request)
  if (!rl.allowed) {
    reqLog.warn(
      { retryMs: rl.retryAfterMs, mode: rl.mode },
      'rate_limit.blocked'
    )
    return respond(rateLimitedResponse(rl))
  }

  // 2. Read raw form body (Twilio signs the form-encoded body,
  //    not JSON). We need both the parsed map (for matching)
  //    and the original key/value pairs (for signature
  //    verification — sorted-concat is over the form, not the
  //    body string).
  const rawText = await request.text()
  const formParams = new URLSearchParams(rawText)
  const paramMap: Record<string, string> = {}
  formParams.forEach((v, k) => {
    paramMap[k] = v
  })

  // 3. Twilio signature verification. HMAC-SHA1 over
  //    `${publicUrl}${sorted_concat(key+value)}` with the
  //    Twilio auth token. Implemented in the helper.
  const headerSig = request.headers.get('x-twilio-signature')
  const authToken = process.env.TWILIO_AUTH_TOKEN!
  const publicUrl = reconstructPublicUrl(request)
  const verified = verifyTwilioSmsSignature({
    url: publicUrl,
    params: paramMap,
    signature: headerSig,
    authToken,
  })

  if (!verified) {
    // Dev-only bypass — when running locally against the
    // Twilio CLI's `twilio phone-numbers:update --sms-url`
    // simulator OR a curl-based test, the host header may
    // differ from the URL Twilio actually signed. Bypass is
    // SCOPED TIGHT: must be non-production AND must have a
    // bypass token header that matches the dev secret. No
    // bypass in production, ever.
    const isDev = process.env.NODE_ENV !== 'production'
    const bypassToken = process.env.INBOUND_SMS_DEV_BYPASS_TOKEN
    const headerBypass = request.headers.get('x-inbound-sms-dev-bypass')
    const bypassOk =
      isDev && bypassToken && headerBypass && bypassToken === headerBypass
    if (!bypassOk) {
      reqLog.warn({}, 'inbound.sms.invalid_signature')
      return respond(
        NextResponse.json({ error: 'invalid_signature' }, { status: 401 })
      )
    }
    reqLog.warn({}, 'inbound.sms.dev_bypass_used')
  }

  // 4. Normalize payload.
  const normalized = normalizeInboundSmsPayload(paramMap)
  if ('error' in normalized) {
    reqLog.warn({ error: normalized.error }, 'inbound.sms.normalize_failed')
    // 200 + empty TwiML — provider shouldn't retry an
    // unparseable payload.
    return respond(twimlResponse())
  }

  // 5. Process. Helper handles dedupe, matching, insert.
  try {
    const result = await processInboundSmsReply(normalized)
    if (!result.ok) {
      reqLog.warn(
        { reason: result.reason, safeError: result.safeError },
        'inbound.sms.process_failed'
      )
      // Still 200 so Twilio doesn't retry on a platform-side
      // failure. The pino trail is the forensic record.
      return respond(twimlResponse())
    }
    reqLog.info(
      {
        ignored: !!result.ignored,
        reason: result.reason,
        messageIdPresent: !!result.messageId,
        conversationIdPresent: !!result.conversationId,
        matchMethod: result.match?.matchMethod ?? null,
        matchConfidence: result.match?.matchConfidence ?? null,
      },
      result.ignored ? 'inbound.sms.ignored' : 'inbound.sms.accepted'
    )
    return respond(twimlResponse())
  } catch (err) {
    reqLog.error({ err }, 'inbound.sms.threw')
    captureWebhookError('inbound_sms', err, {
      requestId,
      route: '/api/inbound/sms',
    })
    // 200 so Twilio doesn't retry on platform bug.
    return respond(twimlResponse())
  }
}
