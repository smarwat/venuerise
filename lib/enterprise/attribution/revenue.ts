import { getLeadAttributionLabel } from '@/lib/enterprise/attribution/parse'
import type { SourceLabel } from '@/lib/enterprise/attribution/types'

/**
 * Phase 8BI — Booked revenue attribution helper.
 *
 * Pure function. Groups leads + tours by attribution source
 * label and computes:
 *   - lead → tour rate
 *   - tour → booked rate
 *   - lead → booked rate
 *   - estimated pipeline value  (sum of budget across all leads)
 *   - estimated booked value    (sum of budget across booked leads)
 *
 * Honesty:
 *   - Booked value is ESTIMATED from `leads.budget`. There is
 *     no separate booked-contract-value field today; the
 *     helper labels its output as "estimated" so downstream UI
 *     can render the disclaimer.
 *   - Rates are null when the denominator is zero (avoids
 *     misleading 0 / 0 → 0 reports).
 *   - "Unknown" stays as its own bucket so operators see the
 *     fraction of booked revenue with no source data.
 *   - NO ROAS — ad spend is not connected.
 */

export const BOOKED_REVENUE_DISCLAIMER =
  'Estimated booked value uses the operator-entered lead budget. Ad spend is not connected — this is not true ROAS. Booked value remains an estimate until a final contract-value field is wired.'

export type AttributionRevenueSourceLabel = SourceLabel | 'Unknown'

export interface AttributionRevenueRow {
  sourceLabel: AttributionRevenueSourceLabel
  leadCount: number
  tourCount: number
  bookedCount: number
  estimatedPipelineValue: number
  estimatedBookedValue: number
  /** Null when leadCount === 0. */
  leadToTourRate: number | null
  /** Null when tourCount === 0. */
  tourToBookedRate: number | null
  /** Null when leadCount === 0. */
  leadToBookedRate: number | null
  /** ISO timestamp of the most-recent booked lead in this bucket. */
  lastBookedAt: string | null
}

export interface AttributionRevenueSummary {
  rows: AttributionRevenueRow[]
  totals: {
    leadCount: number
    tourCount: number
    bookedCount: number
    estimatedPipelineValue: number
    estimatedBookedValue: number
  }
  disclaimer: string
}

export interface RevenueLeadLike {
  id?: string | null
  stage?: string | null
  budget?: number | null
  /** ISO timestamp the lead row was last updated; used as a
   *  best-effort proxy for "booked at" since we don't have a
   *  dedicated booked_at column. Falls back to created_at. */
  updated_at?: string | null
  created_at?: string | null
  metadata?: unknown
}

export interface RevenueTourLike {
  lead_id?: string | null
  status?: string | null
}

export interface BuildArgs {
  leads: ReadonlyArray<RevenueLeadLike>
  tours?: ReadonlyArray<RevenueTourLike>
}

function safeBudget(value: number | null | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 0
  return value
}

function bumpLastBooked(row: AttributionRevenueRow, lead: RevenueLeadLike) {
  const stamp = lead.updated_at ?? lead.created_at ?? null
  if (!stamp) return
  if (
    !row.lastBookedAt ||
    Date.parse(stamp) > Date.parse(row.lastBookedAt)
  ) {
    row.lastBookedAt = stamp
  }
}

function rate(num: number, denom: number): number | null {
  if (denom <= 0) return null
  const r = num / denom
  if (!Number.isFinite(r)) return null
  // Clamp to [0, 1] so a backfill quirk doesn't surface 120%.
  return Math.max(0, Math.min(1, r))
}

export function buildAttributionRevenueSummary(
  args: BuildArgs
): AttributionRevenueSummary {
  // lead_id -> set of tour statuses (so we count UNIQUE leads
  // with at least one tour, not raw tour rows).
  const leadsWithTour = new Set<string>()
  for (const t of args.tours ?? []) {
    if (!t.lead_id) continue
    if (
      t.status &&
      ['scheduled', 'confirmed', 'completed'].includes(t.status)
    ) {
      leadsWithTour.add(t.lead_id)
    }
  }

  const buckets = new Map<AttributionRevenueSourceLabel, AttributionRevenueRow>()
  const ensure = (label: AttributionRevenueSourceLabel): AttributionRevenueRow => {
    const existing = buckets.get(label)
    if (existing) return existing
    const row: AttributionRevenueRow = {
      sourceLabel: label,
      leadCount: 0,
      tourCount: 0,
      bookedCount: 0,
      estimatedPipelineValue: 0,
      estimatedBookedValue: 0,
      leadToTourRate: null,
      tourToBookedRate: null,
      leadToBookedRate: null,
      lastBookedAt: null,
    }
    buckets.set(label, row)
    return row
  }

  let totalLeads = 0
  let totalTours = 0
  let totalBooked = 0
  let totalPipeline = 0
  let totalBookedValue = 0

  for (const lead of args.leads) {
    const label =
      (getLeadAttributionLabel(lead.metadata) as
        | AttributionRevenueSourceLabel
        | null) ?? 'Unknown'
    const row = ensure(label)
    row.leadCount += 1
    totalLeads += 1

    const budget = safeBudget(lead.budget)
    row.estimatedPipelineValue += budget
    totalPipeline += budget

    if (lead.id && leadsWithTour.has(lead.id)) {
      row.tourCount += 1
      totalTours += 1
    }

    if (lead.stage === 'booked') {
      row.bookedCount += 1
      row.estimatedBookedValue += budget
      totalBooked += 1
      totalBookedValue += budget
      bumpLastBooked(row, lead)
    }
  }

  // Compute rates after all rows are tallied.
  for (const row of buckets.values()) {
    row.leadToTourRate = rate(row.tourCount, row.leadCount)
    row.tourToBookedRate = rate(row.bookedCount, row.tourCount)
    row.leadToBookedRate = rate(row.bookedCount, row.leadCount)
  }

  // Sort: estimated booked value desc, booked count desc, lead
  // count desc. Unknown stays in the natural sort order — we do
  // NOT pin it to the bottom so operators see large
  // unattributed buckets when they exist.
  const rows = Array.from(buckets.values()).sort((a, b) => {
    if (b.estimatedBookedValue !== a.estimatedBookedValue)
      return b.estimatedBookedValue - a.estimatedBookedValue
    if (b.bookedCount !== a.bookedCount) return b.bookedCount - a.bookedCount
    return b.leadCount - a.leadCount
  })

  return {
    rows,
    totals: {
      leadCount: totalLeads,
      tourCount: totalTours,
      bookedCount: totalBooked,
      estimatedPipelineValue: totalPipeline,
      estimatedBookedValue: totalBookedValue,
    },
    disclaimer: BOOKED_REVENUE_DISCLAIMER,
  }
}

/**
 * Convenience formatter for short pipeline strings used in
 * dense surfaces (KanbanCard subtitle, drawer chip).
 */
export function formatBookedValueShort(n: number): string {
  if (n <= 0) return '—'
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`
  if (n >= 10_000) return `$${Math.round(n / 1000)}k`
  return `$${n.toLocaleString()}`
}
