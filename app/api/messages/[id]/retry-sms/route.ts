// Phase 8BU — Retry a previously failed / undelivered / skipped
// outbound SMS.
//
// Operates on an EXISTING messages row (role: 'human'). Mirror
// of /api/messages/[id]/retry-email (Phase 8BP). The retry
// re-attempts delivery against the same recipient using the
// same body and patches the existing row's metadata with the
// new outcome — no duplicate bubble.
//
// Audit coverage: writes recordAuditEvent in attempted +
// succeeded/failed paths.
// Rate-limit: per-user-per-message via
// messageDelivery.retrySms.

import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { assertOwnsConversation, OwnershipError } from '@/lib/auth/assert-ownership'
import { SALES_ROLES } from '@/lib/auth/roles'
import {
  requireActiveSubscription,
  SubscriptionRequiredError,
} from '@/lib/billing/subscription-status'
import { rateLimitUserAction, rateLimitedResponse } from '@/lib/rate-limit'
import { recordAuditEvent } from '@/lib/enterprise/audit-events'
import { AUDIT_ACTIONS } from '@/lib/enterprise/audit-actions'
import {
  isOutboundSmsConfigured,
  sendOutboundSms,
} from '@/lib/integrations/delivery/sms'
import {
  getSmsDeliveryDisplay,
  isSmsStatusRetryable,
  normalizeSmsDeliveryStatus,
} from '@/lib/integrations/delivery/sms-status'
import { log } from '@/lib/log'
import {
  getOrCreateRequestId,
  withRequestIdHeader,
} from '@/lib/observability/request-id'
import { captureApiError } from '@/lib/observability/sentry'

interface RouteContext {
  params: Promise<{ id: string }>
}

const MAX_RETRIES = 5

