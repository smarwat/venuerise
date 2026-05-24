// public route — Phase 8BO inbound email reply capture.
//
// Anonymous webhook receiver for inbound email replies. Provider-
// agnostic: accepts a normalized JSON payload that Resend Inbound,
// Postmark Inbound, SendGrid Inbound Parse, and Cloudflare Email
// Workers can all be configured to POST. Auth is a shared
// HMAC-SHA256 secret (`INBOUND_EMAIL_WEBHOOK_SECRET`) signed over
// the raw body via the `x-inbound-email-signature` header.
//
// AUDIT_EXEMPT: mirrors the rationale of /api/integrations/lead-
// forwarding/* — every accepted reply writes a `messages` row +
// an `external_messages` row via normalizeInboundChannelMessage,
// which together constitute the forensic trail. The webhook itself
// stays out of audit_events per the Phase 9A "don't touch
// webhooks" rule (documented in docs/AUDIT-COVERAGE.md). Rejected
// payloads log to pino with the request id; abuse signals flow
// through the rate-limit catalog (inboundChannel.inboundEmailReply).
//
// Gated by INBOUND_EMAIL_ENABLED. When off, the route returns 503
// so a misconfigured upstream provider gets a loud signal instead
// of silently dropping replies.

import { NextRequest, NextResponse } from 'next/server'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import { createServiceClient } from '@/lib/supabase/service'
import { rateLimitWidget, rateLimitedResponse } from '@/lib/rate-limit'
import { log } from '@/lib/log'
import {
  getOrCreateRequestId,
  withRequestIdHeader,
} from '@/lib/observability/request-id'
import { captureWebhookError } from '@/lib/observability/sentry'
import { normalizeInboundChannelMessage } from '@/lib/integrations/channels/normalization'
import { isSuppressed } from '@/lib/integrations/suppression'
import {
  buildInboundMessageMetadata,
  extractReferencedMessageIds,
  INBOUND_REVIEW_THRESHOLD,
  normalizeInboundPayload,
  scoreMatchConfidence,
  type MatchSignals,
} from '@/lib/integrations/inbound/email'
import { createInboundEmailOrphan } from '@/lib/integrations/inbound/orphans'

const FALSE_VALUES = new Set(['', '0', 'false', 'no', 'off'])

function isEnabled(): boolean {
  const raw = process.env.INBOUND_EMAIL_ENABLED
  if (raw == null) return false
  return !FALSE_VALUES.has(raw.trim().toLowerCase())
}

// ─── Body schema ─────────────────────────────────────────────────────────
//
// Provider-agnostic. The webhook config in Resend/Postmark/SG can
// be set to deliver this exact shape (most have a "template" or
// "transform" feature; for Cloudflare Email Workers the worker
// script composes it directly).

const InboundEmailSchema = z.object({
  // Provider name lets us attribute parse confidence + show in
  // admin tooling. Free-form but capped.
  provider: z.string().max(40).default('resend'),
  // The inbound provider's own id for this email — used for
  // de-duplication if the webhook retries.
  provider_inbound_id: z.string().max(200).optional().nullable(),
  // RFC 5322 envelope.
  from: z.string().max(320),
  from_name: z.string().max(200).optional().nullable(),
  to: z.string().max(320),
  cc: z.array(z.string().max(320)).max(20).optional().nullable(),
  subject: z.string().max(500).optional().nullable(),
  text: z.string().max(200_000).optional().nullable(),
  html: z.string().max(400_000).optional().nullable(),
  // Standard headers we use for thread matching.
  headers: z
    .object({
      message_id: z.string().max(998).optional().nullable(),
      in_reply_to: z.string().max(4000).optional().nullable(),
      references: z.string().max(8000).optional().nullable(),
    })
    .optional()
    .nullable(),
  received_at: z.string().datetime().optional().nullable(),
})

// ─── HMAC verification ──────────────────────────────────────────────────

