/**
 * Phase 8BB — Tour Slot Suggestions.
 *
 * Pure helper. No Supabase, no React, no env. The Tour
 * Readiness panel on the lead detail drawer consumes
 * `suggestTourSlots` to render up to 2 concrete tour windows
 * the operator can click to prefill the existing
 * ScheduleTourDrawer.
 *
 * Critical: this helper produces SUGGESTIONS only. Nothing in
 * this file (or in the surfaces that consume it) writes a tour,
 * sends a message, or schedules anything autonomously. The
 * operator still confirms inside the existing
 * ScheduleTourDrawer.
 */

// ---------------------------------------------------------------------------
// Input/output types
// ---------------------------------------------------------------------------

/**
 * Active availability window from `public.tour_availability`.
 * The helper only consumes the four fields it needs — the audit
 * row's `id` + `venue_id` + `created_at` aren't relevant here.
 */
export interface TourAvailabilitySlot {
  day_of_week: number
  start_time: string
  end_time: string
  is_active: boolean
}

/** Minimal existing-tour shape the conflict check needs. */
export interface ExistingTour {
  scheduled_at: string
  duration_minutes: number | null
}

export interface TourSlotSuggestion {
  /** ISO UTC start, e.g. `2026-05-23T17:00:00.000Z`. */
  startsAt: string
  /** ISO UTC end (= start + duration). */
  endsAt: string
  /** Short button-friendly label: `Sat, May 24 · 10:00 AM`. */
  label: string
  /** Single-sentence "why this slot" line. */
  rationale: string
  /** Always `'venue_availability'` today; reserved for future sources. */
  source: 'venue_availability'
}

