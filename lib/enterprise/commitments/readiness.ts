import 'server-only'
import { listCommitments } from '@/lib/enterprise/commitments/commitments'
import {
  COMMITMENTS_DISCLAIMER,
  detectUnsupportedRiskFlags,
  sortByRisk,
} from '@/lib/enterprise/commitments/policy'
import type {
  CommitmentCounts,
  CommitmentRecord,
  CommitmentsReadinessSummary,
  UnsupportedRiskFlag,
} from '@/lib/enterprise/commitments/types'

/**
 * Phase 9P — Commitments readiness summary.
 *
 * Pulls every commitment for the venue, computes counts,
 * detects unsupported-risk flags, and returns the top
 * upcoming reviews. Markdown + CSV renderers carry the
 * identical disclaimer string.
 */

export async function buildCommitmentsReadinessSummary(
  venueId: string | null
): Promise<CommitmentsReadinessSummary> {
  const warnings: string[] = []
  const list = await listCommitments({ venueId, limit: 1000 })
  warnings.push(...list.warnings)

  const flags = detectUnsupportedRiskFlags(list.commitments)
  const counts: CommitmentCounts = {
    ...list.counts,
    unsupportedRiskFlags: flags.length,
  }

  const now = Date.now()
  const open = list.commitments.filter(
    (c) =>
      c.status !== 'fulfilled' &&
      c.status !== 'expired' &&
      c.status !== 'withdrawn'
  )
  const upcomingReviews = open
    .filter((c) => c.reviewAt !== null)
    .sort((a, b) => Date.parse(a.reviewAt ?? '') - Date.parse(b.reviewAt ?? ''))
    .slice(0, 25)

  if (counts.overdueReview > 0) {
    warnings.push(
      `${counts.overdueReview} commitment${counts.overdueReview === 1 ? ' has' : 's have'} a review date in the past. Triage from the CommitmentsRegisterCard.`
    )
  }
  if (counts.dueWithin30Days > 0) {
    warnings.push(
      `${counts.dueWithin30Days} commitment${counts.dueWithin30Days === 1 ? ' is' : 's are'} due within 30 days.`
    )
  }
  if (counts.unsupportedRiskFlags > 0) {
    warnings.push(
      `${counts.unsupportedRiskFlags} unsupported-risk flag${counts.unsupportedRiskFlags === 1 ? '' : 's'} surfaced. Review with the buyer before marking commitments active.`
    )
  }
  if (counts.criticalRisk > 0 && counts.active > 0) {
    warnings.push(
      `${counts.criticalRisk} commitment${counts.criticalRisk === 1 ? ' is' : 's are'} marked critical risk. Confirm operator + legal review.`
    )
  }
  void sortByRisk // imported for downstream consumers; kept referenced
  return {
    generatedAt: new Date().toISOString(),
    disclaimer: COMMITMENTS_DISCLAIMER,
    counts,
    upcomingReviews,
    unsupportedRiskFlags: flags,
    warnings,
  }
}

// ── Renderers ────────────────────────────────────────────────────────────

function csvEscape(value: unknown): string {
  const s = value === null || value === undefined ? '' : String(value)
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"'
  return s
}

export function renderCommitmentsReadinessMarkdown(
  summary: CommitmentsReadinessSummary
): string {
  const lines: string[] = []
  lines.push('# VenueRise Contract Commitments Readiness')
  lines.push('')
  lines.push(`_Generated: ${summary.generatedAt}_`)
  lines.push('')
  lines.push('> ' + summary.disclaimer)
  lines.push('')
  lines.push('## Summary')
  lines.push('')
  lines.push(`- Total commitments: **${summary.counts.total}**`)
  lines.push(`- Active: **${summary.counts.active}**`)
  lines.push(`- Draft: **${summary.counts.draft}**`)
  lines.push(`- Fulfilled: **${summary.counts.fulfilled}**`)
  lines.push(`- At risk: **${summary.counts.atRisk}**`)
  lines.push(`- Expired: **${summary.counts.expired}**`)
  lines.push(`- Withdrawn: **${summary.counts.withdrawn}**`)
  lines.push(`- High risk: **${summary.counts.highRisk}**`)
  lines.push(`- Critical risk: **${summary.counts.criticalRisk}**`)
  lines.push(`- Overdue review: **${summary.counts.overdueReview}**`)
  lines.push(`- Due within 30 days: **${summary.counts.dueWithin30Days}**`)
  lines.push(
    `- Unsupported-risk flags: **${summary.counts.unsupportedRiskFlags}**`
  )
  lines.push('')

  if (summary.warnings.length > 0) {
    lines.push('## Warnings')
    lines.push('')
    for (const w of summary.warnings) lines.push(`- ${w}`)
    lines.push('')
  }

  if (summary.unsupportedRiskFlags.length > 0) {
    lines.push('## Unsupported-risk flags')
    lines.push('')
    lines.push('| Area | Risk | Title | Reason |')
    lines.push('|---|---|---|---|')
    for (const f of summary.unsupportedRiskFlags) {
      lines.push(`| ${f.area} | ${f.riskLevel} | ${f.title} | ${f.reason} |`)
    }
    lines.push('')
  }

  if (summary.upcomingReviews.length > 0) {
    lines.push('## Upcoming reviews')
    lines.push('')
    lines.push('| Review date | Buyer | Area | Risk | Title |')
    lines.push('|---|---|---|---|---|')
    for (const c of summary.upcomingReviews) {
      lines.push(
        `| ${c.reviewAt ?? 'unscheduled'} | ${c.buyerCompany ?? c.buyerName ?? '—'} | ${c.commitmentArea} | ${c.riskLevel} | ${c.title} |`
      )
    }
    lines.push('')
  }
  return lines.join('\n')
}

export function renderCommitmentsReadinessCsv(
  summary: CommitmentsReadinessSummary
): string {
  const headers = [
    'commitment_id',
    'area',
    'risk_level',
    'title',
    'flag_reason',
  ]
  const rows = [headers.join(',')]
  for (const f of summary.unsupportedRiskFlags) {
    rows.push(
      [f.commitmentId, f.area, f.riskLevel, f.title, f.reason]
        .map(csvEscape)
        .join(',')
    )
  }
  return rows.join('\n') + '\n'
}

export function renderCommitmentsListCsv(
  commitments: ReadonlyArray<CommitmentRecord>
): string {
  const headers = [
    'id',
    'buyer_company',
    'buyer_email',
    'source_type',
    'commitment_area',
    'title',
    'status',
    'risk_level',
    'due_at',
    'review_at',
    'fulfilled_at',
    'evidence_url',
    'created_at',
  ]
  const rows = [headers.join(',')]
  for (const c of commitments) {
    rows.push(
      [
        c.id,
        c.buyerCompany ?? '',
        c.buyerEmail ?? '',
        c.sourceType,
        c.commitmentArea,
        c.title,
        c.status,
        c.riskLevel,
        c.dueAt ?? '',
        c.reviewAt ?? '',
        c.fulfilledAt ?? '',
        c.evidenceUrl ?? '',
        c.createdAt,
      ]
        .map(csvEscape)
        .join(',')
    )
  }
  return rows.join('\n') + '\n'
}

// Re-export type so callers can import from one path.
export type { CommitmentsReadinessSummary, UnsupportedRiskFlag }
