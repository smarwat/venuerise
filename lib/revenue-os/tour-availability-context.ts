import type { SupabaseClient } from '@supabase/supabase-js'
import { log } from '@/lib/log'
import {
  suggestTourSlots,
  type TourAvailabilitySlot,
  type ExistingTour,
} from '@/lib/revenue-os/tour-slot-suggestions'
import { parseRevenueOsSettings } from '@/lib/revenue-os/settings'
import {
  detectSchedulingIntent,
  type SchedulingIntent,
} from '@/lib/revenue-os/scheduling-intent'

/**
 * Phase 8BJ — Tour availability context for AI chat.
 *
 * Orchestrates: scheduling-intent detection → DB reads for the
 * venue's availability windows, existing tours, and blackouts →
 * `suggestTourSlots` → a structured context block the AI chat
 * pipeline injects into the conversation prompt.
 *
 * Why this exists: the inbox AI used to say "I don't have access
 * to the calendar" because the prompt had no availability data
 * even though the venue had `tour_availability` rows configured.
 * This helper closes the gap.
 *
 * Failure posture: every read is best-effort and wrapped in
 * try/catch. If the DB read fails, the context returns
 * `availabilityConfigured: false` with `unavailableReason:
 * 'availability_fetch_failed'` and the prompt rule sends the
 * AI to the "team will confirm" fallback. The chat reply is
 * never blocked by a slot-fetch failure.
 */

// ──────────────────────────────────────────────────────────────────────
//  Public types
// ──────────────────────────────────────────────────────────────────────

export interface TourAvailabilityContextSlot {
  startsAt: string
  endsAt: string
  label: string
  rationale: string
}

export interface TourAvailabilityContext {
  schedulingIntent: SchedulingIntent
  availabilityConfigured: boolean
  suggestedSlots: TourAvailabilityContextSlot[]
  timezone: string | null
  durationMinutes: number
  bufferMinutes: number
  unavailableReason?:
    | 'no_availability'
    | 'no_open_windows'
    | 'availability_fetch_failed'
}

export interface BuildTourAvailabilityContextArgs {
  supabase: SupabaseClient
  venue: {
    id: string
    timezone?: string | null
    metadata?: unknown
  }
  lead?: {
    id?: string | null
    event_date?: string | null
  } | null
  latestUserMessage: string | null | undefined
  /** Override clock for tests. Defaults to `new Date()`. */
  now?: Date
  /** Override max suggestions returned. Defaults to 5 (the prompt
   *  shows 3–5 cleanly; the spec asked for 2–5). */
  maxSuggestions?: number
  requestId?: string
}

// ──────────────────────────────────────────────────────────────────────
//  Main entry point
// ──────────────────────────────────────────────────────────────────────

