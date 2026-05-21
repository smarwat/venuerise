import {
  extractLeadAttribution,
  parseLeadAttribution,
} from '@/lib/enterprise/attribution/parse'
import type { SourceLabel } from '@/lib/enterprise/attribution/types'

/**
 * Phase 8BH — Attribution performance summary.
 *
 * Aggregates leads + tours by derived `sourceLabel` so the
 * Overview AttributionPerformanceCard + Analytics breakdown
 * can render an honest table without an extra DB round-trip
 * per row.
 *
 * Honesty:
 *   - Pipeline values are summed from `leads.budget` and
 *     surfaced as "estimated pipeline" — NOT ROAS. Ad spend
 *     is unknown.
 *   - `Unknown` rows are kept so the operator can see the
 *     fraction of inquiries with no attribution.
 *   - Pure function — no DB calls, no I/O.
 */

export interface AttributionRow {
  sourceLabel: SourceLabel
  /** Total leads with this label. */
  leadsCount: number
  /** Of those leads, how many have at least one tour scheduled / confirmed / completed. */
  toursScheduledCount: number
  /** Of those leads, how many reached `stage === 'booked'`. */
  bookedCount: number
  /** Sum of `budget` across the leads with this label. NULLs treated as 0. */
  estimatedPipeline: number
  /** Last-seen ISO timestamp of an inquiry with this label. */
  lastInquiryAt: string | null
}

export interface AttributionSummary {
  generatedAt: string
  totalAttributed: number
  totalUnknown: number
  rows: AttributionRow[]
  /** Truncated when more than `topN` rows exist. */
  totalSources: number
  /** Helpful disclaimer to render in the footer of every surface. */
  disclaimer: string
}

export const ATTRIBUTION_DISCLAIMER =
  'Attribution is best-effort from inquiry URL parameters, click IDs, and channel source. Ad spend is not connected — pipeline values are estimated from operator-entered budgets, not true ROAS.'

export interface LeadLike {
  id?: string
  stage?: string | null
  budget?: number | null
  created_at?: string | null
  metadata?: unknown
}

export interface TourLike {
  lead_id?: string | null
  status?: string | null
}

export interface BuildAttributionSummaryArgs {
  leads: ReadonlyArray<LeadLike>
  tours?: ReadonlyArray<TourLike>
  topN?: number
}

export function buildAttributionSummary(
  args: BuildAttributionSummaryArgs
): AttributionSummary {
  const topN = args.topN ?? 5
  // Map lead_id → set of tour statuses for quick lookups.
  const toursByLead = new Map<string, string[]>()
  for (const t of args.tours ?? []) {
    if (!t.lead_id) continue
    const list = toursByLead.get(t.lead_id) ?? []
    if (t.status) list.push(t.status)
    toursByLead.set(t.lead_id, list)
  }

  const buckets = new Map<SourceLabel, AttributionRow>()
  let totalAttributed = 0
  let totalUnknown = 0

  for (const lead of args.leads) {
    const attribution = extractLeadAttribution(lead.metadata)
    const label: SourceLabel =
      attribution?.source_label ??
      // No attribution metadata at all — bucket as Unknown
      // but still count so the operator sees the gap.
      parseLeadAttribution({}).source_label

    if (label === 'Unknown') totalUnknown += 1
    else totalAttributed += 1

    const existing = buckets.get(label) ?? {
      sourceLabel: label,
      leadsCount: 0,
      toursScheduledCount: 0,
      bookedCount: 0,
      estimatedPipeline: 0,
      lastInquiryAt: null,
    }
    existing.leadsCount += 1
    if (typeof lead.budget === 'number' && lead.budget > 0) {
      existing.estimatedPipeline += lead.budget
    }
    if (lead.stage === 'booked') existing.bookedCount += 1
    const tourStatuses = lead.id ? toursByLead.get(lead.id) ?? [] : []
    if (
      tourStatuses.some((s) =>
        ['scheduled', 'confirmed', 'completed'].includes(s)
      )
    ) {
      existing.toursScheduledCount += 1
    }
    if (lead.created_at) {
      if (
        !existing.lastInquiryAt ||
        Date.parse(lead.created_at) > Date.parse(existing.lastInquiryAt)
      ) {
        existing.lastInquiryAt = lead.created_at
      }
    }
    buckets.set(label, existing)
  }

  const rows = Array.from(buckets.values()).sort((a, b) => {
    if (b.leadsCount !== a.leadsCount) return b.leadsCount - a.leadsCount
    return b.estimatedPipeline - a.estimatedPipeline
  })
  const totalSources = rows.length
  const limited = rows.slice(0, topN)

  return {
    generatedAt: new Date().toISOString(),
    totalAttributed,
    totalUnknown,
    rows: limited,
    totalSources,
    disclaimer: ATTRIBUTION_DISCLAIMER,
  }
}
