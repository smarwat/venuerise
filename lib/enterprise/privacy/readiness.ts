import 'server-only'
import { PRIVACY_DATA_INVENTORY } from '@/lib/enterprise/privacy/data-inventory'
import { RETENTION_POLICY_ITEMS } from '@/lib/enterprise/privacy/retention-policy'
import { computeDsrCounts } from '@/lib/enterprise/privacy/dsr'
import type {
  PrivacyDataInventoryItem,
  PrivacyReadinessCounts,
  PrivacyReadinessSummary,
  RetentionPolicyItem,
} from '@/lib/enterprise/privacy/types'

/**
 * Phase 9M — Privacy readiness summary.
 *
 * Pure summary builder. Pulls from the static inventory +
 * retention policy + the live DSR counts. Never reads any
 * subject data — only counts, never bodies.
 *
 * The disclaimer string is identical across every render so
 * downstream consumers can grep for it.
 */

export const PRIVACY_READINESS_DISCLAIMER =
  'Privacy readiness is not a legal compliance attestation. VenueRise does NOT claim GDPR / CCPA / LGPD compliance in this automated summary. Operator + counsel review is required before any external claim. DSRs are tracked, NOT auto-fulfilled. Export preview is metadata-only. Deletion review is non-destructive.'

export function computeReadinessCounts(
  inventory: ReadonlyArray<PrivacyDataInventoryItem>,
  retention: ReadonlyArray<RetentionPolicyItem>
): PrivacyReadinessCounts {
  let highOrRestricted = 0
  let exportReady = 0
  let deletionReady = 0
  let manualReview = 0
  for (const item of inventory) {
    if (item.sensitivity === 'high' || item.sensitivity === 'restricted') {
      highOrRestricted += 1
    }
    if (item.exportable) exportReady += 1
    if (item.deletable) deletionReady += 1
    if (item.controlStatus === 'manual' || item.controlStatus === 'partial') {
      manualReview += 1
    }
  }
  return {
    totalCategories: inventory.length,
    highOrRestrictedSensitivity: highOrRestricted,
    exportReady,
    deletionReady,
    manualReview,
    retentionPolicyRows: retention.length,
  }
}

export async function buildPrivacyReadinessSummary(
  venueId: string | null
): Promise<PrivacyReadinessSummary> {
  const warnings: string[] = []
  const inventory = [...PRIVACY_DATA_INVENTORY]
  const retention = [...RETENTION_POLICY_ITEMS]
  const counts = computeReadinessCounts(inventory, retention)
  const dsrCounts = await computeDsrCounts(venueId)

  if (counts.manualReview > 0) {
    warnings.push(
      `${counts.manualReview} data categor${counts.manualReview === 1 ? 'y' : 'ies'} carry control status "manual" or "partial" — operator + legal review needed before claiming automation.`
    )
  }
  if (dsrCounts.overdue > 0) {
    warnings.push(
      `${dsrCounts.overdue} open DSR${dsrCounts.overdue === 1 ? '' : 's'} past the due date. Triage from the DsrRequestsCard.`
    )
  }

  return {
    generatedAt: new Date().toISOString(),
    disclaimer: PRIVACY_READINESS_DISCLAIMER,
    counts,
    dsrCounts,
    inventory,
    retentionPolicy: retention,
    warnings,
  }
}

// ── Renderers ────────────────────────────────────────────────────────────

function csvEscape(value: unknown): string {
  const s = value === null || value === undefined ? '' : String(value)
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"'
  return s
}

