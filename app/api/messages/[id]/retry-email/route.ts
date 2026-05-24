// Phase 8BP — Retry a previously failed / bounced / skipped
// composer email send.
//
// Operates on an EXISTING messages row (role: 'human'). The
// retry route never creates a new bubble — it re-attempts
// delivery against the same recipient using the same body and
// patches the row's metadata with the new outcome. From the
// operator's perspective, the pill flips from "Email failed"
// back to "Sending…" → "Accepted by Email" → "Delivered"
// without a duplicate conversation entry.
//
// Audit coverage: writes recordAuditEvent in both success and
// failure paths (attempted + succeeded/failed).
// Rate-limit: per-user-per-message bucket so spam-clicking
// "Retry" on one bad message can't deny retries on others.

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
  isOutboundEmailConfigured,
  sendOutboundEmail,
} from '@/lib/integrations/delivery/email'
import {
  getEmailDeliveryDisplay,
  isStatusRetryable,
  normalizeEmailDeliveryStatus,
} from '@/lib/integrations/delivery/email-status'
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
    route: '/api/messages/[id]/retry-email',
    op: 'messages.retry_email',
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

  // 2. Load the message via service-role so we can read metadata
  //    regardless of RLS posture. Tenant check happens below via
  //    assertOwnsConversation.
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

  // 3. Ownership — caller must have a sales role on the
  //    message's venue. Use assertOwnsConversation so the
  //    posture matches the composer send route exactly.
  let venueId: string
  try {
    const own = await assertOwnsConversation(
      supabase,
      user.id,
      message.conversation_id,
      SALES_ROLES
    )
    venueId = own.venue_id
    // Cross-tenant sanity: the message must belong to the same
    // venue the ownership check resolved.
    if (own.venue_id !== message.venue_id) {
      return respond(NextResponse.json({ error: 'not_found' }, { status: 404 }))
    }
  } catch (err) {
    if (err instanceof OwnershipError) {
      return respond(NextResponse.json({ error: 'not_found' }, { status: 404 }))
    }
    throw err
  }

  // 4. Billing gate (parity with composer send).
  try {
    await requireActiveSubscription(venueId, {
      requestId,
      route: '/api/messages/[id]/retry-email',
    })
  } catch (err) {
    if (err instanceof SubscriptionRequiredError) {
      return respond(
        NextResponse.json({ error: err.code }, { status: err.status })
      )
    }
    throw err
  }

  // 5. Rate limit per user + message so one bad message can't
  //    burn the user's whole retry budget.
  const rl = await rateLimitUserAction(
    request,
    `message:delivery:retry-email:${user.id}:${messageId}`,
    {
      route: '/api/messages/[id]/retry-email',
      method: 'POST',
      userId: user.id,
      requestId,
    }
  )
  if (!rl.allowed) {
    return respond(rateLimitedResponse(rl))
  }

  const md = message.metadata ?? {}
  const currentStatus = normalizeEmailDeliveryStatus(md.delivery_status)
  const display = getEmailDeliveryDisplay(currentStatus)

  // 6. Preconditions. Order matters — return the most specific
  //    error so the UI can surface useful messaging.
  if (message.role !== 'human') {
    return respond(
      NextResponse.json({ ok: false, error: 'not_human_message' }, { status: 400 })
    )
  }
  if (md.reply_method !== 'email') {
    return respond(
      NextResponse.json({ ok: false, error: 'not_email_method' }, { status: 400 })
    )
  }
  const recipient =
    typeof md.reply_destination === 'string' ? md.reply_destination.trim() : ''
  if (!recipient) {
    return respond(
      NextResponse.json({ ok: false, error: 'missing_destination' }, { status: 400 })
    )
  }
  if (!isStatusRetryable(currentStatus)) {
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
  if (!isOutboundEmailConfigured()) {
    return respond(
      NextResponse.json(
        { ok: false, error: 'email_not_configured' },
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

  // 7. Mark the row as pending again so the UI shows "Sending…"
  //    while the provider call is in flight. Realtime
  //    subscribers see this immediately.
  const attemptStartedAt = new Date().toISOString()
  const pendingPatch: Record<string, unknown> = {
    ...md,
    delivery_status: 'pending',
    delivery_provider: 'resend',
    delivery_retry_count: retryCount + 1,
    last_retry_at: attemptStartedAt,
    last_retry_by: user.id,
  }
  // Clear stale terminal markers so the pill doesn't flicker
  // "Email failed → Sending…" with the failure code still
  // attached. The webhook will re-stamp on success/failure.
  delete pendingPatch.delivery_error_code
  delete pendingPatch.delivery_safe_error
  await svc.from('messages').update({ metadata: pendingPatch }).eq('id', messageId)

  // 8. Best-effort audit — attempted, regardless of outcome.
  void recordAuditEvent({
    venueId,
    actorUserId: user.id,
    actorKind: 'operator',
    route: '/api/messages/[id]/retry-email',
    action: AUDIT_ACTIONS.EMAIL_DELIVERY_RETRY_ATTEMPTED,
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

  // 9. Look up the venue name for the humanized subject (parity
  //    with the composer route).
  let venueName: string | null = null
  try {
    const { data: venueRow } = await svc
      .from('venues')
      .select('name')
      .eq('id', venueId)
      .maybeSingle()
    venueName = (venueRow as { name?: string | null } | null)?.name ?? null
  } catch {
    // Non-fatal.
  }

  // 10. Attempt the send.
  let deliveryResult
  try {
    deliveryResult = await sendOutboundEmail({
      to: recipient,
      text: message.content,
      subject: null,
      venueName,
      venueId,
      conversationId: message.conversation_id,
      leadId: message.lead_id,
      messageId: message.id,
    })
  } catch (err) {
    captureApiError(err, {
      requestId,
      route: '/api/messages/[id]/retry-email',
      userId: user.id,
      venueId,
    })
    // Roll the pending flag forward to failed so the pill doesn't
    // stay "Sending…" forever on a route-level throw.
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
      route: '/api/messages/[id]/retry-email',
      action: AUDIT_ACTIONS.EMAIL_DELIVERY_RETRY_FAILED,
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

  // 11. Patch the row with the real result.
  const finalPatch: Record<string, unknown> = { ...pendingPatch }
  if (deliveryResult.ok) {
    finalPatch.delivery_status = 'accepted'
    finalPatch.delivery_provider = deliveryResult.provider
    finalPatch.provider_message_id = deliveryResult.providerMessageId
    finalPatch.accepted_at = new Date().toISOString()
    // Webhook will flip to 'delivered' later.
    delete finalPatch.delivery_error_code
    delete finalPatch.delivery_safe_error
  } else {
    finalPatch.delivery_status = deliveryResult.deliveryStatus
    finalPatch.delivery_provider = deliveryResult.provider
    finalPatch.delivery_error_code = deliveryResult.errorCode
    finalPatch.delivery_safe_error = deliveryResult.safeError
    if (deliveryResult.deliveryStatus === 'failed') {
      finalPatch.failed_at = new Date().toISOString()
    }
  }
  await svc.from('messages').update({ metadata: finalPatch }).eq('id', messageId)

  // 12. Audit — succeeded or failed.
  void recordAuditEvent({
    venueId,
    actorUserId: user.id,
    actorKind: 'operator',
    route: '/api/messages/[id]/retry-email',
    action: deliveryResult.ok
      ? AUDIT_ACTIONS.EMAIL_DELIVERY_RETRY_SUCCEEDED
      : AUDIT_ACTIONS.EMAIL_DELIVERY_RETRY_FAILED,
    targetTable: 'messages',
    targetId: messageId,
    requestId,
    metadata: {
      conversation_id: message.conversation_id,
      lead_id: message.lead_id,
      status_before: currentStatus,
      status_after: finalPatch.delivery_status,
      retry_count: retryCount + 1,
      provider: deliveryResult.provider,
      provider_message_id_present: deliveryResult.ok
        ? !!deliveryResult.providerMessageId
        : false,
      error_code: deliveryResult.ok ? null : deliveryResult.errorCode,
    },
  })

  reqLog.info(
    {
      messageId,
      status: finalPatch.delivery_status,
      retryCount: retryCount + 1,
    },
    'messages.retry_email.completed'
  )

  if (deliveryResult.ok) {
    return respond(
      NextResponse.json({
        ok: true,
        status: 'accepted',
        message_id: messageId,
        retry_count: retryCount + 1,
      })
    )
  }
  return respond(
    NextResponse.json(
      {
        ok: false,
        status: deliveryResult.deliveryStatus,
        error_code: deliveryResult.errorCode,
        safe_error: deliveryResult.safeError,
        retry_count: retryCount + 1,
      },
      { status: 200 }
    )
  )
}
