import type { RevenueOsSettings } from './settings'
import type { LeakageLead, LeakageTour } from './leakage'

/**
 * Phase 8AT — Tour Booking Agent scoring.
 *
 * Pure helper. No Supabase, no React, no env reads. Mirrors the
 * shape of `lib/revenue-os/leakage.ts` and `lib/revenue-os/recovery.ts`
 * so every surface that needs tour-booking signals reuses one path.
 *
 * Tour Booking is the operational bridge between qualification and
 * revenue — booked + confirmed tours are the single strongest
 * predictor of booked weddings. This helper identifies the lead /
 * tour pairs that need an operator touch RIGHT NOW.
 *
 * Like the recovery agent, this is operator-visible scoring only:
 * no autonomous sending, no autonomous scheduling, no background
 * generation. Each signal carries a static `suggestedAction` whose
 * `instruction` can be pre-filled into the regenerate prompt.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type TourBookingSignalKey =
  | 'qualified_no_tour'
  | 'tour_scheduled_unconfirmed'
  | 'tour_today'
  | 'tour_completed_no_next_step'
  | 'tour_no_show_recovery'

export type TourBookingSuggestedActionKey =
  | 'suggest_two_tour_windows'
  | 'confirm_scheduled_tour'
  | 'prepare_for_tour_today'
  | 'follow_up_after_tour'
  | 'recover_no_show'

export interface TourBookingSuggestedAction {
  key: TourBookingSuggestedActionKey
  title: string
  /** Long-form instruction the operator can drop into
   *  /api/ai/draft as the `instruction` field. */
  instruction: string
  ctaLabel: string
}

export interface TourBookingSignal {
  leadId: string
  /** Present when the signal is anchored to a specific tour row. */
  tourId?: string | null
  signal: TourBookingSignalKey
  label: string
  helper: string
  urgency: 'low' | 'medium' | 'high'
  suggestedAction: TourBookingSuggestedAction
  scheduledAt?: string | null
}

// ---------------------------------------------------------------------------
// Suggested-action catalog (static, operator-facing)
// ---------------------------------------------------------------------------

const SUGGESTED_ACTIONS: Record<
  TourBookingSuggestedActionKey,
  TourBookingSuggestedAction
> = {
  suggest_two_tour_windows: {
    key: 'suggest_two_tour_windows',
    title: 'Offer two tour windows',
    instruction:
      'Offer two specific tour windows and ask which one works better. Keep it warm, concise, and venue-concierge style. Do not quote hard prices; invite questions in person.',
    ctaLabel: 'Offer tour',
  },
  confirm_scheduled_tour: {
    key: 'confirm_scheduled_tour',
    title: 'Confirm the scheduled tour',
    instruction:
      'Confirm the scheduled tour time and make it easy for the couple to reply yes or request a different time. Include parking or arrival guidance if relevant; offer a graceful reschedule path.',
    ctaLabel: 'Confirm tour',
  },
  prepare_for_tour_today: {
    key: 'prepare_for_tour_today',
    title: 'Send same-day prep note',
    instruction:
      'Send a same-day tour preparation note that feels helpful, not pushy. Reconfirm the time, share what to expect on the property, and end with one friendly question.',
    ctaLabel: 'Prep today',
  },
  follow_up_after_tour: {
    key: 'follow_up_after_tour',
    title: 'Follow up after the tour',
    instruction:
      'Follow up after the tour by thanking them and asking what questions they still have before deciding. Suggest a specific next step — a hold on a date, a quick call, or revised package — and end with one clear question.',
    ctaLabel: 'Post-tour follow-up',
  },
  recover_no_show: {
    key: 'recover_no_show',
    title: 'Recover a no-show gently',
    instruction:
      'Recover a no-show gently and offer to reschedule without making them feel guilty. Assume life got in the way, leave the door open, and offer two alternative windows.',
    ctaLabel: 'Recover no-show',
  },
}

const SIGNAL_TO_ACTION: Record<
  TourBookingSignalKey,
  TourBookingSuggestedActionKey
> = {
  qualified_no_tour: 'suggest_two_tour_windows',
  tour_scheduled_unconfirmed: 'confirm_scheduled_tour',
  tour_today: 'prepare_for_tour_today',
  tour_completed_no_next_step: 'follow_up_after_tour',
  tour_no_show_recovery: 'recover_no_show',
}

const SIGNAL_LABEL: Record<TourBookingSignalKey, string> = {
  qualified_no_tour: 'Qualified, no tour booked',
  tour_scheduled_unconfirmed: 'Tour needs confirmation',
  tour_today: 'Tour today',
  tour_completed_no_next_step: 'Tour done, no next step',
  tour_no_show_recovery: 'No-show recovery',
}

// Priority drives both per-lead "primary" selection (when multiple
// signals stack on the same lead) AND the cross-lead sort order on
// the dashboard queue / leads-board filter.
const SIGNAL_PRIORITY: Record<TourBookingSignalKey, number> = {
  tour_today: 50,
  tour_scheduled_unconfirmed: 40,
  qualified_no_tour: 30,
  tour_completed_no_next_step: 20,
  tour_no_show_recovery: 10,
}

