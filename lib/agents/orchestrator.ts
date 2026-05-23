import { createServiceClient } from '@/lib/supabase/service'
import { qualifyLead } from './lead-qualifier'
import { generateConversationReply } from './conversation'
import { generateFollowUpMessage, getFollowUpScheduledAt, FOLLOW_UP_DELAYS_MINUTES } from './followup'
import { log } from '@/lib/log'
import { captureAiError } from '@/lib/observability/sentry'
import { parseRevenueOsSettings } from '@/lib/revenue-os/settings'
import {
  generateInstantLeadResponse,
  INSTANT_LEAD_RESPONSE_SOURCE,
} from '@/lib/ai/instant-lead-response'
import {
  buildTourAvailabilityContext,
  renderTourAvailabilityPromptBlock,
} from '@/lib/revenue-os/tour-availability-context'
import {
  getKnownContactSignals,
  renderContactSignalsPromptBlock,
} from '@/lib/revenue-os/contact-extraction'
import {
  detectTourSlotSelection,
  type OfferedTourSlot,
} from '@/lib/revenue-os/tour-slot-selection'

async function logAction(supabase: ReturnType<typeof createServiceClient>, params: {
  venue_id: string
  lead_id?: string | null
  agent: string
  action: string
  input_summary?: string
  output_summary?: string
  latency_ms?: number
  tokens_used?: number
  success: boolean
  error_message?: string
  metadata?: Record<string, unknown>
}) {
  await supabase.from('ai_actions').insert(params)
}

