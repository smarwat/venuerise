/**
 * Phase 8BK — Tour slot selection detector.
 *
 * Pure helper. No Supabase, no AI. Determines whether a lead's
 * latest reply is selecting one of the slots the AI previously
 * offered (in the prior AI message's `metadata.offered_tour_slots`).
 *
 * Why deterministic: this signal gates a UI affordance ("Tour time
 * selected — Create tour"). The operator clicks the button; the
 * existing ScheduleTourDrawer opens prefilled. Detection should
 * be cheap, transparent, and conservative — false positives leak
 * a misleading "selected slot" panel; false negatives just hide
 * the affordance until the operator schedules manually.
 *
 * Confidence tiers:
 *   - 'high'   — unambiguous match (ordinal, weekday+time, AM/PM
 *                that uniquely identifies one offered slot)
 *   - 'medium' — single slot was offered and lead said yes /
 *                that works / sounds good; UI shows a "Medium
 *                confidence" warning
 *   - 'low'    — ambiguous match (e.g. lead said "yes" with
 *                multiple slots on the table); UI hides the
 *                affordance and the agent re-prompts
 */

export interface OfferedTourSlot {
  starts_at: string
  ends_at: string
  label: string
  rationale?: string | null
}

export type TourSlotSelectionConfidence = 'high' | 'medium' | 'low'

export interface TourSlotSelectionMatch {
  startsAt: string
  endsAt: string
  label: string
  matchReason: string
}

export interface TourSlotSelection {
  selected: boolean
  selectedSlot: TourSlotSelectionMatch | null
  confidence: TourSlotSelectionConfidence
}

export interface DetectTourSlotSelectionArgs {
  leadMessage: string | null | undefined
  offeredSlots: ReadonlyArray<OfferedTourSlot>
  /** Override clock for tests. Default = `new Date()`. */
  now?: Date
  /** Reserved for future per-venue TZ math — labels emit local
   *  to the JS runtime today. */
  timezone?: string | null
}

// ──────────────────────────────────────────────────────────────────────
//  Pattern dictionaries
// ──────────────────────────────────────────────────────────────────────

const AFFIRMATIVE_PHRASES: ReadonlyArray<RegExp> = [
  /\byes\b/i,
  /\byep\b/i,
  /\byeah\b/i,
  /\bsure\b/i,
  /\bthat works\b/i,
  /\bsounds (good|great|perfect)\b/i,
  /\bworks for me\b/i,
  /\blet'?s do (it|that)\b/i,
  /\bok(ay)?\b/i,
  /\bperfect\b/i,
  /\bbook it\b/i,
  /\bi'?ll take (it|that)\b/i,
]

const ORDINAL_MAP: ReadonlyArray<{ re: RegExp; index: number }> = [
  { re: /\b(the )?first( one)?\b/i, index: 0 },
  { re: /\b(option )?1\b/i, index: 0 },
  { re: /\b(the )?second( one)?\b/i, index: 1 },
  { re: /\b(option )?2\b/i, index: 1 },
  { re: /\b(the )?third( one)?\b/i, index: 2 },
  { re: /\b(option )?3\b/i, index: 2 },
  { re: /\b(the )?fourth( one)?\b/i, index: 3 },
  { re: /\b(option )?4\b/i, index: 3 },
  { re: /\b(the )?fifth( one)?\b/i, index: 4 },
  { re: /\b(option )?5\b/i, index: 4 },
  { re: /\b(the )?last( one)?\b/i, index: -1 }, // resolved to length-1 after slots known
]

const WEEKDAY_MAP: Record<string, number> = {
  sun: 0, sunday: 0,
  mon: 1, monday: 1,
  tue: 2, tues: 2, tuesday: 2,
  wed: 3, weds: 3, wednesday: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4,
  fri: 5, friday: 5,
  sat: 6, saturday: 6,
}

// ──────────────────────────────────────────────────────────────────────
//  Public detector
// ──────────────────────────────────────────────────────────────────────

export function detectTourSlotSelection(
  args: DetectTourSlotSelectionArgs
): TourSlotSelection {
  const text = (args.leadMessage ?? '').trim()
  const slots = args.offeredSlots ?? []
  if (text.length === 0 || slots.length === 0) {
    return emptyResult()
  }

  // 1. Ordinal match — strongest signal.
  const ordinalIdx = matchOrdinal(text, slots.length)
  if (ordinalIdx !== null) {
    const slot = slots[ordinalIdx]
    return matchedResult(slot, 'high', `ordinal_reference (${ordinalIdx + 1})`)
  }

  // 2. Weekday + time match — also strong when unambiguous.
  const wdMatch = matchWeekdayAndTime(text, slots)
  if (wdMatch) {
    return matchedResult(wdMatch.slot, 'high', wdMatch.reason)
  }

  // 3. Time-only match — "11 works", "the 11am" — strong only if
  //    exactly one slot matches that hour.
  const timeMatch = matchTimeOnly(text, slots)
  if (timeMatch) {
    return matchedResult(timeMatch.slot, 'high', timeMatch.reason)
  }

  // 4. Weekday-only match — "Saturday works" — strong only if
  //    exactly one slot is on that weekday.
  const wdOnly = matchWeekdayOnly(text, slots)
  if (wdOnly) {
    return matchedResult(wdOnly.slot, 'high', wdOnly.reason)
  }

  // 5. Bare affirmative — only confident when one slot was offered.
  if (isAffirmative(text)) {
    if (slots.length === 1) {
      return matchedResult(
        slots[0],
        'medium',
        'single_slot_affirmative'
      )
    }
    // Multiple slots + bare "yes" = ambiguous on purpose.
    return {
      selected: false,
      selectedSlot: null,
      confidence: 'low',
    }
  }

  return emptyResult()
}

