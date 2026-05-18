/**
 * Phase 8C — small helper for the "Quick schedule tour" demo action.
 *
 * Computes "next Tuesday at 10:00 AM local browser time" deterministically
 * so the button always proposes a defensible-sounding default without
 * stepping into UI date-picker complexity.
 *
 * Local time on purpose: the tours dashboard renders times in the venue
 * owner's local timezone, so building the Date in local time and serializing
 * with `toISOString()` gives the operator the time they expect to see
 * on the calendar.
 */

/**
 * Returns "next Tuesday at 10:00 local time" as an ISO string suitable
 * for the `/api/tours` POST `scheduled_at` field. If today is Tuesday,
 * we jump a week forward — "next" never means "in the past".
 */
export function nextTuesdayAtTenAm(now: Date = new Date()): string {
  const target = new Date(now)
  const day = target.getDay() // 0 = Sunday
  // Days until next Tuesday (2 = Tuesday).
  let daysAhead = (2 - day + 7) % 7
  if (daysAhead === 0) daysAhead = 7
  target.setDate(target.getDate() + daysAhead)
  target.setHours(10, 0, 0, 0)
  return target.toISOString()
}

/** Default duration in minutes for a quick-scheduled tour. */
export const QUICK_TOUR_DURATION_MIN = 60

/** Default `location_notes` value attached to a quick-scheduled tour. */
export const QUICK_TOUR_NOTES = 'Quick-scheduled from demo dashboard.'
