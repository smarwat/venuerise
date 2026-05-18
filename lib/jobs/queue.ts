import 'server-only'
import { inngest, inngestConfigured } from './client'
import {
  JOB_EVENTS,
  type LeadCreatedPayload,
  type FollowUpDuePayload,
} from './events'
import { log } from '@/lib/log'

/**
 * Job enqueue abstraction.
 *
 * Production path:  events are sent to Inngest (durable, retried, observable).
 *
 * Local-dev fallback: if Inngest isn't configured, we invoke the function
 * handler directly via `setImmediate` — the request returns immediately, the
 * work runs in the same Node process. THIS ONLY WORKS WHEN A LONG-LIVED
 * NODE PROCESS HOSTS THE REQUEST (`next dev`, `next start`). It is NOT a
 * substitute for a real queue in a serverless deployment.
 *
 * Scheduled jobs (process-follow-ups, tour-reminders) have NO local fallback
 * — they only fire when Inngest is configured. See README / handoff for
 * how to invoke them manually for dev.
 */

function describeRuntime(): 'inngest' | 'local-fallback' {
  return inngestConfigured() ? 'inngest' : 'local-fallback'
}

/** Currently-active runtime (used by /api/health). */
export function getJobsRuntime(): 'inngest' | 'local-fallback' {
  return describeRuntime()
}

// ---- enqueueLeadCreated -----------------------------------------------------

export async function enqueueLeadCreated(payload: LeadCreatedPayload): Promise<void> {
  if (inngestConfigured()) {
    try {
      await inngest.send({ name: JOB_EVENTS.LEAD_CREATED, data: payload })
      log.info({ leadId: payload.lead_id, runtime: 'inngest' }, 'jobs.lead_created.enqueued')
    } catch (err) {
      log.error({ err, leadId: payload.lead_id, runtime: 'inngest' }, 'jobs.lead_created.enqueue_failed')
      throw err
    }
    return
  }

  // Local fallback — fire-and-forget on the same process.
  log.warn({ leadId: payload.lead_id, runtime: 'local-fallback' }, 'jobs.lead_created.local_fallback')
  fireLocally(async () => {
    const { runQualifyLead } = await import('./functions/qualify-lead')
    await runQualifyLead(payload)
  }, 'lead.created')
}

// ---- enqueueFollowUpDue -----------------------------------------------------

export async function enqueueFollowUpDue(payload: FollowUpDuePayload): Promise<void> {
  if (inngestConfigured()) {
    try {
      await inngest.send({ name: JOB_EVENTS.FOLLOWUP_DUE, data: payload })
      log.info({ followUpId: payload.follow_up_id, runtime: 'inngest' }, 'jobs.followup.enqueued')
    } catch (err) {
      log.error({ err, followUpId: payload.follow_up_id, runtime: 'inngest' }, 'jobs.followup.enqueue_failed')
      throw err
    }
    return
  }

  log.warn({ followUpId: payload.follow_up_id, runtime: 'local-fallback' }, 'jobs.followup.local_fallback')
  fireLocally(async () => {
    const { runProcessSingleFollowUp } = await import('./functions/process-follow-ups')
    await runProcessSingleFollowUp(payload.follow_up_id)
  }, 'followup.due')
}

// ---- Internal: fire-and-forget runner --------------------------------------

function fireLocally(work: () => Promise<unknown>, label: string) {
  // `setImmediate` ensures we return from the calling request handler before
  // the work begins. The promise rejection is caught so an unhandled rejection
  // doesn't crash the dev server.
  setImmediate(() => {
    work().catch((err) => {
      log.error({ err, label, runtime: 'local-fallback' }, 'jobs.local_runner.failed')
    })
  })
}
