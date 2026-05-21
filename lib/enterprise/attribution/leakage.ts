import { getLeadAttributionLabel } from '@/lib/enterprise/attribution/parse'
import type { SourceLabel } from '@/lib/enterprise/attribution/types'
import {
  computeRevenueLeakage,
  type LeakageInboundActivity,
  type LeakageLead,
  type LeakageOutboundActivity,
  type LeakageTour,
} from '@/lib/revenue-os/leakage'
import {
  computeRecoverySignals,
  recoveryLeadIds,
  type RecoveryLeadSignal,
} from '@/lib/revenue-os/recovery'
import {
  computeTourBookingSignals,
  tourBookingLeadIds,
} from '@/lib/revenue-os/tour-booking'
import {
  computeReactivationSignals,
  type LeadLike as ReactivationLeadLike,
} from '@/lib/revenue-os/reactivation'
import type { RevenueOsSettings } from '@/lib/revenue-os/settings'

/**
 * Phase 8BJ — Source-level revenue leakage drilldowns.
 *
 * Pure helper. Composes the existing Revenue OS signal helpers
 * (`computeRevenueLeakage`, `computeRecoverySignals`,
 * `computeTourBookingSignals`, `computeReactivationSignals`) and
 * groups every output by the lead's attribution source label.
 * No DB calls, no I/O, never throws.
 *
 * Honesty:
 *   - NOT ROAS. Ad spend is not connected. Booked / pipeline
 *     values are estimated from `leads.budget`.
 *   - Attribution is the captured / last-known signal at intake
 *     time; multi-touch is not supported.
 *   - Legacy leads with no `metadata.attribution` group under
 *     `Unknown` so operators see the unattributed bucket.
 *   - `topLeakageReason` is the per-source bucket with the
 *     highest count; ties resolve in a deterministic priority
 *     order so the UI doesn't flap between renders.
 */

export const SOURCE_LEAKAGE_DISCLAIMER =
  'Source leakage is based on captured attribution and Revenue OS signals. It is not ROAS — ad spend is not connected. Booked / pipeline values are estimated from operator-entered budgets.'

export type SourceLeakageLabel = SourceLabel | 'Unknown'

export type SourceLeakageKey =
  | 'slow_first_reply'
  | 'high_fit_idle'
  | 'no_tour_booked'
  | 'tour_pending_confirm'
  | 'cold_lead_recovery'
  | 'follow_up_recovery'
  | 'tour_booking'
  | 'reactivation'
  | 'lost'

export interface SourceLeakageBuckets {
  slowFirstReply: number
  highFitIdle: number
  noTourBooked: number
  tourPendingConfirm: number
  coldLeadRecovery: number
  followUpRecovery: number
  tourBooking: number
  reactivation: number
  lost: number
}

export interface SourceLeakageRow {
  sourceLabel: SourceLeakageLabel
  leadCount: number
  bookedCount: number
  estimatedPipelineValue: number
  estimatedBookedValue: number
  leakage: SourceLeakageBuckets
  topLeakageReason: SourceLeakageKey | null
  /** Total at-risk leads across the actionable leakage signals
   *  (everything except `lost`, which is terminal). */
  atRiskCount: number
  /** Per-bucket de-duplicated lead id list so the leads board
   *  filter can pre-narrow without re-running every helper. */
  leadIdsByLeakage: Record<SourceLeakageKey, string[]>
}

export interface SourceLeakageSummary {
  rows: SourceLeakageRow[]
  totals: {
    leadCount: number
    bookedCount: number
    atRiskCount: number
    estimatedPipelineValue: number
    estimatedBookedValue: number
  }
  disclaimer: string
}

// ── Inputs ──────────────────────────────────────────────────────────────

export interface SourceLeakageLeadLike extends LeakageLead {
  budget?: number | null
  event_date?: string | null
  metadata?: unknown
}

export interface SourceLeakageMessageLike {
  lead_id: string
  /** Earliest outbound / latest inbound (depending on slot). */
  first_outbound_at?: string | null
  last_inbound_at?: string | null
  /** Free-form fallback for callers that have raw message rows. */
  created_at?: string | null
  role?: string | null
}

