import { parseRevenueOsSettings, type RevenueOsSettings } from './settings'
import {
  computeRevenueLeakage,
  type LeakageInboundActivity,
  type LeakageLead,
  type LeakageOutboundActivity,
  type LeakageSignal,
  type LeakageTour,
} from './leakage'
import {
  computeRecoverySignals,
  type RecoveryLeadSignal,
  type RecoveryReason,
} from './recovery'
import {
  computeTourBookingSignals,
  type TourBookingSignal,
} from './tour-booking'
import {
  computeSpeedToLeadRollup,
  type SpeedToLeadRollup,
} from './sla-rollup'
import {
  computeReactivationSignals,
  type LostReason,
} from './reactivation'

/**
 * Phase 8AU — Revenue OS digest summary composer.
 *
 * Pure helper. No Supabase, no React, no env reads. Composes the four
 * Revenue OS scoring helpers into ONE owner-readable summary the
 * digest cron + preview + manual-send routes share.
 *
 * Why this layer:
 *   - We want the daily/weekly email to LEAD with revenue language
 *     (speed-to-lead miss rate, stalled high-value leads, tour
 *     conversion) instead of raw `tour_status_events` counts.
 *   - Multiple call sites (cron, preview, manual) all need the same
 *     output shape. Centralizing here keeps them in lockstep + lets
 *     us unit-test the composer in isolation.
 *
 * The composer takes the same narrow input slices the underlying
 * helpers already accept; callers are responsible for fetching that
 * data. See `fetchRevenueOsDigestInputs` in
 * `lib/jobs/functions/operator-activity-digest.ts` for the shared
 * Supabase fetch.
 */

export interface RevenueOsDigestLeadSlice extends LeakageLead {
  name?: string | null
}

export interface RevenueOsDigestSummary {
  speedToLead: {
    totalMeasured: number
    met: number
    missed: number
    pendingOverdue: number
    metRate: number | null
    medianMinutesToFirstReply: number | null
  }
  recovery: {
    stalledLeads: number
    highFitStalled: number
    topLeads: Array<{
      lead_id: string
      name: string
      lead_score: number | null
      primary_reason: RecoveryReason
      suggested_action_title: string
    }>
  }
  tourBooking: {
    qualifiedNoTour: number
    unconfirmedTours: number
    toursToday: number
    topUnconfirmed: Array<{
      tour_id: string
      lead_id: string
      name: string
      scheduled_at: string
      lead_score: number | null
    }>
  }
  leakage: {
    totalAttentionItems: number
    topPriorityLabel: string | null
  }
  // Phase 8BD — Reactivation candidates this week. Counts +
  // top 3 lost leads where the reactivation helper classified
  // them as `strong` or `possible`. The digest body links to
  // `/dashboard/leads?leakage=reactivation` so the operator can
  // open the full queue.
  reactivation: {
    candidateCount: number
    strongCount: number
    topLeads: Array<{
      lead_id: string
      name: string
      lead_score: number | null
      reason: LostReason | null
      candidacy: 'strong_candidate' | 'possible_candidate'
      label: string
    }>
  }
}

interface ComposeArgs {
  leads: ReadonlyArray<RevenueOsDigestLeadSlice>
  inbound: ReadonlyArray<LeakageInboundActivity>
  outbound: ReadonlyArray<LeakageOutboundActivity>
  tours: ReadonlyArray<LeakageTour>
  /** Parsed `RevenueOsSettings`. Callers can pass `parseRevenueOsSettings(metadata)`. */
  settings: RevenueOsSettings
  now?: Date
  /** Speed-to-Lead window in days. Default 7 (mirrors the rollup card). */
  speedToLeadWindowDays?: number
  // Phase 8BD — lost leads + their last lead-role message
  // timestamps + their operator-supplied reasons feed the
  // reactivation block. Optional: when omitted, the reactivation
  // section comes out as zero counts (consistent with a venue
  // that has no lost leads yet).
  lostLeads?: ReadonlyArray<{
    id: string
    name?: string | null
    stage: string
    lead_score: number | null
    event_date: string | null
    updated_at: string
    lost_reason: LostReason | null
  }>
  lostLeadLastInbound?: Record<string, string | null>
}

const TOP_RECOVERY_COUNT = 3
const TOP_UNCONFIRMED_COUNT = 3
const HIGH_FIT_STALLED_FLOOR_SCORE = 820

