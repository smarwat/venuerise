// public route — Phase 8BU Twilio outbound SMS status callback.
//
// Twilio POSTs a status update for each outbound message at
// every lifecycle transition (queued → sent → delivered, or
// failed / undelivered). The webhook is signed with the same
// HMAC-SHA1 + sorted-form-params algorithm as inbound SMS
// (8BS); we reuse `verifyTwilioSmsSignature` to keep one code
// path.
//
// AUDIT_EXEMPT: webhook posture matches /api/inbound/sms.
// Forensic trail = the message metadata patch + pino logs.
// Webhooks stay out of audit_events per the Phase 9A
// "don't touch webhooks" rule (documented in
// docs/AUDIT-COVERAGE.md).
//
// Kill switch: TWILIO_SMS_STATUS_CALLBACK_ENABLED. When off,
// the route returns 200 + empty body so Twilio doesn't burn
// its retry budget. The operator notices because no lifecycle
// updates land on bubbles (sends stay at "Accepted by SMS"
// forever).

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { rateLimitWidget, rateLimitedResponse } from '@/lib/rate-limit'
import { log } from '@/lib/log'
import {
  getOrCreateRequestId,
  withRequestIdHeader,
} from '@/lib/observability/request-id'
import { captureWebhookError } from '@/lib/observability/sentry'
import { verifyTwilioSmsSignature } from '@/lib/integrations/inbound/sms'
import {
  normalizeSmsDeliveryStatus,
  normalizeTwilioRawStatus,
  shouldOverwriteSmsStatus,
  type SmsDeliveryStatus,
} from '@/lib/integrations/delivery/sms-status'

const FALSE_VALUES = new Set(['', '0', 'false', 'no', 'off'])

function isStatusCallbackEnabled(): boolean {
  const raw = process.env.TWILIO_SMS_STATUS_CALLBACK_ENABLED
  if (raw == null) return false
  if (FALSE_VALUES.has(raw.trim().toLowerCase())) return false
  return !!process.env.TWILIO_AUTH_TOKEN
}

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

/** Trim Twilio error message into a UI-safe short form. */
function safeShortError(raw: string | null | undefined): string | null {
  if (!raw) return null
  return String(raw).replace(/\s+/g, ' ').trim().slice(0, 200) || null
}