function verifyHmac(rawBody: string, headerSig: string | null, secret: string): boolean {
  if (!headerSig) return false
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex')
  // Header may be "sha256=<hex>" (Postmark/Cloudflare convention)
  // or just "<hex>" — handle both.
  const candidate = headerSig.startsWith('sha256=')
    ? headerSig.slice('sha256='.length)
    : headerSig
  if (candidate.length !== expected.length) return false
  try {
    return timingSafeEqual(
      Buffer.from(candidate, 'utf8'),
      Buffer.from(expected, 'utf8')
    )
  } catch {
    return false
  }
}

// ─── Matching strategies ────────────────────────────────────────────────
//
// Two paths, tried in order:
//
//   1. HEADER MATCH (high confidence). Parse In-Reply-To +
//      References for any RFC 5322 message ids. For each, look up
//      `outbound_messages.provider_message_id`. First hit wins.
//      The Resend webhook (Phase 8BN) stamps the Resend email id
//      onto this column; we never invented our own Message-ID, so
//      we rely on the provider's id appearing in the recipient's
//      reply headers. Every modern mail client preserves
//      In-Reply-To verbatim.
//
//   2. RECENT-RECIPIENT MATCH (medium confidence). No matching
//      header. Fall back to "the From address received an outbound
//      from us within the last 30 days" — likely a reply that
//      lost its headers (some forwarding rules, some webmail
//      clients). Pick the most recent matching outbound to lock in
//      the venue + conversation.
//
//   3. NONE → still ingest, stamp parse_needs_review=true so the
//      operator sees the orphan in a review queue (or, today, on
//      the inbox conversation it lands on via the From address's
//      lead record — TBD; see "Known limitations" in the doc).

interface MatchResult {
  outboundMessageId: string | null
  providerMessageId: string | null
  conversationId: string | null
  venueId: string | null
  leadId: string | null
  signals: MatchSignals
}

async function matchInboundToConversation(args: {
  fromEmail: string
  referencedMessageIds: string[]
}): Promise<MatchResult> {
  const supabase = createServiceClient()
  const signals: MatchSignals = {
    matchedByHeader: false,
    matchedByRecentRecipient: false,
    recipientWasSuppressed: false,
  }

  // 1. Header match. Iterate the referenced message ids and look
  //    each up. We use `.in()` so a single query covers all refs.
  if (args.referencedMessageIds.length > 0) {
    const { data, error } = await supabase
      .from('outbound_messages')
      .select(
        'id, provider_message_id, venue_id, lead_id, related_table, related_id, metadata'
      )
      .in('provider_message_id', args.referencedMessageIds)
      .limit(5)
    if (error) {
      log.error(
        { errorMessage: error.message },
        'inbound.email.header_match_failed'
      )
    } else if (data && data.length > 0) {
      // First match wins. Look at the related_id (which is
      // `messages.id` for composer-originated sends) to derive the
      // conversation. Fall back to looking up by venue_id +
      // lead_id if related_table isn't 'messages'.
      const hit = data[0] as {
        id: string
        provider_message_id: string | null
        venue_id: string
        lead_id: string | null
        related_table: string | null
        related_id: string | null
        metadata: Record<string, unknown> | null
      }
      let conversationId: string | null = null
      if (hit.related_table === 'messages' && hit.related_id) {
        const { data: msgRow } = await supabase
          .from('messages')
          .select('conversation_id')
          .eq('id', hit.related_id)
          .maybeSingle()
        conversationId =
          (msgRow as { conversation_id?: string } | null)?.conversation_id ??
          null
      }
      // If we couldn't resolve via related_id, pick the most
      // recent conversation on this lead.
      if (!conversationId && hit.lead_id) {
        const { data: convRow } = await supabase
          .from('conversations')
          .select('id')
          .eq('lead_id', hit.lead_id)
          .order('last_message_at', { ascending: false })
          .limit(1)
          .maybeSingle()
        conversationId = (convRow as { id?: string } | null)?.id ?? null
      }
      signals.matchedByHeader = true
      return {
        outboundMessageId: hit.id,
        providerMessageId: hit.provider_message_id,
        conversationId,
        venueId: hit.venue_id,
        leadId: hit.lead_id,
        signals,
      }
    }
  }

  // 2. Recipient match — most recent outbound to this From
  //    address within the last 30 days.
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
  const { data: recent, error: recentErr } = await supabase
    .from('outbound_messages')
    .select(
      'id, provider_message_id, venue_id, lead_id, related_table, related_id, created_at'
    )
    .eq('to_address', args.fromEmail)
    .eq('channel', 'email')
    .gte('created_at', cutoff)
    .order('created_at', { ascending: false })
    .limit(1)
  if (recentErr) {
    log.error(
      { errorMessage: recentErr.message },
      'inbound.email.recent_match_failed'
    )
  }
  const recentHit = (recent as Array<{
    id: string
    provider_message_id: string | null
    venue_id: string
    lead_id: string | null
    related_table: string | null
    related_id: string | null
  }> | null)?.[0]
  if (recentHit) {
    let conversationId: string | null = null
    if (recentHit.related_table === 'messages' && recentHit.related_id) {
      const { data: msgRow } = await supabase
        .from('messages')
        .select('conversation_id')
        .eq('id', recentHit.related_id)
        .maybeSingle()
      conversationId =
        (msgRow as { conversation_id?: string } | null)?.conversation_id ??
        null
    }
    if (!conversationId && recentHit.lead_id) {
      const { data: convRow } = await supabase
        .from('conversations')
        .select('id')
        .eq('lead_id', recentHit.lead_id)
        .order('last_message_at', { ascending: false })
        .limit(1)
        .maybeSingle()
      conversationId = (convRow as { id?: string } | null)?.id ?? null
    }
    signals.matchedByRecentRecipient = true
    return {
      outboundMessageId: recentHit.id,
      providerMessageId: recentHit.provider_message_id,
      conversationId,
      venueId: recentHit.venue_id,
      leadId: recentHit.lead_id,
      signals,
    }
  }

  return {
    outboundMessageId: null,
    providerMessageId: null,
    conversationId: null,
    venueId: null,
    leadId: null,
    signals,
  }
}

