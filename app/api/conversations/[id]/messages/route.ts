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
import { editDistanceBucket } from '@/lib/revenue-os/brand-voice-calibration'
import { parseRevenueOsSettings } from '@/lib/revenue-os/settings'
import { recordAuditEvent } from '@/lib/enterprise/audit-events'
import {
  isOutboundEmailConfigured,
  sendOutboundEmail,
} from '@/lib/integrations/delivery/email'
import {
  isOutboundSmsConfigured,
  sendOutboundSms,
} from '@/lib/integrations/delivery/sms'
import { log } from '@/lib/log'
import {
  getOrCreateRequestId,
  withRequestIdHeader,
} from '@/lib/observability/request-id'
import { captureApiError } from '@/lib/observability/sentry'

/**
 * POST /api/conversations/[id]/messages  (Phase 8AJ; route
 * param renamed in the 8BG hotfix to match the sibling
 * /api/conversations/[id]/mark-sent-manually route — Next.js
 * disallows differing dynamic segment names at the same path
 * level.)
 *
 * Inserts an OPERATOR-authored message into a conversation.
 *
 * Surfaced by the LeadDetailDrawer "Approve & send" CTA so an operator
 * can approve an AI draft and emit it to the lead as a `human` role
 * message. Mirrors the security posture of /api/ai/chat:
 *
 *   - `assertOwnsConversation` verifies the conversation belongs to a
 *     venue the caller has SALES_ROLES on. Cross-tenant access throws
 *     `OwnershipError` which we map to 403.
 *   - `requireActiveSubscription` honors the billing gate.
 *   - Per-user-per-conversation rate-limit so a runaway click loop
 *     can't spam the lead.
 *   - Insert via service-role client (RLS would otherwise need the
 *     operator's session to write directly).
 *
 * ── EXTERNAL DELIVERY ────────────────────────────────────────────────────
 * This route ONLY inserts the message row. It does NOT send email or
 * SMS — the existing message system stores conversation history
 * in-app and downstream paths (e.g. resend webhooks, future outbound
 * email dispatch) decide whether to deliver. That's intentional and
 * matches the rest of the conversation surface.
 */

// Phase 8AM — `metadata` block accepts an allowlisted subset of fields
// so the LeadDetailDrawer can stamp the chosen AI variant onto the
// outgoing message row. Any other key the client sends is dropped on
// the floor (we never spread arbitrary metadata into the DB row).
//
// Phase 8BM extension — the composer also stamps reply-method
// context (where the operator INTENDED to send) so downstream audit
// + digest surfaces have an honest record. None of these fields
// claim external delivery; they describe operator intent + the
// platform's delivery-mode resolution at write time.
const ApproveMetadataSchema = z
  .object({
    source: z.string().max(80).optional(),
    ai_action_id: z.string().uuid().optional(),
    selected_variant_index: z.number().int().min(0).max(9).optional(),
    variant_count: z.number().int().min(1).max(9).optional(),
    // Phase 8BM — reply method allowlist. The resolver's full type
    // is `'email' | 'sms' | 'instagram' | 'facebook' | 'the_knot' |
    // 'weddingwire' | 'meta_lead_ads' | 'website' | 'internal'` —
    // we cap at length so the column stays narrow.
    reply_method: z.string().max(40).optional(),
    reply_delivery_mode: z
      .enum(['direct', 'manual', 'internal_only', 'unavailable'])
      .optional(),
    channel_type: z.string().max(40).optional(),
    reply_destination: z.string().max(200).optional(),
  })
  .strict()
  .optional()