export interface SuggestTourSlotsArgs {
  availability: ReadonlyArray<TourAvailabilitySlot>
  existingTours: ReadonlyArray<ExistingTour>
  leadEventDate?: string | null
  timezone?: string | null
  now?: Date
  maxSuggestions?: number
  // Phase 8BC — operator-managed blackout dates. Candidates
  // whose local calendar date matches a blackout row are dropped
  // before being surfaced. The shape mirrors the
  // `tour_blackouts` row (date + optional reason); we only need
  // `blackout_date` for the math but accept the full shape so the
  // caller can pass server rows verbatim.
  blackoutDates?: ReadonlyArray<{
    blackout_date: string
    reason?: string | null
  }>
  // Phase 8BC — duration + buffer overrides. Default 60 minutes
  // (unchanged from Phase 8BB) so existing callers don't have to
  // thread the new params. Buffer applies AFTER every existing
  // tour during the conflict check so back-to-back tours aren't
  // suggested too tightly.
  defaultDurationMinutes?: number
  bufferMinutes?: number
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_DURATION_MINUTES = 60
const DEFAULT_MAX_SUGGESTIONS = 2
// 21 days is enough to cover most lead-to-tour windows without
// suggesting slots so far out they feel irrelevant. Operator can
// still pick anything via the drawer's date picker.
const SCAN_WINDOW_DAYS = 21

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

/**
 * Generate up to N candidate tour slots from the venue's saved
 * availability + existing tour calendar.
 *
 * Rules (matching the Phase 8BB spec):
 *   - Only active availability windows contribute candidates.
 *   - Default duration 60 minutes. Windows narrower than the
 *     duration are skipped entirely (we won't suggest a
 *     45-minute slot when ScheduleTourDrawer's default is 60).
 *   - Candidates in the past are dropped.
 *   - Candidates after `leadEventDate` (if provided) are
 *     dropped — we don't suggest a tour after the wedding.
 *   - Candidates that overlap any existing tour for the
 *     venue are dropped.
 *   - Sort primary by `startsAt` ascending (earlier wins).
 *   - Weekend candidates are preferred only as a tiebreaker
 *     among same-day candidates: we de-duplicate by calendar
 *     date, picking the earliest weekend candidate on a given
 *     day before any same-day weekday candidate (in practice
 *     a single day is either weekday or weekend, so this is
 *     functionally an "earliest per day" rule).
 *   - Return at most `maxSuggestions` (default 2). Empty array
 *     when there's no availability or every candidate
 *     conflicts.
 *
 * Timezone note: the helper treats `start_time` strings as
 * local time in the JS runtime's TZ. Passing `timezone` is
 * accepted today but only affects the label string for clarity;
 * full per-venue TZ math is reserved for a future "venue
 * availability intelligence" phase.
 */
export function suggestTourSlots(
  args: SuggestTourSlotsArgs
): TourSlotSuggestion[] {
  const now = args.now ?? new Date()
  const maxSuggestions = clampMax(args.maxSuggestions)
  const eventDateMs = parseEventDate(args.leadEventDate)
  const tours = args.existingTours ?? []
  // Phase 8BC — duration override + buffer + blackouts. The
  // duration param is clamped to the same bounds Settings UI
  // enforces (15–240 min); buffer is clamped 0–120; blackout
  // dates are normalized to a Set of `YYYY-MM-DD` strings for
  // O(1) per-candidate membership checks.
  const durationMinutes = clampDuration(args.defaultDurationMinutes)
  const bufferMinutes = clampBuffer(args.bufferMinutes)
  const blackoutSet = buildBlackoutSet(args.blackoutDates)

  // Active-only filter — inactive windows shouldn't surface
  // even if they're saved on the table.
  const active = (args.availability ?? []).filter(
    (w) =>
      w &&
      w.is_active === true &&
      Number.isInteger(w.day_of_week) &&
      w.day_of_week >= 0 &&
      w.day_of_week <= 6 &&
      typeof w.start_time === 'string' &&
      typeof w.end_time === 'string'
  )
  if (active.length === 0) return []

  const candidates: TourSlotSuggestion[] = []
  for (let dayOffset = 0; dayOffset < SCAN_WINDOW_DAYS; dayOffset += 1) {
    const date = new Date(now)
    date.setDate(date.getDate() + dayOffset)
    // Normalize to midnight LOCAL for the day we're scanning;
    // start_time then becomes the candidate's exact start.
    date.setHours(0, 0, 0, 0)
    const dow = date.getDay()
    for (const window of active) {
      if (window.day_of_week !== dow) continue
      const start = applyTime(date, window.start_time)
      if (!start) continue
      const end = applyTime(date, window.end_time)
      if (!end) continue
      // Window must fit the configured duration or the
      // suggestion is unusable.
      if (end.getTime() - start.getTime() < durationMinutes * 60_000) {
        continue
      }
      if (start.getTime() <= now.getTime()) continue
      if (eventDateMs !== null && start.getTime() > eventDateMs) continue
      // Phase 8BC — blackout-date filter. Compare against the
      // LOCAL date prefix (not UTC) so a venue in PT with a
      // blackout on `2026-05-26` correctly blocks PT-local
      // candidates whose UTC ISO string might still read
      // `2026-05-27T03:00:00Z` after toISOString().
      const localDateKey = formatLocalDateKey(start)
      if (blackoutSet.has(localDateKey)) continue
      const startsAt = start.toISOString()
      const endsAt = new Date(
        start.getTime() + durationMinutes * 60_000
      ).toISOString()
      const conflict = overlapsAny(start, durationMinutes, tours, bufferMinutes)
      if (conflict.overlap) continue
      candidates.push({
        startsAt,
        endsAt,
        label: formatLabel(start, args.timezone ?? null),
        rationale: buildRationale(start, {
          bufferMinutes,
          hasBlackouts: blackoutSet.size > 0,
        }),
        source: 'venue_availability',
      })
    }
  }

  // Sort by startsAt ascending — earliest available wins. Then
  // de-duplicate by calendar date so we don't return two
  // candidates on the same day (e.g. a venue with three Saturday
  // windows shouldn't fill both suggestion slots with one day).
  candidates.sort((a, b) => a.startsAt.localeCompare(b.startsAt))
  const out: TourSlotSuggestion[] = []
  const seenDates = new Set<string>()
  for (const c of candidates) {
    const dateKey = c.startsAt.slice(0, 10)
    if (seenDates.has(dateKey)) continue
    seenDates.add(dateKey)
    out.push(c)
    if (out.length >= maxSuggestions) break
  }
  return out
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function clampMax(raw: number | undefined): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 1) {
    return DEFAULT_MAX_SUGGESTIONS
  }
  return Math.min(Math.floor(raw), 5)
}

function parseEventDate(raw: string | null | undefined): number | null {
  if (!raw) return null
  // Accept either `YYYY-MM-DD` or full ISO. We treat the date
  // boundary as end-of-day in local time so a "tour the morning
  // of the event" still counts as before the event.
  const parsed = new Date(raw)
  if (!Number.isFinite(parsed.getTime())) return null
  // If the input was just `YYYY-MM-DD`, Date parses it as UTC
  // midnight — bump to end-of-day local to give the candidate
  // window a fair chance.
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const local = new Date(raw)
    local.setHours(23, 59, 59, 999)
    return local.getTime()
  }
  return parsed.getTime()
}

function applyTime(dayMidnight: Date, hhmm: string): Date | null {
  // Accept HH:MM or HH:MM:SS.
  const m = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(hhmm)
  if (!m) return null
  const hour = Number(m[1])
  const min = Number(m[2])
  if (
    !Number.isFinite(hour) ||
    !Number.isFinite(min) ||
    hour < 0 ||
    hour > 23 ||
    min < 0 ||
    min > 59
  ) {
    return null
  }
  const out = new Date(dayMidnight)
  out.setHours(hour, min, 0, 0)
  return out
}

