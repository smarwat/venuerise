import type { RevenueOsSettings } from './settings'
import type {
  LeakageLead,
  LeakageOutboundActivity,
  LeakageInboundActivity,
  LeakageTour,
} from './leakage'

/**
 * Phase 8AS — Follow-Up Recovery Agent scoring.
 *
 * Pure helper. No Supabase, no React, no env reads. Mirrors the
 * `lib/revenue-os/leakage.ts` shape — callers fetch a narrow slice
 * of data + pass it in, the helper returns ranked recovery signals.
 *
 * Recovery is NOT autonomous AI. Each signal carries a static
 * `suggestedAction` that the operator can pre-fill into the
 * regenerate prompt; the operator still has to click Regenerate +
 * Approve. No background generation, no auto-send, no new tables.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type RecoveryReason =
  | 'cold_lead'
  | 'high_fit_idle'
  | 'qualified_no_tour'
  | 'tour_pending_confirm'
  | 'negotiation_stalled'

export type RecoverySuggestedActionKey =
  | 'reintroduce_and_ask_date'
  | 'offer_tour_slots'
  | 'confirm_tour_intent'
  | 'revive_budget_fit'
  | 'soft_check_in'

export interface RecoverySuggestedAction {
  key: RecoverySuggestedActionKey
  title: string
  /** The instruction string the operator can drop straight into the
   *  /api/ai/draft regenerate request as `instruction`. */
  instruction: string
  ctaLabel: string
}

export interface RecoveryLeadSignal {
  leadId: string
  /** Composite score 0–1000-ish. Higher = surface first. */
  score: number
  /** Every recovery reason that applies to the lead, in detection order. */
  reasons: RecoveryReason[]
  /** The single reason that drove the suggested action — most actionable. */
  primaryReason: RecoveryReason
  /** Operator-language label tied to the primary reason. */
  label: string
  /** Operator-language explanation of WHY this lead is on the queue. */
  helper: string
  /** Static suggestion the operator can pre-fill into Regenerate. */
  suggestedAction: RecoverySuggestedAction
  /** Days since the most meaningful activity baseline (for sort + display). */
  daysSinceActivity: number
}

// ---------------------------------------------------------------------------
// Suggested-action catalog
// ---------------------------------------------------------------------------

const SUGGESTED_ACTIONS: Record<
  RecoverySuggestedActionKey,
  RecoverySuggestedAction
> = {
  soft_check_in: {
    key: 'soft_check_in',
    title: 'Send a soft check-in',
    instruction:
      'Re-engage this lead with a brief, warm check-in. Acknowledge it has been a while, ask if they are still planning their event, and gently invite them to share an updated event date if anything has shifted.',
    ctaLabel: 'Soft check-in',
  },
  reintroduce_and_ask_date: {
    key: 'reintroduce_and_ask_date',
    title: 'Re-introduce + ask about updated date',
    instruction:
      'Briefly re-introduce the venue, lead with one specific reason it fits this couple (use what you already know), and ask whether their event date is still open. Keep it short, warm, and end with one clear question.',
    ctaLabel: 'Re-introduce',
  },
  offer_tour_slots: {
    key: 'offer_tour_slots',
    title: 'Offer two tour windows',
    instruction:
      'Offer two specific tour windows that match their event window. Frame the tour as the next natural step. Do not quote hard prices; invite them to bring questions in person.',
    ctaLabel: 'Offer tour',
  },
  confirm_tour_intent: {
    key: 'confirm_tour_intent',
    title: 'Confirm they are still planning to attend',
    instruction:
      'Send a warm reminder confirming their scheduled tour. Reconfirm the date and time, ask if they need parking or arrival guidance, and offer a graceful reschedule path if their plans changed.',
    ctaLabel: 'Confirm tour',
  },
  revive_budget_fit: {
    key: 'revive_budget_fit',
    title: 'Revive the conversation around fit',
    instruction:
      'Acknowledge that negotiation has slowed. Reaffirm what they liked, propose one tangible next step (a hold on a date, a short call, a revised package), and end with one clear question. Do not push price discounts.',
    ctaLabel: 'Revive negotiation',
  },
}

const REASON_TO_ACTION: Record<RecoveryReason, RecoverySuggestedActionKey> = {
  cold_lead: 'soft_check_in',
  high_fit_idle: 'reintroduce_and_ask_date',
  qualified_no_tour: 'offer_tour_slots',
  tour_pending_confirm: 'confirm_tour_intent',
  negotiation_stalled: 'revive_budget_fit',
}

// Higher = more actionable. Drives `primaryReason` selection when a
// lead has multiple reasons. Order intentionally favors "doing
// something specific" over "checking in vaguely".
const REASON_PRIORITY: Record<RecoveryReason, number> = {
  tour_pending_confirm: 5,
  negotiation_stalled: 4,
  qualified_no_tour: 3,
  high_fit_idle: 2,
  cold_lead: 1,
}