export async function handleNewLead(
  leadId: string,
  venueId: string,
  /** Optional: reuse a conversation pre-created by the caller (e.g. widget). */
  existingConversationId?: string | null,
  /** Optional Phase 5B request id — threaded into agent calls + Sentry tags. */
  requestId?: string
) {
  const supabase = createServiceClient()
  const start = Date.now()

  try {
    // 0. Defensive validation — confirm the lead exists, belongs to the
    //    expected venue, and the venue exists. Cheap, but catches a class
    //    of bugs where a caller passes mismatched ids or a stale lead.
    const [leadRes, venueRes, kbRes] = await Promise.all([
      supabase.from('leads').select('*').eq('id', leadId).maybeSingle(),
      supabase.from('venues').select('*').eq('id', venueId).maybeSingle(),
      supabase.from('knowledge_base').select('*').eq('venue_id', venueId).eq('is_active', true).order('priority', { ascending: false }).limit(15),
    ])

    const lead = leadRes.data as Record<string, unknown> | null
    const venue = venueRes.data as Record<string, unknown> | null

    if (!lead) {
      log.error({ leadId, venueId }, 'orchestrator.handle_new_lead.lead_not_found')
      throw new Error(`Lead ${leadId} not found`)
    }
    if (!venue) {
      log.error({ leadId, venueId }, 'orchestrator.handle_new_lead.venue_not_found')
      throw new Error(`Venue ${venueId} not found`)
    }
    if (lead.venue_id !== venueId) {
      log.error(
        { leadId, passedVenueId: venueId, actualVenueId: lead.venue_id },
        'orchestrator.handle_new_lead.lead_venue_mismatch'
      )
      throw new Error('Lead does not belong to the supplied venue')
    }

    const kb = (kbRes.data ?? []) as { category: string; title: string; content: string }[]

    // 1. Qualify the lead
    const qualification = await qualifyLead(
      {
        name: lead.name as string,
        email: lead.email as string,
        guest_count: lead.guest_count as number | null,
        budget: lead.budget as number | null,
        event_date: lead.event_date as string | null,
        notes: lead.notes as string | null,
        source: lead.source as string,
      },
      {
        name: venue.name as string,
        capacity_min: venue.capacity_min as number | null,
        capacity_max: venue.capacity_max as number | null,
        base_price: venue.base_price as number | null,
        style_tags: (venue.style_tags as string[]) ?? [],
        ai_persona_name: venue.ai_persona_name as string,
      },
      requestId
    )

    // 2. Update lead with score, urgency, and potentially extracted data
    const updatePayload: Record<string, unknown> = {
      lead_score: qualification.score,
      urgency: qualification.urgency,
      stage: qualification.is_qualified ? 'qualified' : 'new_inquiry',
    }
    if (qualification.extracted.guest_count && !lead.guest_count) {
      updatePayload.guest_count = qualification.extracted.guest_count
    }
    if (qualification.extracted.budget && !lead.budget) {
      updatePayload.budget = qualification.extracted.budget
    }
    if (qualification.extracted.event_date && !lead.event_date) {
      updatePayload.event_date = qualification.extracted.event_date
    }
    await supabase.from('leads').update(updatePayload).eq('id', leadId)

    // 3. Resolve conversation (idempotent) — reuse caller-supplied id,
    //    else reuse an existing one for this lead, else create.
    let conversation: { id: string } | null = null

    if (existingConversationId) {
      const r = await supabase
        .from('conversations')
        .select('id')
        .eq('id', existingConversationId)
        .eq('lead_id', leadId)
        .maybeSingle()
      conversation = (r.data as { id: string } | null) ?? null
    }

    if (!conversation) {
      const r = await supabase
        .from('conversations')
        .select('id')
        .eq('lead_id', leadId)
        .order('created_at')
        .limit(1)
        .maybeSingle()
      conversation = (r.data as { id: string } | null) ?? null
    }

    if (!conversation) {
      const convRes = await supabase
        .from('conversations')
        .insert({ lead_id: leadId, venue_id: venueId, sentiment: 'neutral', unread_count: 0 })
        .select('id')
        .single()
      conversation = (convRes.data as { id: string } | null) ?? null
    }

    if (!conversation) throw new Error('Failed to resolve or create conversation')

    // Idempotency guard: if this conversation already has an AI message,
    // a previous qualification run completed — don't re-charge Anthropic.
    const existingAiMsgs = await supabase
      .from('messages')
      .select('id', { count: 'exact', head: true })
      .eq('conversation_id', conversation.id)
      .eq('role', 'ai')

    if ((existingAiMsgs.count ?? 0) > 0) {
      log.warn(
        { leadId, conversationId: conversation.id },
        'orchestrator.handle_new_lead.idempotent_skip'
      )
      await logAction(supabase, {
        venue_id: venueId,
        lead_id: leadId,
        agent: 'orchestrator',
        action: 'handle_new_lead',
        input_summary: `Skipped (idempotent): lead ${lead.name}`,
        output_summary: 'Already processed — existing AI message found',
        latency_ms: Date.now() - start,
        success: true,
      })
      return { success: true, skipped: true, conversationId: conversation.id }
    }

    // Save lead's initial message if notes exist
    if (lead.notes) {
      await supabase.from('messages').insert({
        conversation_id: conversation.id,
        lead_id: leadId,
        venue_id: venueId,
        role: 'lead',
        content: lead.notes as string,
      })
    }

    // Phase GTM-ILR — Instant Lead Response.
    //
    // The training profile (tone, sample replies, phrases, auto-send
    // posture) lives at `venues.metadata.revenue_os.instant_response`.
    // When `enabled` (the default), we run the structured-output
    // helper that returns a confidence-scored draft + safety gate +
    // suggested next step. When disabled, fall back to the legacy
    // `generateConversationReply` path. The fallback path is also
    // taken automatically if the structured helper itself fell back
    // (Anthropic failure) — we still persist its safe message + log
    // the failure so the lead never silently goes unanswered.
    const settings = parseRevenueOsSettings(venue.metadata)
    const useInstantResponse = settings.instantResponse.enabled

    type AiMessageMetadata = Record<string, unknown>
    let aiMessageText: string
    let aiMessageMetadata: AiMessageMetadata
    let tokensUsedForAudit: number | undefined
    let aiActionForAudit: string
    let aiActionMetadata: Record<string, unknown> | undefined

    if (useInstantResponse) {
      const ilr = await generateInstantLeadResponse({
        venue: {
          name: venue.name as string,
          description: (venue.description as string | null) ?? null,
          capacity_min: (venue.capacity_min as number | null) ?? null,
          capacity_max: (venue.capacity_max as number | null) ?? null,
          base_price: (venue.base_price as number | null) ?? null,
          style_tags: (venue.style_tags as string[]) ?? [],
          ai_persona_name: (venue.ai_persona_name as string) ?? 'the event coordinator',
          ai_tone: (venue.ai_tone as string | null) ?? null,
        },
        lead: {
          name: lead.name as string,
          email: (lead.email as string | null) ?? null,
          phone: (lead.phone as string | null) ?? null,
          event_date: (lead.event_date as string | null) ?? null,
          guest_count: (lead.guest_count as number | null) ?? null,
          budget: (lead.budget as number | null) ?? null,
          notes: (lead.notes as string | null) ?? null,
          source: (lead.source as string | null) ?? null,
          lead_score: qualification.score,
          stage: qualification.is_qualified ? 'qualified' : 'new_inquiry',
          most_recent_inbound_message: (lead.notes as string | null) ?? null,
        },
        knowledgeBase: kb.map((entry) => ({
          category: entry.category,
          title: entry.title,
          content: entry.content,
        })),
        training: settings.instantResponse,
        brandVoiceConfidenceFloor: settings.brandVoiceConfidenceFloor,
        requestId,
      })

      aiMessageText = ilr.response
      aiMessageMetadata = {
        source: INSTANT_LEAD_RESPONSE_SOURCE,
        tokens_used: ilr.tokensUsed,
        latency_ms: ilr.latencyMs,
        model: ilr.model,
        confidence: ilr.confidence,
        model_confidence: ilr.modelConfidence,
        heuristic_confidence: ilr.heuristicConfidence,
        needs_human_review: ilr.needsHumanReview,
        unsupported_claims: ilr.unsupportedClaims,
        detected_questions: ilr.detectedQuestions,
        suggested_next_step: ilr.suggestedNextStep,
        venue_context_signal: ilr.venueContextSignal,
        risk_flags: ilr.riskFlags,
        autopilot_mode: ilr.autopilotMode,
        fallback_used: ilr.fallbackUsed,
        auto_send_eligible: ilr.autoSendEligible,
        // Auto-send is scaffold-only: even when eligible, this phase
        // never actually sends. Recording the intent here lets a
        // future outbound integration consume the flag without
        // re-running the safety gate.
        auto_send_action_taken: 'draft_only',
        reasons: ilr.reasons,
      }
      tokensUsedForAudit = ilr.tokensUsed ?? undefined

      if (ilr.fallbackUsed) {
        aiActionForAudit = 'instant_lead_response.fallback_created'
      } else if (ilr.autoSendEligible) {
        aiActionForAudit = 'instant_lead_response.auto_send_eligible'
      } else {
        aiActionForAudit = 'instant_lead_response.generated'
      }

      aiActionMetadata = {
        source: INSTANT_LEAD_RESPONSE_SOURCE,
        confidence: ilr.confidence,
        needs_human_review: ilr.needsHumanReview,
        fallback_used: ilr.fallbackUsed,
        auto_send_enabled: settings.instantResponse.autoSendEnabled,
        auto_send_eligible: ilr.autoSendEligible,
        auto_send_min_confidence: settings.instantResponse.autoSendMinConfidence,
        suggested_next_step: ilr.suggestedNextStep,
        autopilot_mode: ilr.autopilotMode,
        unsupported_claims_count: ilr.unsupportedClaims.length,
        reasons: ilr.reasons,
        model: ilr.model,
        latency_ms: ilr.latencyMs,
      }
    } else {
      // Legacy unstructured path — kept so a venue that explicitly
      // disables the instant response stays in the old behavior.
      const aiResponse = await generateConversationReply(
        {
          name: lead.name as string,
          lead_score: qualification.score,
          urgency: qualification.urgency,
          event_date: lead.event_date as string | null,
          guest_count: lead.guest_count as number | null,
          budget: lead.budget as number | null,
        },
        {
          name: venue.name as string,
          description: venue.description as string | null,
          capacity_min: venue.capacity_min as number | null,
          capacity_max: venue.capacity_max as number | null,
          base_price: venue.base_price as number | null,
          style_tags: (venue.style_tags as string[]) ?? [],
          ai_persona_name: venue.ai_persona_name as string,
          ai_tone: venue.ai_tone as string,
        },
        [],
        kb,
        true,
        requestId
      )
      aiMessageText = aiResponse.message
      aiMessageMetadata = {
        tokens_used: aiResponse.tokens_used,
        latency_ms: aiResponse.latency_ms,
      }
      tokensUsedForAudit = aiResponse.tokens_used
      aiActionForAudit = 'handle_new_lead.legacy_path'
      aiActionMetadata = { reason: 'instant_response_disabled_by_venue_setting' }
    }

    await supabase.from('messages').insert({
      conversation_id: conversation.id,
      lead_id: leadId,
      venue_id: venueId,
      role: 'ai',
      content: aiMessageText,
      metadata: aiMessageMetadata,
    })

    // Update conversation last_message_at
    await supabase.from('conversations').update({ last_message_at: new Date().toISOString() }).eq('id', conversation.id)

    // Per-call ai_actions audit row. Distinct from the orchestrator
    // success row at the bottom — this captures the response-
    // generation step specifically so the dashboard's AI activity
    // feed can render an "instant response drafted" event regardless
    // of follow-up scheduling outcome.
    void logAction(supabase, {
      venue_id: venueId,
      lead_id: leadId,
      agent: 'instant_lead_response',
      action: aiActionForAudit,
      input_summary: `Lead: ${lead.name}`,
      output_summary: aiMessageText.slice(0, 240),
      latency_ms: Date.now() - start,
      tokens_used: tokensUsedForAudit,
      success: true,
      metadata: aiActionMetadata,
    })

    // 4. Schedule follow-up sequence (5 touches)
    const followUps = FOLLOW_UP_DELAYS_MINUTES.map((_, i) => ({
      lead_id: leadId,
      venue_id: venueId,
      touch_number: i + 1,
      scheduled_at: getFollowUpScheduledAt(i + 1).toISOString(),
      status: 'pending' as const,
    }))
    await supabase.from('follow_up_schedules').insert(followUps)

    // 5. Log success
    await logAction(supabase, {
      venue_id: venueId,
      lead_id: leadId,
      agent: 'orchestrator',
      action: 'handle_new_lead',
      input_summary: `Lead: ${lead.name}, source: ${lead.source}`,
      output_summary: `Score: ${qualification.score}, qualified: ${qualification.is_qualified}`,
      latency_ms: Date.now() - start,
      tokens_used: tokensUsedForAudit,
      success: true,
    })

    return { success: true, qualification, conversationId: conversation.id }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    await logAction(supabase, {
      venue_id: venueId,
      lead_id: leadId,
      agent: 'orchestrator',
      action: 'handle_new_lead',
      success: false,
      error_message: message,
      latency_ms: Date.now() - start,
    })
    captureAiError('orchestrator.handle_new_lead', err, { leadId, venueId })
    throw err
  }
}

