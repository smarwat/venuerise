import { anthropic, MODEL } from '@/lib/anthropic'

interface Lead {
  id: string
  name: string
  email: string
  event_date: string | null
  guest_count: number | null
  budget: number | null
  lead_score: number
}

interface Venue {
  id: string
  name: string
  ai_persona_name: string
}

interface FollowUpMessage {
  subject: string
  body: string
}

// Touch schedule: +5min, +24hr, +3day, +7day, +14day (in minutes)
export const FOLLOW_UP_DELAYS_MINUTES = [5, 1440, 4320, 10080, 20160]

export function getFollowUpScheduledAt(touchNumber: number): Date {
  const delayMinutes = FOLLOW_UP_DELAYS_MINUTES[touchNumber - 1] ?? 20160
  return new Date(Date.now() + delayMinutes * 60 * 1000)
}

export async function generateFollowUpMessage(
  lead: Lead,
  venue: Venue,
  touchNumber: number,
  previousMessages: { role: string; content: string }[]
): Promise<FollowUpMessage> {
  const tones: Record<number, string> = {
    1: 'Warm intro — excited to connect, reference their specific inquiry details',
    2: 'Friendly check-in — did they get the last message? Share one compelling venue benefit',
    3: 'Value-add — mention a real testimonial or peak date availability to create gentle urgency',
    4: 'Ghost recovery — acknowledge they may be busy, offer a quick 10-min call, very low-pressure',
    5: 'Final farewell — graceful close, leave door open, wish them well on their event journey',
  }

  const tone = tones[touchNumber] ?? tones[5]
  const firstName = lead.name.split(' ')[0]

  const systemPrompt = `You are ${venue.ai_persona_name} at ${venue.name}.
Write a follow-up email (touch #${touchNumber} of 5).
Tone: ${tone}

Rules:
- Subject line: compelling, personal, under 50 chars, no emojis
- Body: 2-4 short paragraphs max, conversational, no corporate jargon
- Never mention AI or automation
- Sign off as ${venue.ai_persona_name}
- Return ONLY valid JSON: { "subject": "...", "body": "..." }`

  const context = previousMessages.length > 0
    ? `Previous conversation:\n${previousMessages.slice(-4).map((m) => `${m.role}: ${m.content}`).join('\n')}`
    : `Lead info: ${firstName}, ${lead.guest_count ?? 'N/A'} guests, event date: ${lead.event_date ?? 'TBD'}, budget: ${lead.budget ? `$${lead.budget}` : 'TBD'}`

  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 400,
    system: systemPrompt,
    messages: [{ role: 'user', content: `Write touch #${touchNumber} for lead ${firstName}.\n\n${context}` }],
  })

  const text = response.content[0].type === 'text' ? response.content[0].text : ''
  try {
    const clean = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim()
    return JSON.parse(clean) as FollowUpMessage
  } catch {
    return {
      subject: `Following up — ${venue.name}`,
      body: `Hi ${firstName},\n\nJust wanted to follow up on your inquiry. We'd love to show you around ${venue.name}.\n\nBest,\n${venue.ai_persona_name}`,
    }
  }
}
