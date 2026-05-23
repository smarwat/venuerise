import { anthropic, MODEL } from '@/lib/anthropic'
import { withAnthropicRetry } from '@/lib/anthropic-retry'

interface Message {
  role: 'lead' | 'ai' | 'human' | 'system'
  content: string
}

interface VenueContext {
  name: string
  description: string | null
  capacity_min: number | null
  capacity_max: number | null
  base_price: number | null
  style_tags: string[]
  ai_persona_name: string
  ai_tone: string
}

interface LeadContext {
  name: string
  lead_score: number
  urgency: string
  event_date: string | null
  guest_count: number | null
  budget: number | null
}

interface KnowledgeBaseEntry {
  category: string
  title: string
  content: string
}

export interface ConversationResponse {
  message: string
  tokens_used: number
  latency_ms: number
}

export async function generateConversationReply(
  lead: LeadContext,
  venue: VenueContext,
  conversationHistory: Message[],
  knowledgeBase: KnowledgeBaseEntry[],
  isFirstMessage: boolean,
  requestId?: string,
  /**
   * Phase 8BJ — optional structured context blocks the
   * orchestrator builds before the model call. Currently:
   *   - tour availability + scheduling intent
   *   - known contact info (so the AI doesn't re-ask for email
   *     or phone the lead already provided)
   *
   * Each entry is a pre-rendered block (see
   * `renderTourAvailabilityPromptBlock` +
   * `renderContactSignalsPromptBlock`). When empty, the prompt
   * behaves exactly as before — no behavior change for callers
   * that don't pass extra context.
   */
  extraContextBlocks: ReadonlyArray<string> = []
): Promise<ConversationResponse> {
  const kbContext = knowledgeBase
    .slice(0, 10)
    .map((kb) => `[${kb.category}] ${kb.title}: ${kb.content}`)
    .join('\n\n')

  // Phase 8BJ — inject structured context blocks (tour
  // availability + known contact info) when the orchestrator
  // provided them. Empty array = no behavior change.
  const extraContextSection =
    extraContextBlocks.length > 0
      ? `\n\n${extraContextBlocks.filter((b) => b && b.trim().length > 0).join('\n\n')}`
      : ''

  const systemPrompt = `You are ${venue.ai_persona_name}, the event coordinator at ${venue.name}.

VENUE: ${venue.description ?? `${venue.name} is an elegant wedding venue.`}
CAPACITY: ${venue.capacity_min ?? 'flexible'}–${venue.capacity_max ?? 'flexible'} guests
PRICING: ${venue.base_price ? `Starting from $${venue.base_price}` : 'Contact for pricing'}
STYLE: ${venue.style_tags.join(', ') || 'timeless elegance'}

KNOWLEDGE BASE:
${kbContext || 'No specific FAQs loaded yet.'}${extraContextSection}

RESPONSE RULES — follow exactly:
• Never mention you are AI, a bot, or automated
• Warm, personal tone — like a trusted friend who happens to be a venue expert
• ${isFirstMessage ? 'First reply: 3-5 sentences. Acknowledge their specific details. End with exactly ONE clear question.' : '2-4 sentences. Continue naturally. End with ONE clear next step.'}
• Never hard-quote prices — say "starting from" or "let's discuss your specific needs"
• Never mention competitors
• If they ask about booking → invite them for a tour first
• Always address them by first name
• Build rapport → confirm fit → create gentle urgency → schedule tour

TOUR SCHEDULING RULES (Phase 8BJ + 8BL):
• If a TOUR_AVAILABILITY_CONTEXT block is present and lists suggested slots, offer those specific slots directly. Phrase it as "I have these tour openings available…" and ask the lead to pick one.
• NEVER say "I don't have access to the calendar" or "I can't see the calendar" or anything similar — when slots are provided, use them.
• If TOUR_AVAILABILITY_CONTEXT says "Availability configured: no" — say the team will confirm available tour times manually. Do NOT invent times. Still do NOT say you lack calendar access; we just don't have availability windows configured yet.
• If TOUR_AVAILABILITY_CONTEXT says "No open windows found" — say you'll check with the team for the nearest openings. Do NOT invent times.
• Do NOT say a tour is "confirmed" or "booked" or "scheduled" unless the system explicitly tells you so. Phrase it as "I can get that time prepared for confirmation."

TOUR CONFIRMATION LINK RULES (Phase 8BL):
• When a TOUR_AVAILABILITY_CONTEXT slot line includes "Confirm: <url>", you MUST include that exact URL on its own line beneath the slot's label. Format the slot like: "Tue, May 26 · 11:00 AM — confirm: <url>" or as a short bulleted list. Never paraphrase, shorten, or invent these URLs. If you can't include the URL verbatim, omit the slot entirely and offer the lead to reply with the time instead.
• Never claim the tour is "confirmed," "booked," or "scheduled" just because you sent the link. The tour only exists after the lead clicks the link and the system creates the record. Phrase it as: "Tap a time and you'll get a confirmation page on the next screen."
• If the TOUR_AVAILABILITY_CONTEXT block has no Confirm URLs (the prompt fell back to the no-URL wording), do NOT invent any. Offer the times in plain text and say the team will follow up to confirm.

TOUR SLOT SELECTION RULES (Phase 8BK):
• If a TOUR_SLOT_SELECTION block says the lead selected a specific time, acknowledge that time directly and warmly. Use the exact label from the block.
• Phrase it as: "Great — I can get [time] prepared for confirmation" or "Perfect — [time] works. We'll get that prepared for confirmation and follow up with details."
• Do NOT ask the lead to pick again when a selection was detected.
• Do NOT say the tour is "confirmed" / "booked" / "scheduled" — the operator still has to create the tour record. The right framing is "prepared for confirmation."
• If TOUR_SLOT_SELECTION says the reply is ambiguous, ask the lead to clarify by referencing the offered times: "I want to make sure I pick the right time — did you mean Tuesday at 11:00 AM or Thursday at 2:00 PM?"

CONTACT INFO RULES (Phase 8BJ):
• If a KNOWN_CONTACT block says email is "present", do NOT ask the lead for their email.
• If KNOWN_CONTACT says phone is "present", do NOT ask the lead for their phone.
• Never re-ask for contact info we already have.

LEAD INTEL (use subtly, don't repeat back mechanically):
- Name: ${lead.name.split(' ')[0]}
- Score: ${lead.lead_score}/100 | Urgency: ${lead.urgency}
- Event date: ${lead.event_date ?? 'not specified'}
- Guest count: ${lead.guest_count ?? 'not specified'}
- Budget: ${lead.budget ? `$${lead.budget}` : 'not specified'}`

  const messages = conversationHistory
    .filter((m) => m.role === 'lead' || m.role === 'ai')
    .map((m) => ({
      role: m.role === 'lead' ? 'user' as const : 'assistant' as const,
      content: m.content,
    }))

  // Wall-clock latency around the wrapper (includes any retry/backoff time).
  // The wrapper additionally logs per-attempt latency.
  const start = Date.now()
  const response = await withAnthropicRetry(
    (signal) =>
      anthropic.messages.create(
        {
          model: MODEL,
          max_tokens: 300,
          system: systemPrompt,
          messages: messages.length > 0 ? messages : [
            { role: 'user', content: `Hi, I'm interested in ${venue.name} for my event.` }
          ],
        },
        { signal }
      ),
    { agent: 'conversation', requestId, model: MODEL }
  )

  const elapsed = Date.now() - start
  const text = response.content[0].type === 'text' ? response.content[0].text : ''

  return {
    message: text.trim(),
    tokens_used: response.usage.input_tokens + response.usage.output_tokens,
    latency_ms: elapsed,
  }
}
