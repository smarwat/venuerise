import 'server-only'
import { createServiceClient } from '@/lib/supabase/service'
import { log } from '@/lib/log'
import {
  COMPLIANCE_REVIEW_POLICY,
  COMPLIANCE_OPS_DISCLAIMER,
} from '@/lib/enterprise/compliance-ops/policy'
import type {
  ComplianceCounts,
  ComplianceFreshnessRow,
  ComplianceFreshnessSummary,
  ComplianceReviewArea,
  ComplianceReviewCadence,
  ComplianceReviewPolicyItem,
  ComplianceReviewStatus,
} from '@/lib/enterprise/compliance-ops/types'

/**
 * Phase 9O — Evidence freshness summary.
 *
 * Reads compliance_review_events for a venue + cross-references
 * the static `COMPLIANCE_REVIEW_POLICY` map. For each policy
 * row, identifies:
 *
 *   - The most recent COMPLETED event timestamp (used for the
 *     stale-after-days check).
 *   - The next OPEN event due date (used to derive status).
 *   - An aggregate status across all that policy's open events.
 *
 * The disclaimer is identical across every render so downstream
 * consumers can grep for it.
 */

interface RowMinimal {
  policy_id: string
  status: string
  due_at: string
  completed_at: string | null
}

function deriveStatusFromDueAt(
  rawStatus: string,
  dueAt: string,
  now: number
): ComplianceReviewStatus {
  if (rawStatus === 'completed' || rawStatus === 'waived') {
    return rawStatus as ComplianceReviewStatus
  }
  const due = Date.parse(dueAt)
  const overdueWindow = 24 * 60 * 60 * 1000
  if (due <= now - overdueWindow) return 'overdue'
  if (due <= now) return 'due'
  return 'upcoming'
}

function aggregateStatus(
  rows: ReadonlyArray<RowMinimal>,
  now: number
): ComplianceReviewStatus {
  // No events ever → treat as overdue so the operator runs the
  // seed flow + records a review.
  if (rows.length === 0) return 'overdue'
  let bestOpen: ComplianceReviewStatus | null = null
  let hasCompleted = false
  for (const r of rows) {
    const s = deriveStatusFromDueAt(r.status, r.due_at, now)
    if (s === 'completed') {
      hasCompleted = true
      continue
    }
    if (s === 'waived') continue
    if (s === 'overdue') return 'overdue'
    if (s === 'due') {
      bestOpen = 'due'
    } else if (s === 'upcoming' && bestOpen !== 'due') {
      bestOpen = 'upcoming'
    }
  }
  return bestOpen ?? (hasCompleted ? 'completed' : 'overdue')
}

export function evaluatePolicyFreshness(
  policy: ComplianceReviewPolicyItem,
  rows: ReadonlyArray<RowMinimal>,
  now: number = Date.now()
): ComplianceFreshnessRow {
  // Most recent completed event timestamp.
  let lastCompletedAt: string | null = null
  for (const r of rows) {
    if (r.status !== 'completed' || !r.completed_at) continue
    if (!lastCompletedAt || Date.parse(r.completed_at) > Date.parse(lastCompletedAt)) {
      lastCompletedAt = r.completed_at
    }
  }
  // Next open due date.
  let nextDueAt: string | null = null
  for (const r of rows) {
    if (r.status === 'completed' || r.status === 'waived') continue
    if (!nextDueAt || Date.parse(r.due_at) < Date.parse(nextDueAt)) {
      nextDueAt = r.due_at
    }
  }
  const status = aggregateStatus(rows, now)
  const stale =
    lastCompletedAt !== null
      ? now - Date.parse(lastCompletedAt) >=
        policy.staleAfterDays * 24 * 60 * 60 * 1000
      : true
  return {
    policyId: policy.id,
    area: policy.area,
    title: policy.title,
    cadence: policy.cadence,
    ownerRole: policy.ownerRole,
    lastCompletedAt,
    nextDueAt,
    status,
    stale,
    buyerImpactIfStale: policy.buyerImpactIfStale,
  }
}