const BodySchema = z.object({
  body: z.string().min(1).max(8000),
  // Reserved for future expansion (e.g. 'note' for an internal-only
  // note). Today only 'operator' is accepted; mapped to MessageRole
  // 'human' on insert.
  sender_type: z.enum(['operator']).optional(),
  metadata: ApproveMetadataSchema,
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
    route: '/api/conversations/[id]/messages',
    op: 'conversations.messages.post',
  })
  const respond = <T extends Response>(r: T) => withRequestIdHeader(r, requestId)

  // Resolve the dynamic segment. Next 15+ wraps params in a promise;
  // we await once at the top so the rest of the handler reads the
  // resolved value. The route param was renamed from `conversationId`
  // to `id` in the 8BG hotfix so the sibling /api/conversations/[id]/
  // mark-sent-manually route doesn't conflict; we still bind it to a
  // `conversationId` local so the existing body of the handler
  // continues to read naturally.
  const { id: conversationId } = await params

  if (!z.string().uuid().safeParse(conversationId).success) {
    return respond(
      NextResponse.json(
        { error: 'conversation_id must be a UUID' },
        { status: 400 }
      )
    )
  }

  // 1. Auth + role gate (sales roles can send to leads).
  const supabase = await createClient()
  const {
    data: { user },
    error: userErr,
  } = await supabase.auth.getUser()
  if (userErr || !user) {
    return respond(NextResponse.json({ error: 'unauthorized' }, { status: 401 }))
  }

  // 2. Ownership: conversation must belong to a venue the caller has
  // SALES_ROLES on. Same posture as /api/ai/chat.
  let venueId: string
  let leadId: string
  try {
    const own = await assertOwnsConversation(
      supabase,
      user.id,
      conversationId,
      SALES_ROLES
    )
    venueId = own.venue_id
    leadId = own.lead_id
  } catch (err) {
    if (err instanceof OwnershipError) {
      // Ownership/role failures collapse to 404 — matches the rest
      // of the conversation surface (existing /api/ai/chat uses the
      // same posture). Doesn't leak whether the conversation
      // actually exists across tenants.
      return respond(NextResponse.json({ error: 'not_found' }, { status: 404 }))
    }
    throw err
  }

  // 3. Billing gate (parity with /api/ai/chat).
  try {
    await requireActiveSubscription(venueId, {
      requestId,
      route: '/api/conversations/[id]/messages',
    })
  } catch (err) {
    if (err instanceof SubscriptionRequiredError) {
      return respond(
        NextResponse.json({ error: err.code }, { status: err.status })
      )
    }
    throw err
  }

  // 4. Body.
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

  // 5. Rate limit. Per user + conversation so a runaway click loop on
  // one thread doesn't deny the operator on every other thread.
  const rl = await rateLimitUserAction(
    request,
    `conversation-message-send:${user.id}:${conversationId}`
  )
  if (!rl.allowed) {
    reqLog.warn(
      { userId: user.id, conversationId, retryMs: rl.retryAfterMs },
      'rate_limit.blocked'
    )
    return respond(rateLimitedResponse(rl))
  }

  // 6. Insert via service client — mirrors the /api/ai/chat write
  // path (the orchestrator writes through service-role for
  // consistency; doing the same here keeps the message row chain
  // homogeneous).
  const svc = createServiceClient()
  // Phase 8AM — merge the allowlisted client metadata with the server-
  // owned `source` tag. The Zod schema (`.strict()`) already discarded
  // any non-allowlisted keys; we still construct the object field-by-
  // field so an accidental spread refactor can't widen the surface.
  const clientMeta = parsed.data.metadata ?? {}
  const messageMetadata: Record<string, unknown> = {
    source: 'lead_detail_drawer_approve',
  }
  if (typeof clientMeta.source === 'string') {
    // Client `source` overrides the server default — useful for
    // distinguishing future call sites (e.g. an inbox-side approve)
    // without changing this route.
    messageMetadata.source = clientMeta.source
  }
  if (typeof clientMeta.ai_action_id === 'string') {
    messageMetadata.ai_action_id = clientMeta.ai_action_id
  }
  if (typeof clientMeta.selected_variant_index === 'number') {
    messageMetadata.selected_variant_index = clientMeta.selected_variant_index
  }
  if (typeof clientMeta.variant_count === 'number') {
    messageMetadata.variant_count = clientMeta.variant_count
  }
  // Phase 8BM — carry reply-method context onto the row so
  // downstream surfaces (audit, digest, future switching UI) have
  // an honest record of where the operator intended the reply to
  // go. Delivery STATUS (below) is the separate truth signal.
  if (typeof clientMeta.reply_method === 'string') {
    messageMetadata.reply_method = clientMeta.reply_method
  }
  if (typeof clientMeta.reply_delivery_mode === 'string') {
    messageMetadata.reply_delivery_mode = clientMeta.reply_delivery_mode
  }
  if (typeof clientMeta.channel_type === 'string') {
    messageMetadata.channel_type = clientMeta.channel_type
  }
  if (typeof clientMeta.reply_destination === 'string') {
    messageMetadata.reply_destination = clientMeta.reply_destination
  }

  // Phase 8BN / 8BR — direct outbound delivery decision.
  //
  // The composer stamps `reply_method='email'|'sms'` +
  // `reply_delivery_mode='direct'` when the server-side
  // resolver decided that channel's delivery is wired for the
  // venue. We RE-VERIFY here — never trust the client to
  // authorize a real outbound send. If the kill-switch is off
  // or the provider isn't configured, we silently downgrade to
  // `internal_only` (the message still saves; the pill just
  // won't say "Sent" / "Accepted").
  const requestedDirectEmail =
    clientMeta.reply_method === 'email' &&
    clientMeta.reply_delivery_mode === 'direct'
  const requestedDirectSms =
    clientMeta.reply_method === 'sms' &&
    clientMeta.reply_delivery_mode === 'direct'
  const directEmailAuthorized =
    requestedDirectEmail && isOutboundEmailConfigured()
  const directSmsAuthorized =
    requestedDirectSms && isOutboundSmsConfigured()

  if (requestedDirectEmail && !directEmailAuthorized) {
    // Email downgrade — stored metadata reflects what actually
    // happened (no external send), not what the client claimed.
    messageMetadata.reply_delivery_mode = 'internal_only'
    messageMetadata.delivery_status = 'skipped'
    messageMetadata.delivery_skip_reason = 'delivery_disabled'
    messageMetadata.delivery_provider = 'resend'
  } else if (directEmailAuthorized) {
    // Optimistic placeholder — realtime subscriber sees
    // "Sending…" while the provider call is in flight.
    messageMetadata.delivery_status = 'pending'
    messageMetadata.delivery_provider = 'resend'
    messageMetadata.delivery_channel = 'email'
  } else if (requestedDirectSms && !directSmsAuthorized) {
    // SMS downgrade — same pattern as email.
    messageMetadata.reply_delivery_mode = 'internal_only'
    messageMetadata.delivery_status = 'skipped'
    messageMetadata.delivery_skip_reason = 'delivery_disabled'
    messageMetadata.delivery_provider = 'twilio'
    messageMetadata.delivery_channel = 'sms'
  } else if (directSmsAuthorized) {
    messageMetadata.delivery_status = 'pending'
    messageMetadata.delivery_provider = 'twilio'
    messageMetadata.delivery_channel = 'sms'
  }

  const { data: inserted, error: insertErr } = await svc
    .from('messages')
    .insert({
      conversation_id: conversationId,
      lead_id: leadId,
      venue_id: venueId,
      role: 'human',
      content: parsed.data.body.trim(),
      metadata: messageMetadata,
    })
    .select('*')
    .single()

  if (insertErr) {
    reqLog.error(
      { err: insertErr, conversationId, leadId, venueId },
      'conversations.messages.insert_failed'
    )
    captureApiError(insertErr, {
      requestId,
      route: '/api/conversations/[id]/messages',
      userId: user.id,
      venueId,
    })
    return respond(
      NextResponse.json({ error: 'unexpected_error' }, { status: 500 })
    )
  }

  // 7. Touch the conversation so list ordering surfaces the new
  // activity. Best-effort: a failure here doesn't roll back the
  // message insert (the message is the truth signal).
  await svc
    .from('conversations')
    .update({ last_message_at: new Date().toISOString() })
    .eq('id', conversationId)

  // 7b. Phase 8BN — direct email delivery.
  //
  // The message row is already durable on disk (step 6) with
  // `delivery_status: 'pending'`. We now attempt the send and
  // patch the same row with the result. If the provider rejects,
  // the operator's typed reply is preserved — they don't have to
  // retype, they can mark-sent-manually or escalate.
  //
  // Critical: we do NOT throw or return early on delivery failure.
  // The message is real; the delivery attempt is an annotation.
  // Phase 8BR — union covers both email + SMS outcomes so the
  // downstream patch + response code reads from one variable.
  let deliveryResult:
    | Awaited<ReturnType<typeof sendOutboundEmail>>
    | Awaited<ReturnType<typeof sendOutboundSms>>
    | null = null
  if (directEmailAuthorized && inserted) {
    const insertedRow = inserted as { id: string; metadata: Record<string, unknown> | null }
    const recipient = (clientMeta.reply_destination ?? '').trim()
    // Pull venue name for a humanized subject. Best-effort — if
    // the lookup fails we fall back to the safe default subject.
    let venueName: string | null = null
    try {
      const { data: venueRow } = await svc
        .from('venues')
        .select('name')
        .eq('id', venueId)
        .maybeSingle()
      venueName = (venueRow as { name?: string | null } | null)?.name ?? null
    } catch {
      // Non-fatal — subject just won't include the venue name.
    }

    deliveryResult = await sendOutboundEmail({
      to: recipient,
      text: parsed.data.body.trim(),
      subject: null, // wrapper picks safe default
      venueName,
      venueId,
      conversationId,
      leadId,
      messageId: insertedRow.id,
    })

    // Build the patch — only the delivery fields, merged onto the
    // existing metadata. We re-read messageMetadata locally to
    // include the placeholders we set above (delivery_provider,
    // pending status); the patch overwrites them with the real
    // outcome.
    const deliveryPatch: Record<string, unknown> = {
      ...messageMetadata,
      delivery_status: deliveryResult.deliveryStatus,
      delivery_provider: deliveryResult.provider,
    }
    if (deliveryResult.ok) {
      deliveryPatch.provider_message_id = deliveryResult.providerMessageId
      deliveryPatch.delivered_at = new Date().toISOString()
      // Clear any stale error fields on retry-shaped flows.
      delete deliveryPatch.delivery_error_code
      delete deliveryPatch.delivery_safe_error
    } else {
      deliveryPatch.delivery_error_code = deliveryResult.errorCode
      deliveryPatch.delivery_safe_error = deliveryResult.safeError
      // On failure/skip the row's reply_delivery_mode is still
      // 'direct' (operator INTENDED direct). The delivery_status
      // field is the truth signal the UI reads.
    }
    // Only the email helper returns outboundMessageId; the SMS
    // helper doesn't write to outbound_messages today.
    const emailOutboundId =
      'outboundMessageId' in deliveryResult
        ? (deliveryResult as { outboundMessageId?: string | null })
            .outboundMessageId
        : null
    if (emailOutboundId) {
      deliveryPatch.outbound_message_id = emailOutboundId
    }

    const { error: patchErr } = await svc
      .from('messages')
      .update({ metadata: deliveryPatch })
      .eq('id', insertedRow.id)
    if (patchErr) {
      reqLog.warn(
        { err: patchErr, messageId: insertedRow.id },
        'conversations.messages.delivery_patch_failed'
      )
    } else {
      // Reflect the patch back onto the in-memory row so the
      // response payload matches what the client will read on
      // refresh.
      ;(inserted as { metadata: Record<string, unknown> }).metadata = deliveryPatch
    }

    reqLog.info(
      {
        messageId: insertedRow.id,
        deliveryStatus: deliveryResult.deliveryStatus,
        errorCode: deliveryResult.ok ? null : deliveryResult.errorCode,
        provider: deliveryResult.provider,
      },
      'conversations.messages.delivery_attempted'
    )
  }

  // 7c. Phase 8BR — direct SMS delivery.
  //
  // Same insert-then-send-then-patch flow as email. Body is
  // already capped at 8000 chars by the route's BodySchema; the
  // SMS helper applies a tighter cap (OUTBOUND_SMS_MAX_LENGTH /
  // 1200 default) and returns `failed:message_too_long` if the
  // operator typed a novel.
  if (directSmsAuthorized && inserted) {
    const insertedRow = inserted as { id: string; metadata: Record<string, unknown> | null }
    const recipient = (clientMeta.reply_destination ?? '').trim()
    const smsResult = await sendOutboundSms({
      to: recipient,
      body: parsed.data.body.trim(),
      venueId,
      conversationId,
      leadId,
      messageId: insertedRow.id,
    })
    deliveryResult = smsResult

    const deliveryPatch: Record<string, unknown> = {
      ...messageMetadata,
      delivery_status: smsResult.deliveryStatus,
      delivery_provider: smsResult.provider,
      delivery_channel: 'sms',
    }
    if (smsResult.ok) {
      deliveryPatch.provider_message_id = smsResult.providerMessageId
      // For SMS, "accepted" / "queued" / "sent" come back
      // immediately. Stamp accepted_at as the truth-signal
      // timestamp; sent_at would require the status callback
      // (deferred to a later phase).
      deliveryPatch.accepted_at = new Date().toISOString()
      if (smsResult.deliveryStatus === 'sent') {
        deliveryPatch.sent_at = new Date().toISOString()
      }
      delete deliveryPatch.delivery_error_code
      delete deliveryPatch.delivery_safe_error
    } else {
      deliveryPatch.delivery_error_code = smsResult.errorCode
      deliveryPatch.delivery_safe_error = smsResult.safeError
      if (smsResult.deliveryStatus === 'failed') {
        deliveryPatch.failed_at = new Date().toISOString()
      }
    }

    const { error: patchErr } = await svc
      .from('messages')
      .update({ metadata: deliveryPatch })
      .eq('id', insertedRow.id)
    if (patchErr) {
      reqLog.warn(
        { err: patchErr, messageId: insertedRow.id },
        'conversations.messages.sms_delivery_patch_failed'
      )
    } else {
      ;(inserted as { metadata: Record<string, unknown> }).metadata = deliveryPatch
    }

    reqLog.info(
      {
        messageId: insertedRow.id,
        deliveryStatus: smsResult.deliveryStatus,
        errorCode: smsResult.ok ? null : smsResult.errorCode,
        provider: smsResult.provider,
        providerMessageIdPresent: smsResult.ok ? !!smsResult.providerMessageId : false,
      },
      'conversations.messages.sms_delivery_attempted'
    )
  }

  // 8. Phase 8AW — write operator outcome onto the source ai_actions
  // row (the draft this operator chose to approve & send). Lets the
  // calibration panel measure how often operators send drafts as-is
  // vs after edits — the core trust signal for the Brand Voice agent.
  //
  // Best-effort: any failure is swallowed. The message is already
  // inserted; we never block a successful send to write telemetry.
  //
  // Terminal-once: we skip if the source row already has an outcome
  // (e.g. a regenerate marked it 'regenerated' before this send
  // landed — preserve the first-observed signal).
  if (typeof clientMeta.ai_action_id === 'string') {
    try {
      const { data: sourceRow } = await svc
        .from('ai_actions')
        .select('id, venue_id, lead_id, metadata')
        .eq('id', clientMeta.ai_action_id)
        .maybeSingle()
      const source = sourceRow as {
        id: string
        venue_id: string
        lead_id: string | null
        metadata: Record<string, unknown> | null
      } | null
      // Cross-tenant guard. We just validated the conversation
      // belongs to this venue/lead; require the ai_action to match
      // before mutating it. A mismatched id is a client bug or worse,
      // so we silently skip rather than 4xx (the message is sent).
      if (
        source &&
        source.venue_id === venueId &&
        source.lead_id === leadId &&
        !(
          source.metadata &&
          (source.metadata as { operator_outcome?: string })
            .operator_outcome
        )
      ) {
        const md = source.metadata ?? {}
        const variantsOffered = Array.isArray(
          (md as { variants_offered?: unknown }).variants_offered
        )
          ? ((md as { variants_offered?: unknown[] }).variants_offered as unknown[])
          : []
        const variantConfidences = Array.isArray(
          (md as { variant_confidences?: unknown }).variant_confidences
        )
          ? ((md as { variant_confidences?: unknown[] })
              .variant_confidences as unknown[])
          : []
        const selectedIdx =
          typeof clientMeta.selected_variant_index === 'number'
            ? clientMeta.selected_variant_index
            : null
        const originalDraft =
          selectedIdx !== null && typeof variantsOffered[selectedIdx] === 'string'
            ? (variantsOffered[selectedIdx] as string)
            : null
        const bucket = editDistanceBucket(
          originalDraft,
          parsed.data.body.trim()
        )
        const outcome: 'sent_as_is' | 'sent_after_edit' =
          bucket === 'none' || bucket === 'unknown'
            ? 'sent_as_is'
            : bucket === 'minor'
              ? 'sent_as_is'
              : 'sent_after_edit'
        // Look up the brand voice floor so we can flag whether the
        // selected variant was below the venue's gate when sent — a
        // direct measurement of "did the operator override a
        // low-confidence draft?"
        let floor = 70
        try {
          const { data: venueRow } = await svc
            .from('venues')
            .select('metadata')
            .eq('id', venueId)
            .maybeSingle()
          const settings = parseRevenueOsSettings(
            (venueRow as { metadata?: unknown } | null)?.metadata ?? null
          )
          floor = settings.brandVoiceConfidenceFloor
        } catch {
          // Stick with default floor if the venue read fails — the
          // outcome write itself is the higher-value signal.
        }
        const selectedConfidenceRaw =
          selectedIdx !== null ? variantConfidences[selectedIdx] : null
        const selectedConfidence =
          typeof selectedConfidenceRaw === 'number' &&
          Number.isFinite(selectedConfidenceRaw)
            ? selectedConfidenceRaw
            : null
        const selectedVariantWasLowConfidence =
          selectedConfidence === null ? null : selectedConfidence < floor
        const mergedMetadata = {
          ...md,
          operator_outcome: outcome,
          operator_outcome_at: new Date().toISOString(),
          selected_variant_index: selectedIdx,
          selected_variant_confidence: selectedConfidence,
          selected_variant_was_low_confidence: selectedVariantWasLowConfidence,
          edit_distance_bucket: bucket,
        }
        await svc
          .from('ai_actions')
          .update({ metadata: mergedMetadata })
          .eq('id', source.id)
      }
    } catch (err) {
      reqLog.warn(
        { err, conversationId, leadId, aiActionId: clientMeta.ai_action_id },
        'conversations.messages.outcome_mark_failed'
      )
    }
  }

  reqLog.info(
    {
      conversationId,
      leadId,
      venueId,
      userId: user.id,
      messageId: (inserted as { id: string } | null)?.id ?? null,
    },
    'conversations.messages.inserted'
  )

  // Phase 9A — best-effort audit row for the operator-approved
  // send. We deliberately do NOT include the raw message body in
  // either snapshot — the audit row records that the operator
  // approved a draft for a conversation, not what was said. The
  // body itself lives in `messages.content` and is queryable
  // separately with the appropriate scope.
  void recordAuditEvent({
    venueId,
    actorUserId: user.id,
    actorKind: 'operator',
    route: '/api/conversations/[id]/messages',
    action: 'operator_message_send',
    targetTable: 'messages',
    targetId: (inserted as { id?: string } | null)?.id ?? null,
    requestId,
    ip: request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
    userAgent: request.headers.get('user-agent'),
    metadata: {
      conversation_id: conversationId,
      lead_id: leadId,
      source: clientMeta.source ?? 'lead_detail_drawer_approve',
      ai_action_id: clientMeta.ai_action_id ?? null,
      selected_variant_index: clientMeta.selected_variant_index ?? null,
      body_length: parsed.data.body.length,
      // Phase 8BN — record the delivery outcome on the audit row
      // so security/ops can answer "did this operator's reply
      // actually go out?" without joining to messages.metadata.
      // We deliberately do NOT include the recipient email here
      // (already in messages.metadata.reply_destination); the
      // audit-events helper sanitizes message metadata before
      // surfacing, but the audit row itself is high-volume +
      // long-retained and should stay PII-light.
      reply_method: clientMeta.reply_method ?? null,
      reply_delivery_mode_intended: clientMeta.reply_delivery_mode ?? null,
      delivery_channel:
        directEmailAuthorized ? 'email'
        : directSmsAuthorized ? 'sms'
        : null,
      delivery_attempted: directEmailAuthorized || directSmsAuthorized,
      delivery_status: deliveryResult
        ? deliveryResult.deliveryStatus
        : (requestedDirectEmail || requestedDirectSms)
          ? 'skipped'
          : null,
      delivery_provider: deliveryResult ? deliveryResult.provider : null,
      delivery_error_code:
        deliveryResult && !deliveryResult.ok ? deliveryResult.errorCode : null,
      provider_message_id_present: !!(
        deliveryResult &&
        deliveryResult.ok &&
        deliveryResult.providerMessageId
      ),
    },
  })

  // Phase 8BN / 8BR — surface the delivery outcome to the client
  // so the composer can show an immediate toast/pill without
  // waiting for the realtime echo. The message row itself is the
  // durable truth; this is a UX shortcut.
  return respond(
    NextResponse.json({
      success: true,
      message: inserted,
      delivery: deliveryResult
        ? {
            attempted: true,
            status: deliveryResult.deliveryStatus,
            provider: deliveryResult.provider,
            error_code: deliveryResult.ok ? null : deliveryResult.errorCode,
            safe_error: deliveryResult.ok ? null : deliveryResult.safeError,
          }
        : requestedDirectEmail
          ? {
              attempted: false,
              status: 'skipped' as const,
              provider: 'resend' as const,
              error_code: 'delivery_disabled' as const,
              safe_error: 'Email sending is not connected for this workspace.',
            }
          : requestedDirectSms
            ? {
                attempted: false,
                status: 'skipped' as const,
                provider: 'twilio' as const,
                error_code: 'delivery_disabled' as const,
                safe_error: 'SMS sending is not connected for this workspace.',
              }
            : { attempted: false, status: null },
    })
  )
}
