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
const ApproveMetadataSchema = z
  .object({
    source: z.string().max(80).optional(),
    ai_action_id: z.string().uuid().optional(),
    selected_variant_index: z.number().int().min(0).max(9).optional(),
    variant_count: z.number().int().min(1).max(9).optional(),
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
    },
  })

  return respond(NextResponse.json({ success: true, message: inserted }))
}
