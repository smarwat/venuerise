// Phase 8BQ — Link an unmatched inbound email orphan to a
// conversation.
//
// Operator-initiated. Inserts the orphan body as a `role:'lead'`
// message in the chosen conversation (left-side bubble),
// stamps the orphan as `status='linked'`, and writes an audit
// event. Does NOT trigger AI. Does NOT send anything outbound.
//
// Audit coverage: writes recordAuditEvent in the success path.
// Rate-limit: per-user-per-orphan via inboundEmailOrphan.link.

import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { assertOwnsConversation, OwnershipError } from '@/lib/auth/assert-ownership'
import { SALES_ROLES } from '@/lib/auth/roles'
import { rateLimitUserAction, rateLimitedResponse } from '@/lib/rate-limit'
import { recordAuditEvent } from '@/lib/enterprise/audit-events'
import { AUDIT_ACTIONS } from '@/lib/enterprise/audit-actions'
import { log } from '@/lib/log'
import {
  getOrCreateRequestId,
  withRequestIdHeader,
} from '@/lib/observability/request-id'
import { captureApiError } from '@/lib/observability/sentry'

const BodySchema = z.object({
  conversation_id: z.string().uuid(),
})

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
    route: '/api/inbound-email-orphans/[id]/link',
    op: 'inbound-email-orphans.link',
  })
  const respond = <T extends Response>(r: T) => withRequestIdHeader(r, requestId)

  const { id: orphanId } = await params
  if (!z.string().uuid().safeParse(orphanId).success) {
    return respond(
      NextResponse.json({ error: 'orphan_id must be a UUID' }, { status: 400 })
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

  const body = await request.json().catch(() => null)
  const parsed = BodySchema.safeParse(body ?? {})
  if (!parsed.success) {
    return respond(
      NextResponse.json(
        { error: 'validation_failed', detail: parsed.error.flatten() },
        { status: 400 }
      )
    )
  }

  // Per-user-per-orphan rate limit.
  const rl = await rateLimitUserAction(
    request,
    `inbound-email-orphan:link:${user.id}:${orphanId}`,
    {
      route: '/api/inbound-email-orphans/[id]/link',
      method: 'POST',
      userId: user.id,
      requestId,
    }
  )
  if (!rl.allowed) {
    return respond(rateLimitedResponse(rl))
  }

  // 1. Load the orphan via service-role so we get the venue_id
  //    + body fields regardless of RLS. Tenant check happens
  //    next via assertOwnsConversation.
  const svc = createServiceClient()
  // Phase 8BT — SELECT widened to include the new channel +
  // phone fields so the metadata branch below can stamp the
  // right shape for SMS orphans.
  const { data: orphanRow, error: orphanErr } = await svc
    .from('inbound_email_orphans')
    .select(
      'id, channel, venue_id, status, from_email, from_name, from_phone, to_phone, subject, stripped_body, raw_body_preview, received_at, provider, provider_inbound_id, match_confidence'
    )
    .eq('id', orphanId)
    .maybeSingle()
  if (orphanErr || !orphanRow) {
    return respond(NextResponse.json({ error: 'not_found' }, { status: 404 }))
  }
  const orphan = orphanRow as {
    id: string
    channel: 'email' | 'sms' | null
    venue_id: string | null
    status: string
    from_email: string | null
    from_name: string | null
    from_phone: string | null
    to_phone: string | null
    subject: string | null
    stripped_body: string | null
    raw_body_preview: string | null
    received_at: string | null
    provider: string
    provider_inbound_id: string | null
    match_confidence: number
  }
  // Legacy rows (created before migration 041) have channel=null
  // → treat as email per the column default.
  const channel: 'email' | 'sms' = orphan.channel ?? 'email'

  // 2. Already-acted orphans get 409 so the UI can refresh.
  if (orphan.status !== 'unresolved') {
    return respond(
      NextResponse.json(
        { error: 'already_resolved', status: orphan.status },
        { status: 409 }
      )
    )
  }

  // 3. Ownership: the conversation must belong to a venue the
  //    caller has SALES_ROLES on AND must match the orphan's
  //    inferred venue (when set). NULL-venue orphans (platform-
  //    orphan) cannot be linked from the operator surface —
  //    those require infra escalation.
  if (!orphan.venue_id) {
    return respond(
      NextResponse.json({ error: 'orphan_unscoped' }, { status: 403 })
    )
  }

  let convVenueId: string
  let convLeadId: string
  try {
    const own = await assertOwnsConversation(
      supabase,
      user.id,
      parsed.data.conversation_id,
      SALES_ROLES
    )
    convVenueId = own.venue_id
    convLeadId = own.lead_id
  } catch (err) {
    if (err instanceof OwnershipError) {
      return respond(NextResponse.json({ error: 'not_found' }, { status: 404 }))
    }
    throw err
  }

  if (convVenueId !== orphan.venue_id) {
    // Cross-tenant attempt — the conversation belongs to a
    // different venue than the orphan. Refuse without leaking
    // which side mismatched.
    return respond(NextResponse.json({ error: 'not_found' }, { status: 404 }))
  }

  // 4. Insert the orphan body as a role:'lead' message. This
  //    mirrors what /api/inbound/email would have done if the
  //    match had succeeded at capture time. Critically: NO AI
  //    trigger.
  const messageBody = (orphan.stripped_body || orphan.raw_body_preview || '').trim()
  if (!messageBody) {
    return respond(
      NextResponse.json({ error: 'orphan_body_empty' }, { status: 400 })
    )
  }

  // Phase 8BT — branch metadata shape on the orphan's channel.
  // Email keeps the 8BQ shape exactly. SMS swaps in
  // channel_type='sms' + phone envelope. Both flavors stamp
  // operator-vouched parse_confidence so the existing
  // ParseReviewBadge stays quiet on the linked bubble.
  const baseMetadata: Record<string, unknown> = {
    inbound_provider: orphan.provider,
    inbound_provider_message_id: orphan.provider_inbound_id,
    inbound_orphan_id: orphan.id,
    inbound_orphan_match_confidence: orphan.match_confidence,
    parse_needs_review: false,
    parse_confidence: 100,
    parse_confidence_reasons: ['operator_linked_from_orphan_queue'],
    parser_version: channel === 'sms' ? '8BT_v1' : '8BQ_v1',
    manually_linked: true,
    linked_by_user_id: user.id,
    linked_at: new Date().toISOString(),
  }
  const messageMetadata: Record<string, unknown> =
    channel === 'sms'
      ? {
          ...baseMetadata,
          source: 'inbound_sms_orphan_link',
          channel_type: 'sms',
          inbound_from_phone: orphan.from_phone,
          inbound_to_phone: orphan.to_phone,
        }
      : {
          ...baseMetadata,
          source: 'inbound_email_orphan_link',
          channel_type: 'email',
          inbound_from_email: orphan.from_email,
          inbound_from_name: orphan.from_name,
          inbound_subject: orphan.subject,
        }

  let insertedMessageId: string | null = null
  try {
    const { data: msgRow, error: msgErr } = await svc
      .from('messages')
      .insert({
        conversation_id: parsed.data.conversation_id,
        lead_id: convLeadId,
        venue_id: convVenueId,
        role: 'lead' as const,
        content: messageBody.slice(0, 8000),
        metadata: messageMetadata,
      })
      .select('id')
      .single()
    if (msgErr || !msgRow) {
      reqLog.error(
        { errorMessage: msgErr?.message },
        'inbound-email-orphans.link.message_insert_failed'
      )
      captureApiError(msgErr ?? new Error('messages insert returned no row'), {
        requestId,
        route: '/api/inbound-email-orphans/[id]/link',
        userId: user.id,
        venueId: convVenueId,
      })
      return respond(
        NextResponse.json({ error: 'unexpected_error' }, { status: 500 })
      )
    }
    insertedMessageId = (msgRow as { id: string }).id
  } catch (err) {
    captureApiError(err, {
      requestId,
      route: '/api/inbound-email-orphans/[id]/link',
      userId: user.id,
      venueId: convVenueId,
    })
    return respond(
      NextResponse.json({ error: 'unexpected_error' }, { status: 500 })
    )
  }

  // 5. Touch the conversation so the inbox list re-sorts.
  await svc
    .from('conversations')
    .update({ last_message_at: new Date().toISOString() })
    .eq('id', parsed.data.conversation_id)

  // 6. Mark the orphan resolved.
  await svc
    .from('inbound_email_orphans')
    .update({
      status: 'linked',
      linked_conversation_id: parsed.data.conversation_id,
      linked_lead_id: convLeadId,
      linked_message_id: insertedMessageId,
      linked_at: new Date().toISOString(),
      linked_by: user.id,
    })
    .eq('id', orphanId)

  // 7. Audit (safe fields only — no body, no full PII payload).
  void recordAuditEvent({
    venueId: convVenueId,
    actorUserId: user.id,
    actorKind: 'operator',
    route: '/api/inbound-email-orphans/[id]/link',
    action: AUDIT_ACTIONS.INBOUND_EMAIL_ORPHAN_LINKED,
    targetTable: 'inbound_email_orphans',
    targetId: orphanId,
    requestId,
    ip: request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
    userAgent: request.headers.get('user-agent'),
    metadata: {
      orphan_id: orphanId,
      channel,
      conversation_id: parsed.data.conversation_id,
      lead_id: convLeadId,
      linked_message_id: insertedMessageId,
      match_confidence: orphan.match_confidence,
      provider: orphan.provider,
      provider_inbound_id_present: !!orphan.provider_inbound_id,
    },
  })

  reqLog.info(
    {
      orphanId,
      conversationId: parsed.data.conversation_id,
      messageId: insertedMessageId,
    },
    'inbound-email-orphans.link.completed'
  )

  return respond(
    NextResponse.json({
      ok: true,
      orphan_id: orphanId,
      message_id: insertedMessageId,
      conversation_id: parsed.data.conversation_id,
    })
  )
}