function pickTopRecovery(
  signals: ReadonlyArray<RecoveryLeadSignal>,
  nameByLeadId: Map<string, string | null>
): RevenueOsDigestSummary['recovery']['topLeads'] {
  return signals.slice(0, TOP_RECOVERY_COUNT).map((s) => ({
    lead_id: s.leadId,
    name: nameByLeadId.get(s.leadId) ?? 'Unknown lead',
    lead_score: null, // populated below from the leads slice
    primary_reason: s.primaryReason,
    suggested_action_title: s.suggestedAction.title,
  }))
}

function pickTopUnconfirmed(
  signals: ReadonlyArray<TourBookingSignal>,
  nameByLeadId: Map<string, string | null>
): RevenueOsDigestSummary['tourBooking']['topUnconfirmed'] {
  // The signal helper already orders by soonest scheduled_at for
  // unconfirmed-scheduled rows. We just slice + project.
  return signals
    .filter((s) => s.signal === 'tour_scheduled_unconfirmed')
    .slice(0, TOP_UNCONFIRMED_COUNT)
    .map((s) => ({
      tour_id: s.tourId ?? '',
      lead_id: s.leadId,
      name: nameByLeadId.get(s.leadId) ?? 'Unknown lead',
      scheduled_at: s.scheduledAt ?? '',
      lead_score: null,
    }))
}

/**
 * Compose the Revenue OS digest summary from the same input slices
 * the underlying helpers consume. Pure — every value is derived;
 * nothing is fetched.
 */
export function composeRevenueOsDigestSummary(
  args: ComposeArgs
): RevenueOsDigestSummary {
  const now = args.now ?? new Date()
  const windowDays = args.speedToLeadWindowDays ?? 7

  // Build a name lookup so the recovery + tour-booking projections
  // can attach `name` without a second pass over `leads`.
  const nameByLeadId = new Map<string, string | null>()
  const scoreByLeadId = new Map<string, number | null>()
  for (const l of args.leads) {
    nameByLeadId.set(l.id, l.name ?? null)
    scoreByLeadId.set(l.id, l.lead_score ?? null)
  }

  // 1. Speed-to-Lead rollup.
  const speedRollup: SpeedToLeadRollup = computeSpeedToLeadRollup({
    leads: args.leads.map((l) => ({ id: l.id, created_at: l.created_at })),
    outbound: args.outbound,
    settings: { firstReplySlaMinutes: args.settings.firstReplySlaMinutes },
    now,
    days: windowDays,
  })

  // 2. Recovery signals (ranked).
  const recoverySignals: RecoveryLeadSignal[] = computeRecoverySignals({
    leads: args.leads,
    inbound: args.inbound,
    outbound: args.outbound,
    tours: args.tours,
    settings: args.settings,
    now,
  })
  const topRecovery = pickTopRecovery(recoverySignals, nameByLeadId).map(
    (row) => ({
      ...row,
      lead_score: scoreByLeadId.get(row.lead_id) ?? null,
    })
  )
  const stalledLeads = recoverySignals.length
  const highFitStalled = recoverySignals.filter(
    (s) => s.score >= HIGH_FIT_STALLED_FLOOR_SCORE
  ).length

  // 3. Tour Booking signals.
  const tourSignals: TourBookingSignal[] = computeTourBookingSignals({
    leads: args.leads,
    tours: args.tours,
    settings: { highFitThreshold: args.settings.highFitThreshold },
    now,
  })
  const qualifiedNoTour = tourSignals.filter(
    (s) => s.signal === 'qualified_no_tour'
  ).length
  const unconfirmedTours = tourSignals.filter(
    (s) => s.signal === 'tour_scheduled_unconfirmed'
  ).length
  const toursToday = tourSignals.filter((s) => s.signal === 'tour_today').length
  const topUnconfirmed = pickTopUnconfirmed(tourSignals, nameByLeadId).map(
    (row) => ({
      ...row,
      lead_score: scoreByLeadId.get(row.lead_id) ?? null,
    })
  )

  // 4. Leakage roll-up. We compose this to mirror the
  //    RevenueLeakageBrief card numbers — total non-zero count + the
  //    highest-severity signal label (so the digest opener can name
  //    the top risk without inspecting the array).
  const leakageSignals: LeakageSignal[] = computeRevenueLeakage({
    leads: args.leads,
    outbound: args.outbound,
    inbound: args.inbound,
    tours: args.tours,
    settings: args.settings,
    now,
  })
  const SEVERITY_RANK: Record<LeakageSignal['severity'], number> = {
    red: 4,
    amber: 3,
    blue: 2,
    slate: 1,
  }
  let topPriorityLabel: string | null = null
  let topSeverity = -1
  let totalAttention = 0
  for (const sig of leakageSignals) {
    if (sig.count <= 0) continue
    totalAttention += sig.count
    if (SEVERITY_RANK[sig.severity] > topSeverity) {
      topSeverity = SEVERITY_RANK[sig.severity]
      topPriorityLabel = sig.label
    }
  }

  // 5. Phase 8BD — reactivation candidates. Computed from the
  //    optional lost-leads slice + per-lead last lead-role
  //    message timestamps. Operator-supplied reasons only; the
  //    helper drops `picked_competitor` and `not_a_fit` and
  //    gates everything else on the cooling window.
  const lostLeads = args.lostLeads ?? []
  const lostLastInbound = args.lostLeadLastInbound ?? {}
  const reactivationSignals = computeReactivationSignals({
    leads: lostLeads.map((l) => ({
      id: l.id,
      name: l.name ?? null,
      stage: l.stage,
      lead_score: l.lead_score,
      event_date: l.event_date,
      updated_at: l.updated_at,
      lost_reason: l.lost_reason,
    })),
    lastMessages: lostLastInbound,
    now,
  })
  const reactivationNameById = new Map<string, string | null>()
  for (const l of lostLeads) {
    reactivationNameById.set(l.id, l.name ?? null)
  }
  const reactivationScoreById = new Map<string, number | null>()
  for (const l of lostLeads) {
    reactivationScoreById.set(l.id, l.lead_score ?? null)
  }
  const reactivationTop = reactivationSignals.slice(0, 3).map((s) => ({
    lead_id: s.leadId,
    name: reactivationNameById.get(s.leadId) ?? 'Unknown lead',
    lead_score: reactivationScoreById.get(s.leadId) ?? null,
    reason: s.reason,
    candidacy: s.candidacy as 'strong_candidate' | 'possible_candidate',
    label: s.label,
  }))
  const strongCount = reactivationSignals.filter(
    (s) => s.candidacy === 'strong_candidate'
  ).length

  return {
    speedToLead: {
      totalMeasured: speedRollup.total,
      met: speedRollup.met,
      missed: speedRollup.missed,
      pendingOverdue: speedRollup.pendingOverdue,
      metRate: speedRollup.metRate,
      medianMinutesToFirstReply: speedRollup.medianMinutesToFirstReply,
    },
    recovery: {
      stalledLeads,
      highFitStalled,
      topLeads: topRecovery,
    },
    tourBooking: {
      qualifiedNoTour,
      unconfirmedTours,
      toursToday,
      topUnconfirmed,
    },
    leakage: {
      totalAttentionItems: totalAttention,
      topPriorityLabel,
    },
    reactivation: {
      candidateCount: reactivationSignals.length,
      strongCount,
      topLeads: reactivationTop,
    },
  }
}