const REASON_LABEL: Record<RecoveryReason, string> = {
  cold_lead: 'Cold lead',
  high_fit_idle: 'High-fit idle',
  qualified_no_tour: 'Qualified, no tour booked',
  tour_pending_confirm: 'Tour pending confirmation',
  negotiation_stalled: 'Negotiation stalled',
}

// ---------------------------------------------------------------------------
// Time helpers
// ---------------------------------------------------------------------------

const MS_PER_DAY = 24 * 60 * 60 * 1000
const MS_PER_HOUR = 60 * 60 * 1000

function daysAgoMs(now: Date, days: number): number {
  return now.getTime() - days * MS_PER_DAY
}
function hoursAgoMs(now: Date, hours: number): number {
  return now.getTime() - hours * MS_PER_HOUR
}

// ---------------------------------------------------------------------------
// Stage helpers
// ---------------------------------------------------------------------------

const STAGES_IN_FLIGHT = new Set([
  'new_inquiry',
  'qualified',
  'tour_scheduled',
  'tour_completed',
  'negotiation',
])

// ---------------------------------------------------------------------------
// computeRecoverySignals
// ---------------------------------------------------------------------------

interface RecoveryInput {
  leads: ReadonlyArray<LeakageLead>
  inbound: ReadonlyArray<LeakageInboundActivity>
  outbound: ReadonlyArray<LeakageOutboundActivity>
  tours: ReadonlyArray<LeakageTour>
  settings: RevenueOsSettings
  now?: Date
}

/**
 * Compute per-lead recovery signals.
 *
 * Returns leads with at LEAST one active reason, ranked by:
 *   1. lead_score desc (highest-value first)
 *   2. number of active reasons (multiple-signal leads outrank single)
 *   3. days since meaningful activity (older first within the same band)
 *
 * `daysSinceActivity` uses the same baseline rule as the Phase 8AR
 * cold-lead fix: prefer the last inbound; fall back to `created_at`
 * when no inbound exists.
 *
 * Caller decides how many to surface (top 5 on the dashboard card,
 * full list for the leads-board filter).
 */