export async function POST(
  request: NextRequest,
  { params }: RouteContext
): Promise<Response> {
  const requestId = getOrCreateRequestId(request)
  const reqLog = log.child({
    requestId,
    route: '/api/messages/[id]/retry-sms',
    op: 'messages.retry_sms',
  })
  const respond = <T extends Response>(r: T) => withRequestIdHeader(r, requestId)

  const { id: messageId } = await params
  if (!z.string().uuid().safeParse(messageId).success) {
    return respond(
      NextResponse.json({ error: 'message_id must be a UUID' }, { status: 400 })
    )
  }

  // 1. Auth.
  const supabase = await createClient()
  const {
    data: { user },
    error: userErr,
  } = await supabase.auth.getUser()
  if (userErr || !user) {
    return respond(NextResponse.json({ error: 'unauthorized' }, { status: 401 }))
  }

  // 2. Load message (service-role so we can read metadata
  //    regardless of RLS posture; tenant check happens via
  //    assertOwnsConversation).
  const svc = createServiceClient()
  const { data: msgRow, error: msgErr } = await svc
    .from('messages')
    .select(
      'id, conversation_id, lead_id, venue_id, role, content, metadata, created_at'
    )
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
    content: string
    metadata: Record<string, unknown> | null
    created_at: string
  }

  // 3. Ownership.
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

  // 4. Billing gate.
  try {
    await requireActiveSubscription(venueId, {
      requestId,
      route: '/api/messages/[id]/retry-sms',
    })
  } catch (err) {
    if (err instanceof SubscriptionRequiredError) {
      return respond(
        NextResponse.json({ error: err.code }, { status: err.status })
      )
    }
    throw err
  }

  // 5. Rate limit.
  const rl = await rateLimitUserAction(
    request,
    `message:delivery:retry-sms:${user.id}:${messageId}`,
    {
      route: '/api/messages/[id]/retry-sms',
      method: 'POST',
      userId: user.id,
      requestId,
    }
  )
  if (!rl.allowed) {
    return respond(rateLimitedResponse(rl))
  }

  const md = message.metadata ?? {}
  const currentStatus = normalizeSmsDeliveryStatus(md.delivery_status)
  const display = getSmsDeliveryDisplay(currentStatus)

  // 6. Preconditions.
  if (message.role !== 'human') {
    return respond(
      NextResponse.json({ ok: false, error: 'not_human_message' }, { status: 400 })
    )
  }
  if (md.reply_method !== 'sms') {
    return respond(
      NextResponse.json({ ok: false, error: 'not_sms_method' }, { status: 400 })
    )
  }
  const recipient =
    typeof md.reply_destination === 'string' ? md.reply_destination.trim() : ''
  if (!recipient) {
    return respond(
      NextResponse.json({ ok: false, error: 'missing_destination' }, { status: 400 })
    )
  }
  if (!isSmsStatusRetryable(currentStatus)) {
    return respond(
      NextResponse.json(
        {
          ok: false,
          error: 'not_retryable',
          status: currentStatus,
          can_retry: display.canRetry,
        },
        { status: 409 }
      )
    )
  }
  if (!isOutboundSmsConfigured()) {
    return respond(
      NextResponse.json(
        { ok: false, error: 'sms_not_configured' },
        { status: 409 }
      )
    )
  }
  const retryCount =
    typeof md.delivery_retry_count === 'number' ? md.delivery_retry_count : 0
  if (retryCount >= MAX_RETRIES) {
    return respond(
      NextResponse.json(
        { ok: false, error: 'retry_limit_exceeded', retry_count: retryCount },
        { status: 429 }
      )
    )
  }

  // 7. Optimistic pending stamp + bump retry count. Also
  //    archive the previous provider_message_id so an audit
  //    drawer can show "this attempt SM..., previous SM...".
  //    Capped at 5 entries to keep metadata bounded.
  const previousIds = Array.isArray(md.previous_provider_message_ids)
    ? (md.previous_provider_message_ids as unknown[]).filter(
        (v) => typeof v === 'string'
      ) as string[]
    : []
  if (typeof md.provider_message_id === 'string') {
    previousIds.push(md.provider_message_id)
  }
  const cappedPreviousIds = previousIds.slice(-5)

  const attemptStartedAt = new Date().toISOString()
  const pendingPatch: Record<string, unknown> = {
    ...md,
    delivery_status: 'pending',
    delivery_provider: 'twilio',
    delivery_channel: 'sms',
    delivery_retry_count: retryCount + 1,
    last_retry_at: attemptStartedAt,
    last_retry_by: user.id,
    previous_provider_message_ids: cappedPreviousIds,
  }
  delete pendingPatch.delivery_error_code
  delete pendingPatch.delivery_safe_error
  await svc.from('messages').update({ metadata: pendingPatch }).eq('id', messageId)

  // 8. Audit attempt (best-effort).
  void recordAuditEvent({
    venueId,
    actorUserId: user.id,
    actorKind: 'operator',
    route: '/api/messages/[id]/retry-sms',
    action: AUDIT_ACTIONS.SMS_DELIVERY_RETRY_ATTEMPTED,
    targetTable: 'messages',
    targetId: messageId,
    requestId,
    ip: request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
    userAgent: request.headers.get('user-agent'),
    metadata: {
      conversation_id: message.conversation_id,
      lead_id: message.lead_id,
      status_before: currentStatus,
      retry_count: retryCount + 1,
    },
  })

  // 9. Attempt send.
  let result
  try {
    result = await sendOutboundSms({
      to: recipient,
      body: message.content,
      venueId,
      conversationId: message.conversation_id,
      leadId: message.lead_id,
      messageId: message.id,
    })
  } catch (err) {
    captureApiError(err, {
      requestId,
      route: '/api/messages/[id]/retry-sms',
      userId: user.id,
      venueId,
    })
    const failPatch: Record<string, unknown> = {
      ...pendingPatch,
      delivery_status: 'failed',
      delivery_error_code: 'route_threw',
      delivery_safe_error: 'Unexpected error during retry.',
      failed_at: new Date().toISOString(),
    }
    await svc.from('messages').update({ metadata: failPatch }).eq('id', messageId)
    void recordAuditEvent({
      venueId,
      actorUserId: user.id,
      actorKind: 'operator',
      route: '/api/messages/[id]/retry-sms',
      action: AUDIT_ACTIONS.SMS_DELIVERY_RETRY_FAILED,
      targetTable: 'messages',
      targetId: messageId,
      requestId,
      metadata: {
        conversation_id: message.conversation_id,
        status_before: currentStatus,
        status_after: 'failed',
        retry_count: retryCount + 1,
        error_code: 'route_threw',
      },
    })
    return respond(
      NextResponse.json(
        { ok: false, error: 'unexpected_error' },
        { status: 500 }
      )
    )
  }

  // 10. Patch with real result.
  const finalPatch: Record<string, unknown> = { ...pendingPatch }
  if (result.ok) {
    finalPatch.delivery_status = result.deliveryStatus
    finalPatch.delivery_provider = result.provider
    finalPatch.provider_message_id = result.providerMessageId
    finalPatch.accepted_at = new Date().toISOString()
    if (result.deliveryStatus === 'sent') {
      finalPatch.sent_at = new Date().toISOString()
    }
    delete finalPatch.delivery_error_code
    delete finalPatch.delivery_safe_error
  } else {
    finalPatch.delivery_status = result.deliveryStatus
    finalPatch.delivery_provider = result.provider
    finalPatch.delivery_error_code = result.errorCode
    finalPatch.delivery_safe_error = result.safeError
    if (result.deliveryStatus === 'failed') {
      finalPatch.failed_at = new Date().toISOString()
    }
  }
  await svc.from('messages').update({ metadata: finalPatch }).eq('id', messageId)

  // 11. Audit succeeded / failed.
  void recordAuditEvent({
    venueId,
    actorUserId: user.id,
    actorKind: 'operator',
    route: '/api/messages/[id]/retry-sms',
    action: result.ok
      ? AUDIT_ACTIONS.SMS_DELIVERY_RETRY_SUCCEEDED
      : AUDIT_ACTIONS.SMS_DELIVERY_RETRY_FAILED,
    targetTable: 'messages',
    targetId: messageId,
    requestId,
    metadata: {
      conversation_id: message.conversation_id,
      lead_id: message.lead_id,
      status_before: currentStatus,
      status_after: finalPatch.delivery_status,
      retry_count: retryCount + 1,
      provider: result.provider,
      provider_message_id_present: result.ok
        ? !!result.providerMessageId
        : false,
      error_code: result.ok ? null : result.errorCode,
    },
  })

  reqLog.info(
    {
      messageId,
      status: finalPatch.delivery_status,
      retryCount: retryCount + 1,
    },
    'messages.retry_sms.completed'
  )

  if (result.ok) {
    return respond(
      NextResponse.json({
        ok: true,
        status: result.deliveryStatus,
        message_id: messageId,
        retry_count: retryCount + 1,
      })
    )
  }
  return respond(
    NextResponse.json(
      {
        ok: false,
        status: result.deliveryStatus,
        error_code: result.errorCode,
        safe_error: result.safeError,
        retry_count: retryCount + 1,
      },
      { status: 200 }
    )
  )
}