/**
 * Convenience wrapper used by the digest call sites that already
 * hold the raw `venues.metadata` value. Avoids forcing every caller
 * to import `parseRevenueOsSettings` separately.
 */
export function composeRevenueOsDigestSummaryFromMetadata(
  args: Omit<ComposeArgs, 'settings'> & { venueMetadata: unknown }
): RevenueOsDigestSummary {
  const { venueMetadata, ...rest } = args
  return composeRevenueOsDigestSummary({
    ...rest,
    settings: parseRevenueOsSettings(venueMetadata),
  })
}

/**
 * True when the summary has anything worth surfacing. The digest body
 * uses this to decide whether to render the section vs collapse it
 * to a single "looking calm" line so a venue with zero leakage
 * doesn't see a wall of zeros.
 */
export function summaryHasActionableContent(
  summary: RevenueOsDigestSummary
): boolean {
  return (
    summary.leakage.totalAttentionItems > 0 ||
    summary.recovery.stalledLeads > 0 ||
    summary.tourBooking.qualifiedNoTour > 0 ||
    summary.tourBooking.unconfirmedTours > 0 ||
    summary.tourBooking.toursToday > 0 ||
    summary.speedToLead.pendingOverdue > 0 ||
    (summary.speedToLead.metRate !== null &&
      summary.speedToLead.metRate < 1) ||
    // Phase 8BD — reactivation candidates count toward actionable
    // content too. A venue with only reactivation work this week
    // still deserves a digest body.
    summary.reactivation.candidateCount > 0
  )
}