export async function buildTourAvailabilityContext(
  args: BuildTourAvailabilityContextArgs
): Promise<TourAvailabilityContext> {
  const now = args.now ?? new Date()
  const reqLog = log.child({
    requestId: args.requestId,
    op: 'ai.tour_availability_context',
    venueId: args.venue.id,
  })

  const schedulingIntent = detectSchedulingIntent(args.latestUserMessage)
  const settings = parseRevenueOsSettings(args.venue.metadata)
  const durationMinutes = settings.tourDurationMinutes
  const bufferMinutes = settings.tourBufferMinutes
  const timezone = args.venue.timezone ?? null

  // Short-circuit when the lead isn't asking about scheduling.
  // No DB cost, no slot math.
  if (!schedulingIntent.wantsTourAvailability) {
    return {
      schedulingIntent,
      availabilityConfigured: false,
      suggestedSlots: [],
      timezone,
      durationMinutes,
      bufferMinutes,
    }
  }

  // Run the three reads in parallel — they're independent and
  // each is small. Best-effort: a single failure degrades to the
  // "fetch_failed" branch instead of throwing.
  let availability: TourAvailabilitySlot[] = []
  let tours: ExistingTour[] = []
  let blackouts: Array<{ blackout_date: string; reason?: string | null }> = []
  let fetchFailed = false

  try {
    const [availRes, toursRes, blackoutsRes] = await Promise.all([
      args.supabase
        .from('tour_availability')
        .select('day_of_week, start_time, end_time, is_active')
        .eq('venue_id', args.venue.id)
        .eq('is_active', true),
      args.supabase
        .from('tours')
        .select('scheduled_at, duration_minutes')
        // Only non-cancelled tours block candidate slots. Cancelled
        // tours stay in the table for audit but don't reserve the
        // time anymore.
        .eq('venue_id', args.venue.id)
        .not('status', 'eq', 'cancelled')
        .gte('scheduled_at', now.toISOString())
        .order('scheduled_at', { ascending: true })
        .limit(200),
      args.supabase
        .from('tour_blackouts')
        .select('date, reason')
        .eq('venue_id', args.venue.id),
    ])

    if (availRes.error) {
      reqLog.warn({ err: availRes.error }, 'availability.query_failed')
      fetchFailed = true
    } else {
      availability = (availRes.data ?? []) as TourAvailabilitySlot[]
    }

    if (!toursRes.error && toursRes.data) {
      tours = toursRes.data as ExistingTour[]
    }
    // tours fetch failure is non-fatal: we just won't be able to
    // de-conflict against existing tours. Suggestions still
    // surface; rationale will be honest about "may conflict".

    if (!blackoutsRes.error && Array.isArray(blackoutsRes.data)) {
      blackouts = (
        blackoutsRes.data as Array<{ date: string; reason: string | null }>
      ).map((b) => ({ blackout_date: b.date, reason: b.reason }))
    }
  } catch (err) {
    reqLog.error({ err }, 'tour_availability_context.fetch_failed')
    fetchFailed = true
  }

  if (fetchFailed) {
    return {
      schedulingIntent,
      availabilityConfigured: false,
      suggestedSlots: [],
      timezone,
      durationMinutes,
      bufferMinutes,
      unavailableReason: 'availability_fetch_failed',
    }
  }

  if (availability.length === 0) {
    return {
      schedulingIntent,
      availabilityConfigured: false,
      suggestedSlots: [],
      timezone,
      durationMinutes,
      bufferMinutes,
      unavailableReason: 'no_availability',
    }
  }

  // Adjust the slot-search clock when the lead asked specifically
  // for "next week" — we start the scan from next Monday so the
  // suggestions match the lead's wording. For "this week" /
  // "weekend" / "general", we start from `now`.
  //
  // We DON'T change the underlying helper's 21-day window. We just
  // shift the start. If the venue has no slots next week, the
  // helper will surface slots later within the window so the AI
  // can honestly offer "next week is fully booked, here's the
  // following week."
  const scanStart = adjustScanStartForTimeframe(now, schedulingIntent)

  const slots = suggestTourSlots({
    availability,
    existingTours: tours,
    leadEventDate: args.lead?.event_date ?? null,
    timezone,
    now: scanStart,
    maxSuggestions: clampMaxSuggestions(args.maxSuggestions ?? 5),
    blackoutDates: blackouts,
    defaultDurationMinutes: durationMinutes,
    bufferMinutes,
  })

  if (slots.length === 0) {
    return {
      schedulingIntent,
      availabilityConfigured: true,
      suggestedSlots: [],
      timezone,
      durationMinutes,
      bufferMinutes,
      unavailableReason: 'no_open_windows',
    }
  }

  return {
    schedulingIntent,
    availabilityConfigured: true,
    suggestedSlots: slots.map((s) => ({
      startsAt: s.startsAt,
      endsAt: s.endsAt,
      label: s.label,
      rationale: s.rationale,
    })),
    timezone,
    durationMinutes,
    bufferMinutes,
  }
}

// ──────────────────────────────────────────────────────────────────────
//  Prompt rendering
// ──────────────────────────────────────────────────────────────────────

