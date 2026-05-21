// Phase 8BG — admin lead-forwarding parser QA endpoint.
//
// Returns the parsed output for a structured payload or raw
// body WITHOUT creating a lead, conversation, or message. Used
// by operators to verify a forwarder's payload shape before
// pointing the real inbound URL at it, and by sales demos to
// show parse confidence + needs-review flagging.
//
// Audit coverage: writes `lead_forwarding_test_parse` on
// every accepted call. Raw body is NOT logged in audit metadata
// — only the parser-derived confidence + needs-review flag.

import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireAdmin } from '@/lib/auth/require-admin'
import { rateLimitUserAction, rateLimitedResponse } from '@/lib/rate-limit'
import { log } from '@/lib/log'
import {
  getOrCreateRequestId,
  withRequestIdHeader,
} from '@/lib/observability/request-id'
import { captureApiError } from '@/lib/observability/sentry'
import {
  parseForwardedLead,
  type ForwardingChannel,
} from '@/lib/integrations/channels/lead-forwarding-parser'
import { recordAuditEvent } from '@/lib/enterprise/audit-events'
import { AUDIT_ACTIONS } from '@/lib/enterprise/audit-actions'

const ChannelEnum = z.enum(['the_knot', 'weddingwire'])

const BodySchema = z
  .object({
    channel_type: ChannelEnum,
    subject: z.string().max(500).optional().nullable(),
    body: z.string().max(20000).optional().nullable(),
    payload: z.record(z.string(), z.unknown()).optional().nullable(),
  })
  .refine(
    (v) => Boolean(v.body) || Boolean(v.payload),
    {
      message: 'Either `body` or `payload` is required.',
      path: ['body'],
    }
  )

export async function POST(request: NextRequest): Promise<Response> {
  const requestId = getOrCreateRequestId(request)
  const reqLog = log.child({
    requestId,
    route: '/api/admin/integrations/lead-forwarding/test-parse',
    op: 'admin.integrations.lead-forwarding.test-parse',
  })
  const respond = <T extends Response>(r: T) =>
    withRequestIdHeader(r, requestId)

  const admin = await requireAdmin()
  if (!admin.ok) {
    return respond(
      NextResponse.json({ error: admin.code }, { status: admin.status })
    )
  }
  const { user, venueId: callerVenueId } = admin

  const rl = await rateLimitUserAction(
    request,
    `admin:integrations:lead-forwarding:test:${user.id}`,
    {
      route: '/api/admin/integrations/lead-forwarding/test-parse',
      method: 'POST',
      userId: user.id,
      venueId: callerVenueId,
      requestId,
    }
  )
  if (!rl.allowed) {
    reqLog.warn({ userId: user.id }, 'rate_limit.blocked')
    return respond(rateLimitedResponse(rl))
  }

  let parsed: z.infer<typeof BodySchema>
  try {
    const raw = await request.json()
    const r = BodySchema.safeParse(raw)
    if (!r.success) {
      return respond(
        NextResponse.json(
          { error: 'validation_failed', detail: r.error.flatten() },
          { status: 400 }
        )
      )
    }
    parsed = r.data
  } catch {
    return respond(
      NextResponse.json({ error: 'invalid_json' }, { status: 400 })
    )
  }

  try {
    const result = parseForwardedLead({
      channelType: parsed.channel_type as ForwardingChannel,
      subject: parsed.subject ?? null,
      body: parsed.body ?? null,
      payload: parsed.payload ?? null,
    })

    void recordAuditEvent({
      venueId: callerVenueId,
      actorUserId: user.id,
      actorKind: 'operator',
      route: '/api/admin/integrations/lead-forwarding/test-parse',
      action: AUDIT_ACTIONS.LEAD_FORWARDING_TEST_PARSE,
      targetTable: null,
      targetId: null,
      requestId,
      ip:
        request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
      userAgent: request.headers.get('user-agent'),
      // PII-light: only parser-derived signals + the input source
      // shape. Raw body / subject NEVER lands in audit metadata.
      metadata: {
        channel_type: parsed.channel_type,
        input_shape: parsed.payload ? 'payload' : 'body',
        parse_confidence: result.confidence,
        parse_needs_review: result.needsReview,
        parse_confidence_reasons: result.confidenceReasons,
      },
    })

    return respond(
      NextResponse.json({
        ok: true,
        parsed: {
          channel_type: result.channelType,
          external_lead_id: result.externalLeadId,
          name: result.name,
          email: result.email,
          phone: result.phone,
          event_date: result.eventDate,
          guest_count: result.guestCount,
          budget: result.budget,
          message_preview:
            result.message.length > 500
              ? `${result.message.slice(0, 500)}…`
              : result.message,
          confidence: result.confidence,
          confidence_reasons: result.confidenceReasons,
          needs_review: result.needsReview,
          raw_subject: result.rawSubject,
        },
      })
    )
  } catch (err) {
    reqLog.error({ err }, 'admin.lead-forwarding.test-parse.failed')
    captureApiError(err, {
      requestId,
      route: '/api/admin/integrations/lead-forwarding/test-parse',
      userId: user.id,
      venueId: callerVenueId,
    })
    return respond(
      NextResponse.json({ error: 'unexpected_error' }, { status: 500 })
    )
  }
}
