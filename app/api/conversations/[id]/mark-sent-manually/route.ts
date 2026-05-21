// Phase 8BE — Operator confirms a manual reply was sent on a
// channel that VenueRise cannot deliver into directly (Instagram,
// Facebook, Meta lead ad, email, The Knot, WeddingWire).
//
// Records a `human` message in the conversation so the inbox
// shows the operator's reply, writes an `external_messages` row
// with `delivery_status='marked_sent_manually'` for the trail,
// and emits a `channel_reply_marked_sent_manually` audit row.
//
// Audit coverage: writes recordAuditEvent in the success path.

import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireUser } from '@/lib/auth/tenant-access'
import { createServiceClient } from '@/lib/supabase/service'
import { rateLimitUserAction, rateLimitedResponse } from '@/lib/rate-limit'
import { log } from '@/lib/log'
import {
  getOrCreateRequestId,
  withRequestIdHeader,
} from '@/lib/observability/request-id'
import { captureApiError } from '@/lib/observability/sentry'
import { recordManualSendOutcome } from '@/lib/integrations/channels/delivery'
import { recordAuditEvent } from '@/lib/enterprise/audit-events'
import { AUDIT_ACTIONS } from '@/lib/enterprise/audit-actions'

const BodySchema = z.object({
  body: z.string().min(1).max(8000),
  channel_type: z.string().max(40).optional().nullable(),
})

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
): Promise<Response> {
  const requestId = getOrCreateRequestId(request)
  const reqLog = log.child({
    requestId,
    route: '/api/conversations/[id]/mark-sent-manually',
  })
  const respond = <T extends Response>(r: T) =>
    withRequestIdHeader(r, requestId)

  let user
  try {
    user = await requireUser()
  } catch {
    return respond(
      NextResponse.json({ error: 'unauthorized' }, { status: 401 })
    )
  }

  const rl = await rateLimitUserAction(
    request,
    `channel:manual-sent:${user.userId}`,
    {
      route: '/api/conversations/[id]/mark-sent-manually',
      method: 'POST',
      userId: user.userId,
      requestId,
    }
  )
  if (!rl.allowed) {
    return respond(rateLimitedResponse(rl))
  }

  const { id: conversationId } = await context.params

  let parsed: z.infer<typeof BodySchema>
  try {
    const raw = await request.json()
    const result = BodySchema.safeParse(raw)
    if (!result.success) {
      return respond(
        NextResponse.json(
          { error: 'validation_failed', detail: result.error.flatten() },
          { status: 400 }
        )
      )
    }
    parsed = result.data
  } catch {
    return respond(
      NextResponse.json({ error: 'invalid_json' }, { status: 400 })
    )
  }

  const supabase = createServiceClient()

  // Confirm caller has access to this conversation. Use the
  // user-scoped client through RLS by querying conversations
  // via service-role + a venue-membership check.
  const { data: convo, error: convErr } = await supabase
    .from('conversations')
    .select('id, venue_id, lead_id')
    .eq('id', conversationId)
    .maybeSingle()
  if (convErr || !convo) {
    return respond(NextResponse.json({ error: 'not_found' }, { status: 404 }))
  }
  const conversation = convo as { id: string; venue_id: string; lead_id: string }

  // Cross-tenant collapse: membership check via venue_members.
  const { data: member } = await supabase
    .from('venue_members')
    .select('role')
    .eq('venue_id', conversation.venue_id)
    .eq('user_id', user.userId)
    .maybeSingle()
  if (
    !member ||
    !['owner', 'admin', 'sales_manager', 'coordinator'].includes(
      (member as { role: string }).role
    )
  ) {
    return respond(NextResponse.json({ error: 'not_found' }, { status: 404 }))
  }

  // Insert the human reply with channel metadata so the inbox UI
  // renders it with the correct source badge and the
  // sent-manually pill. Phase 8BE-2 added `manual_reply_marked_by`
  // for symmetry with the marked_at timestamp.
  const channelMetadata = {
    source: 'manual_channel_reply',
    channel_type: parsed.channel_type ?? null,
    manual_reply_marked_at: new Date().toISOString(),
    manual_reply_marked_by: user.userId,
  }
  const { data: messageRow, error: messageErr } = await supabase
    .from('messages')
    .insert({
      conversation_id: conversationId,
      lead_id: conversation.lead_id,
      venue_id: conversation.venue_id,
      role: 'human' as const,
      content: parsed.body,
      metadata: channelMetadata,
    })
    .select('id')
    .single()
  if (messageErr || !messageRow) {
    reqLog.error(
      { errorMessage: messageErr?.message, conversationId },
      'manual_send.message_insert_failed'
    )
    captureApiError(
      messageErr ?? new Error('messages insert returned no row'),
      {
        requestId,
        route: '/api/conversations/[id]/mark-sent-manually',
        userId: user.userId,
      }
    )
    return respond(
      NextResponse.json({ error: 'unexpected_error' }, { status: 500 })
    )
  }
  const messageId = (messageRow as { id: string }).id

  // Record the outbound external_messages row + bump
  // last_outbound_at. Non-fatal if no external mapping exists —
  // the operator can still record the reply even on a
  // legacy in-product conversation.
  const outcome = await recordManualSendOutcome({
    venueId: conversation.venue_id,
    conversationId,
    messageId,
  })

  void recordAuditEvent({
    venueId: conversation.venue_id,
    actorUserId: user.userId,
    actorKind: 'operator',
    route: '/api/conversations/[id]/mark-sent-manually',
    action: AUDIT_ACTIONS.CHANNEL_REPLY_MARKED_SENT_MANUALLY,
    targetTable: 'messages',
    targetId: messageId,
    requestId,
    ip: request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
    userAgent: request.headers.get('user-agent'),
    metadata: {
      conversation_id: conversationId,
      lead_id: conversation.lead_id,
      channel_type:
        outcome.ok && outcome.channelType
          ? outcome.channelType
          : parsed.channel_type ?? null,
      external_mapping_recorded: outcome.ok,
    },
  })

  return respond(
    NextResponse.json({
      ok: true,
      message_id: messageId,
      external_mapping_recorded: outcome.ok,
      channel_type:
        outcome.ok && outcome.channelType
          ? outcome.channelType
          : parsed.channel_type ?? null,
    })
  )
}