export interface BuildSourceLeakageArgs {
  leads: ReadonlyArray<SourceLeakageLeadLike>
  tours: ReadonlyArray<LeakageTour>
  outbound: ReadonlyArray<LeakageOutboundActivity>
  inbound: ReadonlyArray<LeakageInboundActivity>
  /** Optional last-message map for reactivation. When omitted,
   *  reactivation falls back to no-recent-activity assumptions
   *  and may surface fewer rows. */
  lastMessages?: Record<string, string | null>
  settings: RevenueOsSettings
  now?: Date
}

// ── Helpers ─────────────────────────────────────────────────────────────

function emptyBuckets(): SourceLeakageBuckets {
  return {
    slowFirstReply: 0,
    highFitIdle: 0,
    noTourBooked: 0,
    tourPendingConfirm: 0,
    coldLeadRecovery: 0,
    followUpRecovery: 0,
    tourBooking: 0,
    reactivation: 0,
    lost: 0,
  }
}

function emptyLeadIdsByLeakage(): Record<SourceLeakageKey, string[]> {
  return {
    slow_first_reply: [],
    high_fit_idle: [],
    no_tour_booked: [],
    tour_pending_confirm: [],
    cold_lead_recovery: [],
    follow_up_recovery: [],
    tour_booking: [],
    reactivation: [],
    lost: [],
  }
}

function pushUnique(arr: string[], id: string) {
  if (id && !arr.includes(id)) arr.push(id)
}

function safeBudget(value: number | null | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 0
  return value
}

// Priority order for `topLeakageReason` tiebreak — actionable
// buckets first, terminal last. Operators get pointed at the
// "fix this first" bucket when two counts are tied.
const TOP_LEAK_PRIORITY: SourceLeakageKey[] = [
  'slow_first_reply',
  'tour_pending_confirm',
  'no_tour_booked',
  'high_fit_idle',
  'follow_up_recovery',
  'cold_lead_recovery',
  'tour_booking',
  'reactivation',
  'lost',
]

function topLeak(buckets: SourceLeakageBuckets): SourceLeakageKey | null {
  let bestKey: SourceLeakageKey | null = null
  let bestCount = 0
  let bestPriority = Number.MAX_SAFE_INTEGER
  for (const key of TOP_LEAK_PRIORITY) {
    const camel = SNAKE_TO_CAMEL[key]
    const count = (buckets as unknown as Record<string, number>)[camel] ?? 0
    if (count <= 0) continue
    const priority = TOP_LEAK_PRIORITY.indexOf(key)
    if (
      count > bestCount ||
      (count === bestCount && priority < bestPriority)
    ) {
      bestKey = key
      bestCount = count
      bestPriority = priority
    }
  }
  return bestKey
}

const SNAKE_TO_CAMEL: Record<SourceLeakageKey, keyof SourceLeakageBuckets> = {
  slow_first_reply: 'slowFirstReply',
  high_fit_idle: 'highFitIdle',
  no_tour_booked: 'noTourBooked',
  tour_pending_confirm: 'tourPendingConfirm',
  cold_lead_recovery: 'coldLeadRecovery',
  follow_up_recovery: 'followUpRecovery',
  tour_booking: 'tourBooking',
  reactivation: 'reactivation',
  lost: 'lost',
}

// ── Per-lead view ───────────────────────────────────────────────────────

export interface SourceLeakageForLeadArgs extends BuildSourceLeakageArgs {
  leadId: string
}

/**
 * For the LeadDetailDrawer source-context line. Returns the
 * single active leakage key (highest priority) that the lead
 * currently triggers, or null when the lead is clean.
 */
export function sourceLeakageForLead(
  args: SourceLeakageForLeadArgs
): SourceLeakageKey | null {
  const all = buildSourceLeakageSummary(args)
  for (const row of all.rows) {
    for (const key of TOP_LEAK_PRIORITY) {
      if (row.leadIdsByLeakage[key].includes(args.leadId)) return key
    }
  }
  return null
}

// ── Main entry point ────────────────────────────────────────────────────

