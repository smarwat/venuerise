// Phase 8BF — admin Meta webhook payload QA endpoint.
//
// Pure parser run — accepts a Meta webhook JSON body (or a
// hand-crafted minimal payload) and returns the parsed event
// list WITHOUT verifying the signature, WITHOUT writing leads
// or messages, and WITHOUT touching any external API. Used for
// QA + demos so an operator can validate parser coverage
// before pointing a real Meta subscription at the public
// webhook.
//
// Audit coverage: writes `meta_webhook_test_parse` on success
// with parser-output metadata only — raw payload is NEVER
// stamped into audit metadata.

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
import { parseMetaWebhookPayload } from '@/lib/integrations/channels/meta-parser'
import { recordAuditEvent } from '@/lib/enterprise/audit-events'
import { AUDIT_ACTIONS } from '@/lib/enterprise/audit-actions'

const BodySchema = z.object({
  payload: z.record(z.string(), z.unknown()),
})

export async function POST(request: NextRequest): Promise<Response> {
  const requestId = getOrCreateRequestId(request)
  const reqLog = log.child({
    requestId,
    route: '/api/admin/integrations/meta/test-parse',
    op: 'admin.integrations.meta.test-parse',
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
    `admin:integrations:meta:webhook-test:${user.id}`,
    {
      route: '/api/admin/integrations/meta/test-parse',
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

  let parsedInput: z.infer<typeof BodySchema>
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
    parsedInput = r.data
  } catch {
    return respond(
      NextResponse.json({ error: 'invalid_json' }, { status: 400 })
    )
  }

  try {
    const result = parseMetaWebhookPayload(parsedInput.payload)

    void recordAuditEvent({
      venueId: callerVenueId,
      actorUserId: user.id,
      actorKind: 'operator',
      route: '/api/admin/integrations/meta/test-parse',
      action: AUDIT_ACTIONS.META_WEBHOOK_TEST_PARSE,
      targetTable: null,
      targetId: null,
      requestId,
      ip:
        request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
      userAgent: request.headers.get('user-agent'),
      metadata: {
        object_type: result.objectType,
        events_parsed: result.events.length,
        events_ignored: result.ignored,
        channels: result.events.map((e) => e.channelType),
      },
    })

    return respond(
      NextResponse.json({
        ok: true,
        object_type: result.objectType,
        events_parsed: result.events.length,
        events_ignored: result.ignored,
        events: result.events.map((e) => ({
          channel_type: e.channelType,
          event_type: e.eventType,
          external_thread_id: e.externalThreadId,
          external_message_id: e.externalMessageId,
          external_sender_id: e.externalSenderId,
          external_recipient_page_id: e.externalRecipientPageId,
          name: e.name,
          message_preview:
            e.message.length > 500 ? `${e.message.slice(0, 500)}…` : e.message,
          received_at: e.receivedAt,
          metadata: e.metadata,
        })),
      })
    )
  } catch (err) {
    reqLog.error({ err }, 'admin.meta.test-parse.failed')
    captureApiError(err, {
      requestId,
      route: '/api/admin/integrations/meta/test-parse',
      userId: user.id,
      venueId: callerVenueId,
    })
    return respond(
      NextResponse.json({ error: 'unexpected_error' }, { status: 500 })
    )
  }
}