// ──────────────────────────────────────────────────────────────────────
//  Internals
// ──────────────────────────────────────────────────────────────────────

function emptyResult(): TourSlotSelection {
  return { selected: false, selectedSlot: null, confidence: 'low' }
}

function matchedResult(
  slot: OfferedTourSlot,
  confidence: TourSlotSelectionConfidence,
  matchReason: string
): TourSlotSelection {
  return {
    selected: true,
    selectedSlot: {
      startsAt: slot.starts_at,
      endsAt: slot.ends_at,
      label: slot.label,
      matchReason,
    },
    confidence,
  }
}

function matchOrdinal(text: string, slotsLength: number): number | null {
  for (const { re, index } of ORDINAL_MAP) {
    if (re.test(text)) {
      const resolved = index === -1 ? slotsLength - 1 : index
      if (resolved < slotsLength) return resolved
    }
  }
  return null
}

function matchWeekdayAndTime(
  text: string,
  slots: ReadonlyArray<OfferedTourSlot>
): { slot: OfferedTourSlot; reason: string } | null {
  const wd = extractWeekday(text)
  const hour = extractHour(text)
  if (wd === null || hour === null) return null

  const matches = slots.filter((s) => {
    const d = new Date(s.starts_at)
    if (!Number.isFinite(d.getTime())) return false
    return d.getDay() === wd && d.getHours() === hour
  })
  if (matches.length === 1) {
    return { slot: matches[0], reason: 'weekday_and_time' }
  }
  return null
}

function matchTimeOnly(
  text: string,
  slots: ReadonlyArray<OfferedTourSlot>
): { slot: OfferedTourSlot; reason: string } | null {
  const wd = extractWeekday(text)
  if (wd !== null) return null // handled by matchWeekdayAndTime
  const hour = extractHour(text)
  if (hour === null) return null
  const matches = slots.filter((s) => {
    const d = new Date(s.starts_at)
    return Number.isFinite(d.getTime()) && d.getHours() === hour
  })
  if (matches.length === 1) {
    return { slot: matches[0], reason: 'time_only' }
  }
  return null
}

function matchWeekdayOnly(
  text: string,
  slots: ReadonlyArray<OfferedTourSlot>
): { slot: OfferedTourSlot; reason: string } | null {
  const hour = extractHour(text)
  if (hour !== null) return null // handled by matchWeekdayAndTime
  const wd = extractWeekday(text)
  if (wd === null) return null
  const matches = slots.filter((s) => {
    const d = new Date(s.starts_at)
    return Number.isFinite(d.getTime()) && d.getDay() === wd
  })
  if (matches.length === 1) {
    return { slot: matches[0], reason: 'weekday_only' }
  }
  return null
}

function extractWeekday(text: string): number | null {
  // Strip punctuation. Lowercase. Then test each weekday key against
  // word boundaries so "tues" inside "tuesday's" still matches.
  const lower = text.toLowerCase()
  for (const [key, dow] of Object.entries(WEEKDAY_MAP)) {
    const re = new RegExp(`\\b${key}\\b`, 'i')
    if (re.test(lower)) return dow
  }
  return null
}

/**
 * Extract the first hour-of-day expression from the message.
 * Returns 0-23 in 24-hour form.
 *
 * Accepts:
 *   "11", "11am", "11 AM", "11:00", "11:00am",
 *   "2pm", "2 PM", "2:30 pm"
 *
 * Does NOT extract bare 2-digit numbers without AM/PM context
 * (would falsely match "for 11 people"). Hour-without-suffix only
 * matches when wrapped in time-ish context: "at 11", "11 works",
 * "the 11", "at 11:00".
 */
function extractHour(text: string): number | null {
  // 1. Explicit AM/PM forms — strongest signal.
  const ampm = text.match(
    /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)\b/i
  )
  if (ampm) {
    let hour = parseInt(ampm[1], 10)
    const suffix = ampm[3].toLowerCase().replace(/\./g, '')
    if (!Number.isFinite(hour) || hour < 1 || hour > 12) return null
    if (suffix === 'pm' && hour < 12) hour += 12
    if (suffix === 'am' && hour === 12) hour = 0
    return hour
  }

  // 2. Hour with colon (likely 24-hour). "14:00", "9:30".
  const colon = text.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/)
  if (colon) {
    const hour = parseInt(colon[1], 10)
    if (Number.isFinite(hour) && hour >= 0 && hour <= 23) return hour
  }

  // 3. Bare hour wrapped in time-ish context: "at 11", "the 11",
  //    "11 works", "11 sounds good".
  const contextual = text.match(
    /\b(?:at|the|@)\s+(\d{1,2})\b|\b(\d{1,2})\s+(?:works|sounds|is good|please)\b/i
  )
  if (contextual) {
    const raw = contextual[1] ?? contextual[2]
    const hour = parseInt(raw, 10)
    if (!Number.isFinite(hour) || hour < 0 || hour > 23) return null
    // Heuristic: 1..7 with no AM/PM probably means PM (afternoon
    // tour); 8..11 probably means AM. 12 = noon. 13..23 = exact.
    if (hour >= 0 && hour <= 7) return hour + 12
    return hour
  }

  return null
}

function isAffirmative(text: string): boolean {
  return AFFIRMATIVE_PHRASES.some((re) => re.test(text))
}