export async function handleIncomingMessage(
  conversationId: string,
  leadMessage: string
) {
  const supabase = createServiceClient()

  // Fetch conversation, lead, venue, messages
  const convRes = await supabase.from('conversations').select('*').eq('id', conversationId).single()
  const conv = convRes.data as Record<string, unknown> | null
  if (!conv) throw new Error('Conversation not found')

  const leadId = conv.lead_id as string
  const venueId = conv.venue_id as string

  // Check if AI is still active for this lead
  const leadRes = await supabase.from('leads').select('*').eq('id', leadId).single()
  const lead = leadRes.data as Record<string, unknown> | null
  if (!lead || !lead.ai_active) return { skipped: true, reason: 'AI paused for this lead' }

  const [venueRes, messagesRes, kbRes] = await Promise.all([
    supabase.from('venues').select('*').eq('id', venueId).single(),
    supabase.from('messages').select('*').eq('conversation_id', conversationId).order('created_at').limit(20),
    supabase.from('knowledge_base').select('*').eq('venue_id', venueId).eq('is_active', true).order('priority', { ascending: false }).limit(10),
  ])

  const venue = venueRes.data as Record<string, unknown> | null
  const messages = (messagesRes.data ?? []) as { role: string; content: string }[]
  const kb = (kbRes.data ?? []) as { category: string; title: string; content: string }[]
  if (!venue) throw new Error('Venue not found')

  // ── Phase 8BK — detect selected tour slot BEFORE saving the lead
  //    message so we can stamp the selection result onto the message
  //    metadata. We look up the most recent AI message that offered
  //    slots (Phase 8BJ stamps `offered_tour_slots` into the AI
  //    message metadata when slots are surfaced) and run the
  //    deterministic detector against the lead's latest reply.
  //
  //    If detected, the lead message lands with
  //    `metadata.tour_slot_selection` set, which the LeadDetailDrawer
  //    panel reads to surface a "Create tour" affordance.
  //
  //    Best-effort: any failure here degrades to "no selection" — the
  //    lead message is still saved and the AI reply still runs.
  type RecentAiMessageRow = {
    id: string
    metadata: Record<string, unknown> | null
  }
  let detectedSelection: ReturnType<typeof detectTourSlotSelection> | null =
    null
  let matchedFromMessageId: string | null = null
  try {
    const { data: recentAiRows } = await supabase
      .from('messages')
      .select('id, metadata')
      .eq('conversation_id', conversationId)
      .eq('role', 'ai')
      .order('created_at', { ascending: false })
      .limit(3)
    for (const row of (recentAiRows ?? []) as RecentAiMessageRow[]) {
      const raw = row?.metadata?.['offered_tour_slots']
      if (!Array.isArray(raw) || raw.length === 0) continue
      const slots = (raw as Array<Record<string, unknown>>)
        .filter(
          (s) =>
            typeof s?.['starts_at'] === 'string' &&
            typeof s?.['ends_at'] === 'string' &&
            typeof s?.['label'] === 'string'
        )
        .map(
          (s) =>
            ({
              starts_at: s['starts_at'] as string,
              ends_at: s['ends_at'] as string,
              label: s['label'] as string,
              rationale: (s['rationale'] as string | undefined) ?? null,
            }) satisfies OfferedTourSlot
        )
      if (slots.length === 0) continue
      detectedSelection = detectTourSlotSelection({
        leadMessage,
        offeredSlots: slots,
      })
      matchedFromMessageId = row.id
      break
    }
  } catch (err) {
    log.warn({ err, conversationId }, 'orchestrator.slot_selection_lookup_failed')
  }

  // Save incoming message (with slot-selection metadata when detected)
  const leadMessageMetadata: Record<string, unknown> = {}
  if (detectedSelection && detectedSelection.selected && detectedSelection.selectedSlot) {
    leadMessageMetadata.tour_slot_selection = {
      selected: true,
      starts_at: detectedSelection.selectedSlot.startsAt,
      ends_at: detectedSelection.selectedSlot.endsAt,
      label: detectedSelection.selectedSlot.label,
      confidence: detectedSelection.confidence,
      match_reason: detectedSelection.selectedSlot.matchReason,
      matched_from_message_id: matchedFromMessageId,
    }
  }
  await supabase.from('messages').insert({
    conversation_id: conversationId,
    lead_id: leadId,
    venue_id: venueId,
    role: 'lead',
    content: leadMessage,
    metadata:
      Object.keys(leadMessageMetadata).length > 0 ? leadMessageMetadata : null,
  })

  // ── Phase 8BJ — tour availability + contact-info context ──────────
  //
  // Two structured blocks fed into the conversation prompt:
  //
  //   1. TOUR_AVAILABILITY_CONTEXT — built from scheduling-intent
  //      detection + the venue's `tour_availability`, existing
  //      `tours`, and `tour_blackouts`. Fixes the "I don't have
  //      access to the calendar" bug where the AI claimed no
  //      calendar access even when the venue had availability
  //      windows saved.
  //
  //   2. KNOWN_CONTACT — derived from the lead row's email/phone
  //      columns + the latest inbound message + recent transcript.
  //      Stops the AI from re-asking for contact info the lead
  //      already shared.
  //
  // Both are best-effort. A failure inside either path falls back
  // to "no extra context" so the reply is never blocked.
  const recentLeadMessages = messages.map((m) => ({
    role: m.role,
    content: m.content,
  }))
  const contactSignals = getKnownContactSignals({
    leadEmail: (lead.email as string | null) ?? null,
    leadPhone: (lead.phone as string | null) ?? null,
    latestMessage: leadMessage,
    recentMessages: recentLeadMessages,
  })

  // Patch the lead row with anything the lead just typed when those
  // columns are still null. Safe: we only ever fill null → value,
  // never overwrite an existing value. Wrapped so the AI reply
  // continues even if the update fails.
  const justExtracted = contactSignals.extractedFromMessage
  const leadUpdatePatch: Record<string, string> = {}
  if (!lead.email && justExtracted.email) leadUpdatePatch.email = justExtracted.email
  if (!lead.phone && justExtracted.phone) leadUpdatePatch.phone = justExtracted.phone
  if (Object.keys(leadUpdatePatch).length > 0) {
    try {
      await supabase.from('leads').update(leadUpdatePatch).eq('id', leadId)
    } catch (err) {
      log.warn(
        { err, leadId, fields: Object.keys(leadUpdatePatch) },
        'orchestrator.handle_incoming.contact_patch_failed'
      )
    }
  }

  // Availability context is async (DB reads) and never throws —
  // returns the safe "fetch_failed" / "no_availability" branch
  // when something goes wrong.
  const tourCtx = await buildTourAvailabilityContext({
    supabase,
    venue: {
      id: venueId,
      timezone: (venue.timezone as string | null) ?? null,
      metadata: venue.metadata,
    },
    lead: {
      id: leadId,
      event_date: (lead.event_date as string | null) ?? null,
    },
    latestUserMessage: leadMessage,
  })

  // Phase 8BK — when the deterministic detector caught a slot
  // selection in the lead's latest reply, surface it to the agent
  // so the reply acknowledges the picked time (without claiming
  // the tour is "confirmed" — see prompt rules in conversation.ts).
  const slotSelectionBlock =
    detectedSelection && detectedSelection.selected && detectedSelection.selectedSlot
      ? renderSlotSelectionPromptBlock(detectedSelection)
      : detectedSelection &&
          !detectedSelection.selected &&
          detectedSelection.confidence === 'low'
        ? renderAmbiguousSlotSelectionPromptBlock()
        : ''

  const extraContextBlocks = [
    renderTourAvailabilityPromptBlock(tourCtx),
    renderContactSignalsPromptBlock(contactSignals),
    slotSelectionBlock,
  ].filter((block) => block.length > 0)

  // Generate AI response
  const aiResponse = await generateConversationReply(
    {
      name: lead.name as string,
      lead_score: lead.lead_score as number,
      urgency: lead.urgency as string,
      event_date: lead.event_date as string | null,
      guest_count: lead.guest_count as number | null,
      budget: lead.budget as number | null,
    },
    {
      name: venue.name as string,
      description: venue.description as string | null,
      capacity_min: venue.capacity_min as number | null,
      capacity_max: venue.capacity_max as number | null,
      base_price: venue.base_price as number | null,
      style_tags: (venue.style_tags as string[]) ?? [],
      ai_persona_name: venue.ai_persona_name as string,
      ai_tone: venue.ai_tone as string,
    },
    [...messages, { role: 'lead', content: leadMessage }] as { role: 'lead' | 'ai' | 'human' | 'system'; content: string }[],
    kb,
    false,
    undefined,
    extraContextBlocks
  )

  // Save AI response
  // Phase 8BJ — stamp scheduling context + contact signals into the
  // message metadata so the dashboard can render a small "Tour
  // availability context used · N slots" debug chip on the AI draft.
  // Phase 8BK — when the reply offered concrete slots, also persist
  // the structured slot list so the NEXT inbound lead message can
  // detect selection against it (LeadDetailDrawer's "Tour time
  // selected" panel reads this off the prior AI message's metadata).
  const aiOfferedSlots =
    tourCtx.schedulingIntent.wantsTourAvailability &&
    tourCtx.suggestedSlots.length > 0
      ? tourCtx.suggestedSlots.map((s) => ({
          starts_at: s.startsAt,
          ends_at: s.endsAt,
          label: s.label,
          rationale: s.rationale,
        }))
      : null
  await supabase.from('messages').insert({
    conversation_id: conversationId,
    lead_id: leadId,
    venue_id: venueId,
    role: 'ai',
    content: aiResponse.message,
    metadata: {
      tokens_used: aiResponse.tokens_used,
      latency_ms: aiResponse.latency_ms,
      scheduling_intent: tourCtx.schedulingIntent.wantsTourAvailability
        ? {
            timeframe: tourCtx.schedulingIntent.timeframeLabel,
            specific_booking: tourCtx.schedulingIntent.wantsSpecificBooking,
            availability_configured: tourCtx.availabilityConfigured,
            suggested_slots_count: tourCtx.suggestedSlots.length,
            unavailable_reason: tourCtx.unavailableReason ?? null,
          }
        : null,
      offered_tour_slots: aiOfferedSlots,
      tour_availability_context_used: aiOfferedSlots !== null,
      contact_signals: {
        email_known: contactSignals.email,
        phone_known: contactSignals.phone,
        extracted_from_this_message: {
          email: !!justExtracted.email,
          phone: !!justExtracted.phone,
        },
      },
      slot_selection_ack: detectedSelection?.selected
        ? {
            label: detectedSelection.selectedSlot?.label,
            confidence: detectedSelection.confidence,
          }
        : null,
    },
  })

  // Update conversation
  await supabase.from('conversations').update({
    last_message_at: new Date().toISOString(),
    unread_count: 0,
  }).eq('id', conversationId)

  return { success: true, message: aiResponse.message }
}

