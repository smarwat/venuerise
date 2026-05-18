import 'server-only'
import { inngest } from '../client'
import { JOB_EVENTS, type LeadCreatedPayload } from '../events'
import { createServiceClient } from '@/lib/supabase/service'
import { handleNewLead } from '@/lib/agents/orchestrator'

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
  const { lead_id, conversation_id } = payload
  const supabase = createServiceClient()

  // 1. Look up the lead (service-role — RLS bypassed inside the worker).
  const { data: leadRow, error: leadErr } = await supabase
    .from('leads')
    .select('id, venue_id, name')
    .eq('id', lead_id)
    .maybeSingle()

  if (leadErr) {
    console.error('[job:qualify-lead] lead lookup failed', { lead_id, error: leadErr.message })
    throw new Error(`Lead lookup failed: ${leadErr.message}`)
  }
  if (!leadRow) {
    console.warn('[job:qualify-lead] lead not found, skipping', { lead_id })
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
    console.error('[job:qualify-lead] venue lookup failed', { venue_id: lead.venue_id, error: venueErr.message })
    throw new Error(`Venue lookup failed: ${venueErr.message}`)
  }
  if (!venueRow) {
    console.warn('[job:qualify-lead] venue not found, skipping', { venue_id: lead.venue_id })
    return { status: 'skipped', reason: 'venue_not_found' }
  }
  const venue = venueRow as { id: string; is_active: boolean }
  if (!venue.is_active) {
    console.warn('[job:qualify-lead] venue inactive, skipping', { venue_id: lead.venue_id })
    return { status: 'skipped', reason: 'venue_inactive' }
  }

  // 3. Hand off to the orchestrator. It's idempotent: a second run for the
  //    same conversation will exit early and not call Anthropic again.
  const result = await handleNewLead(lead.id, venue.id, conversation_id ?? null)

  if ((result as { skipped?: boolean }).skipped) {
    return { status: 'skipped', reason: 'already_processed' }
  }

  console.log('[job:qualify-lead] completed', { lead_id, lead_name: lead.name })
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
    return runQualifyLead(event.data as LeadCreatedPayload)
  }
)
