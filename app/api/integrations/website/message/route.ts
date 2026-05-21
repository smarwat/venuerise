// public route — Phase 8BE structured website-channel inbound.
//
// The legacy /api/widget endpoint is the primary website intake
// path (multi-step form). This new route is the explicit
// omnichannel equivalent: any other website surface (chat
// widget, popup, retargeted form) can POST a STRUCTURED JSON
// payload here and have it normalized into the same internal
// lead / conversation / message graph.
//
// AUDIT_EXEMPT: anonymous inbound — same posture as /api/widget
// (documented in docs/AUDIT-COVERAGE.md). External_messages row
// is the forensic trail.
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

const WebsiteBodySchema = z.object({
  venue_id: z.string().uuid(),
  external_message_id: z.string().max(200).optional().nullable(),
  external_thread_id: z.string().max(200).optional().nullable(),
  external_contact_id: z.string().max(200).optional().nullable(),
  name: z.string().max(200).optional().nullable(),
  email: z.string().email().max(320).optional().nullable(),
  phone: z.string().max(60).optional().nullable(),
  message: z.string().min(1).max(8000),
  event_date: z.string().optional().nullable(),
  guest_count: z.number().int().min(1).max(10000).optional().nullable(),
  budget: z.number().min(0).optional().nullable(),
  received_at: z.string().datetime().optional().nullable(),
})

export async function POST(request: NextRequest): Promise<Response> {
  const requestId = getOrCreateRequestId(request)
  const reqLog = log.child({
    requestId,
    route: '/api/integrations/website/message',
  })
  const respond = <T extends Response>(r: T) =>
    withRequestIdHeader(r, requestId)

  let body: z.infer<typeof WebsiteBodySchema>
  try {
    const raw = await request.json()
    const parsed = WebsiteBodySchema.safeParse(raw)
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

  try {
    const result = await normalizeInboundChannelMessage({
      venueId: body.venue_id,
      channelType: 'website',
      externalMessageId: body.external_message_id ?? null,
      externalThreadId: body.external_thread_id ?? null,
      externalContactId: body.external_contact_id ?? null,
      contactName: body.name ?? null,
      contactEmail: body.email ?? null,
      contactPhone: body.phone ?? null,
      messageBody: body.message,
      eventDate: body.event_date ?? null,
      guestCount: body.guest_count ?? null,
      budget: body.budget ?? null,
      sourceLabel: 'website',
      receivedAt: body.received_at ?? null,
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
      },
      'inbound.website.accepted'
    )
    return respond(
      NextResponse.json(
        {
          success: true,
          lead_id: result.lead.id,
          conversation_id: result.conversation.id,
          created: result.created,
        },
        { status: result.created ? 201 : 200 }
      )
    )
  } catch (err) {
    reqLog.error({ err }, 'inbound.website.failed')
    captureApiError(err, {
      requestId,
      route: '/api/integrations/website/message',
      venueId: body.venue_id,
    })
    return respond(
      NextResponse.json({ error: 'unexpected_error' }, { status: 500 })
    )
  }
}
