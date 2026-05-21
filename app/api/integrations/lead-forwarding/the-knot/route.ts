// public route — Phase 8BE lead-forwarding inbound endpoint.
//
// Phase 8BG extended this route to accept BOTH:
//   1. A pre-cleaned structured payload (legacy 8BE shape:
//      flat name/email/phone/message at the top level), AND
//   2. A raw forwarded `body` + optional `subject` plus an
//      optional nested `payload` object — the parser below
//      extracts identity + event fields and stamps parse
//      confidence onto messages.metadata.
//
// VenueRise does NOT have an official two-way API with The
// Knot. This route is the structured / forwarded-email intake.
//
// AUDIT_EXEMPT: anonymous inbound forwarding mirror of the
// /api/widget posture. Every accepted payload writes a
// `messages` row + an `external_messages` row which together
// constitute the forensic trail. The widget exemption is
// documented in docs/AUDIT-COVERAGE.md; this row extends the
// same rationale to omnichannel forwarding.
//
// Rate-limited by IP+venue via inboundChannel.leadForwardTheKnot.

import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { rateLimitWidget, rateLimitedResponse } from '@/lib/rate-limit'
import { log } from '@/lib/log'
import {
  getOrCreateRequestId,
  withRequestIdHeader,
} from '@/lib/observability/request-id'
import { captureApiError } from '@/lib/observability/sentry'
import { normalizeInboundChannelMessage } from '@/lib/integrations/channels/normalization'
import {
  buildParseMetadata,
  parseForwardedLead,
} from '@/lib/integrations/channels/lead-forwarding-parser'

// Phase 8BG — flexible schema. Either the legacy structured
// fields (name/email/phone/message/event_date/guest_count/budget)
// OR a raw `body` + optional `subject` + optional `payload`.
// We accept ALL of them and let the parser merge.
const ForwardingBodySchema = z.object({
  venue_id: z.string().uuid(),
  external_lead_id: z.string().max(200).optional().nullable(),
  external_message_id: z.string().max(200).optional().nullable(),
  external_thread_id: z.string().max(200).optional().nullable(),
  subject: z.string().max(500).optional().nullable(),
  body: z.string().max(20000).optional().nullable(),
  payload: z.record(z.string(), z.unknown()).optional().nullable(),
  // Legacy 8BE structured fields — passed straight through if
  // present, otherwise filled by the parser.
  name: z.string().max(200).optional().nullable(),
  email: z.string().email().max(320).optional().nullable(),
  phone: z.string().max(60).optional().nullable(),
  message: z.string().max(20000).optional().nullable(),
  event_date: z.string().optional().nullable(),
  guest_count: z.number().int().min(1).max(10000).optional().nullable(),
  budget: z.number().min(0).optional().nullable(),
  received_at: z.string().datetime().optional().nullable(),
})

export async function POST(request: NextRequest): Promise<Response> {
  const requestId = getOrCreateRequestId(request)
  const reqLog = log.child({
    requestId,
    route: '/api/integrations/lead-forwarding/the-knot',
  })
  const respond = <T extends Response>(r: T) =>
    withRequestIdHeader(r, requestId)

  let body: z.infer<typeof ForwardingBodySchema>
  try {
    const raw = await request.json()
    const parsed = ForwardingBodySchema.safeParse(raw)
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

  const rl = await rateLimitWidget(request, body.venue_id)
  if (!rl.allowed) {
    reqLog.warn(
      { venueId: body.venue_id, retryMs: rl.retryAfterMs, mode: rl.mode },
      'rate_limit.blocked'
    )
    return respond(rateLimitedResponse(rl))
  }

  // ── Phase 8BG — run the parser. Prefer the nested `payload`
  //    object; fall back to the legacy top-level structured
  //    fields when provided. The body string contributes
  //    regex-based extraction when present.
  const parsedLead = parseForwardedLead({
    channelType: 'the_knot',
    subject: body.subject ?? null,
    body: body.body ?? body.message ?? null,
    payload:
      body.payload ??
      // Synthesize a payload from the legacy flat fields so the
      // parser still has a structured surface to read.
      ({
        name: body.name ?? undefined,
        email: body.email ?? undefined,
        phone: body.phone ?? undefined,
        event_date: body.event_date ?? undefined,
        guest_count: body.guest_count ?? undefined,
        budget: body.budget ?? undefined,
        message: body.message ?? undefined,
        external_lead_id: body.external_lead_id ?? undefined,
      } as Record<string, unknown>),
    externalLeadId: body.external_lead_id ?? null,
  })

  try {
    const result = await normalizeInboundChannelMessage({
      venueId: body.venue_id,
      channelType: 'the_knot',
      externalLeadId: parsedLead.externalLeadId,
      externalMessageId: body.external_message_id ?? null,
      externalThreadId: body.external_thread_id ?? null,
      contactName: parsedLead.name,
      contactEmail: parsedLead.email,
      contactPhone: parsedLead.phone,
      messageBody: parsedLead.message,
      eventDate: parsedLead.eventDate,
      guestCount: parsedLead.guestCount,
      budget: parsedLead.budget,
      sourceLabel: 'the_knot',
      receivedAt: body.received_at ?? null,
      // Phase 8BG — parse metadata lands on both surfaces so
      // the inbox UI can render the review badge without an
      // extra join, and the external_messages trail carries
      // the same confidence for auditability.
      metadata: buildParseMetadata(parsedLead),
      messageMetadataExtra: buildParseMetadata(parsedLead),
    })
    if (!result.ok) {
      const status = result.code === 'venue_not_found' ? 404 : result.code === 'invalid_input' ? 400 : 500
      return respond(
        NextResponse.json({ error: result.code }, { status })
      )
    }
    reqLog.info(
      {
        venueId: body.venue_id,
        leadId: result.lead.id,
        conversationId: result.conversation.id,
        created: result.created,
        parseConfidence: parsedLead.confidence,
        parseNeedsReview: parsedLead.needsReview,
      },
      'inbound.the_knot.accepted'
    )
    return respond(
      NextResponse.json(
        {
          success: true,
          lead_id: result.lead.id,
          conversation_id: result.conversation.id,
          created: result.created,
          parse_confidence: parsedLead.confidence,
          parse_needs_review: parsedLead.needsReview,
        },
        { status: result.created ? 201 : 200 }
      )
    )
  } catch (err) {
    reqLog.error({ err }, 'inbound.the_knot.failed')
    captureApiError(err, {
      requestId,
      route: '/api/integrations/lead-forwarding/the-knot',
      venueId: body.venue_id,
    })
    return respond(
      NextResponse.json({ error: 'unexpected_error' }, { status: 500 })
    )
  }
}
