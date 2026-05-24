// Phase 8BP — Flip an existing operator message to
// `delivery_status: 'manual_fallback'`.
//
// This is the message-level cousin of /api/conversations/[id]/
// mark-sent-manually. The conversation route INSERTS a new
// `role:'human'` row for manual-only channels (Instagram, The
// Knot). This route UPDATES an existing failed/bounced/skipped
// composer-direct send so the operator can declare "I handled
// this outside VenueRise (forwarded from the Reply-To, called
// the lead, etc.)" without claiming external delivery.
//
// Audit coverage: writes recordAuditEvent in the success path.
// Rate-limit: per-user-per-message bucket.

import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { assertOwnsConversation, OwnershipError } from '@/lib/auth/assert-ownership'
import { SALES_ROLES } from '@/lib/auth/roles'
import { rateLimitUserAction, rateLimitedResponse } from '@/lib/rate-limit'
import { recordAuditEvent } from '@/lib/enterprise/audit-events'
import { AUDIT_ACTIONS } from '@/lib/enterprise/audit-actions'
import {
  getEmailDeliveryDisplay,
  normalizeEmailDeliveryStatus,
} from '@/lib/integrations/delivery/email-status'
import { log } from '@/lib/log'
import {
  getOrCreateRequestId,
  withRequestIdHeader,
} from '@/lib/observability/request-id'

interface RouteContext {
  params: Promise<{ id: string }>
}

export async function POST(
  request: NextRequest,
  { params }: RouteContext
): Promise<Response> {
  const requestId = getOrCreateRequestId(request)
  const reqLog = log.child({
    requestId,
    route: '/api/messages/[id]/mark-fallback',
    op: 'messages.mark_fallback',
  })
  const respond = <T extends Response>(r: T) => withRequestIdHeader(r, requestId)

  const { id: messageId } = await params
  if (!z.string().uuid().safeParse(messageId).success) {
    return respond(
      NextResponse.json({ error: 'message_id must be a UUID' }, { status: 400 })
    )
  }

  const supabase = await createClient()
  const {
    data: { user },
    error: userErr,
  } = await supabase.auth.getUser()
  if (userErr || !user) {
    return respond(NextResponse.json({ error: 'unauthorized' }, { status: 401 }))
  }

  const svc = createServiceClient()
  const { data: msgRow, error: msgErr } = await svc
    .from('messages')
    .select('id, conversation_id, lead_id, venue_id, role, metadata')
    .eq('id', messageId)
    .maybeSingle()
  if (msgErr || !msgRow) {
    return respond(NextResponse.json({ error: 'not_found' }, { status: 404 }))
  }
  const message = msgRow as {
    id: string
    conversation_id: string
    lead_id: string
    venue_id: string
    role: 'lead' | 'ai' | 'human' | 'system'
    metadata: Record<string, unknown> | null
  }

  let venueId: string
  try {
    const own = await assertOwnsConversation(
      supabase,
      user.id,
      message.conversation_id,
      SALES_ROLES
    )
    venueId = own.venue_id
    if (own.venue_id !== message.venue_id) {
      return respond(NextResponse.json({ error: 'not_found' }, { status: 404 }))
    }
  } catch (err) {
    if (err instanceof OwnershipError) {
      return respond(NextResponse.json({ error: 'not_found' }, { status: 404 }))
    }
    throw err
  }

  const rl = await rateLimitUserAction(
    request,
    `message:delivery:mark-fallback:${user.id}:${messageId}`,
    {
      route: '/api/messages/[id]/mark-fallback',
      method: 'POST',
      userId: user.id,
      requestId,
    }
  )
  if (!rl.allowed) {
    return respond(rateLimitedResponse(rl))
  }

  if (message.role !== 'human') {
    return respond(
      NextResponse.json({ ok: false, error: 'not_human_message' }, { status: 400 })
    )
  }

  const md = message.metadata ?? {}
  const currentStatus = normalizeEmailDeliveryStatus(md.delivery_status)
  const display = getEmailDeliveryDisplay(currentStatus)
  if (!display.canMarkManual) {
    return respond(
      NextResponse.json(
        {
          ok: false,
          error: 'not_markable',
          status: currentStatus,
        },
        { status: 409 }
      )
    )
  }

  const nowIso = new Date().toISOString()
  const patch: Record<string, unknown> = {
    ...md,
    delivery_status: 'manual_fallback',
    manual_reply_marked_at: nowIso,
    manual_reply_marked_by: user.id,
    manual_fallback_reason: 'email_delivery_issue',
    manual_fallback_from_status: currentStatus,
    // Clear the spinner / retry surfaces — operator has taken
    // over.
    delivery_error_code: undefined,
    delivery_safe_error: undefined,
  }
  await svc.from('messages').update({ metadata: patch }).eq('id', messageId)

  void recordAuditEvent({
    venueId,
    actorUserId: user.id,
    actorKind: 'operator',
    route: '/api/messages/[id]/mark-fallback',
    action: AUDIT_ACTIONS.EMAIL_DELIVERY_MANUAL_FALLBACK_MARKED,
    targetTable: 'messages',
    targetId: messageId,
    requestId,
    ip: request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
    userAgent: request.headers.get('user-agent'),
    metadata: {
      conversation_id: message.conversation_id,
      lead_id: message.lead_id,
      status_before: currentStatus,
      status_after: 'manual_fallback',
    },
  })

  reqLog.info(
    { messageId, statusBefore: currentStatus },
    'messages.mark_fallback.completed'
  )

  return respond(
    NextResponse.json({
      ok: true,
      status: 'manual_fallback',
      message_id: messageId,
    })
  )
}