/**
 * Returns whether the candidate `[start, start+duration)` overlaps
 * any existing tour, treating each existing tour as
 * `[ts, ts+dur+buffer)`. The buffer is applied to the END of the
 * existing tour, so a tour at 10–11am with a 30-min buffer
 * blocks any candidate starting before 11:30am.
 *
 * `conflict` is returned as an object so a future caller can read
 * the conflicting tour for richer "blocked by Tour X at 10am"
 * rationale strings — today we only consume the boolean.
 */
function overlapsAny(
  start: Date,
  durationMinutes: number,
  tours: ReadonlyArray<ExistingTour>,
  bufferMinutes: number
): { overlap: boolean } {
  const startMs = start.getTime()
  const endMs = startMs + durationMinutes * 60_000
  const bufferMs = Math.max(0, bufferMinutes) * 60_000
  for (const t of tours) {
    if (!t || typeof t.scheduled_at !== 'string') continue
    const ts = Date.parse(t.scheduled_at)
    if (!Number.isFinite(ts)) continue
    const dur =
      typeof t.duration_minutes === 'number' && t.duration_minutes > 0
        ? t.duration_minutes
        : DEFAULT_DURATION_MINUTES
    // Half-open overlap with buffer on the existing tour's end.
    // We deliberately don't symmetrically pad the candidate's
    // start — buffer is "cleanup after a tour", not "warm-up
    // before one." Symmetric padding can land in a future phase
    // if venues ask.
    const te = ts + dur * 60_000 + bufferMs
    if (ts < endMs && te > startMs) return { overlap: true }
  }
  return { overlap: false }
}

/**
 * Format `Sat, May 24 · 10:00 AM`. We use `Intl.DateTimeFormat`
 * to honor the operator's locale automatically; passing the
 * lead/venue `timezone` (when known) keeps the label honest
 * across DST + cross-region scenarios.
 */
function formatLabel(start: Date, timezone: string | null): string {
  const opts: Intl.DateTimeFormatOptions = {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }
  if (timezone) opts.timeZone = timezone
  // Output: "Sat, May 24, 10:00 AM" — swap the second comma for
  // the bullet so the chip reads `Sat, May 24 · 10:00 AM`.
  const raw = new Intl.DateTimeFormat(undefined, opts).format(start)
  const parts = raw.split(', ')
  if (parts.length === 3) return `${parts[0]}, ${parts[1]} · ${parts[2]}`
  return raw
}

function buildRationale(
  start: Date,
  ctx: { bufferMinutes: number; hasBlackouts: boolean }
): string {
  const dow = start.getDay()
  const isWeekend = dow === 0 || dow === 6
  const hour = start.getHours()
  const tod =
    hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : 'evening'
  const base = isWeekend
    ? `Earliest open ${weekdayName(dow)} ${tod} from your saved availability.`
    : `Earliest open weekday ${tod} from your saved availability.`
  // Phase 8BC — append a single sentence when buffer / blackouts
  // are actually in play. Keeps the tooltip short on a venue with
  // no buffer and no blackouts.
  if (ctx.bufferMinutes > 0 && ctx.hasBlackouts) {
    return `${base} Avoids existing tours, buffer time, and blackout dates.`
  }
  if (ctx.bufferMinutes > 0) {
    return `${base} Avoids existing tours and buffer time.`
  }
  if (ctx.hasBlackouts) {
    return `${base} Avoids existing tours and blackout dates.`
  }
  return base
}

function clampDuration(raw: number | undefined): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    return DEFAULT_DURATION_MINUTES
  }
  const rounded = Math.round(raw)
  if (rounded < 15) return 15
  if (rounded > 240) return 240
  return rounded
}

function clampBuffer(raw: number | undefined): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return 0
  const rounded = Math.round(raw)
  if (rounded < 0) return 0
  if (rounded > 120) return 120
  return rounded
}

function buildBlackoutSet(
  rows:
    | ReadonlyArray<{ blackout_date: string; reason?: string | null }>
    | undefined
): Set<string> {
  const out = new Set<string>()
  if (!Array.isArray(rows)) return out
  for (const r of rows) {
    if (!r || typeof r.blackout_date !== 'string') continue
    const raw = r.blackout_date
    // Accept both `YYYY-MM-DD` and full ISO; normalize to the
    // date prefix so candidate-side keys match.
    if (raw.length >= 10) out.add(raw.slice(0, 10))
  }
  return out
}

/**
 * Format a Date as `YYYY-MM-DD` using LOCAL fields (not UTC).
 * The blackout-date filter compares against the candidate's
 * local date so a PT venue's `2026-05-26` blackout blocks a
 * candidate whose `.toISOString()` rolls into the next UTC day.
 */
function formatLocalDateKey(d: Date): string {
  const pad = (n: number) => n.toString().padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function weekdayName(dow: number): string {
  return (
    ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][
      dow
    ] ?? 'day'
  )
}
