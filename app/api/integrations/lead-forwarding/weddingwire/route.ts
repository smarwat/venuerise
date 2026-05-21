// public route — Phase 8BE lead-forwarding inbound endpoint.
//
// Phase 8BG extended this route the same way as the-knot:
// accepts both structured payloads + raw forwarded body/subject
// strings and runs them through the deterministic parser
// before normalization. See the-knot/route.ts header for the
// rationale.
//
// AUDIT_EXEMPT: anonymous inbound forwarding — same posture as
// /api/widget (documented in docs/AUDIT-COVERAGE.md).
//
// Rate-limited by IP+venue.

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

const ForwardingBodySchema = z.object({
  venue_id: z.string().uuid(),
  external_lead_id: z.string().max(200).optional().nullable(),
  external_message_id: z.string().max(200).optional().nullable(),
  external_thread_id: z.string().max(200).optional().nullable(),
  subject: z.string().max(500).optional().nullable(),
  body: z.string().max(20000).optional().nullable(),
  payload: z.record(z.string(), z.unknown()).optional().nullable(),
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
    route: '/api/integrations/lead-forwarding/weddingwire',
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

  const parsedLead = parseForwardedLead({
    channelType: 'weddingwire',
    subject: body.subject ?? null,
    body: body.body ?? body.message ?? null,
    payload:
      body.payload ??
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
      channelType: 'weddingwire',
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
      sourceLabel: 'weddingwire',
      receivedAt: body.received_at ?? null,
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
      'inbound.weddingwire.accepted'
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
    reqLog.error({ err }, 'inbound.weddingwire.failed')
    captureApiError(err, {
      requestId,
      route: '/api/integrations/lead-forwarding/weddingwire',
      venueId: body.venue_id,
    })
    return respond(
      NextResponse.json({ error: 'unexpected_error' }, { status: 500 })
    )
  }
}
