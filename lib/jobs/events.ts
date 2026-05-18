/**
 * Job event names + typed payloads.
 *
 * These are the only types that should leak across the queue boundary.
 * If we ever swap Inngest for Trigger.dev / Temporal / Supabase Functions,
 * these definitions stay the same — only `lib/jobs/client.ts` and
 * `lib/jobs/queue.ts` change.
 */

export const JOB_EVENTS = {
  LEAD_CREATED:        'lead.created',
  FOLLOWUP_DUE:        'followup.due',
  TOUR_REMINDERS_SCAN: 'tour.reminders.scan',
} as const

export type JobEventName = (typeof JOB_EVENTS)[keyof typeof JOB_EVENTS]

// ---- Payloads ---------------------------------------------------------------

/**
 * Optional correlation id threaded through job payloads (Phase 5B).
 * When present, job handlers pin every log line to this id so an operator can
 * trace an entire widget → qualify → email send flow with a single search.
 */
interface WithRequestId {
  request_id?: string
}

export interface LeadCreatedPayload extends WithRequestId {
  lead_id: string
  /** Optional — the widget pre-creates a conversation row and passes it in. */
  conversation_id?: string | null
}

export interface FollowUpDuePayload extends WithRequestId {
  follow_up_id: string
}

export interface TourReminderScanPayload extends WithRequestId {
  triggered_at: string
}

// ---- Discriminated event map for the Inngest client typing ------------------
//
// Inngest's `EventSchemas.fromRecord<T>()` consumes a record where each key
// is the event name and the value `{ data: Payload }`.

export type JobEventMap = {
  [JOB_EVENTS.LEAD_CREATED]:        { data: LeadCreatedPayload }
  [JOB_EVENTS.FOLLOWUP_DUE]:        { data: FollowUpDuePayload }
  [JOB_EVENTS.TOUR_REMINDERS_SCAN]: { data: TourReminderScanPayload }
}