/**
 * Render the context as a structured prompt block the conversation
 * agent's system prompt can embed verbatim. The agent already
 * knows to treat `TOUR_AVAILABILITY_CONTEXT:` blocks per the
 * scheduling rules added in this phase.
 */
export function renderTourAvailabilityPromptBlock(
  ctx: TourAvailabilityContext
): string {
  if (!ctx.schedulingIntent.wantsTourAvailability) {
    return ''
  }

  const lines: string[] = []
  lines.push('TOUR_AVAILABILITY_CONTEXT:')
  lines.push(`- Lead is asking for tour availability: yes`)
  if (ctx.schedulingIntent.timeframeLabel) {
    lines.push(`- Timeframe hint: ${ctx.schedulingIntent.timeframeLabel}`)
  }
  if (ctx.schedulingIntent.requestedDateText) {
    lines.push(
      `- Lead's exact wording: "${ctx.schedulingIntent.requestedDateText}"`
    )
  }
  if (ctx.timezone) {
    lines.push(`- Venue timezone: ${ctx.timezone}`)
  }
  lines.push(`- Default tour duration: ${ctx.durationMinutes} minutes`)

  if (!ctx.availabilityConfigured) {
    const reason = ctx.unavailableReason ?? 'no_availability'
    if (reason === 'availability_fetch_failed') {
      lines.push(`- Availability lookup failed momentarily.`)
      lines.push(
        `- Instruction: Say the team will confirm available tour times manually. Do NOT say you lack calendar access. Do NOT invent times.`
      )
    } else {
      lines.push(`- Availability configured: no`)
      lines.push(
        `- Instruction: Do not invent times. Say the team will confirm available tour times manually. Do NOT claim you lack calendar access (we have the venue's profile, just no availability windows yet).`
      )
    }
    return lines.join('\n')
  }

  if (ctx.suggestedSlots.length === 0) {
    lines.push(`- Availability configured: yes`)
    lines.push(`- No open windows found in the next 21 days.`)
    lines.push(
      `- Instruction: Say you will check with the team for the nearest openings. Do NOT invent times.`
    )
    return lines.join('\n')
  }

  lines.push(`- Available suggested slots:`)
  ctx.suggestedSlots.forEach((slot, i) => {
    lines.push(`  ${i + 1}. ${slot.label}`)
  })
  lines.push(
    `- Instruction: Offer these specific slots to the lead and ask them to pick one. Phrase it as "I have these tour openings available…" — never say "I don't have access to the calendar." Do NOT say the tour is confirmed; a tour record only exists after an operator schedules it.`
  )
  return lines.join('\n')
}

// ──────────────────────────────────────────────────────────────────────
//  Internals
// ──────────────────────────────────────────────────────────────────────

function clampMaxSuggestions(raw: number): number {
  if (!Number.isFinite(raw)) return 5
  return Math.max(2, Math.min(5, Math.floor(raw)))
}

/**
 * Shift the scan-start date to match the lead's stated timeframe.
 * The helper's existing 21-day window keeps it bounded.
 *
 *   - `next_week` → next Monday 00:00 local
 *   - `this_week` / `weekend` / `specific_date` / `general` → now
 *
 * If next-Monday math fails for any reason (unlikely), we degrade
 * to `now` and the helper still surfaces the earliest slots.
 */
function adjustScanStartForTimeframe(
  now: Date,
  intent: SchedulingIntent
): Date {
  if (intent.timeframeLabel !== 'next_week') return now
  const dayOfWeek = now.getDay() // 0 = Sun, 1 = Mon, ...
  // Days until NEXT Monday (always ≥ 1, ≤ 7).
  const daysUntilNextMonday = ((1 - dayOfWeek + 7) % 7) || 7
  const nextMonday = new Date(now)
  nextMonday.setDate(now.getDate() + daysUntilNextMonday)
  nextMonday.setHours(0, 0, 0, 0)
  return nextMonday
}