const SIGNAL_URGENCY: Record<TourBookingSignalKey, 'low' | 'medium' | 'high'> = {
  tour_today: 'high',
  tour_scheduled_unconfirmed: 'high',
  qualified_no_tour: 'medium',
  tour_completed_no_next_step: 'medium',
  tour_no_show_recovery: 'low',
}

// ---------------------------------------------------------------------------
// Time helpers
// ---------------------------------------------------------------------------

const MS_PER_DAY = 24 * 60 * 60 * 1000

function startOfUtcDay(d: Date): Date {
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0)
  )
}

function isSameUtcDay(a: Date, b: Date): boolean {
  return (
    a.getUTCFullYear() === b.getUTCFullYear() &&
    a.getUTCMonth() === b.getUTCMonth() &&
    a.getUTCDate() === b.getUTCDate()
  )
}

// ---------------------------------------------------------------------------
// computeTourBookingSignals
// ---------------------------------------------------------------------------

interface TourBookingInput {
  leads: ReadonlyArray<LeakageLead>
  tours: ReadonlyArray<LeakageTour>
  /** Optional — reserved for a future signal that checks for
   *  post-tour silence using outbound message data. The helper
   *  works without it today; the field is accepted so callers can
   *  pre-wire the slice. */
  messages?: ReadonlyArray<{ lead_id: string; role: string; created_at: string }>
  /** Tour Booking is loosely coupled to the venue's leakage/recovery
   *  thresholds — for now the only setting that matters is "what
   *  counts as a high-fit lead." Accepting the full settings object
   *  matches the other Revenue OS helpers' shape and gives us room
   *  to grow without breaking callers. */
  settings?: Pick<RevenueOsSettings, 'highFitThreshold'>
  now?: Date
}

/**
 * Compute the Tour Booking signal set for a venue.
 *
 * One signal per (lead, situation) pair — a lead can show up under
 * multiple signals (e.g. has a scheduled-unconfirmed tour AND
 * qualified status), so the caller is free to dedupe per-lead via
 * `primaryTourSignalForLead` if needed.
 *
 * Sort order: priority desc → urgency-tiebreak → soonest tour first.
 */