// ─── Handler ────────────────────────────────────────────────────────────

export async function POST(request: NextRequest): Promise<Response> {
  const requestId = getOrCreateRequestId(request)
  const reqLog = log.child({
    requestId,
    route: '/api/inbound/email',
  })
  const respond = <T extends Response>(r: T) =>
    withRequestIdHeader(r, requestId)

  // 0. Kill switch. 503 (not 404) so a misconfigured upstream
  //    provider sees a loud signal instead of silently retrying
  //    forever — and so the operator notices in their provider
  //    dashboard that inbound is off.
  if (!isEnabled()) {
    return respond(
      NextResponse.json(
        { error: 'inbound_email_disabled' },
        { status: 503 }
      )
    )
  }

  const secret = process.env.INBOUND_EMAIL_WEBHOOK_SECRET
  if (!secret) {
    // Production misconfiguration. Loud + safe.
    reqLog.error({}, 'inbound.email.secret_missing')
    return respond(
      NextResponse.json(
        { error: 'webhook_not_configured' },
        { status: 401 }
      )
    )
  }

  // 1. Rate limit by IP (provider IP). Same posture as widget;
  //    legitimate inbound bursts (one venue getting 10 replies in
  //    a minute) stay under the cap.
  const rl = await rateLimitWidget(request)
  if (!rl.allowed) {
    reqLog.warn(
      { retryMs: rl.retryAfterMs, mode: rl.mode },
      'rate_limit.blocked'
    )
    return respond(rateLimitedResponse(rl))
  }

  // 2. Read raw body for HMAC verification. We can't use
  //    `request.json()` because we need the exact bytes the
  //    sender signed.
  const rawBody = await request.text()
  const headerSig =
    request.headers.get('x-inbound-email-signature') ??
    request.headers.get('x-webhook-signature')
  if (!verifyHmac(rawBody, headerSig, secret)) {
    return respond(
      NextResponse.json({ error: 'invalid_signature' }, { status: 401 })
    )
  }

  // 3. Parse + validate payload.
  let body: z.infer<typeof InboundEmailSchema>
  try {
    const raw = JSON.parse(rawBody)
    const parsed = InboundEmailSchema.safeParse(raw)
    if (!parsed.success) {
      return respond(
        NextResponse.json(
          { error: 'invalid_payload', detail: parsed.error.flatten() },
          { status: 400 }
        )
      )
    }
    body = parsed.data
  } catch {
    return respond(
      NextResponse.json({ error: 'invalid_json' }, { status: 400 })
    )
  }

  // 4. Normalize provider payload into our internal shape +
  //    strip reply quotes.
  const normalized = normalizeInboundPayload({
    from: body.from,
    fromName: body.from_name ?? null,
    to: body.to,
    cc: body.cc ?? null,
    text: body.text ?? null,
    html: body.html ?? null,
    headers: {
      messageId: body.headers?.message_id ?? null,
      inReplyTo: body.headers?.in_reply_to ?? null,
      references: body.headers?.references ?? null,
      subject: body.subject ?? null,
    },
    receivedAt: body.received_at ?? null,
  })
  if ('error' in normalized) {
    reqLog.warn({ error: normalized.error }, 'inbound.email.normalize_failed')
    // 200 — provider should not retry an unparseable email.
    return respond(
      NextResponse.json({ ok: true, ignored: normalized.error })
    )
  }

  // 5. Dedupe by provider_inbound_id if present. Cheap guard
  //    against retry storms.
  if (body.provider_inbound_id) {
    const svc = createServiceClient()
    const { data: existing } = await svc
      .from('messages')
      .select('id')
      .contains('metadata', { inbound_provider_message_id: body.provider_inbound_id })
      .limit(1)
      .maybeSingle()
    if (existing && (existing as { id?: string }).id) {
      reqLog.info(
        { providerInboundId: body.provider_inbound_id },
        'inbound.email.duplicate_ignored'
      )
      return respond(
        NextResponse.json({
          ok: true,
          deduplicated: true,
          message_id: (existing as { id: string }).id,
        })
      )
    }
  }

  // 6. Match to source conversation.
  const refIds = extractReferencedMessageIds({
    inReplyTo: body.headers?.in_reply_to ?? null,
    references: body.headers?.references ?? null,
  })
  const match = await matchInboundToConversation({
    fromEmail: normalized.fromEmail,
    referencedMessageIds: refIds,
  })

  // 7. Check suppression — informs confidence + tells the
  //    operator if they're hearing back from someone who
  //    previously unsubscribed/bounced (rare but real).
  try {
    const supp = await isSuppressed(normalized.fromEmail)
    if (supp.suppressed) match.signals.recipientWasSuppressed = true
  } catch (err) {
    reqLog.warn({ err }, 'inbound.email.suppression_check_failed')
  }

  const confidence = scoreMatchConfidence(match.signals)
  const needsReview = confidence.score < INBOUND_REVIEW_THRESHOLD

  // 8. If we never resolved a venue OR the match confidence is
  //    below the review threshold, persist this as an ORPHAN
  //    (Phase 8BQ) instead of silently dropping it. The orphan
  //    helper expands the venue-detection net (recent outbound
  //    history + lead-email lookup) and surfaces suggestions so
  //    an operator can one-click link in the queue UI.
  //
  //    Critical: an orphan is NEVER inserted as a `messages` row.
  //    Linking is a deliberate operator action. AI never fires.
  if (!match.venueId || needsReview) {
    const orphanOutcome = await createInboundEmailOrphan({
      normalized,
      provider: body.provider,
      providerInboundId: body.provider_inbound_id ?? null,
      matchConfidence: confidence.score,
      matchReasons: confidence.reasons,
      receivedAtIso: body.received_at ?? null,
    })
    reqLog.info(
      {
        fromEmail: normalized.fromEmail,
        referencedCount: refIds.length,
        confidence: confidence.score,
        orphanCreated: orphanOutcome.ok ? orphanOutcome.created : false,
        orphanVenueId: orphanOutcome.ok ? orphanOutcome.venueId : null,
      },
      'inbound.email.orphaned'
    )
    return respond(
      NextResponse.json({
        ok: true,
        captured: false,
        orphaned: orphanOutcome.ok,
        orphan_id: orphanOutcome.ok ? orphanOutcome.orphanId : null,
        orphan_created: orphanOutcome.ok ? orphanOutcome.created : false,
        confidence: confidence.score,
        reason: !match.venueId ? 'no_venue_match' : 'low_confidence',
      })
    )
  }

  // 9. Ingest via the existing channel normalization helper.
  //    This handles lead lookup/creation, conversation
  //    creation/reuse, message insert, and the external_messages
  //    trail. We pass channelType='email' which Phase 8BE
  //    already declared in CHANNEL_TYPES.
  const messageMetadata = buildInboundMessageMetadata({
    normalized,
    confidence: confidence.score,
    needsReview,
    confidenceReasons: confidence.reasons,
    matchedOutboundMessageId: match.outboundMessageId,
    matchedProviderMessageId: match.providerMessageId,
    matchedConversationId: match.conversationId,
    providerName: body.provider,
    providerInboundId: body.provider_inbound_id ?? null,
  })

  try {
    const result = await normalizeInboundChannelMessage({
      venueId: match.venueId,
      channelType: 'email',
      // Use the matched provider_message_id as the thread anchor
      // so future replies in the same chain land on the same
      // external_conversation row.
      externalThreadId: match.providerMessageId ?? null,
      externalMessageId: body.provider_inbound_id ?? null,
      contactName: normalized.fromName,
      contactEmail: normalized.fromEmail,
      contactPhone: null,
      messageBody: normalized.cleanBody,
      sourceLabel: 'email',
      receivedAt: body.received_at ?? null,
      // Connector-level metadata lands on external_conversations
      // + external_messages.
      metadata: {
        inbound_provider: body.provider,
        inbound_subject: normalized.subject,
        inbound_matched_conversation_id: match.conversationId,
        inbound_matched_outbound_message_id: match.outboundMessageId,
      },
      // Message-level metadata stamps the parse-review badge so
      // the inbox UI's existing 8BG ParseReviewBadge lights up.
      messageMetadataExtra: messageMetadata,
    })

    if (!result.ok) {
      reqLog.error(
        { code: result.code, venueId: match.venueId },
        'inbound.email.normalize_returned_failure'
      )
      return respond(
        NextResponse.json(
          { error: result.code },
          {
            status:
              result.code === 'venue_not_found'
                ? 404
                : result.code === 'invalid_input'
                  ? 400
                  : 500,
          }
        )
      )
    }

    reqLog.info(
      {
        venueId: match.venueId,
        leadId: result.lead.id,
        conversationId: result.conversation.id,
        matchedByHeader: match.signals.matchedByHeader,
        matchedByRecentRecipient: match.signals.matchedByRecentRecipient,
        confidence: confidence.score,
        needsReview,
        suppressed: match.signals.recipientWasSuppressed,
      },
      'inbound.email.captured'
    )

    return respond(
      NextResponse.json(
        {
          ok: true,
          captured: true,
          lead_id: result.lead.id,
          conversation_id: result.conversation.id,
          message_id: result.message?.id ?? null,
          confidence: confidence.score,
          needs_review: needsReview,
          matched_by: match.signals.matchedByHeader
            ? 'header'
            : match.signals.matchedByRecentRecipient
              ? 'recent_recipient'
              : 'none',
        },
        { status: result.created ? 201 : 200 }
      )
    )
  } catch (err) {
    reqLog.error({ err }, 'inbound.email.failed')
    captureWebhookError('inbound_email', err, {
      requestId,
      route: '/api/inbound/email',
    })
    // 200 so the provider doesn't retry indefinitely on a
    // platform-side bug. The pino + Sentry capture is the
    // forensic trail.
    return respond(
      NextResponse.json(
        { ok: true, captured: false, error: 'unexpected_error' },
        { status: 200 }
      )
    )
  }
}
