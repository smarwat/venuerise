import 'server-only'
import { inngest } from '../client'
import { JOB_EVENTS, type FollowUpDuePayload } from '../events'
import { createServiceClient } from '@/lib/supabase/service'
import { generateFollowUpMessage } from '@/lib/agents/followup'
import { sendEmail, emailConfigured } from '@/lib/integrations/email'

/**
 * Scheduled follow-up processor.
 *
 * ── DELIVERY MODEL (Phase 3) ───────────────────────────────────────────────
 * After Phase 3, status flips actually reflect what happened:
 *
 *   pending    → not yet processed
 *   sent       → AI text generated AND Resend accepted the email.
 *                delivery_provider='resend' and delivery_message_id populated.
 *   skipped    → eligibility gate: lead booked/lost/AI-paused/missing email,
 *                OR console-fallback (dev mode w/o RESEND_API_KEY).
 *                delivery_provider='console' if we generated but did not deliver.
 *   failed     → Resend rejected the send. delivery_error populated.
 *                Inngest will retry up to the function's retry policy; if all
 *                retries exhaust we leave 'failed' so a human can investigate.
 *   cancelled  → reserved for operator intervention (no automatic flips today)
 * ──────────────────────────────────────────────────────────────────────────
 */

const BATCH_LIMIT = 25

interface ProcessResult {
  processed: number
  sent: number
  skipped: number
  failed: number
}

/**
 * Process a single follow-up row by id. Returns the outcome label used by
 * the batch caller for telemetry. Always writes a terminal status to the
 * row (sent | skipped | failed); never leaves it pending unless a transient
 * lookup failure happened (in which case caller decides whether to retry).
 */
export async function runProcessSingleFollowUp(
  followUpId: string
): Promise<'sent' | 'skipped' | 'failed'> {
  const supabase = createServiceClient()

  // 1. Re-fetch row — defensive against concurrent processors.
  const { data: fuRow, error: fuErr } = await supabase
    .from('follow_up_schedules')
    .select('id, lead_id, venue_id, touch_number, status')
    .eq('id', followUpId)
    .maybeSingle()

  if (fuErr) {
    console.error('[job:follow-up] fetch failed', { followUpId, error: fuErr.message })
    return 'failed'
  }
  if (!fuRow) {
    console.warn('[job:follow-up] row vanished', { followUpId })
    return 'skipped'
  }
  const fu = fuRow as {
    id: string
    lead_id: string
    venue_id: string
    touch_number: number
    status: 'pending' | 'sent' | 'failed' | 'cancelled' | 'skipped'
  }

  if (fu.status !== 'pending') {
    return 'skipped' // already processed by a concurrent runner
  }

  // 2. Pull lead + venue + last 10 messages for tone continuity.
  const [leadRes, venueRes, messagesRes] = await Promise.all([
    supabase.from('leads')
      .select('id, name, email, event_date, guest_count, budget, lead_score, stage, ai_active')
      .eq('id', fu.lead_id)
      .maybeSingle(),
    supabase.from('venues')
      .select('id, name, ai_persona_name')
      .eq('id', fu.venue_id)
      .maybeSingle(),
    supabase.from('messages')
      .select('role, content')
      .eq('lead_id', fu.lead_id)
      .order('created_at')
      .limit(10),
  ])

  const lead = leadRes.data as Record<string, unknown> | null
  const venue = venueRes.data as Record<string, unknown> | null
  const history = (messagesRes.data ?? []) as { role: string; content: string }[]

  if (!lead || !venue) {
    console.warn('[job:follow-up] lead or venue gone, cancelling', { followUpId })
    await supabase.from('follow_up_schedules').update({ status: 'cancelled' }).eq('id', followUpId)
    return 'skipped'
  }

  // 3. Eligibility gates (each writes a terminal status so we don't reprocess).
  const leadStage = lead.stage as string
  const aiActive = lead.ai_active as boolean
  const leadEmail = lead.email as string | null

  if (leadStage === 'booked' || leadStage === 'lost' || !aiActive || !leadEmail) {
    const reason = !leadEmail ? 'missing_email' : !aiActive ? 'ai_paused' : 'stage_terminal'
    console.log('[job:follow-up] ineligible, skipping', { followUpId, stage: leadStage, reason })
    await supabase
      .from('follow_up_schedules')
      .update({ status: 'skipped', delivery_error: `eligibility:${reason}` })
      .eq('id', followUpId)
      .eq('status', 'pending')
    return 'skipped'
  }

  // 4. Generate AI message text.
  let message: { subject: string; body: string }
  try {
    message = await generateFollowUpMessage(
      {
        id: lead.id as string,
        name: lead.name as string,
        email: leadEmail,
        event_date: lead.event_date as string | null,
        guest_count: lead.guest_count as number | null,
        budget: lead.budget as number | null,
        lead_score: lead.lead_score as number,
      },
      {
        id: venue.id as string,
        name: venue.name as string,
        ai_persona_name: venue.ai_persona_name as string,
      },
      fu.touch_number,
      history
    )
  } catch (err) {
    const errMessage = err instanceof Error ? err.message : String(err)
    console.error('[job:follow-up] generation failed', { followUpId, error: errMessage })
    await supabase
      .from('follow_up_schedules')
      .update({ status: 'failed', delivery_error: `generation:${errMessage}`.slice(0, 500) })
      .eq('id', followUpId)
      .eq('status', 'pending')
    return 'failed'
  }

  // 5. Send the email (or console-fallback in dev). The function NEVER lies:
  //    delivered=true only if Resend accepted; console-fallback returns false.
  //    Phase 4B: sendEmail also checks the suppression list, writes an
  //    outbound_messages row, and decorates the body with an unsubscribe link.
  const sendResult = await sendEmail({
    to: leadEmail,
    subject: message.subject,
    text: message.body,
    venueId: fu.venue_id,
    leadId: fu.lead_id,
    relatedTable: 'follow_up_schedules',
    relatedId: fu.id,
    metadata: {
      follow_up_id: fu.id,
      touch: String(fu.touch_number),
    },
  })

  // 6. Persist generated text + outcome.
  const base: Record<string, unknown> = {
    subject: message.subject,
    body: message.body,
    delivery_provider: sendResult.provider,
  }

  if (sendResult.delivered) {
    // Real delivery — flip to 'sent'.
    const { error: updateErr } = await supabase
      .from('follow_up_schedules')
      .update({
        ...base,
        status: 'sent',
        sent_at: new Date().toISOString(),
        delivered_at: new Date().toISOString(),
        delivery_message_id: sendResult.messageId ?? null,
        delivery_error: null,
      })
      .eq('id', followUpId)
      .eq('status', 'pending')

    if (updateErr) {
      console.error('[job:follow-up] persist after delivery failed', { followUpId, error: updateErr.message })
      return 'failed'
    }

    console.log('[job:follow-up] delivered via Resend', {
      followUpId,
      touch: fu.touch_number,
      to: leadEmail,
      messageId: sendResult.messageId,
    })
    return 'sent'
  }

  // 7. Not delivered — three failure modes:
  //    (a) suppression hit (bounce/complaint/manual/unsubscribe)
  //    (b) console-fallback (dev mode, no Resend keys)
  //    (c) real provider error
  if (sendResult.error?.startsWith('suppressed:')) {
    const { error: updateErr } = await supabase
      .from('follow_up_schedules')
      .update({
        ...base,
        status: 'skipped',
        delivery_error: sendResult.error.slice(0, 500),
      })
      .eq('id', followUpId)
      .eq('status', 'pending')

    if (updateErr) {
      console.error('[job:follow-up] persist after suppression failed', { followUpId, error: updateErr.message })
      return 'failed'
    }
    console.warn('[job:follow-up] skipped — recipient is on suppression list', {
      followUpId,
      to: leadEmail,
      reason: sendResult.error,
      outboundMessageId: sendResult.outboundMessageId,
    })
    return 'skipped'
  }

  if (sendResult.provider === 'console' && !emailConfigured()) {
    // Dev mode, no Resend key. Persist generated text + mark 'skipped' so we
    // do not falsely claim delivery. The text is preserved so the dashboard
    // can still show what would have been sent.
    const { error: updateErr } = await supabase
      .from('follow_up_schedules')
      .update({
        ...base,
        status: 'skipped',
        delivery_error: 'console-fallback: RESEND_API_KEY not set (no real delivery in dev)',
      })
      .eq('id', followUpId)
      .eq('status', 'pending')

    if (updateErr) {
      console.error('[job:follow-up] persist after console fallback failed', { followUpId, error: updateErr.message })
      return 'failed'
    }
    console.warn('[job:follow-up] console-fallback — NOT delivered to inbox', {
      followUpId,
      to: leadEmail,
      reason: 'no_resend_key',
    })
    return 'skipped'
  }

  // 8. Real provider error — Resend was configured but rejected.
  const { error: updateErr } = await supabase
    .from('follow_up_schedules')
    .update({
      ...base,
      status: 'failed',
      delivery_error: (sendResult.error ?? 'unknown send error').slice(0, 500),
    })
    .eq('id', followUpId)
    .eq('status', 'pending')

  if (updateErr) {
    console.error('[job:follow-up] persist after send failure failed', { followUpId, error: updateErr.message })
  }
  console.error('[job:follow-up] send failed', {
    followUpId,
    to: leadEmail,
    provider: sendResult.provider,
    error: sendResult.error,
  })
  return 'failed'
}

