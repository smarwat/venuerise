import 'server-only'
import { inngest } from '../client'
import { createServiceClient } from '@/lib/supabase/service'
import { generateTourReminder } from '@/lib/agents/tour-scheduler'

/**
 * Scheduled tour-reminder generator.
 *
 * ── HONESTY NOTICE ─────────────────────────────────────────────────────────
 * No email/SMS provider is wired up yet. This job generates reminder TEXT
 * via the AI agent and flips the boolean columns `reminder_24h_sent` /
 * `reminder_2h_sent` to `true` so the same tour isn't processed twice.
 *
 * The column names say "sent" but at this stage that only means "reminder
 * text generated and logged to ai_actions". Until a delivery provider
 * (Resend / Twilio / Postmark) is integrated in Phase 3, the lead never
 * actually receives the reminder.
 * ──────────────────────────────────────────────────────────────────────────
 */

const BATCH_LIMIT = 50

interface ReminderResult {
  scanned24h: number
  generated24h: number
  failed24h: number
  scanned2h: number
  generated2h: number
  failed2h: number
}

async function logTourAction(supabase: ReturnType<typeof createServiceClient>, params: {
  venue_id: string
  lead_id: string | null
  action: string
  output_summary: string
  success: boolean
  error_message?: string
}) {
  await supabase.from('ai_actions').insert({
    venue_id: params.venue_id,
    lead_id: params.lead_id,
    agent: 'tour-scheduler',
    action: params.action,
    output_summary: params.output_summary,
    success: params.success,
    error_message: params.error_message,
  })
}

type TourRow = {
  id: string
  lead_id: string
  venue_id: string
  scheduled_at: string
  reminder_24h_sent: boolean
  reminder_2h_sent: boolean
  leads: { name: string } | null
  venues: { name: string; ai_persona_name: string } | null
}

async function processReminderBatch(
  windowFrom: Date,
  windowTo: Date,
  flagColumn: 'reminder_24h_sent' | 'reminder_2h_sent',
  hoursUntil: 24 | 2
): Promise<{ scanned: number; generated: number; failed: number }> {
  const supabase = createServiceClient()

  const { data, error } = await supabase
    .from('tours')
    .select(`
      id, lead_id, venue_id, scheduled_at, reminder_24h_sent, reminder_2h_sent,
      leads:lead_id ( name ),
      venues:venue_id ( name, ai_persona_name )
    `)
    .eq(flagColumn, false)
    .in('status', ['scheduled', 'confirmed'])
    .gte('scheduled_at', windowFrom.toISOString())
    .lte('scheduled_at', windowTo.toISOString())
    .limit(BATCH_LIMIT)

  if (error) {
    console.error(`[job:tour-reminders:${hoursUntil}h] query failed`, error.message)
    throw new Error(`Tour reminders ${hoursUntil}h query failed: ${error.message}`)
  }

  const rows = (data ?? []) as unknown as TourRow[]
  let generated = 0
  let failed = 0

  for (const tour of rows) {
    if (!tour.leads || !tour.venues) {
      console.warn(`[job:tour-reminders:${hoursUntil}h] orphan tour, skipping`, tour.id)
      continue
    }

    try {
      const reminderText = await generateTourReminder({
        leadName: tour.leads.name,
        venueName: tour.venues.name,
        personaName: tour.venues.ai_persona_name,
        scheduledAt: tour.scheduled_at,
        hoursUntil,
      })

      // Log to ai_actions so the venue owner has a record of the generated
      // message. Once a real delivery channel exists, append a `messages` row.
      await logTourAction(supabase, {
        venue_id: tour.venue_id,
        lead_id: tour.lead_id,
        action: `tour_reminder_${hoursUntil}h_generated`,
        output_summary: reminderText.slice(0, 400),
        success: true,
      })

      // Flip the flag so we don't re-process. Atomic update with the same
      // false condition for safety against concurrent processors.
      const { error: updateErr } = await supabase
        .from('tours')
        .update({ [flagColumn]: true })
        .eq('id', tour.id)
        .eq(flagColumn, false)

      if (updateErr) {
        console.error(`[job:tour-reminders:${hoursUntil}h] flag update failed`, {
          tour_id: tour.id,
          error: updateErr.message,
        })
        failed++
        continue
      }

      console.log(`[job:tour-reminders:${hoursUntil}h] generated (NOT delivered — no email provider yet)`, {
        tour_id: tour.id,
        lead: tour.leads.name,
      })
      generated++
    } catch (err) {
      const errMessage = err instanceof Error ? err.message : String(err)
      console.error(`[job:tour-reminders:${hoursUntil}h] generation failed`, { tour_id: tour.id, err })
      await logTourAction(supabase, {
        venue_id: tour.venue_id,
        lead_id: tour.lead_id,
        action: `tour_reminder_${hoursUntil}h_failed`,
        output_summary: '(generation failed)',
        success: false,
        error_message: errMessage,
      })
      failed++
    }
  }

  return { scanned: rows.length, generated, failed }
}

async function runReminderScan(): Promise<ReminderResult> {
  const now = new Date()
  const in24h = new Date(now.getTime() + 24 * 60 * 60 * 1000)
  const in2h = new Date(now.getTime() + 2 * 60 * 60 * 1000)

  // 24h window: tours due between now+22h and now+24h (slight overlap with
  // 2h window is harmless — the flag column ensures each fires once).
  const window24hFrom = new Date(now.getTime() + 22 * 60 * 60 * 1000)
  const r24 = await processReminderBatch(window24hFrom, in24h, 'reminder_24h_sent', 24)

  // 2h window: tours due in the next 2 hours that haven't had the 2h ping yet.
  const r2 = await processReminderBatch(now, in2h, 'reminder_2h_sent', 2)

  const result: ReminderResult = {
    scanned24h: r24.scanned,
    generated24h: r24.generated,
    failed24h: r24.failed,
    scanned2h: r2.scanned,
    generated2h: r2.generated,
    failed2h: r2.failed,
  }
  console.log('[job:tour-reminders] scan complete', result)
  return result
}

// ---- Inngest binding --------------------------------------------------------

export const tourRemindersFn = inngest.createFunction(
  {
    id: 'tour-reminders',
    name: 'Generate tour reminders (every 15 min)',
    retries: 1,
    triggers: [{ cron: '*/15 * * * *' }],
  },
  async () => runReminderScan()
)
