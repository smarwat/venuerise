// webhook route — Phase 8BF Meta / Instagram / Facebook
// inbound webhook with REAL signature verification + payload
// normalization.
//
// Replaces the Phase 8BE placeholder. Posture:
//
//   - GET:  Meta `hub.challenge` verification. Compares the
//           query `hub.verify_token` to `META_WEBHOOK_VERIFY_TOKEN`
//           env var in constant-time. Returns raw challenge as
//           text/plain on success.
//   - POST: Reads raw body ONCE, verifies the
//           `X-Hub-Signature-256` HMAC against `META_APP_SECRET`,
//           parses with `parseMetaWebhookPayload`, resolves the
//           target venue via `findMetaConnectionForEvent`, and
//           hands each event to `normalizeInboundChannelMessage`.
//
// Outbound stays MANUAL-REQUIRED. Lead-ad events ship as
// hydration-pending placeholders (see meta-parser.ts).
//
// AUDIT_EXEMPT: public webhook route. Failed verifications are
// counted via Sentry / pino logs (no token / signature / body
// logged). Successful events leave a forensic trail through the
// `messages` + `external_messages` rows the normalization helper
// inserts — same rationale as the public widget intake.
//
// Rate-limited by IP via inboundChannel.metaWebhook (Phase 8BE
// catalog entry).

import { NextRequest, NextResponse } from 'next/server'
import { rateLimitWidget, rateLimitedResponse } from '@/lib/rate-limit'
import { log } from '@/lib/log'
import {
  getOrCreateRequestId,
  withRequestIdHeader,
} from '@/lib/observability/request-id'
import { captureApiError } from '@/lib/observability/sentry'
import { verifyMetaSignature } from '@/lib/integrations/channels/meta-signature'
import {
  parseMetaWebhookPayload,
  type ParsedMetaEvent,
} from '@/lib/integrations/channels/meta-parser'
import { findMetaConnectionForEvent } from '@/lib/integrations/channels/meta-connections'
import { normalizeInboundChannelMessage } from '@/lib/integrations/channels/normalization'

// ── GET — Meta hub.challenge verification ─────────────────────────────

export async function GET(request: NextRequest): Promise<Response> {
  const requestId = getOrCreateRequestId(request)
  const reqLog = log.child({
    requestId,
    route: '/api/integrations/meta/webhook',
    op: 'meta.webhook.verify',
  })
  const respond = <T extends Response>(r: T) =>
    withRequestIdHeader(r, requestId)

  const url = new URL(request.url)
  const mode = url.searchParams.get('hub.mode')
  const verifyToken = url.searchParams.get('hub.verify_token')
  const challenge = url.searchParams.get('hub.challenge')
  const expected = process.env.META_WEBHOOK_VERIFY_TOKEN

  if (!expected) {
    reqLog.warn({ mode }, 'meta.webhook.verify_unconfigured')
    // Match the 8BE placeholder shape so existing operator
    // tooling keeps reading the same error code.
    return respond(
      NextResponse.json(
        {
          error: 'placeholder_only',
          detail:
            'META_WEBHOOK_VERIFY_TOKEN is not configured. See docs/OMNICHANNEL-INBOX.md §15.',
        },
        { status: 503 }
      )
    )
  }

  if (
    mode === 'subscribe' &&
    typeof verifyToken === 'string' &&
    typeof challenge === 'string' &&
    constantTimeStringEqual(verifyToken, expected)
  ) {
    reqLog.info({}, 'meta.webhook.verify_ok')
    return respond(
      new NextResponse(challenge, {
        status: 200,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      })
    )
  }
  // Never log the token. Failure path returns 403 per Meta spec.
  reqLog.warn({ mode }, 'meta.webhook.verify_failed')
  return respond(NextResponse.json({ error: 'invalid_verify' }, { status: 403 }))
}

function constantTimeStringEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return diff === 0
}

// ── POST — verified event delivery ──────────────────────────────────

interface PerEventOutcome {
  channel: string
  status: 'normalized' | 'ignored_no_connection' | 'ignored_normalization_failed'
  reason?: string
}

