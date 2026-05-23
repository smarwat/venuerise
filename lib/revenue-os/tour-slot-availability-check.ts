import type { SupabaseClient } from '@supabase/supabase-js'
import { log } from '@/lib/log'
import { parseRevenueOsSettings } from '@/lib/revenue-os/settings'

/**
 * Phase 8BL — re-check that a previously-offered tour slot is still
 * bookable at the moment the lead clicks the confirmation link.
 *
 * The orchestrator offered the slot via `suggestTourSlots` at the
 * time the AI replied. That can be minutes, hours, or days ago.
 * Before we create a `tours` row from a lead's click, we must
 * re-validate:
 *
 *   1. The slot is in the future (not in the past at click time).
 *   2. No active blackout falls on the slot's local calendar date.
 *   3. The slot doesn't overlap an existing non-cancelled tour
 *      (with the venue's buffer minutes applied).
 *   4. Optional: the slot still falls inside an active
 *      `tour_availability` window. (Window edits are rare but
 *      possible — a venue could deactivate Tuesday slots after
 *      offering one.)
 *
 * Returns a structured `RecheckOutcome` the POST route maps to a
 * user-facing response. The route never invents tours when the
 * recheck fails — the lead sees a "this slot is no longer available"
 * page and the AI conversation is told (via a system message) that
 * the link couldn't be completed.
 *
 * ── DESIGN NOTE: NOT REUSING suggestTourSlots ────────────────────────────
 * `suggestTourSlots` is a SUGGESTION engine — it scans forward from
 * "now" looking for candidates. Here we're validating one SPECIFIC
 * pre-determined slot. Different shape: we don't need to scan, we
 * need to ask "is THIS interval still clean?" So we re-implement the
 * three checks against the same data sources, keeping the math local
 * and easy to audit.
 */

export type TourSlotRecheckResult =
  | { ok: true }
  | { ok: false; reason: TourSlotRecheckFailureReason }

export type TourSlotRecheckFailureReason =
  | 'in_past'                  // slot start ≤ now
  | 'blackout'                 // slot date matches an active blackout
  | 'conflict'                 // overlaps a non-cancelled tour (+ buffer)
  | 'availability_removed'     // the underlying window is no longer active
  | 'fetch_failed'             // any DB error during the recheck

export interface TourSlotRecheckArgs {
  supabase: SupabaseClient
  venueId: string
  /** Venue's metadata (for tour_duration / buffer settings). */
  venueMetadata: unknown
  /** ISO UTC start of the slot the lead is trying to confirm. */
  slotStartsAt: string
  /** ISO UTC end of the slot. */
  slotEndsAt: string
  /** Optional venue timezone label (for blackout local-date math). */
  timezone?: string | null
  /** Override clock for tests. */
  now?: Date
  requestId?: string
}

