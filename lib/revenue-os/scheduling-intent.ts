/**
 * Phase 8BJ — Scheduling intent detector.
 *
 * Pure helper. No Supabase, no AI, no env. Used by the AI chat
 * pipeline to decide whether a lead's latest message is asking
 * about tour availability — if so, the orchestrator injects a
 * structured `TOUR_AVAILABILITY_CONTEXT` block into the prompt
 * so the model can answer with real venue availability instead
 * of saying "I don't have access to the calendar."
 *
 * Deterministic on purpose. We don't want to burn a model call
 * just to classify whether the lead is asking about tours.
 *
 * The detector is intentionally generous:
 *   - "any time" / "when can I come" / "available this weekend"
 *     all qualify as wantsTourAvailability
 *   - "book a tour for Tuesday at 3pm" qualifies as
 *     wantsSpecificBooking (still surfaces availability so the
 *     model can confirm the slot exists)
 *   - "what's the parking like" does NOT qualify
 *
 * False positives are cheap (model sees slot context it doesn't
 * use). False negatives are expensive (model says "I don't have
 * the calendar" — the bug this phase fixes). Bias toward false
 * positives.
 */

export type SchedulingTimeframe =
  | 'this_week'
  | 'next_week'
  | 'weekend'
  | 'specific_date'
  | 'general'
  | null

export interface SchedulingIntent {
  /** True when the message is asking about tour availability in
   *  any form (open-ended or constrained to a timeframe). */
  wantsTourAvailability: boolean
  /** True when the message names a specific date/time the lead
   *  wants to book at, e.g. "can I come Tuesday at 3?" */
  wantsSpecificBooking: boolean
  /** Soft hint at which calendar window the model should bias
   *  toward. `null` when no timeframe was detected. */
  timeframeLabel: SchedulingTimeframe
  /** Raw substring of the requested date text, if any —
   *  helps the model echo the lead's wording back. */
  requestedDateText: string | null
}

// ──────────────────────────────────────────────────────────────────────
//  Pattern dictionaries
// ──────────────────────────────────────────────────────────────────────

// Verbs and nouns that signal scheduling intent. Lowercased
// substring match (not whole-word) so "tours" / "touring" /
// "schedule a tour" all hit.
const SCHEDULING_KEYWORDS: ReadonlyArray<string> = [
  'tour',
  'visit',
  'come by',
  'come see',
  'come in',
  'come look',
  'walk through',
  'walkthrough',
  'appointment',
  'showing',
  'open house',
  'see the venue',
  'see the space',
  'see the property',
  'check out the venue',
  'check out the space',
  'stop by',
  'drop by',
  'see you in person',
]

// Availability-question phrasings, even without an explicit
// "tour" word.
const AVAILABILITY_KEYWORDS: ReadonlyArray<string> = [
  'available',
  'availability',
  'avail', // catches "avail" / "avails" / "avail time" — common typo / shorthand
  'opening',
  'openings',
  'slot',
  'slots',
  'time slot',
  'when can',
  'when are you',
  'when is',
  "when's",
  'what times',
  'what time',
  'what days',
  'free time',
  'free this',
  'open this',
  'open next',
  'have any time',
  'have any opening',
  'any time this',
  'any time next',
  'any times',
]

const TIMEFRAME_PATTERNS: ReadonlyArray<{
  re: RegExp
  label: Exclude<SchedulingTimeframe, null>
}> = [
  { re: /\bnext week\b/i, label: 'next_week' },
  { re: /\bthis week\b/i, label: 'this_week' },
  {
    re: /\b(this|next)\s+(weekend|sat|sat\.?|saturday|sun|sun\.?|sunday)\b/i,
    label: 'weekend',
  },
  { re: /\bweekend\b/i, label: 'weekend' },
  // Specific date hints — month name, "the 14th", "Tue 3pm", numeric date.
  {
    re: /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{1,2}/i,
    label: 'specific_date',
  },
  { re: /\bthe\s+\d{1,2}(st|nd|rd|th)\b/i, label: 'specific_date' },
  {
    re: /\b(mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)[a-z]*\.?\s+(at|@)?\s*\d/i,
    label: 'specific_date',
  },
  { re: /\b\d{1,2}\/\d{1,2}(\/\d{2,4})?\b/, label: 'specific_date' },
]

// Specific-booking patterns are scheduling intent + a concrete
// date / time the lead is proposing.
const SPECIFIC_BOOKING_PATTERNS: ReadonlyArray<RegExp> = [
  /\b(can i|could i|may i)\s+(come|tour|visit|stop by)\b/i,
  /\b(book|schedule|set up|put me down for|sign me up for)\b.{0,30}\b(tour|visit|appointment)\b/i,
  /\b(tour|visit|come by|stop by|appointment)\b.{0,40}\b(at|on|for)\s+\d/i,
  /\bi('ll| will)?\s*(take|grab)\s+(the\s+)?\d{1,2}\b/i, // "I'll take the 11am"
]

// ──────────────────────────────────────────────────────────────────────
//  Public detector
// ──────────────────────────────────────────────────────────────────────

export function detectSchedulingIntent(
  rawText: string | null | undefined
): SchedulingIntent {
  if (!rawText || typeof rawText !== 'string') {
    return emptyIntent()
  }
  const text = rawText.trim()
  if (text.length === 0) return emptyIntent()
  const lower = text.toLowerCase()

  const hasScheduling = SCHEDULING_KEYWORDS.some((kw) => lower.includes(kw))
  const hasAvailability = AVAILABILITY_KEYWORDS.some((kw) => lower.includes(kw))

  // "Tell me all the available times" — pure availability ask
  // even without the word "tour". Must qualify.
  const wantsTourAvailability =
    hasScheduling || (hasAvailability && hasTimeContext(lower))

  if (!wantsTourAvailability) {
    return emptyIntent()
  }

  let timeframeLabel: SchedulingTimeframe = null
  let requestedDateText: string | null = null
  for (const { re, label } of TIMEFRAME_PATTERNS) {
    const m = re.exec(text)
    if (m) {
      timeframeLabel = label
      requestedDateText = m[0]
      break
    }
  }
  if (timeframeLabel === null) {
    timeframeLabel = 'general'
  }

  const wantsSpecificBooking = SPECIFIC_BOOKING_PATTERNS.some((re) =>
    re.test(text)
  )

  return {
    wantsTourAvailability,
    wantsSpecificBooking,
    timeframeLabel,
    requestedDateText,
  }
}

// ──────────────────────────────────────────────────────────────────────
//  Internals
// ──────────────────────────────────────────────────────────────────────

function emptyIntent(): SchedulingIntent {
  return {
    wantsTourAvailability: false,
    wantsSpecificBooking: false,
    timeframeLabel: null,
    requestedDateText: null,
  }
}

/**
 * "Available" alone isn't enough — "are you available for catering"
 * doesn't mean tour availability. We require either a time word
 * (week, weekend, tomorrow, next Tuesday) or an explicit time
 * phrasing ("what times" / "when can").
 */
function hasTimeContext(lower: string): boolean {
  return (
    /\b(week|weekend|day|today|tomorrow|morning|afternoon|evening|am|pm|mon|tue|wed|thu|fri|sat|sun)\b/i.test(
      lower
    ) ||
    /\b(times|time slots|openings|slots|when)\b/i.test(lower)
  )
}
