import { createServiceClient } from '@/lib/supabase/service'
import { qualifyLead } from './lead-qualifier'
import { generateConversationReply } from './conversation'
import { generateFollowUpMessage, getFollowUpScheduledAt, FOLLOW_UP_DELAYS_MINUTES } from './followup'
import { log } from '@/lib/log'

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
}) {
  await supabase.from('ai_actions').insert(params)
}

export async function handleNewLead(
  leadId: string,
  venueId: string,
  /** Optional: reuse a conversation pre-created by the caller (e.g. widget). */
  existingConversationId?: string | null
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
      }
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

    // Generate and save AI first response
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
      true
    )

    await supabase.from('messages').insert({
      conversation_id: conversation.id,
      lead_id: leadId,
      venue_id: venueId,
      role: 'ai',
      content: aiResponse.message,
      metadata: { tokens_used: aiResponse.tokens_used, latency_ms: aiResponse.latency_ms },
    })

    // Update conversation last_message_at
    await supabase.from('conversations').update({ last_message_at: new Date().toISOString() }).eq('id', conversation.id)

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
      tokens_used: aiResponse.tokens_used,
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

  // Save incoming message
  await supabase.from('messages').insert({
    conversation_id: conversationId,
    lead_id: leadId,
    venue_id: venueId,
    role: 'lead',
    content: leadMessage,
  })

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
    false
  )

  // Save AI response
  await supabase.from('messages').insert({
    conversation_id: conversationId,
    lead_id: leadId,
    venue_id: venueId,
    role: 'ai',
    content: aiResponse.message,
    metadata: { tokens_used: aiResponse.tokens_used, latency_ms: aiResponse.latency_ms },
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