export async function processPendingFollowUp(followUpId: string) {
  const supabase = createServiceClient()

  const fuRes = await supabase.from('follow_up_schedules').select('*').eq('id', followUpId).eq('status', 'pending').single()
  const fu = fuRes.data as Record<string, unknown> | null
  if (!fu) return { skipped: true }

  const [leadRes, venueRes, messagesRes] = await Promise.all([
    supabase.from('leads').select('*').eq('id', fu.lead_id).single(),
    supabase.from('venues').select('*').eq('id', fu.venue_id).single(),
    supabase.from('messages').select('role, content').eq('lead_id', fu.lead_id as string).order('created_at').limit(10),
  ])

  const lead = leadRes.data as Record<string, unknown> | null
  const venue = venueRes.data as Record<string, unknown> | null
  const messages = (messagesRes.data ?? []) as { role: string; content: string }[]
  if (!lead || !venue) return { skipped: true }

  // Don't send if lead is booked or lost
  if (['booked', 'lost'].includes(lead.stage as string)) {
    await supabase.from('follow_up_schedules').update({ status: 'cancelled' }).eq('id', followUpId)
    return { skipped: true, reason: 'Lead already booked or lost' }
  }

  const message = await generateFollowUpMessage(
    {
      id: lead.id as string,
      name: lead.name as string,
      email: lead.email as string,
      event_date: lead.event_date as string | null,
      guest_count: lead.guest_count as number | null,
      budget: lead.budget as number | null,
      lead_score: lead.lead_score as number,
    },
    { id: venue.id as string, name: venue.name as string, ai_persona_name: venue.ai_persona_name as string },
    fu.touch_number as number,
    messages
  )

  // Mark as sent with generated content
  await supabase.from('follow_up_schedules').update({
    status: 'sent',
    sent_at: new Date().toISOString(),
    subject: message.subject,
    body: message.body,
  }).eq('id', followUpId)

  return { success: true, subject: message.subject }
}

// ──────────────────────────────────────────────────────────────────────
//  Phase 8BK — slot-selection prompt rendering helpers
// ──────────────────────────────────────────────────────────────────────

function renderSlotSelectionPromptBlock(
  selection: ReturnType<typeof detectTourSlotSelection>
): string {
  if (!selection.selected || !selection.selectedSlot) return ''
  const lines: string[] = []
  lines.push('TOUR_SLOT_SELECTION:')
  lines.push(`- Lead selected: ${selection.selectedSlot.label}`)
  lines.push(`- Match confidence: ${selection.confidence}`)
  lines.push(
    `- Instruction: Acknowledge the selected time naturally. Say "I can get [time] prepared for confirmation" — do NOT say the tour is confirmed/booked/scheduled. Do NOT ask the lead to pick again.`
  )
  return lines.join('\n')
}

function renderAmbiguousSlotSelectionPromptBlock(): string {
  const lines: string[] = []
  lines.push('TOUR_SLOT_SELECTION:')
  lines.push(`- Lead's reply may be selecting a time, but it's ambiguous.`)
  lines.push(
    `- Instruction: Ask the lead to clarify which of the listed slots they meant. Reference the offered times by their labels.`
  )
  return lines.join('\n')
}