export function computeRecoverySignals(
  input: RecoveryInput
): RecoveryLeadSignal[] {
  const now = input.now ?? new Date()
  const { settings } = input

  // Build lookup maps for O(1) per-lead probes.
  const inboundByLead = new Map<string, string | null>()
  for (const i of input.inbound) inboundByLead.set(i.lead_id, i.last_inbound_at)

  const outboundByLead = new Map<string, string | null>()
  for (const o of input.outbound) outboundByLead.set(o.lead_id, o.first_outbound_at)

  const toursByLead = new Map<string, LeakageTour[]>()
  for (const t of input.tours) {
    const arr = toursByLead.get(t.lead_id) ?? []
    arr.push(t)
    toursByLead.set(t.lead_id, arr)
  }

  const coldCutoff = daysAgoMs(now, settings.coldLeadDays)
  const highFitCutoff = hoursAgoMs(now, settings.staleHighFitHours)
  // "Negotiation stalled" is a slower-moving signal than the general
  // high-fit-idle one — operators expect negotiations to take a few
  // days. We use 2x the high-fit window so a normal back-and-forth
  // doesn't show up as stalled.
  const negotiationStalledCutoff = hoursAgoMs(
    now,
    settings.staleHighFitHours * 2
  )

  const results: RecoveryLeadSignal[] = []

  for (const lead of input.leads) {
    if (!STAGES_IN_FLIGHT.has(lead.stage)) continue

    const reasons: RecoveryReason[] = []
    const lastInbound = inboundByLead.get(lead.id) ?? null
    // Phase 8AR baseline: prefer last inbound, fall back to lead
    // created_at when no inbound exists. Same rule used by the
    // leakage helper so the two surfaces agree on "when did we last
    // hear from this lead."
    const baselineMs = new Date(lastInbound ?? lead.created_at).getTime()
    const updatedMs = new Date(lead.updated_at).getTime()
    const leadTours = toursByLead.get(lead.id) ?? []

    // 1. cold_lead: in-flight (excluding brand-new) + baseline past
    //    the cold cutoff.
    if (
      lead.stage !== 'new_inquiry' &&
      Number.isFinite(baselineMs) &&
      baselineMs < coldCutoff
    ) {
      reasons.push('cold_lead')
    }

    // 2. high_fit_idle: score >= threshold + updated past stale
    //    window. We exclude new_inquiry because Speed-to-Lead owns
    //    that surface; the recovery agent picks up the lead once
    //    it has at least crossed into qualification.
    if (
      lead.lead_score >= settings.highFitThreshold &&
      lead.stage !== 'new_inquiry' &&
      Number.isFinite(updatedMs) &&
      updatedMs < highFitCutoff
    ) {
      reasons.push('high_fit_idle')
    }

    // 3. qualified_no_tour: qualified-stage leads with no tour row
    //    yet. Negotiation is intentionally NOT included here — at
    //    that stage the conversation has usually moved past slot
    //    selection.
    if (lead.stage === 'qualified' && leadTours.length === 0) {
      reasons.push('qualified_no_tour')
    }

    // 4. tour_pending_confirm: this lead has a future tour stuck in
    //    'scheduled' (not yet 'confirmed').
    const hasPendingTour = leadTours.some(
      (t) =>
        t.status === 'scheduled' &&
        t.scheduled_at !== null &&
        new Date(t.scheduled_at).getTime() > now.getTime()
    )
    if (hasPendingTour) reasons.push('tour_pending_confirm')

    // 5. negotiation_stalled: negotiation stage that hasn't been
    //    touched in 2x the high-fit window.
    if (
      lead.stage === 'negotiation' &&
      Number.isFinite(updatedMs) &&
      updatedMs < negotiationStalledCutoff
    ) {
      reasons.push('negotiation_stalled')
    }

    if (reasons.length === 0) continue

    // Primary reason = highest priority among the active ones.
    const primaryReason = [...reasons].sort(
      (a, b) => REASON_PRIORITY[b] - REASON_PRIORITY[a]
    )[0]

    const daysSinceActivity = Number.isFinite(baselineMs)
      ? Math.max(0, Math.floor((now.getTime() - baselineMs) / MS_PER_DAY))
      : 0

    // Composite ranking score. lead_score dominates; reason count
    // tie-breaks; days-since-activity surfaces older stalls within
    // the same score+reason band.
    //   - lead_score: 0..100 → weight ×10 (so 100 fit = 1000)
    //   - reasons: 1..5 → weight ×20
    //   - daysSinceActivity: capped at 60 so a 5-year-old lead can't
    //     out-rank a hot one
    const score =
      lead.lead_score * 10 +
      reasons.length * 20 +
      Math.min(60, daysSinceActivity)

    results.push({
      leadId: lead.id,
      score,
      reasons,
      primaryReason,
      label: REASON_LABEL[primaryReason],
      helper: helperForReason(primaryReason, {
        daysSinceActivity,
        lastInbound,
        hasInbound: lastInbound !== null,
        leadStage: lead.stage,
      }),
      suggestedAction: SUGGESTED_ACTIONS[REASON_TO_ACTION[primaryReason]],
      daysSinceActivity,
    })
  }

  // Stable sort by composite score, then by lead_score for visual
  // determinism in test fixtures.
  results.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    return b.daysSinceActivity - a.daysSinceActivity
  })
  return results
}

// ---------------------------------------------------------------------------
// Human-language helper text
// ---------------------------------------------------------------------------

interface HelperContext {
  daysSinceActivity: number
  lastInbound: string | null
  hasInbound: boolean
  leadStage: string
}

function helperForReason(
  reason: RecoveryReason,
  ctx: HelperContext
): string {
  const days = ctx.daysSinceActivity
  switch (reason) {
    case 'cold_lead': {
      const since = ctx.hasInbound
        ? `No inbound reply in ${days} day${days === 1 ? '' : 's'}.`
        : `No reply since first contact ${days} day${days === 1 ? '' : 's'} ago.`
      return `${since} This lead may need a soft check-in.`
    }
    case 'high_fit_idle':
      return `High-fit lead has not moved in ${days} day${days === 1 ? '' : 's'}. Re-introduce the venue and ask if their date is still open.`
    case 'qualified_no_tour':
      return `Qualified lead has no tour booked. Offer two tour windows.`
    case 'tour_pending_confirm':
      return `Tour is on the calendar but unconfirmed. Send a warm confirm + reschedule path.`
    case 'negotiation_stalled':
      return `Negotiation has been quiet for ${days} day${days === 1 ? '' : 's'}. Suggest one tangible next step.`
  }
}

// ---------------------------------------------------------------------------
// Filter / lookup helpers exposed for surfaces
// ---------------------------------------------------------------------------

/**
 * Convenience: return only the leadIds (sorted by composite score).
 * The KanbanBoard's `?leakage=follow_up_recovery` filter consumes
 * this to narrow its in-memory lead list.
 */
export function recoveryLeadIds(signals: RecoveryLeadSignal[]): string[] {
  return signals.map((s) => s.leadId)
}

export const RECOVERY_REASON_LABELS = REASON_LABEL
export const RECOVERY_SUGGESTED_ACTIONS = SUGGESTED_ACTIONS
