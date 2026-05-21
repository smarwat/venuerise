/**
 * Phase 8BD — Reactivation candidate surfacing.
 *
 * Pure module. No Supabase, no React, no env. The Overview
 * `ReactivationQueueCard`, the leads-board `?leakage=reactivation`
 * filter, the LeadDetailDrawer reactivation panel, and the
 * `/api/admin/leads/reactivation-queue` endpoint all funnel
 * through `computeReactivationSignals` so the candidacy + score +
 * suggested instruction match across every surface.
 *
 * Safety posture (the same line gets repeated everywhere on
 * purpose):
 *   - These are SUGGESTIONS surfaced to the operator. Nothing in
 *     this file (or in the surfaces that consume it) sends a
 *     message, opens a conversation, or queues an outbound. The
 *     reactivation reply still flows through Regenerate +
 *     Approve & send, which still flow through the Phase 8AV–
 *     8BA brand voice / autopilot safety stack.
 *   - `autonomous_sending_still_disabled` (from 8AX) remains
 *     `mounted`.
 *   - Lost reasons are OPERATOR-supplied. The helper never
 *     synthesizes a reason — when `metadata.lost_reason` is
 *     missing, the lead surfaces with `reason: null`.
 */

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/**
 * Operator-supplied lost reason. The UI drop-down on the
 * LeadDetailDrawer offers these six exact strings; the PATCH route
 * at `/api/leads/[id]` rejects anything else. Storage is under
 * `leads.metadata.lost_reason.reason`.
 *
 * `other` is a deliberate escape hatch — operators won't pick a
 * structured reason in every case, and forcing them to does
 * worse than letting them park the lead with a free-text note.
 */
export type LostReason =
  | 'priced_out'
  | 'date_unavailable'
  | 'picked_competitor'
  | 'ghosted'
  | 'not_a_fit'
  | 'other'

export const LOST_REASON_VALUES: ReadonlyArray<LostReason> = [
  'priced_out',
  'date_unavailable',
  'picked_competitor',
  'ghosted',
  'not_a_fit',
  'other',
]

export function isLostReason(value: unknown): value is LostReason {
  return (
    typeof value === 'string' &&
    (LOST_REASON_VALUES as ReadonlyArray<string>).includes(value)
  )
}

/**
 * Operator-readable labels. Kept in one place so the drawer
 * select + the queue card row + the digest section + the admin
 * endpoint response all show the same text.
 */
export const LOST_REASON_LABEL: Record<LostReason, string> = {
  priced_out: 'Priced out',
  date_unavailable: 'Date unavailable',
  picked_competitor: 'Picked competitor',
  ghosted: 'Ghosted',
  not_a_fit: 'Not a fit',
  other: 'Other',
}

/**
 * `strong_candidate` — high-signal actionable reason
 * (`priced_out` / `date_unavailable` / `ghosted`) AND last
 * contact > 30 days AND event_date is past or > 60 days out.
 *
 * `possible_candidate` — softer signal. `other` with enough
 * cooling time, or one of the strong reasons but missing the
 * cooling threshold.
 *
 * `not_candidate` — `picked_competitor` (won't change minds),
 * `not_a_fit` (the operator already said this lead isn't a
 * match), event_date inside the 60-day no-touch window, or
 * lost-but-not-yet-cooled.
 */
export type ReactivationCandidacy =
  | 'strong_candidate'
  | 'possible_candidate'
  | 'not_candidate'

