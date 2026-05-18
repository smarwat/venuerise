import { anthropic, MODEL } from '@/lib/anthropic'
import { log } from '@/lib/log'

interface VenueContext {
  name: string
  capacity_min: number | null
  capacity_max: number | null
  base_price: number | null
  style_tags: string[]
  ai_persona_name: string
}

interface LeadContext {
  name: string
  email: string
  guest_count: number | null
  budget: number | null
  event_date: string | null
  notes: string | null
  source: string
}

export interface QualificationResult {
  score: number
  reasoning: string
  summary: string
  is_qualified: boolean
  urgency: 'low' | 'medium' | 'high' | 'critical'
  extracted: {
    guest_count?: number | null
    budget?: number | null
    event_date?: string | null
  }
}

export async function qualifyLead(
  lead: LeadContext,
  venue: VenueContext
): Promise<QualificationResult> {
  const systemPrompt = `You are an expert lead qualification AI for ${venue.name}, a wedding venue.

Score this lead 0-100 across 5 criteria:
1. Budget fit (30pts): Does their budget align with venue pricing? Base: $${venue.base_price ?? 'contact for pricing'}
2. Guest count fit (25pts): Do their guests fit? Capacity: ${venue.capacity_min ?? 'flexible'}–${venue.capacity_max ?? 'flexible'}
3. Date availability (20pts): Is their date reasonable? (Far future = good, last-minute = risky, no date = neutral)
4. Inquiry quality (15pts): Is the inquiry specific and detailed?
5. Urgency signals (10pts): Words/context suggesting they're ready to decide soon

Return ONLY valid JSON with this exact shape:
{
  "score": <0-100>,
  "reasoning": "<2-3 sentences explaining the score>",
  "summary": "<1 sentence for the venue owner>",
  "is_qualified": <true if score >= 55>,
  "urgency": "<low|medium|high|critical>",
  "extracted": {
    "guest_count": <number or null>,
    "budget": <number or null>,
    "event_date": "<YYYY-MM-DD or null>"
  }
}`

  const userMessage = `Lead Details:
Name: ${lead.name}
Email: ${lead.email}
Guest Count: ${lead.guest_count ?? 'not provided'}
Budget: ${lead.budget ? `$${lead.budget}` : 'not provided'}
Event Date: ${lead.event_date ?? 'not provided'}
Source: ${lead.source}
Message/Notes: ${lead.notes ?? 'none'}

Venue Style: ${venue.style_tags.join(', ') || 'general'}`

  const start = Date.now()
  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 500,
    system: systemPrompt,
    messages: [{ role: 'user', content: userMessage }],
  })

  const elapsed = Date.now() - start
  const text = response.content[0].type === 'text' ? response.content[0].text : ''

  try {
    // Strip possible markdown fences
    const clean = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim()
    const result = JSON.parse(clean) as QualificationResult
    log.info(
      {
        score: result.score,
        latencyMs: elapsed,
        tokens: response.usage.input_tokens + response.usage.output_tokens,
      },
      'ai.lead_qualifier.completed'
    )
    return result
  } catch {
    // Intentionally do NOT log the raw model output — it may contain echoed
    // lead PII. The job-level log line already captures lead_id + outcome.
    log.error({ textLength: text.length }, 'ai.lead_qualifier.parse_failed')
    return {
      score: 50,
      reasoning: 'Unable to parse AI response. Manual review recommended.',
      summary: 'Lead received — manual qualification needed.',
      is_qualified: false,
      urgency: 'medium',
      extracted: {},
    }
  }
}