export function buildSourceLeakageSummary(
  args: BuildSourceLeakageArgs
): SourceLeakageSummary {
  const now = args.now ?? new Date()

  // 1. Run every existing helper once over the FULL lead list.
  //    Each returns lead-id buckets we'll filter per source.
  const leakageSignals = computeRevenueLeakage({
    leads: args.leads,
    outbound: args.outbound,
    inbound: args.inbound,
    tours: args.tours,
    settings: args.settings,
    now,
  })

  const recoverySignals = computeRecoverySignals({
    leads: args.leads,
    inbound: args.inbound,
    outbound: args.outbound,
    tours: args.tours,
    settings: args.settings,
    now,
  })

  const tourBookingSignals = computeTourBookingSignals({
    leads: args.leads,
    tours: args.tours,
    settings: { highFitThreshold: args.settings.highFitThreshold },
    now,
  })

  // Reactivation needs the LeadLike shape + lastMessages map.
  const reactivationLeads: ReactivationLeadLike[] = args.leads.map((l) => ({
    id: l.id,
    name: null,
    stage: l.stage,
    lead_score: l.lead_score,
    event_date: l.event_date ?? null,
    updated_at: l.updated_at,
    lost_reason: extractLostReason(l.metadata),
  }))
  const reactivationSignals = computeReactivationSignals({
    leads: reactivationLeads,
    lastMessages: args.lastMessages ?? {},
    now,
  })

  // 2. Bucket every signal output by attribution source label.
  const buckets = new Map<SourceLeakageLabel, SourceLeakageRow>()
  const labelByLead = new Map<string, SourceLeakageLabel>()
  const ensure = (label: SourceLeakageLabel): SourceLeakageRow => {
    const existing = buckets.get(label)
    if (existing) return existing
    const row: SourceLeakageRow = {
      sourceLabel: label,
      leadCount: 0,
      bookedCount: 0,
      estimatedPipelineValue: 0,
      estimatedBookedValue: 0,
      leakage: emptyBuckets(),
      topLeakageReason: null,
      atRiskCount: 0,
      leadIdsByLeakage: emptyLeadIdsByLeakage(),
    }
    buckets.set(label, row)
    return row
  }

  // Lead-level pass: counts, booked / pipeline value, label map.
  for (const lead of args.leads) {
    const label =
      (getLeadAttributionLabel(lead.metadata) as SourceLeakageLabel | null) ??
      'Unknown'
    labelByLead.set(lead.id, label)
    const row = ensure(label)
    row.leadCount += 1
    const budget = safeBudget(lead.budget)
    row.estimatedPipelineValue += budget
    if (lead.stage === 'booked') {
      row.bookedCount += 1
      row.estimatedBookedValue += budget
    }
    if (lead.stage === 'lost') {
      row.leakage.lost += 1
      pushUnique(row.leadIdsByLeakage.lost, lead.id)
    }
  }

  // Leakage signals → counts + per-leakage lead id buckets.
  for (const signal of leakageSignals) {
    for (const id of signal.leadIds) {
      const label = labelByLead.get(id)
      if (!label) continue
      const row = ensure(label)
      switch (signal.key) {
        case 'slow_first_reply':
          if (!row.leadIdsByLeakage.slow_first_reply.includes(id)) {
            row.leadIdsByLeakage.slow_first_reply.push(id)
            row.leakage.slowFirstReply += 1
          }
          break
        case 'high_fit_idle':
          if (!row.leadIdsByLeakage.high_fit_idle.includes(id)) {
            row.leadIdsByLeakage.high_fit_idle.push(id)
            row.leakage.highFitIdle += 1
          }
          break
        case 'no_tour_booked':
          if (!row.leadIdsByLeakage.no_tour_booked.includes(id)) {
            row.leadIdsByLeakage.no_tour_booked.push(id)
            row.leakage.noTourBooked += 1
          }
          break
        case 'tour_pending_confirm':
          if (!row.leadIdsByLeakage.tour_pending_confirm.includes(id)) {
            row.leadIdsByLeakage.tour_pending_confirm.push(id)
            row.leakage.tourPendingConfirm += 1
          }
          break
        case 'cold_lead_recovery':
          if (!row.leadIdsByLeakage.cold_lead_recovery.includes(id)) {
            row.leadIdsByLeakage.cold_lead_recovery.push(id)
            row.leakage.coldLeadRecovery += 1
          }
          break
      }
    }
  }

  // Recovery → follow_up_recovery bucket.
  for (const id of recoveryLeadIds(recoverySignals)) {
    const label = labelByLead.get(id)
    if (!label) continue
    const row = ensure(label)
    if (!row.leadIdsByLeakage.follow_up_recovery.includes(id)) {
      row.leadIdsByLeakage.follow_up_recovery.push(id)
      row.leakage.followUpRecovery += 1
    }
  }
  // Suppress dead-code lint on the typed import — we explicitly
  // reference the type elsewhere via the union.
  void (null as unknown as RecoveryLeadSignal)

  // Tour-booking → tour_booking bucket (de-duped by lead).
  for (const id of tourBookingLeadIds(tourBookingSignals)) {
    const label = labelByLead.get(id)
    if (!label) continue
    const row = ensure(label)
    if (!row.leadIdsByLeakage.tour_booking.includes(id)) {
      row.leadIdsByLeakage.tour_booking.push(id)
      row.leakage.tourBooking += 1
    }
  }

  // Reactivation candidates. `computeReactivationSignals`
  // already filters out `not_candidate`; the remaining
  // `strong_candidate` / `possible_candidate` rows are all
  // real reactivation opportunities.
  for (const s of reactivationSignals) {
    const label = labelByLead.get(s.leadId)
    if (!label) continue
    const row = ensure(label)
    if (!row.leadIdsByLeakage.reactivation.includes(s.leadId)) {
      row.leadIdsByLeakage.reactivation.push(s.leadId)
      row.leakage.reactivation += 1
    }
  }

  // 3. Compute top leak + at-risk count per row.
  let totalLeads = 0
  let totalBooked = 0
  let totalAtRisk = 0
  let totalPipeline = 0
  let totalBookedValue = 0
  for (const row of buckets.values()) {
    row.topLeakageReason = topLeak(row.leakage)
    // at-risk = union of actionable bucket lead ids (skip `lost`).
    const atRisk = new Set<string>()
    for (const key of TOP_LEAK_PRIORITY) {
      if (key === 'lost') continue
      for (const id of row.leadIdsByLeakage[key]) atRisk.add(id)
    }
    row.atRiskCount = atRisk.size

    totalLeads += row.leadCount
    totalBooked += row.bookedCount
    totalAtRisk += row.atRiskCount
    totalPipeline += row.estimatedPipelineValue
    totalBookedValue += row.estimatedBookedValue
  }

  // Sort: at-risk count desc → lead count desc → booked desc.
  const rows = Array.from(buckets.values()).sort((a, b) => {
    if (b.atRiskCount !== a.atRiskCount) return b.atRiskCount - a.atRiskCount
    if (b.leadCount !== a.leadCount) return b.leadCount - a.leadCount
    return b.bookedCount - a.bookedCount
  })

  return {
    rows,
    totals: {
      leadCount: totalLeads,
      bookedCount: totalBooked,
      atRiskCount: totalAtRisk,
      estimatedPipelineValue: totalPipeline,
      estimatedBookedValue: totalBookedValue,
    },
    disclaimer: SOURCE_LEAKAGE_DISCLAIMER,
  }
}

// ── Lost-reason extraction ──────────────────────────────────────────────

import type { LostReason } from '@/lib/revenue-os/reactivation'
import { isLostReason } from '@/lib/revenue-os/reactivation'

function extractLostReason(metadata: unknown): LostReason | null {
  if (!metadata || typeof metadata !== 'object') return null
  const md = metadata as Record<string, unknown>
  const lr = md['lost_reason']
  if (!lr || typeof lr !== 'object') return null
  const reason = (lr as Record<string, unknown>)['reason']
  return isLostReason(reason) ? reason : null
}

// ── Operator-language labels for the UI ────────────────────────────────

export const SOURCE_LEAKAGE_LABEL: Record<SourceLeakageKey, string> = {
  slow_first_reply: 'Slow first reply',
  high_fit_idle: 'High-fit idle',
  no_tour_booked: 'No tour booked',
  tour_pending_confirm: 'Tour pending confirm',
  cold_lead_recovery: 'Cold recovery',
  follow_up_recovery: 'Follow-up recovery',
  tour_booking: 'Tour booking',
  reactivation: 'Reactivation',
  lost: 'Lost',
}
