import 'server-only'
import { inngest } from '../client'
import { JOB_EVENTS, type LeadCreatedPayload } from '../events'
import { createServiceClient } from '@/lib/supabase/service'
import { handleNewLead } from '@/lib/agents/orchestrator'
import { log } from '@/lib/log'
import { captureJobError } from '@/lib/observability/sentry'

/**
 * Core handler — pure function the Inngest binding AND the local fallback call.
 * Kept side-effect-aware (logs only via console + ai_actions inside orchestrator).
 *
 * Re-entry safety: orchestrator already short-circuits if an AI message exists
 * for the conversation, so Inngest's retry-on-failure won't double-charge.
 */
export async function runQualifyLead(payload: LeadCreatedPayload): Promise<{
  status: 'completed' | 'skipped' | 'error'
  reason?: string
}> {
  const { lead_id, conversation_id, request_id } = payload
  const supabase = createServiceClient()
  // Pin every log line in this job to the originating request, if any.
  const jobLog = request_id ? log.child({ requestId: request_id }) : log
  jobLog.info({ leadId: lead_id, conversationId: conversation_id }, 'jobs.lead_created.started')

  // 1. Look up the lead (service-role — RLS bypassed inside the worker).
  const { data: leadRow, error: leadErr } = await supabase
    .from('leads')
    .select('id, venue_id, name')
    .eq('id', lead_id)
    .maybeSingle()

  if (leadErr) {
    jobLog.error({ leadId: lead_id, errorMessage: leadErr.message }, 'jobs.lead_created.lead_lookup_failed')
    captureJobError('qualify-lead', leadErr, { requestId: request_id, leadId: lead_id })
    throw new Error(`Lead lookup failed: ${leadErr.message}`)
  }
  if (!leadRow) {
    jobLog.warn({ leadId: lead_id }, 'jobs.lead_created.lead_not_found')
    return { status: 'skipped', reason: 'lead_not_found' }
  }
  const lead = leadRow as { id: string; venue_id: string; name: string }

  // 2. Verify venue is still active.
  const { data: venueRow, error: venueErr } = await supabase
    .from('venues')
    .select('id, is_active')
    .eq('id', lead.venue_id)
    .maybeSingle()

  if (venueErr) {
    jobLog.error(
      { leadId: lead_id, venueId: lead.venue_id, errorMessage: venueErr.message },
      'jobs.lead_created.venue_lookup_failed'
    )
    captureJobError('qualify-lead', venueErr, {
      requestId: request_id, leadId: lead_id, venueId: lead.venue_id,
    })
    throw new Error(`Venue lookup failed: ${venueErr.message}`)
  }
  if (!venueRow) {
    jobLog.warn({ leadId: lead_id, venueId: lead.venue_id }, 'jobs.lead_created.venue_not_found')
    return { status: 'skipped', reason: 'venue_not_found' }
  }
  const venue = venueRow as { id: string; is_active: boolean }
  if (!venue.is_active) {
    jobLog.warn({ leadId: lead_id, venueId: lead.venue_id }, 'jobs.lead_created.venue_inactive')
    return { status: 'skipped', reason: 'venue_inactive' }
  }

  // 3. Hand off to the orchestrator. It's idempotent: a second run for the
  //    same conversation will exit early and not call Anthropic again. The
  //    request id is threaded through so Anthropic call lines join the trace.
  const result = await handleNewLead(lead.id, venue.id, conversation_id ?? null, request_id)

  if ((result as { skipped?: boolean }).skipped) {
    jobLog.info({ leadId: lead_id, venueId: venue.id }, 'jobs.lead_created.skipped')
    return { status: 'skipped', reason: 'already_processed' }
  }

  jobLog.info({ leadId: lead_id, venueId: venue.id }, 'jobs.lead_created.completed')
  return { status: 'completed' }
}

/**
 * Inngest binding — triggered by `lead.created`.
 * Concurrency limited to keep Anthropic happy on traffic spikes.
 * 3 retries on failure (Inngest's default error policy).
 */
export const qualifyLeadFn = inngest.createFunction(
  {
    id: 'qualify-lead',
    name: 'Qualify lead after widget submission',
    retries: 3,
    concurrency: { limit: 5 },
    triggers: [{ event: JOB_EVENTS.LEAD_CREATED }],
  },
  async ({ event }) => {
    const data = event.data as LeadCreatedPayload
    try {
      return await runQualifyLead(data)
    } catch (err) {
      // Inngest also reports the throw — but Sentry gets the structured ctx.
      captureJobError('qualify-lead', err, {
        requestId: data.request_id,
        leadId: data.lead_id,
        conversationId: data.conversation_id ?? undefined,
      })
      throw err
    }
  }
)
