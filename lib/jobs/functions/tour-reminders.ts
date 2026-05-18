import 'server-only'
import { inngest } from '../client'
import { createServiceClient } from '@/lib/supabase/service'
import { generateTourReminder } from '@/lib/agents/tour-scheduler'
import { sendEmail, emailConfigured } from '@/lib/integrations/email'
import { log } from '@/lib/log'

/**
 * Scheduled tour-reminder generator + sender.
 *
 * ── DELIVERY MODEL (Phase 3) ───────────────────────────────────────────────
 * We only set `reminder_24h_sent=true` or `reminder_2h_sent=true` when an
 * actual outbound message left the building. Console-fallback (no Resend)
 * does NOT flip the flag — that would silently consume the reminder window
 * and the lead would never receive anything. Instead, we log `console-skip`
 * to ai_actions so the dashboard can show what the system would have done.
 *
 * Real Resend send → flag flipped + ai_action(success=true, action=*_sent)
 * Console fallback → flag NOT flipped + ai_action(success=false, action=*_skipped)
 * Provider error   → flag NOT flipped + ai_action(success=false, action=*_failed)
 * ──────────────────────────────────────────────────────────────────────────
 */

const BATCH_LIMIT = 50

interface ReminderResult {
  scanned24h: number
  delivered24h: number
  skipped24h: number
  failed24h: number
  scanned2h: number
  delivered2h: number
  skipped2h: number
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
  leads: { name: string; email: string | null } | null
  venues: { name: string; ai_persona_name: string } | null
}