export async function checkTourSlotStillAvailable(
  args: TourSlotRecheckArgs
): Promise<TourSlotRecheckResult> {
  const now = args.now ?? new Date()
  const reqLog = log.child({
    requestId: args.requestId,
    op: 'tour_slot_availability.recheck',
    venueId: args.venueId,
  })

  const startMs = Date.parse(args.slotStartsAt)
  const endMs = Date.parse(args.slotEndsAt)
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    return { ok: false, reason: 'fetch_failed' }
  }

  // ── 1. Past-time guard ────────────────────────────────────────────────
  if (startMs <= now.getTime()) {
    return { ok: false, reason: 'in_past' }
  }

  // Pull buffer (and duration, for length validation) from settings.
  const settings = parseRevenueOsSettings(args.venueMetadata)
  const bufferMs = Math.max(0, settings.tourBufferMinutes) * 60_000

  // ── 2. Parallel reads: tours + blackouts + availability windows ───────
  let tours: Array<{ scheduled_at: string; duration_minutes: number | null }> = []
  let blackoutDates: string[] = []
  let activeWindows: Array<{
    day_of_week: number
    start_time: string
    end_time: string
  }> = []

  try {
    const [toursRes, blackoutsRes, availRes] = await Promise.all([
      args.supabase
        .from('tours')
        .select('scheduled_at, duration_minutes')
        .eq('venue_id', args.venueId)
        // Cancelled tours don't reserve the time, matching the
        // semantics in `tour-availability-context.ts`.
        .not('status', 'eq', 'cancelled')
        // Bound the scan: we only care about tours that could
        // possibly overlap a window straddling the slot end.
        // 24h on either side is generous and keeps the query
        // light even on very active venues.
        .gte('scheduled_at', new Date(startMs - 24 * 3600_000).toISOString())
        .lte('scheduled_at', new Date(endMs + 24 * 3600_000).toISOString()),
      args.supabase
        .from('tour_blackouts')
        .select('date')
        .eq('venue_id', args.venueId),
      args.supabase
        .from('tour_availability')
        .select('day_of_week, start_time, end_time')
        .eq('venue_id', args.venueId)
        .eq('is_active', true),
    ])

    if (toursRes.error || blackoutsRes.error || availRes.error) {
      reqLog.warn(
        {
          toursErr: toursRes.error,
          blackoutsErr: blackoutsRes.error,
          availErr: availRes.error,
        },
        'tour_slot_availability.recheck_query_failed'
      )
      return { ok: false, reason: 'fetch_failed' }
    }

    tours = (toursRes.data ?? []) as Array<{
      scheduled_at: string
      duration_minutes: number | null
    }>
    blackoutDates = (
      (blackoutsRes.data ?? []) as Array<{ date: string }>
    )
      .map((b) => (typeof b.date === 'string' ? b.date.slice(0, 10) : ''))
      .filter(Boolean)
    activeWindows = (availRes.data ?? []) as Array<{
      day_of_week: number
      start_time: string
      end_time: string
    }>
  } catch (err) {
    reqLog.error({ err }, 'tour_slot_availability.recheck_unexpected')
    return { ok: false, reason: 'fetch_failed' }
  }

  // ── 3. Blackout date check ────────────────────────────────────────────
  // Use the LOCAL date of the slot start. We don't try to do full
  // timezone math (matches `suggestTourSlots`'s `formatLocalDateKey`
  // which uses the JS-runtime local TZ); a venue running in a TZ
  // different from the server's TZ should set `venues.timezone` and
  // also configure their availability + blackouts in that TZ — the
  // existing helpers all assume that consistency.
  const slotStart = new Date(startMs)
  const localDateKey = formatLocalDateKey(slotStart)
  if (blackoutDates.includes(localDateKey)) {
    return { ok: false, reason: 'blackout' }
  }

  // ── 4. Tour conflict check (with buffer on existing tour ends) ────────
  for (const t of tours) {
    if (!t || typeof t.scheduled_at !== 'string') continue
    const ts = Date.parse(t.scheduled_at)
    if (!Number.isFinite(ts)) continue
    const dur =
      typeof t.duration_minutes === 'number' && t.duration_minutes > 0
        ? t.duration_minutes
        : 60
    const te = ts + dur * 60_000 + bufferMs
    if (ts < endMs && te > startMs) {
      return { ok: false, reason: 'conflict' }
    }
  }

  // ── 5. Availability-window membership ─────────────────────────────────
  // The slot must still sit fully inside an active availability window.
  // If the venue removed the window after offering the slot, refuse
  // the confirmation — even though we'd otherwise allow it, this
  // honors the operator's intent.
  const dow = slotStart.getDay() // 0=Sun, 1=Mon, ...
  const windowsForDow = activeWindows.filter((w) => w.day_of_week === dow)
  if (windowsForDow.length === 0) {
    return { ok: false, reason: 'availability_removed' }
  }
  const slotStartMins = slotStart.getHours() * 60 + slotStart.getMinutes()
  const slotEnd = new Date(endMs)
  const slotEndMins = slotEnd.getHours() * 60 + slotEnd.getMinutes()
  const fitsInWindow = windowsForDow.some((w) => {
    const ws = hhmmToMinutes(w.start_time)
    const we = hhmmToMinutes(w.end_time)
    if (ws === null || we === null) return false
    return ws <= slotStartMins && we >= slotEndMins
  })
  if (!fitsInWindow) {
    return { ok: false, reason: 'availability_removed' }
  }

  return { ok: true }
}

// ── Internals ─────────────────────────────────────────────────────────────

function hhmmToMinutes(raw: string): number | null {
  const m = /^(\d{2}):(\d{2})(?::\d{2})?$/.exec(raw)
  if (!m) return null
  const hh = Number(m[1])
  const mm = Number(m[2])
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null
  return hh * 60 + mm
}

function formatLocalDateKey(d: Date): string {
  const pad = (n: number) => n.toString().padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