/** Batch scheduler — runs every 5 minutes via Inngest cron. */
async function runScheduledBatch(): Promise<ProcessResult> {
  const supabase = createServiceClient()
  const now = new Date().toISOString()

  const { data, error } = await supabase
    .from('follow_up_schedules')
    .select('id')
    .eq('status', 'pending')
    .lte('scheduled_at', now)
    .order('scheduled_at')
    .limit(BATCH_LIMIT)

  if (error) {
    console.error('[job:follow-up:batch] query failed', error.message)
    throw new Error(`Follow-up batch query failed: ${error.message}`)
  }

  const rows = (data ?? []) as { id: string }[]
  const result: ProcessResult = { processed: 0, sent: 0, skipped: 0, failed: 0 }

  for (const row of rows) {
    result.processed++
    try {
      const outcome = await runProcessSingleFollowUp(row.id)
      if (outcome === 'sent') result.sent++
      else if (outcome === 'skipped') result.skipped++
      else result.failed++
    } catch (err) {
      console.error('[job:follow-up:batch] row threw', { id: row.id, err })
      result.failed++
    }
  }

  console.log('[job:follow-up:batch] complete', result)
  return result
}

// ---- Inngest bindings -------------------------------------------------------

export const processFollowUpsCronFn = inngest.createFunction(
  {
    id: 'process-follow-ups-cron',
    name: 'Scan pending follow-ups (every 5 min)',
    retries: 1,
    triggers: [{ cron: '*/5 * * * *' }],
  },
  async () => runScheduledBatch()
)

export const processSingleFollowUpFn = inngest.createFunction(
  {
    id: 'process-single-follow-up',
    name: 'Process a single follow-up by id',
    retries: 2,
    concurrency: { limit: 10 },
    triggers: [{ event: JOB_EVENTS.FOLLOWUP_DUE }],
  },
  async ({ event }) => {
    const data = event.data as FollowUpDuePayload
    return runProcessSingleFollowUp(data.follow_up_id)
  }
)