export interface ReactivationSignal {
  leadId: string
  candidacy: ReactivationCandidacy
  reason: LostReason | null
  label: string
  rationale: string
  suggestedInstruction: string
  /** 0–100 composite score; higher = better candidate. */
  score: number
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/**
 * Minimal lead projection the helper needs. The Overview card +
 * the admin endpoint both project their server rows into this
 * shape; tests can supply fixtures directly.
 */
export interface LeadLike {
  id: string
  name?: string | null
  stage: string
  lead_score: number | null
  event_date: string | null
  updated_at?: string | null
  /** Parsed value of `metadata.lost_reason.reason`. */
  lost_reason: LostReason | null
}

export interface ReactivationInput {
  leads: ReadonlyArray<LeadLike>
  /** Map of `leadId → last lead-role message timestamp` (ISO). */
  lastMessages: Record<string, string | null>
  now?: Date
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const COOLING_DAYS = 30
const UPCOMING_EVENT_DAYS = 60
const POSSIBLE_CANDIDATE_COOLING_DAYS = 60

const STRONG_REASONS: ReadonlySet<LostReason> = new Set([
  'priced_out',
  'date_unavailable',
  'ghosted',
])

const NEVER_REASONS: ReadonlySet<LostReason> = new Set([
  'picked_competitor',
  'not_a_fit',
])

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

/**
 * Compute one reactivation signal per `lost`-stage lead.
 *
 * Returns a sorted list with `strong_candidate` first, then
 * `possible_candidate`. `not_candidate` rows are dropped — the
 * Overview card + admin endpoint never need them.
 *
 * Hard rules (mirror the spec):
 *   - Only `stage === 'lost'`.
 *   - Actionable reasons: `priced_out` / `date_unavailable` /
 *     `ghosted` → can be `strong_candidate`.
 *   - `picked_competitor` and `not_a_fit` are excluded
 *     entirely (operator already said they won't reactivate).
 *   - `other` can be `possible_candidate` only if enough time
 *     has passed (≥ 60 days since last contact).
 *   - Last lead-role message must be older than 30 days.
 *   - If `event_date` is upcoming within 60 days, do not
 *     suggest reactivation.
 *   - If `event_date` has passed, soft reactivation is still
 *     ok for the strong reasons (they may be planning their
 *     NEXT event).
 *
 * The score combines:
 *   - reason quality (40 pts for strong, 15 pts for `other`)
 *   - lead_score (0–40 pts)
 *   - days-cooled bonus (0–20 pts; caps at 180 days)
 */
export function computeReactivationSignals(
  input: ReactivationInput
): ReactivationSignal[] {
  const now = input.now ?? new Date()
  const out: ReactivationSignal[] = []
  for (const lead of input.leads ?? []) {
    if (!lead || lead.stage !== 'lost') continue
    const reason = lead.lost_reason
    // `picked_competitor` + `not_a_fit` never surface — the
    // operator already said they don't want to reach back out.
    if (reason && NEVER_REASONS.has(reason)) continue

    const lastAtRaw = input.lastMessages[lead.id] ?? null
    const lastAtMs = lastAtRaw ? Date.parse(lastAtRaw) : null
    const daysSinceContact =
      lastAtMs !== null && Number.isFinite(lastAtMs)
        ? Math.floor((now.getTime() - lastAtMs) / (24 * 60 * 60 * 1000))
        : null

    // Cooling gate: no last-message timestamp OR last-message
    // within the cooling window → not a candidate today.
    if (daysSinceContact === null || daysSinceContact < COOLING_DAYS) {
      continue
    }

    // Event-date gate: if the wedding is happening soon, leave
    // them alone — they don't need our reactivation pitch in the
    // last 8 weeks before their event.
    const eventDateMs = parseEventDate(lead.event_date)
    if (eventDateMs !== null) {
      const daysToEvent = Math.floor(
        (eventDateMs - now.getTime()) / (24 * 60 * 60 * 1000)
      )
      if (daysToEvent >= 0 && daysToEvent <= UPCOMING_EVENT_DAYS) {
        continue
      }
    }

    // Candidacy tier.
    let candidacy: ReactivationCandidacy = 'not_candidate'
    if (reason && STRONG_REASONS.has(reason)) {
      candidacy = 'strong_candidate'
    } else if (reason === 'other') {
      candidacy =
        daysSinceContact >= POSSIBLE_CANDIDATE_COOLING_DAYS
          ? 'possible_candidate'
          : 'not_candidate'
    } else if (reason === null) {
      // Missing reason — still possible if enough time passed,
      // but down-rank against rows with a clear reason.
      candidacy =
        daysSinceContact >= POSSIBLE_CANDIDATE_COOLING_DAYS
          ? 'possible_candidate'
          : 'not_candidate'
    }
    if (candidacy === 'not_candidate') continue

    out.push({
      leadId: lead.id,
      candidacy,
      reason,
      label: buildLabel(reason),
      rationale: buildRationale({
        reason,
        daysSinceContact,
        eventDatePassed:
          eventDateMs !== null && eventDateMs < now.getTime(),
      }),
      suggestedInstruction: buildSuggestedInstruction(reason),
      score: computeScore({
        reason,
        leadScore: lead.lead_score,
        daysSinceContact,
      }),
    })
  }
  // Sort: strong before possible, then by score desc.
  out.sort((a, b) => {
    if (a.candidacy !== b.candidacy) {
      return a.candidacy === 'strong_candidate' ? -1 : 1
    }
    return b.score - a.score
  })
  return out
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function parseEventDate(raw: string | null | undefined): number | null {
  if (!raw) return null
  const parsed = new Date(raw)
  if (!Number.isFinite(parsed.getTime())) return null
  // Date-only inputs land as UTC midnight; bump to end-of-day
  // local so "tour the morning of the event" doesn't accidentally
  // count the event as already-past.
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const local = new Date(raw)
    local.setHours(23, 59, 59, 999)
    return local.getTime()
  }
  return parsed.getTime()
}

function buildLabel(reason: LostReason | null): string {
  if (reason === null) return 'Lost · reason unknown'
  return `Lost · ${LOST_REASON_LABEL[reason].toLowerCase()}`
}

function buildRationale(ctx: {
  reason: LostReason | null
  daysSinceContact: number
  eventDatePassed: boolean
}): string {
  const cooled = `${ctx.daysSinceContact} days since last contact`
  if (ctx.reason === 'priced_out') {
    return `${cooled}. Budget objections often soften over time — worth a soft check-in.`
  }
  if (ctx.reason === 'date_unavailable') {
    return `${cooled}. The original date may have shifted, or they may be planning a different event.`
  }
  if (ctx.reason === 'ghosted') {
    return `${cooled}. A low-pressure check-in often re-opens the door without feeling pushy.`
  }
  if (ctx.reason === 'other') {
    return `${cooled}. Enough cooling time has passed that a gentle check-in is reasonable.`
  }
  return ctx.eventDatePassed
    ? `${cooled}. Lost without a recorded reason; cooled long enough to revisit.`
    : `${cooled}. Lost without a recorded reason; consider a soft re-engagement.`
}

function buildSuggestedInstruction(reason: LostReason | null): string {
  switch (reason) {
    case 'priced_out':
      return 'Write a soft reactivation message that acknowledges budget sensitivity and offers a lower-pressure conversation about flexible packages.'
    case 'date_unavailable':
      return 'Write a warm note asking if their date or venue search changed, and offer to help if they are still looking.'
    case 'ghosted':
      return 'Write a brief, friendly check-in that makes it easy to respond with yes or no.'
    case 'other':
      return 'Write a gentle reactivation message without assuming why they went quiet.'
    case null:
      return 'Write a brief, warm reactivation message that re-opens the conversation without pressuring them.'
    // `picked_competitor` and `not_a_fit` are filtered out
    // upstream, but TypeScript wants exhaustive coverage —
    // return a benign fallback for safety.
    case 'picked_competitor':
    case 'not_a_fit':
      return 'Write a brief, warm message thanking them for considering us and leaving the door open if their plans change.'
  }
}

function computeScore(ctx: {
  reason: LostReason | null
  leadScore: number | null
  daysSinceContact: number
}): number {
  // Reason quality: strong reasons dominate the score, weaker
  // signals contribute less.
  let reasonPts = 0
  if (ctx.reason && STRONG_REASONS.has(ctx.reason)) reasonPts = 40
  else if (ctx.reason === 'other') reasonPts = 15
  else if (ctx.reason === null) reasonPts = 10

  // Lead score scaled 0–40. Clamped against junk.
  const ls =
    typeof ctx.leadScore === 'number' && Number.isFinite(ctx.leadScore)
      ? Math.max(0, Math.min(100, ctx.leadScore))
      : 0
  const leadPts = (ls / 100) * 40

  // Days cooled: 0–20 pts; caps at 180 days so a venue with
  // very old leads doesn't run the score off the chart.
  const coolDays = Math.max(0, Math.min(180, ctx.daysSinceContact))
  const coolPts = (coolDays / 180) * 20

  return Math.round(reasonPts + leadPts + coolPts)
}