export async function POST(request: NextRequest): Promise<Response> {
  const requestId = getOrCreateRequestId(request)
  const reqLog = log.child({
    requestId,
    route: '/api/twilio/sms/status',
  })
  const respond = <T extends Response>(r: T) =>
    withRequestIdHeader(r, requestId)

  // 0. Kill switch.
  if (!isStatusCallbackEnabled()) {
    reqLog.info({}, 'sms.status.disabled_ignored')
    return respond(new Response('', { status: 200 }))
  }

  // 1. Rate-limit (same posture as other anonymous webhooks).
  const rl = await rateLimitWidget(request)
  if (!rl.allowed) {
    reqLog.warn(
      { retryMs: rl.retryAfterMs, mode: rl.mode },
      'rate_limit.blocked'
    )
    return respond(rateLimitedResponse(rl))
  }

  // 2. Read raw form body — Twilio signs the form-encoded body,
  //    not parsed JSON.
  const rawText = await request.text()
  const formParams = new URLSearchParams(rawText)
  const paramMap: Record<string, string> = {}
  formParams.forEach((v, k) => {
    paramMap[k] = v
  })

  // 3. Signature verify.
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
    // Same dev-bypass posture as inbound. Production: no bypass.
    const isDev = process.env.NODE_ENV !== 'production'
    const bypassToken = process.env.INBOUND_SMS_DEV_BYPASS_TOKEN
    const headerBypass = request.headers.get('x-inbound-sms-dev-bypass')
    const bypassOk =
      isDev && bypassToken && headerBypass && bypassToken === headerBypass
    if (!bypassOk) {
      reqLog.warn({}, 'sms.status.invalid_signature')
      return respond(
        NextResponse.json({ error: 'invalid_signature' }, { status: 401 })
      )
    }
    reqLog.warn({}, 'sms.status.dev_bypass_used')
  }

  // 4. Pull the fields we care about. MessageStatus is the
  //    primary; some legacy events use SmsStatus.
  const messageSid = paramMap['MessageSid'] ?? null
  const rawStatus =
    paramMap['MessageStatus'] ?? paramMap['SmsStatus'] ?? null
  const errorCode = paramMap['ErrorCode'] ?? null
  const errorMessage = paramMap['ErrorMessage'] ?? null

  if (!messageSid) {
    reqLog.warn({}, 'sms.status.missing_message_sid')
    return respond(new Response('', { status: 200 }))
  }
  const nextStatus: SmsDeliveryStatus = normalizeTwilioRawStatus(rawStatus)
  if (nextStatus === 'unknown') {
    // Inbound-style events (`receiving`/`received`) shouldn't
    // hit this callback URL, but defensively ignore.
    reqLog.info({ messageSid, rawStatus }, 'sms.status.unknown_event_ignored')
    return respond(new Response('', { status: 200 }))
  }

  // 5. Look up the matching messages row by MessageSid stamped
  //    on metadata.provider_message_id at send/retry time. We
  //    deliberately also filter on reply_method='sms' so a
  //    spoofed payload couldn't accidentally patch an email
  //    row (Resend uses a different id space, but defense in
  //    depth).
  const svc = createServiceClient()
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const { data: msgRow, error: msgErr } = await (svc as any)
    .from('messages')
    .select('id, conversation_id, venue_id, metadata, created_at')
    .eq('metadata->>provider_message_id', messageSid)
    .eq('metadata->>reply_method', 'sms')
    .eq('metadata->>delivery_provider', 'twilio')
    .limit(1)
    .maybeSingle()
  /* eslint-enable @typescript-eslint/no-explicit-any */
  if (msgErr) {
    reqLog.warn(
      { errorMessage: msgErr.message, messageSid },
      'sms.status.message_lookup_failed'
    )
    return respond(new Response('', { status: 200 }))
  }
  if (!msgRow) {
    // Could be a retry whose new MessageSid hasn't been
    // persisted yet (race) or a callback for a message that
    // pre-dates the StatusCallback wiring. Log + 200.
    reqLog.info(
      { messageSid, nextStatus },
      'sms.status.no_message_match'
    )
    return respond(new Response('', { status: 200 }))
  }
  const message = msgRow as {
    id: string
    conversation_id: string
    venue_id: string
    metadata: Record<string, unknown> | null
    created_at: string
  }
  const md = message.metadata ?? {}

  // 6. Decide whether to overwrite.
  const currentStatus = normalizeSmsDeliveryStatus(md.delivery_status)
  if (!shouldOverwriteSmsStatus(currentStatus, nextStatus)) {
    // Late event — still stamp the forensic timestamp + the
    // raw provider status so an audit drawer can reconstruct
    // the lifecycle. Don't flip the visible status.
    await stampLateEvent(svc, message.id, md, nextStatus, rawStatus)
    reqLog.info(
      { messageSid, currentStatus, nextStatus },
      'sms.status.skipped_overwrite'
    )
    return respond(new Response('', { status: 200 }))
  }

  // 7. Build patch.
  const nowIso = new Date().toISOString()
  const patch: Record<string, unknown> = {
    ...md,
    delivery_status: nextStatus,
    delivery_provider: 'twilio',
    delivery_channel: 'sms',
    delivery_provider_status: rawStatus ?? null,
    delivery_event_type: 'twilio.sms.status',
    delivery_last_event_at: nowIso,
  }
  switch (nextStatus) {
    case 'queued':
    case 'accepted':
      patch.queued_at = md.queued_at ?? nowIso
      delete patch.delivery_error_code
      delete patch.delivery_safe_error
      break
    case 'sending':
      // No new timestamp; "sending" is transient.
      delete patch.delivery_error_code
      delete patch.delivery_safe_error
      break
    case 'sent':
      patch.sent_at = nowIso
      delete patch.delivery_error_code
      delete patch.delivery_safe_error
      break
    case 'delivered':
      patch.delivered_at = nowIso
      delete patch.delivery_error_code
      delete patch.delivery_safe_error
      break
    case 'undelivered':
      patch.undelivered_at = nowIso
      patch.delivery_error_code = errorCode
        ? `twilio_${errorCode}`
        : 'carrier_undelivered'
      patch.delivery_safe_error =
        safeShortError(errorMessage) ??
        'Carrier could not deliver this message.'
      break
    case 'failed':
      patch.failed_at = nowIso
      patch.delivery_error_code = errorCode
        ? `twilio_${errorCode}`
        : 'provider_failed'
      patch.delivery_safe_error =
        safeShortError(errorMessage) ??
        'Provider rejected the message.'
      break
    default:
      break
  }

  const { error: patchErr } = await svc
    .from('messages')
    .update({ metadata: patch })
    .eq('id', message.id)
  if (patchErr) {
    reqLog.warn(
      { errorMessage: patchErr.message, messageId: message.id },
      'sms.status.message_patch_failed'
    )
    captureWebhookError(
      'twilio_sms_status',
      new Error(patchErr.message),
      { requestId, route: '/api/twilio/sms/status' }
    )
    // 200 — Twilio retrying wouldn't fix a DB write failure.
    return respond(new Response('', { status: 200 }))
  }

  reqLog.info(
    {
      messageId: message.id,
      messageSid,
      currentStatus,
      nextStatus,
      rawStatus,
    },
    'sms.status.patched'
  )

  return respond(new Response('', { status: 200 }))
}

/**
 * Late-event stamping. Even when we won't overwrite the visible
 * status (out-of-order webhook), we preserve forensic
 * timestamps + the raw provider status so the audit drawer
 * can reconstruct the lifecycle.
 */
async function stampLateEvent(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  svc: any,
  messageId: string,
  md: Record<string, unknown>,
  nextStatus: SmsDeliveryStatus,
  rawStatus: string | null
): Promise<void> {
  const nowIso = new Date().toISOString()
  const patch: Record<string, unknown> = {
    ...md,
    delivery_last_event_at: nowIso,
    delivery_last_event_type: 'twilio.sms.status',
    delivery_last_provider_status: rawStatus ?? null,
  }
  if (nextStatus === 'queued' && !md.queued_at) patch.queued_at = nowIso
  if (nextStatus === 'sent' && !md.sent_at) patch.sent_at = nowIso
  if (nextStatus === 'delivered' && !md.delivered_at) patch.delivered_at = nowIso
  if (nextStatus === 'undelivered' && !md.undelivered_at) patch.undelivered_at = nowIso
  if (nextStatus === 'failed' && !md.failed_at) patch.failed_at = nowIso
  try {
    await svc.from('messages').update({ metadata: patch }).eq('id', messageId)
  } catch {
    // Best-effort.
  }
}
