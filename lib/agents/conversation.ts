import { anthropic, MODEL } from '@/lib/anthropic'

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
  isFirstMessage: boolean
): Promise<ConversationResponse> {
  const kbContext = knowledgeBase
    .slice(0, 10)
    .map((kb) => `[${kb.category}] ${kb.title}: ${kb.content}`)
    .join('\n\n')

  const systemPrompt = `You are ${venue.ai_persona_name}, the event coordinator at ${venue.name}.

VENUE: ${venue.description ?? `${venue.name} is an elegant wedding venue.`}
CAPACITY: ${venue.capacity_min ?? 'flexible'}–${venue.capacity_max ?? 'flexible'} guests
PRICING: ${venue.base_price ? `Starting from $${venue.base_price}` : 'Contact for pricing'}
STYLE: ${venue.style_tags.join(', ') || 'timeless elegance'}

KNOWLEDGE BASE:
${kbContext || 'No specific FAQs loaded yet.'}

RESPONSE RULES — follow exactly:
• Never mention you are AI, a bot, or automated
• Warm, personal tone — like a trusted friend who happens to be a venue expert
• ${isFirstMessage ? 'First reply: 3-5 sentences. Acknowledge their specific details. End with exactly ONE clear question.' : '2-4 sentences. Continue naturally. End with ONE clear next step.'}
• Never hard-quote prices — say "starting from" or "let's discuss your specific needs"
• Never mention competitors
• If they ask about booking → invite them for a tour first
• Always address them by first name
• Build rapport → confirm fit → create gentle urgency → schedule tour

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

  const start = Date.now()
  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 300,
    system: systemPrompt,
    messages: messages.length > 0 ? messages : [
      { role: 'user', content: `Hi, I'm interested in ${venue.name} for my event.` }
    ],
  })

  const elapsed = Date.now() - start
  const text = response.content[0].type === 'text' ? response.content[0].text : ''

  return {
    message: text.trim(),
    tokens_used: response.usage.input_tokens + response.usage.output_tokens,
    latency_ms: elapsed,
  }
}