export function renderPrivacyReadinessMarkdown(
  summary: PrivacyReadinessSummary
): string {
  const lines: string[] = []
  lines.push('# VenueRise Privacy Readiness')
  lines.push('')
  lines.push(`_Generated: ${summary.generatedAt}_`)
  lines.push('')
  lines.push('> ' + summary.disclaimer)
  lines.push('')
  lines.push('## Summary')
  lines.push('')
  lines.push(`- Total data categories: **${summary.counts.totalCategories}**`)
  lines.push(
    `- High/restricted sensitivity: **${summary.counts.highOrRestrictedSensitivity}**`
  )
  lines.push(`- Export-ready categories: **${summary.counts.exportReady}**`)
  lines.push(`- Deletion-ready categories: **${summary.counts.deletionReady}**`)
  lines.push(`- Manual-review categories: **${summary.counts.manualReview}**`)
  lines.push(`- Retention policy rows: **${summary.counts.retentionPolicyRows}**`)
  lines.push('')
  lines.push('### DSR counts')
  lines.push('')
  lines.push(`- Total: **${summary.dsrCounts.total}**`)
  lines.push(`- Open: **${summary.dsrCounts.open}**`)
  lines.push(
    `- Awaiting legal review: **${summary.dsrCounts.awaitingLegalReview}**`
  )
  lines.push(`- Fulfilled: **${summary.dsrCounts.fulfilled}**`)
  lines.push(`- Denied: **${summary.dsrCounts.denied}**`)
  lines.push(`- Cancelled: **${summary.dsrCounts.cancelled}**`)
  lines.push(`- Overdue: **${summary.dsrCounts.overdue}**`)
  lines.push('')

  if (summary.warnings.length > 0) {
    lines.push('### Warnings')
    lines.push('')
    for (const w of summary.warnings) lines.push(`- ${w}`)
    lines.push('')
  }

  lines.push('## Data inventory')
  lines.push('')
  for (const item of summary.inventory) {
    lines.push(`### ${item.displayName}`)
    lines.push('')
    lines.push(`- **Category**: ${item.category}`)
    lines.push(`- **Sensitivity**: ${item.sensitivity}`)
    lines.push(`- **Purpose**: ${item.purpose}`)
    lines.push(`- **Operational basis**: ${item.operationalBasis}`)
    lines.push(`- **Retention basis**: ${item.retentionBasis}`)
    lines.push(`- **Default retention**: ${item.defaultRetention}`)
    lines.push(
      `- **Exportable**: ${item.exportable ? 'yes' : 'no'} · **Deletable**: ${item.deletable ? 'yes' : 'no'} · **Correction**: ${item.correctionSupported ? 'yes' : 'no'}`
    )
    lines.push(
      `- **Subprocessors involved**: ${item.vendorIds.length > 0 ? item.vendorIds.join(', ') : 'none'}`
    )
    lines.push(`- **Control status**: ${item.controlStatus}`)
    lines.push('')
    lines.push(item.description)
    if (item.exampleFields.length > 0) {
      lines.push('')
      lines.push(`Example fields: ${item.exampleFields.map((f) => `\`${f}\``).join(', ')}`)
    }
    if (item.sources.length > 0) {
      lines.push('')
      lines.push('Sources:')
      for (const s of item.sources) lines.push(`- ${s}`)
    }
    if (item.knownLimitations.length > 0) {
      lines.push('')
      lines.push('Known limitations:')
      for (const k of item.knownLimitations) lines.push(`- ${k}`)
    }
    lines.push('')
  }

  lines.push('## Retention policy')
  lines.push('')
  for (const row of summary.retentionPolicy) {
    lines.push(`### ${row.category}`)
    lines.push('')
    lines.push(`- **Default window**: ${row.defaultWindow}`)
    lines.push(`- **Reason**: ${row.reason}`)
    lines.push(`- **Deletion behaviour**: ${row.deletionBehavior}`)
    lines.push(`- **Export behaviour**: ${row.exportBehavior}`)
    lines.push(`- **Automation status**: ${row.automationStatus}`)
    if (row.exceptions.length > 0) {
      lines.push('')
      lines.push('Exceptions:')
      for (const e of row.exceptions) lines.push(`- ${e}`)
    }
    lines.push('')
  }
  return lines.join('\n')
}

export function renderInventoryCsv(summary: PrivacyReadinessSummary): string {
  const headers = [
    'id',
    'category',
    'display_name',
    'sensitivity',
    'retention_basis',
    'default_retention',
    'exportable',
    'deletable',
    'correction_supported',
    'control_status',
    'vendor_ids',
    'known_limitation_count',
  ]
  const rows = [headers.join(',')]
  for (const item of summary.inventory) {
    rows.push(
      [
        item.id,
        item.category,
        item.displayName,
        item.sensitivity,
        item.retentionBasis,
        item.defaultRetention,
        item.exportable ? 'true' : 'false',
        item.deletable ? 'true' : 'false',
        item.correctionSupported ? 'true' : 'false',
        item.controlStatus,
        item.vendorIds.join('|'),
        String(item.knownLimitations.length),
      ]
        .map(csvEscape)
        .join(',')
    )
  }
  return rows.join('\n') + '\n'
}

export function renderRetentionCsv(summary: PrivacyReadinessSummary): string {
  const headers = [
    'category',
    'default_window',
    'reason',
    'deletion_behavior',
    'export_behavior',
    'automation_status',
    'exception_count',
  ]
  const rows = [headers.join(',')]
  for (const row of summary.retentionPolicy) {
    rows.push(
      [
        row.category,
        row.defaultWindow,
        row.reason,
        row.deletionBehavior,
        row.exportBehavior,
        row.automationStatus,
        String(row.exceptions.length),
      ]
        .map(csvEscape)
        .join(',')
    )
  }
  return rows.join('\n') + '\n'
}
