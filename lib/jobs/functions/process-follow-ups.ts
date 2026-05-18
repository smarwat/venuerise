import 'server-only'
import { inngest } from '../client'
import { JOB_EVENTS, type FollowUpDuePayload } from '../events'
import { createServiceClient } from '@/lib/supabase/service'
import { generateFollowUpMessage } from '@/lib/agents/followup'

/**
 * Scheduled follow-up processor.
 *
 * ── HONESTY NOTICE ─────────────────────────────────────────────────────────
 * There is NO email/SMS provider wired up yet (no Resend, no Twilio, etc.).
 * This job ONLY generates the follow-up subject/body via the AI agent and
 * persists it to the `follow_up_schedules` row. Nothing is delivered to the
 * lead's inbox. Phase 3 must wire an actual delivery channel.
 *
 * The DB schema's `status` column accepts only: `pending | sent | cancelled`
 * (per migration 001). We use:
 *   - `pending`   → not yet processed
 *   - `sent`      → AI text generated AND persisted to subject/body fields.
 *                   *NOT* delivered — interpret strictly as "ready to be sent".
 *   - `cancelled` → lead ineligible (booked/lost/AI-paused) OR generation
 *                   failed irrecoverably after retries.
 * If we ever add a real `failed` or `generated` status, update this comment
 * and the logic below. For now, every status flip below is faithful to
 * what actually happened.
 * ──────────────────────────────────────────────────────────────────────────
 */

const BATCH_LIMIT = 25

interface ProcessResult {
  processed: number
  generated: number
  skipped: number
  failed: number
}

/**
 * Process a single follow-up row by id. Shared by the scheduled batch
 * function and the per-row `followup.due` event handler (used by local
 * fallback in queue.ts).
 *
 * Returns one of `generated | skipped | failed`. `failed` represents a
 * transient failure — Inngest can retry. Persistent failures should be
 * marked `cancelled` by the caller after exhausting retries.
 */
export async function runProcessSingleFollowUp(
  followUpId: string
): Promise<'generated' | 'skipped' | 'failed'> {
  const supabase = createServiceClient()

  // 1. Re-fetch row to ensure status is still pending (defensive against
  //    concurrent processors).
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
    status: 'pending' | 'sent' | 'cancelled'
  }

  if (fu.status !== 'pending') {
    return 'skipped'
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

  // 3. Eligibility gates.
  const leadStage = lead.stage as string
  const aiActive = lead.ai_active as boolean
  if (leadStage === 'booked' || leadStage === 'lost' || !aiActive) {
    console.log('[job:follow-up] lead ineligible, cancelling', {
      followUpId,
      stage: leadStage,
      aiActive,
    })
    await supabase.from('follow_up_schedules').update({ status: 'cancelled' }).eq('id', followUpId)
    return 'skipped'
  }

  // 4. Generate message text.
  try {
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
      {
        id: venue.id as string,
        name: venue.name as string,
        ai_persona_name: venue.ai_persona_name as string,
      },
      fu.touch_number,
      history
    )

    // 5. Persist generated text + flip to `sent`. NOTE: "sent" here means
    //    "AI text generated and stored" — NOT delivered. See top comment.
    const { error: updateErr } = await supabase
      .from('follow_up_schedules')
      .update({
        status: 'sent',
        sent_at: new Date().toISOString(),
        subject: message.subject,
        body: message.body,
      })
      .eq('id', followUpId)
      .eq('status', 'pending') // optimistic concurrency guard

    if (updateErr) {
      console.error('[job:follow-up] persist failed', { followUpId, error: updateErr.message })
      return 'failed'
    }

    console.log('[job:follow-up] generated (NOT delivered — no email provider yet)', {
      followUpId,
      touch: fu.touch_number,
      lead: lead.name,
      subject: message.subject,
    })
    return 'generated'
  } catch (err) {
    console.error('[job:follow-up] generation failed', { followUpId, error: err })
    return 'failed' // caller (Inngest retry policy) decides whether to cancel.
  }
}

/**
 * Batch scheduler — runs every 5 minutes via Inngest cron.
 * Local dev: this never fires unless you point your Inngest Dev Server
 * at /api/inngest. Document this loudly in the handoff.
 */
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
  const result: ProcessResult = { processed: 0, generated: 0, skipped: 0, failed: 0 }

  for (const row of rows) {
    result.processed++
    try {
      const outcome = await runProcessSingleFollowUp(row.id)
      if (outcome === 'generated') result.generated++
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

/** Cron — every 5 minutes. */
export const processFollowUpsCronFn = inngest.createFunction(
  {
    id: 'process-follow-ups-cron',
    name: 'Scan pending follow-ups (every 5 min)',
    retries: 1,
    triggers: [{ cron: '*/5 * * * *' }],
  },
  async () => runScheduledBatch()
)

/** Per-row event — used by the local fallback path in queue.ts. */
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