export async function buildComplianceFreshnessSummary(
  venueId: string | null
): Promise<ComplianceFreshnessSummary> {
  const warnings: string[] = []
  const now = Date.now()
  const supabase = createServiceClient()
  let rowsByPolicy = new Map<string, RowMinimal[]>()
  try {
    let q = supabase
      .from('compliance_review_events')
      .select('policy_id,status,due_at,completed_at')
      .limit(2000)
    if (venueId) q = q.eq('venue_id', venueId)
    const { data, error } = await q
    if (error) {
      warnings.push(`load_failed:${error.message}`)
      log.error({ err: error, venueId }, 'compliance.freshness.load_failed')
    } else {
      rowsByPolicy = bucketByPolicy((data ?? []) as RowMinimal[])
    }
  } catch (err) {
    log.error({ err }, 'compliance.freshness.unexpected')
    warnings.push('unexpected_error')
  }

  const rows: ComplianceFreshnessRow[] = COMPLIANCE_REVIEW_POLICY.map((item) =>
    evaluatePolicyFreshness(item, rowsByPolicy.get(item.id) ?? [], now)
  )

  const counts: ComplianceCounts = {
    totalPolicyItems: rows.length,
    upcoming: 0,
    due: 0,
    overdue: 0,
    completedLast30d: 0,
    waived: 0,
    staleAreas: 0,
  }
  const cutoff = now - 30 * 24 * 60 * 60 * 1000
  for (const r of rows) {
    if (r.status === 'upcoming') counts.upcoming += 1
    else if (r.status === 'due') counts.due += 1
    else if (r.status === 'overdue') counts.overdue += 1
    else if (r.status === 'waived') counts.waived += 1
    else if (r.status === 'completed') {
      if (r.lastCompletedAt && Date.parse(r.lastCompletedAt) >= cutoff) {
        counts.completedLast30d += 1
      }
    }
    if (r.stale) counts.staleAreas += 1
  }

  if (counts.overdue > 0) {
    warnings.push(
      `${counts.overdue} review${counts.overdue === 1 ? ' is' : 's are'} overdue. Open the ComplianceCalendarCard to triage.`
    )
  }
  if (counts.staleAreas > 0) {
    warnings.push(
      `${counts.staleAreas} area${counts.staleAreas === 1 ? '' : 's'} flagged stale (last completion older than the policy staleAfterDays threshold).`
    )
  }
  if (rows.every((r) => r.lastCompletedAt === null)) {
    warnings.push(
      'No completed reviews recorded yet for this venue. Run the seed flow + record reviews as they happen.'
    )
  }

  return {
    generatedAt: new Date().toISOString(),
    disclaimer: COMPLIANCE_OPS_DISCLAIMER,
    counts,
    rows,
    warnings,
  }
}

function bucketByPolicy(
  rows: ReadonlyArray<RowMinimal>
): Map<string, RowMinimal[]> {
  const out = new Map<string, RowMinimal[]>()
  for (const r of rows) {
    const list = out.get(r.policy_id) ?? []
    list.push(r)
    out.set(r.policy_id, list)
  }
  return out
}

// ── Renderers ────────────────────────────────────────────────────────────

function csvEscape(value: unknown): string {
  const s = value === null || value === undefined ? '' : String(value)
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"'
  return s
}

export function renderComplianceFreshnessMarkdown(
  summary: ComplianceFreshnessSummary
): string {
  const lines: string[] = []
  lines.push('# VenueRise Compliance Freshness')
  lines.push('')
  lines.push(`_Generated: ${summary.generatedAt}_`)
  lines.push('')
  lines.push('> ' + summary.disclaimer)
  lines.push('')
  lines.push('## Summary')
  lines.push('')
  lines.push(`- Total policy items: **${summary.counts.totalPolicyItems}**`)
  lines.push(`- Upcoming: **${summary.counts.upcoming}**`)
  lines.push(`- Due: **${summary.counts.due}**`)
  lines.push(`- Overdue: **${summary.counts.overdue}**`)
  lines.push(`- Completed last 30 days: **${summary.counts.completedLast30d}**`)
  lines.push(`- Waived: **${summary.counts.waived}**`)
  lines.push(`- Stale areas (soft signal): **${summary.counts.staleAreas}**`)
  lines.push('')
  if (summary.warnings.length > 0) {
    lines.push('## Warnings')
    lines.push('')
    for (const w of summary.warnings) lines.push(`- ${w}`)
    lines.push('')
  }
  lines.push('## Per-area status')
  lines.push('')
  lines.push(
    '| Area | Title | Cadence | Owner | Last completed | Next due | Status | Stale |'
  )
  lines.push('|---|---|---|---|---|---|---|---|')
  for (const r of summary.rows) {
    lines.push(
      `| ${r.area} | ${r.title} | ${r.cadence} | ${r.ownerRole} | ${r.lastCompletedAt ?? 'never'} | ${r.nextDueAt ?? 'unscheduled'} | ${r.status} | ${r.stale ? 'yes' : 'no'} |`
    )
  }
  return lines.join('\n')
}

export function renderComplianceFreshnessCsv(
  summary: ComplianceFreshnessSummary
): string {
  const headers = [
    'policy_id',
    'area',
    'title',
    'cadence',
    'owner_role',
    'last_completed_at',
    'next_due_at',
    'status',
    'stale',
    'buyer_impact_if_stale',
  ]
  const rows = [headers.join(',')]
  for (const r of summary.rows) {
    rows.push(
      [
        r.policyId,
        r.area,
        r.title,
        r.cadence,
        r.ownerRole,
        r.lastCompletedAt ?? '',
        r.nextDueAt ?? '',
        r.status,
        r.stale ? 'true' : 'false',
        r.buyerImpactIfStale,
      ]
        .map(csvEscape)
        .join(',')
    )
  }
  return rows.join('\n') + '\n'
}

// Helper to satisfy ts-noUnusedLocals when callers want the
// shape exported.
export type {
  ComplianceCounts,
  ComplianceFreshnessRow,
  ComplianceFreshnessSummary,
  ComplianceReviewArea,
  ComplianceReviewCadence,
  ComplianceReviewStatus,
}