export async function POST(request: NextRequest): Promise<Response> {
  const requestId = getOrCreateRequestId(request)
  const reqLog = log.child({
    requestId,
    route: '/api/integrations/meta/webhook',
    op: 'meta.webhook.event',
  })
  const respond = <T extends Response>(r: T) =>
    withRequestIdHeader(r, requestId)

  // 1. Rate-limit by IP. The verified-venue context is buried
  // inside the signed payload, so per-IP is the cheapest gate
  // against signature-probe abuse.
  const rl = await rateLimitWidget(request)
  if (!rl.allowed) {
    return respond(rateLimitedResponse(rl))
  }

  // 2. Read the raw body EXACTLY once. The HMAC is computed
  // over the literal bytes Meta sent; we must not re-serialize
  // after JSON.parse. The Node.js fetch Request gives us bytes
  // via .text(), which preserves whitespace + ordering.
  let rawBody: string
  try {
    rawBody = await request.text()
  } catch (err) {
    reqLog.warn({ err }, 'meta.webhook.body_read_failed')
    return respond(
      NextResponse.json({ error: 'body_read_failed' }, { status: 400 })
    )
  }
  if (rawBody.length === 0) {
    return respond(NextResponse.json({ error: 'empty_body' }, { status: 400 }))
  }

  // 3. Verify the HMAC. NEVER log the signature or the secret.
  const signatureHeader = request.headers.get('x-hub-signature-256')
  const sig = verifyMetaSignature(
    rawBody,
    signatureHeader,
    process.env.META_APP_SECRET
  )
  if (!sig.ok) {
    if (sig.reason === 'missing_secret') {
      // Server misconfiguration — distinct from a bad caller.
      reqLog.warn({}, 'meta.webhook.signature_unconfigured')
      return respond(
        NextResponse.json(
          {
            error: 'webhook_not_configured',
            detail:
              'META_APP_SECRET is not set. See docs/OMNICHANNEL-INBOX.md §15.',
          },
          { status: 503 }
        )
      )
    }
    reqLog.warn(
      { reason: sig.reason },
      'meta.webhook.signature_verification_failed'
    )
    return respond(
      NextResponse.json({ error: 'invalid_signature' }, { status: 401 })
    )
  }

  // 4. Parse JSON safely.
  let payload: unknown
  try {
    payload = JSON.parse(rawBody)
  } catch (err) {
    reqLog.warn({ err }, 'meta.webhook.invalid_json')
    return respond(
      NextResponse.json({ error: 'invalid_json' }, { status: 400 })
    )
  }

  // 5. Run parser. Pure function, never throws.
  const parsed = parseMetaWebhookPayload(payload)
  const perEvent: PerEventOutcome[] = []
  let normalized = 0
  let ignored = parsed.ignored

  // 6. For each event, resolve a connection + normalize.
  for (const ev of parsed.events) {
    try {
      const match = await findMetaConnectionForEvent(ev)
      if (!match) {
        ignored += 1
        perEvent.push({
          channel: ev.channelType,
          status: 'ignored_no_connection',
        })
        continue
      }
      const out = await runNormalize(ev, match.venueId, match.connection.id)
      if (out.ok) {
        normalized += 1
        perEvent.push({ channel: ev.channelType, status: 'normalized' })
      } else {
        ignored += 1
        perEvent.push({
          channel: ev.channelType,
          status: 'ignored_normalization_failed',
          reason: out.reason,
        })
      }
    } catch (err) {
      ignored += 1
      perEvent.push({
        channel: ev.channelType,
        status: 'ignored_normalization_failed',
        reason: 'exception',
      })
      reqLog.error(
        { err, channel: ev.channelType, eventType: ev.eventType },
        'meta.webhook.normalize_threw'
      )
      captureApiError(err, {
        requestId,
        route: '/api/integrations/meta/webhook',
      })
    }
  }

  reqLog.info(
    {
      objectType: parsed.objectType,
      eventsParsed: parsed.events.length,
      eventsNormalized: normalized,
      eventsIgnored: ignored,
    },
    'meta.webhook.processed'
  )

  // Always 200 so Meta does not retry. Per-event outcomes ride
  // in the response body for QA / curl runs.
  return respond(
    NextResponse.json({
      success: true,
      received: true,
      events_parsed: parsed.events.length,
      events_normalized: normalized,
      events_ignored: ignored,
      object_type: parsed.objectType,
      per_event: perEvent,
    })
  )
}

async function runNormalize(
  event: ParsedMetaEvent,
  venueId: string,
  channelConnectionId: string
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const metadata = {
    provider: 'meta' as const,
    meta_object_type: event.metadata['meta_object_type'] ?? null,
    meta_event_type: event.eventType,
    signature_verified: true,
    channel_connection_id: channelConnectionId,
    ...(event.eventType === 'leadgen'
      ? { requires_graph_hydration: true, parse_needs_review: true }
      : {}),
    ...event.metadata,
  }
  const result = await normalizeInboundChannelMessage({
    venueId,
    channelType: event.channelType,
    externalLeadId: null,
    externalMessageId: event.externalMessageId,
    externalThreadId: event.externalThreadId,
    externalContactId: event.externalSenderId,
    contactName: event.name,
    contactEmail: event.email,
    contactPhone: event.phone,
    messageBody: event.message,
    eventDate: event.eventDate,
    guestCount: event.guestCount,
    budget: event.budget,
    sourceLabel: event.channelType,
    receivedAt: event.receivedAt,
    metadata,
    messageMetadataExtra: metadata,
  })
  if (!result.ok) {
    return { ok: false, reason: result.code }
  }
  return { ok: true }
}