export function computeTourBookingSignals(
  input: TourBookingInput
): TourBookingSignal[] {
  const now = input.now ?? new Date()
  const todayStartMs = startOfUtcDay(now).getTime()
  const todayEndMs = todayStartMs + MS_PER_DAY

  // Lookup maps.
  const leadById = new Map<string, LeakageLead>()
  for (const lead of input.leads) leadById.set(lead.id, lead)

  const toursByLead = new Map<string, LeakageTour[]>()
  for (const t of input.tours) {
    const arr = toursByLead.get(t.lead_id) ?? []
    arr.push(t)
    toursByLead.set(t.lead_id, arr)
  }

  const results: TourBookingSignal[] = []

  // ---- 1. qualified_no_tour ----------------------------------------------
  for (const lead of input.leads) {
    if (lead.stage !== 'qualified') continue
    const tours = toursByLead.get(lead.id) ?? []
    if (tours.length > 0) continue
    results.push({
      leadId: lead.id,
      signal: 'qualified_no_tour',
      label: SIGNAL_LABEL.qualified_no_tour,
      helper:
        'This lead is qualified but has no tour scheduled. Offer two clear windows.',
      urgency: SIGNAL_URGENCY.qualified_no_tour,
      suggestedAction: SUGGESTED_ACTIONS[SIGNAL_TO_ACTION.qualified_no_tour],
    })
  }

  // ---- Per-tour signals --------------------------------------------------
  for (const tour of input.tours) {
    const lead = leadById.get(tour.lead_id)
    if (!lead) continue // surfaced lead must exist in the slice
    const scheduledAtMs = tour.scheduled_at
      ? new Date(tour.scheduled_at).getTime()
      : null
    const scheduledAt = tour.scheduled_at

    // 2. tour_today — anything (scheduled or confirmed) with a UTC
    //    day-of date equal to today.
    if (
      tour.status === 'scheduled' ||
      tour.status === 'confirmed'
    ) {
      if (
        scheduledAtMs !== null &&
        scheduledAtMs >= todayStartMs &&
        scheduledAtMs < todayEndMs
      ) {
        results.push({
          leadId: lead.id,
          tourId: tour.id,
          signal: 'tour_today',
          label: SIGNAL_LABEL.tour_today,
          helper: `Tour today. Send a same-day prep note + reconfirm the time.`,
          urgency: SIGNAL_URGENCY.tour_today,
          suggestedAction: SUGGESTED_ACTIONS[SIGNAL_TO_ACTION.tour_today],
          scheduledAt,
        })
        // tour_today supersedes the unconfirmed signal for the same
        // tour row — we don't want two cards screaming about the same
        // event.
        continue
      }
    }

    // 3. tour_scheduled_unconfirmed — future tour stuck in
    //    'scheduled' (not yet 'confirmed').
    if (
      tour.status === 'scheduled' &&
      scheduledAtMs !== null &&
      scheduledAtMs >= now.getTime()
    ) {
      results.push({
        leadId: lead.id,
        tourId: tour.id,
        signal: 'tour_scheduled_unconfirmed',
        label: SIGNAL_LABEL.tour_scheduled_unconfirmed,
        helper:
          'Tour is on the calendar but unconfirmed. Send a warm confirm.',
        urgency: SIGNAL_URGENCY.tour_scheduled_unconfirmed,
        suggestedAction:
          SUGGESTED_ACTIONS[SIGNAL_TO_ACTION.tour_scheduled_unconfirmed],
        scheduledAt,
      })
      continue
    }

    // 4. tour_completed_no_next_step — completed tour + lead still
    //    in a tour_completed / negotiation stage. The "no next step"
    //    part is enforced at the stage level: a booked lead would
    //    have moved out of the in-flight window.
    if (
      tour.status === 'completed' &&
      (lead.stage === 'tour_completed' || lead.stage === 'negotiation')
    ) {
      results.push({
        leadId: lead.id,
        tourId: tour.id,
        signal: 'tour_completed_no_next_step',
        label: SIGNAL_LABEL.tour_completed_no_next_step,
        helper:
          'Tour wrapped but the lead hasn’t moved. Send a friendly post-tour follow-up.',
        urgency: SIGNAL_URGENCY.tour_completed_no_next_step,
        suggestedAction:
          SUGGESTED_ACTIONS[SIGNAL_TO_ACTION.tour_completed_no_next_step],
        scheduledAt,
      })
      continue
    }

    // 5. tour_no_show_recovery — no_show status and the lead is
    //    still in-flight.
    if (
      tour.status === 'no_show' &&
      lead.stage !== 'booked' &&
      lead.stage !== 'lost'
    ) {
      results.push({
        leadId: lead.id,
        tourId: tour.id,
        signal: 'tour_no_show_recovery',
        label: SIGNAL_LABEL.tour_no_show_recovery,
        helper:
          'Lead missed their tour. Recover gently and offer to reschedule.',
        urgency: SIGNAL_URGENCY.tour_no_show_recovery,
        suggestedAction:
          SUGGESTED_ACTIONS[SIGNAL_TO_ACTION.tour_no_show_recovery],
        scheduledAt,
      })
      continue
    }
  }

  // Sort by priority, then by upcoming tour time (soonest first),
  // then by lead score so a hot lead beats a cool one at the same
  // priority level.
  results.sort((a, b) => {
    const pa = SIGNAL_PRIORITY[a.signal]
    const pb = SIGNAL_PRIORITY[b.signal]
    if (pa !== pb) return pb - pa
    const ta = a.scheduledAt ? new Date(a.scheduledAt).getTime() : Infinity
    const tb = b.scheduledAt ? new Date(b.scheduledAt).getTime() : Infinity
    if (ta !== tb) return ta - tb
    const sa = leadById.get(a.leadId)?.lead_score ?? 0
    const sb = leadById.get(b.leadId)?.lead_score ?? 0
    return sb - sa
  })
  return results
}

/**
 * Convenience: pick the highest-priority signal for a single lead
 * out of a precomputed signal list. The LeadDetailDrawer's
 * TourReadinessPanel uses this so it shows ONE panel per lead even
 * when multiple tour-shape signals stack.
 */
export function primaryTourSignalForLead(
  signals: ReadonlyArray<TourBookingSignal>,
  leadId: string
): TourBookingSignal | null {
  let best: TourBookingSignal | null = null
  for (const s of signals) {
    if (s.leadId !== leadId) continue
    if (!best || SIGNAL_PRIORITY[s.signal] > SIGNAL_PRIORITY[best.signal]) {
      best = s
    }
  }
  return best
}

/**
 * Confirmation-queue convenience: the dashboard card needs only the
 * future-scheduled-unconfirmed slice, ordered by soonest tour. We
 * expose it as a helper so the card stays declarative.
 */
export function unconfirmedScheduledTours(
  signals: ReadonlyArray<TourBookingSignal>
): TourBookingSignal[] {
  return signals.filter((s) => s.signal === 'tour_scheduled_unconfirmed')
}

export const TOUR_BOOKING_SIGNAL_LABELS = SIGNAL_LABEL
export const TOUR_BOOKING_SUGGESTED_ACTIONS = SUGGESTED_ACTIONS

/**
 * Used by the KanbanBoard's `?leakage=tour_booking` filter. Reduces
 * a list of signals to the unique lead-id set so the board can
 * narrow its in-memory list.
 */
export function tourBookingLeadIds(
  signals: ReadonlyArray<TourBookingSignal>
): Set<string> {
  return new Set(signals.map((s) => s.leadId))
}
