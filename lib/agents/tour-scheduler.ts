import { anthropic, MODEL } from '@/lib/anthropic'
import { format } from 'date-fns'

interface TourConfirmationParams {
  leadName: string
  venueName: string
  personaName: string
  scheduledAt: string
  durationMinutes: number
  locationNotes?: string | null
}

export async function generateTourConfirmation(params: TourConfirmationParams): Promise<string> {
  const { leadName, venueName, personaName, scheduledAt, durationMinutes, locationNotes } = params
  const firstName = leadName.split(' ')[0]
  const formattedDate = format(new Date(scheduledAt), "EEEE, MMMM d 'at' h:mm a")

  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 200,
    system: `You are ${personaName} at ${venueName}. Write a warm, luxury-level tour confirmation message. Under 150 words. Excited but professional tone — like a boutique hotel concierge. Include date/time and set anticipation. Sign off as ${personaName}.`,
    messages: [{
      role: 'user',
      content: `Write a tour confirmation for ${firstName}. Tour is on ${formattedDate} (${durationMinutes} minutes). ${locationNotes ? `Location note: ${locationNotes}` : ''}`,
    }],
  })

  return response.content[0].type === 'text' ? response.content[0].text.trim() : `Hi ${firstName}, we're confirmed for your tour on ${formattedDate}! See you then. — ${personaName}`
}

export async function generateTourReminder(params: {
  leadName: string
  venueName: string
  personaName: string
  scheduledAt: string
  hoursUntil: number
}): Promise<string> {
  const { leadName, venueName, personaName, scheduledAt, hoursUntil } = params
  const firstName = leadName.split(' ')[0]
  const formattedDate = format(new Date(scheduledAt), "EEEE, MMMM d 'at' h:mm a")
  const timeframe = hoursUntil <= 2 ? '2 hours' : '24 hours'

  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 150,
    system: `You are ${personaName} at ${venueName}. Write a friendly tour reminder. Under 100 words. Warm and welcoming. Sign off as ${personaName}.`,
    messages: [{
      role: 'user',
      content: `Reminder for ${firstName} — their tour at ${venueName} is in ${timeframe} (${formattedDate}).`,
    }],
  })

  return response.content[0].type === 'text' ? response.content[0].text.trim() : `Hi ${firstName}, just a reminder about your tour at ${venueName} — ${formattedDate}! Looking forward to seeing you. — ${personaName}`
}