async function processReminderBatch(
  windowFrom: Date,
  windowTo: Date,
  flagColumn: 'reminder_24h_sent' | 'reminder_2h_sent',
  hoursUntil: 24 | 2
): Promise<{ scanned: number; delivered: number; skipped: number; failed: number }> {
  const supabase = createServiceClient()

  const { data, error } = await supabase
    .from('tours')
    .select(`
      id, lead_id, venue_id, scheduled_at, reminder_24h_sent, reminder_2h_sent,
      leads:lead_id ( name, email ),
      venues:venue_id ( name, ai_persona_name )
    `)
    .eq(flagColumn, false)
    .in('status', ['scheduled', 'confirmed'])
    .gte('scheduled_at', windowFrom.toISOString())
    .lte('scheduled_at', windowTo.toISOString())
    .limit(BATCH_LIMIT)

  if (error) {
    log.error({ hoursUntil, errorMessage: error.message }, 'jobs.tour_reminders.query_failed')
    throw new Error(`Tour reminders ${hoursUntil}h query failed: ${error.message}`)
  }

  const rows = (data ?? []) as unknown as TourRow[]
  let delivered = 0
  let skipped = 0
  let failed = 0

  for (const tour of rows) {
    if (!tour.leads || !tour.venues) {
      log.warn({ hoursUntil, tourId: tour.id }, 'jobs.tour_reminders.orphan_tour')
      skipped++
      continue
    }
    if (!tour.leads.email) {
      log.warn({ hoursUntil, tourId: tour.id }, 'jobs.tour_reminders.missing_lead_email')
      await logTourAction(supabase, {
        venue_id: tour.venue_id,
        lead_id: tour.lead_id,
        action: `tour_reminder_${hoursUntil}h_skipped`,
        output_summary: 'No lead email on file',
        success: false,
        error_message: 'missing_email',
      })
      skipped++
      continue
    }

    // 1. Generate reminder text.
    let reminderText: string
    try {
      reminderText = await generateTourReminder({
        leadName: tour.leads.name,
        venueName: tour.venues.name,
        personaName: tour.venues.ai_persona_name,
        scheduledAt: tour.scheduled_at,
        hoursUntil,
      })
    } catch (err) {
      const errMessage = err instanceof Error ? err.message : String(err)
      log.error({ err, hoursUntil, tourId: tour.id }, 'jobs.tour_reminders.generation_failed')
      await logTourAction(supabase, {
        venue_id: tour.venue_id,
        lead_id: tour.lead_id,
        action: `tour_reminder_${hoursUntil}h_failed`,
        output_summary: '(generation failed)',
        success: false,
        error_message: errMessage,
      })
      failed++
      continue
    }

    // 2. Send the email. Phase 4B: sendEmail handles suppression checks,
    //    writes an outbound_messages row, and decorates with unsubscribe link.
    const sendResult = await sendEmail({
      to: tour.leads.email,
      subject: `${hoursUntil === 24 ? 'Tomorrow' : 'In 2 hours'}: your tour at ${tour.venues.name}`,
      text: reminderText,
      venueId: tour.venue_id,
      leadId: tour.lead_id,
      relatedTable: 'tours',
      relatedId: tour.id,
      metadata: {
        tour_id: tour.id,
        reminder_window: `${hoursUntil}h`,
      },
    })

    if (sendResult.delivered) {
      // 3a. Real delivery — flip the flag.
      const { error: updateErr } = await supabase
        .from('tours')
        .update({ [flagColumn]: true })
        .eq('id', tour.id)
        .eq(flagColumn, false) // optimistic concurrency

      if (updateErr) {
        log.error(
          { hoursUntil, tourId: tour.id, errorMessage: updateErr.message },
          'jobs.tour_reminders.flag_update_failed'
        )
        failed++
        continue
      }
      await logTourAction(supabase, {
        venue_id: tour.venue_id,
        lead_id: tour.lead_id,
        action: `tour_reminder_${hoursUntil}h_sent`,
        output_summary: `Delivered to ${tour.leads.email} (resend:${sendResult.messageId ?? '?'})`,
        success: true,
      })
      log.info(
        { hoursUntil, tourId: tour.id, messageId: sendResult.messageId },
        'jobs.tour_reminders.delivered'
      )
      delivered++
      continue
    }

    // 3b. Not delivered — three failure modes:
    //     (i)   suppression hit → flag NOT flipped (no real send possible)
    //     (ii)  console-fallback (dev) → flag NOT flipped, will retry next scan
    //     (iii) real provider error → flag NOT flipped, log + count failed
    if (sendResult.error?.startsWith('suppressed:')) {
      log.warn(
        { hoursUntil, tourId: tour.id, reason: sendResult.error },
        'jobs.tour_reminders.skipped_suppressed'
      )
      await logTourAction(supabase, {
        venue_id: tour.venue_id,
        lead_id: tour.lead_id,
        action: `tour_reminder_${hoursUntil}h_skipped`,
        output_summary: `Suppressed recipient ${tour.leads.email} (${sendResult.error})`,
        success: false,
        error_message: sendResult.error.slice(0, 500),
      })
      // IMPORTANT: do NOT flip the flag — but ALSO don't retry pointlessly
      // for a permanently suppressed address. We rely on the flag staying
      // false; if a venue owner unsubscribes the address by mistake the
      // dashboard surface will reveal repeated skips. A future phase can
      // add a `tours.reminder_*_status` enum to record "suppressed" once
      // and stop scanning. For now: skipped counter incremented, no flag.
      skipped++
      continue
    }

    if (sendResult.provider === 'console' && !emailConfigured()) {
      log.warn(
        { hoursUntil, tourId: tour.id, reason: 'no_resend_key' },
        'jobs.tour_reminders.console_fallback'
      )
      await logTourAction(supabase, {
        venue_id: tour.venue_id,
        lead_id: tour.lead_id,
        action: `tour_reminder_${hoursUntil}h_skipped`,
        output_summary: `console-fallback (RESEND not configured) — would have sent to ${tour.leads.email}`,
        success: false,
        error_message: 'console_fallback',
      })
      // IMPORTANT: do NOT flip the flag — the visitor receives nothing.
      // Next scan will re-attempt; once Resend is configured the reminder
      // will actually go out as long as it's still within window.
      skipped++
      continue
    }

    // 3c. Real provider error.
    await logTourAction(supabase, {
      venue_id: tour.venue_id,
      lead_id: tour.lead_id,
      action: `tour_reminder_${hoursUntil}h_failed`,
      output_summary: `Send failed to ${tour.leads.email}`,
      success: false,
      error_message: sendResult.error?.slice(0, 500) ?? 'unknown_send_error',
    })
    log.error(
      { hoursUntil, tourId: tour.id, errorMessage: sendResult.error },
      'jobs.tour_reminders.send_failed'
    )
    failed++
  }

  return { scanned: rows.length, delivered, skipped, failed }
}

async function runReminderScan(): Promise<ReminderResult> {
  const now = new Date()
  const in24h = new Date(now.getTime() + 24 * 60 * 60 * 1000)
  const in2h = new Date(now.getTime() + 2 * 60 * 60 * 1000)
  const window24hFrom = new Date(now.getTime() + 22 * 60 * 60 * 1000)

  const r24 = await processReminderBatch(window24hFrom, in24h, 'reminder_24h_sent', 24)
  const r2 = await processReminderBatch(now, in2h, 'reminder_2h_sent', 2)

  const result: ReminderResult = {
    scanned24h: r24.scanned,
    delivered24h: r24.delivered,
    skipped24h: r24.skipped,
    failed24h: r24.failed,
    scanned2h: r2.scanned,
    delivered2h: r2.delivered,
    skipped2h: r2.skipped,
    failed2h: r2.failed,
  }
  log.info(result, 'jobs.tour_reminders.scan_complete')
  return result
}

// ---- Inngest binding --------------------------------------------------------

export const tourRemindersFn = inngest.createFunction(
  {
    id: 'tour-reminders',
    name: 'Generate + send tour reminders (every 15 min)',
    retries: 1,
    triggers: [{ cron: '*/15 * * * *' }],
  },
  async () => runReminderScan()
)
