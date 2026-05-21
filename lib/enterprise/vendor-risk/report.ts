import 'server-only'
import { VENDOR_REGISTRY } from '@/lib/enterprise/vendor-risk/vendor-registry'
import type {
  SubprocessorDisclosure,
  SubprocessorDisclosureRecord,
  VendorRecord,
  VendorRiskCounts,
  VendorRiskSummary,
} from '@/lib/enterprise/vendor-risk/types'

/**
 * Phase 9K — Vendor risk + subprocessor disclosure builder.
 *
 * Two distinct outputs, one source of truth:
 *
 *   - `buildVendorRiskSummary()` — admin view. Includes every
 *     vendor row regardless of disclosureStatus. Used by the
 *     VendorRiskCard, the admin export, and the local pack
 *     generator.
 *
 *   - `buildSubprocessorDisclosure()` — buyer view. Filters to
 *     vendors whose `disclosureStatus === 'public'` and strips
 *     evidence references (env vars + package names) to avoid
 *     exposing internal architecture details. Used by the
 *     SubprocessorDisclosureCard, the admin export, and any
 *     future public /security/subprocessors page.
 *
 * Both outputs carry an identical disclaimer string:
 *
 *   "This disclosure is for security review and procurement
 *    support. It is not legal advice or a contractual
 *    representation."
 *
 * Honesty rules carried forward from the registry comment:
 *   - DPA / SCC / SOC 2 status is `manual_review_required`
 *     unless verified evidence exists.
 *   - We never use the word "compliant" in any rendered string.
 *   - Operators MUST review before sending.
 */

export const VENDOR_RISK_DISCLAIMER =
  'This disclosure is for security review and procurement support. It is not legal advice or a contractual representation. Vendor SOC 2, DPA, SCC, and ISO posture must be verified against the vendor\'s current evidence before relying on any contractual commitment. Operators MUST review before sending to a buyer.'

function computeCounts(vendors: ReadonlyArray<VendorRecord>): VendorRiskCounts {
  let production = 0
  let critical = 0
  let manualReview = 0
  let unknownAssurance = 0
  let publicDisclosable = 0
  for (const v of vendors) {
    if (v.productionUse) production += 1
    if (v.criticality === 'critical') critical += 1
    if (v.assuranceStatus === 'manual_review_required') manualReview += 1
    if (v.assuranceStatus === 'unknown') unknownAssurance += 1
    if (v.disclosureStatus === 'public') publicDisclosable += 1
  }
  return {
    total: vendors.length,
    production,
    critical,
    manualReviewRequired: manualReview,
    unknownAssurance,
    publicDisclosable,
  }
}

export async function buildVendorRiskSummary(): Promise<VendorRiskSummary> {
  const vendors = [...VENDOR_REGISTRY]
  const warnings: string[] = []
  const neverReviewed = vendors.filter((v) => v.lastReviewedAt === null)
  if (neverReviewed.length > 0) {
    warnings.push(
      `${neverReviewed.length} vendor row(s) have never been formally reviewed (lastReviewedAt = null). Update the registry after the next operator review.`
    )
  }
  return {
    generatedAt: new Date().toISOString(),
    disclaimer: VENDOR_RISK_DISCLAIMER,
    counts: computeCounts(vendors),
    vendors,
    warnings,
  }
}

export async function buildSubprocessorDisclosure(): Promise<SubprocessorDisclosure> {
  const publicVendors = VENDOR_REGISTRY.filter(
    (v) => v.disclosureStatus === 'public'
  )
  const records: SubprocessorDisclosureRecord[] = publicVendors.map((v) => ({
    id: v.id,
    name: v.name,
    category: v.category,
    description: v.buyerSafeDescription,
    dataCategories: v.dataCategories,
    criticality: v.criticality,
    riskTier: v.riskTier,
  }))
  return {
    generatedAt: new Date().toISOString(),
    disclaimer: VENDOR_RISK_DISCLAIMER,
    records,
    counts: {
      total: records.length,
      productionDisclosed: publicVendors.filter((v) => v.productionUse).length,
    },
  }
}

// ── Renderers ────────────────────────────────────────────────────────────

function csvEscape(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return '"' + value.replace(/"/g, '""') + '"'
  }
  return value
}

export function renderVendorRiskMarkdown(summary: VendorRiskSummary): string {
  const lines: string[] = []
  lines.push('# VenueRise Vendor Risk Report')
  lines.push('')
  lines.push(`_Generated: ${summary.generatedAt}_`)
  lines.push('')
  lines.push('> ' + summary.disclaimer)
  lines.push('')
  lines.push('## Summary')
  lines.push('')
  lines.push(`- Total vendors: **${summary.counts.total}**`)
  lines.push(`- Production runtime: **${summary.counts.production}**`)
  lines.push(`- Critical: **${summary.counts.critical}**`)
  lines.push(
    `- Manual-review-required assurance: **${summary.counts.manualReviewRequired}**`
  )
  lines.push(
    `- Unknown assurance: **${summary.counts.unknownAssurance}**`
  )
  lines.push(
    `- Public-disclosable: **${summary.counts.publicDisclosable}**`
  )
  lines.push('')
  if (summary.warnings.length > 0) {
    lines.push('### Warnings')
    lines.push('')
    for (const w of summary.warnings) {
      lines.push(`- ${w}`)
    }
    lines.push('')
  }
  lines.push('## Vendors')
  lines.push('')
  for (const v of summary.vendors) {
    lines.push(`### ${v.name}`)
    lines.push('')
    lines.push(`- **Category**: ${v.category}`)
    lines.push(`- **Purpose**: ${v.purpose}`)
    lines.push(`- **Criticality**: ${v.criticality}`)
    lines.push(`- **Disclosure**: ${v.disclosureStatus}`)
    lines.push(`- **Risk tier**: ${v.riskTier}`)
    lines.push(`- **Assurance status**: ${v.assuranceStatus}`)
    lines.push(`- **Production use**: ${v.productionUse ? 'yes' : 'no'}`)
    lines.push(
      `- **Data categories**: ${
        v.dataCategories.length > 0 ? v.dataCategories.join(', ') : 'none'
      }`
    )
    lines.push(`- **Review owner**: ${v.reviewOwner}`)
    lines.push(`- **Review cadence**: ${v.reviewCadence}`)
    lines.push(
      `- **Last reviewed**: ${v.lastReviewedAt ?? 'never (registry default)'}`
    )
    lines.push('')
    lines.push('**Buyer-safe description**')
    lines.push('')
    lines.push(v.buyerSafeDescription)
    if (v.evidence.length > 0) {
      lines.push('')
      lines.push('**Evidence references**')
      lines.push('')
      for (const e of v.evidence) {
        const label = e.label ? ` — ${e.label}` : ''
        lines.push(`- \`${e.kind}\`: ${e.reference}${label}`)
      }
    }
    if (v.knownLimitations.length > 0) {
      lines.push('')
      lines.push('**Known limitations**')
      lines.push('')
      for (const k of v.knownLimitations) {
        lines.push(`- ${k}`)
      }
    }
    lines.push('')
  }
  return lines.join('\n')
}

export function renderVendorRiskCsv(summary: VendorRiskSummary): string {
  const headers = [
    'id',
    'name',
    'category',
    'criticality',
    'disclosure_status',
    'production_use',
    'risk_tier',
    'assurance_status',
    'data_categories',
    'review_owner',
    'review_cadence',
    'last_reviewed_at',
    'known_limitation_count',
    'evidence_reference_count',
    'buyer_safe_description',
  ]
  const rows: string[] = [headers.join(',')]
  for (const v of summary.vendors) {
    rows.push(
      [
        v.id,
        v.name,
        v.category,
        v.criticality,
        v.disclosureStatus,
        v.productionUse ? 'true' : 'false',
        v.riskTier,
        v.assuranceStatus,
        v.dataCategories.join('|'),
        v.reviewOwner,
        v.reviewCadence,
        v.lastReviewedAt ?? '',
        String(v.knownLimitations.length),
        String(v.evidence.length),
        v.buyerSafeDescription,
      ]
        .map(csvEscape)
        .join(',')
    )
  }
  return rows.join('\n') + '\n'
}

export function renderSubprocessorDisclosureMarkdown(
  disclosure: SubprocessorDisclosure
): string {
  const lines: string[] = []
  lines.push('# VenueRise Subprocessor Disclosure')
  lines.push('')
  lines.push(`_Generated: ${disclosure.generatedAt}_`)
  lines.push('')
  lines.push('> ' + disclosure.disclaimer)
  lines.push('')
  lines.push(
    `${disclosure.counts.productionDisclosed} production subprocessor(s) listed below.`
  )
  lines.push('')
  for (const r of disclosure.records) {
    lines.push(`## ${r.name}`)
    lines.push('')
    lines.push(`- **Category**: ${r.category}`)
    lines.push(`- **Criticality**: ${r.criticality}`)
    lines.push(`- **Risk tier**: ${r.riskTier}`)
    lines.push(
      `- **Data categories**: ${
        r.dataCategories.length > 0 ? r.dataCategories.join(', ') : 'none'
      }`
    )
    lines.push('')
    lines.push(r.description)
    lines.push('')
  }
  return lines.join('\n')
}

export function renderSubprocessorDisclosureCsv(
  disclosure: SubprocessorDisclosure
): string {
  const headers = [
    'id',
    'name',
    'category',
    'criticality',
    'risk_tier',
    'data_categories',
    'description',
  ]
  const rows: string[] = [headers.join(',')]
  for (const r of disclosure.records) {
    rows.push(
      [
        r.id,
        r.name,
        r.category,
        r.criticality,
        r.riskTier,
        r.dataCategories.join('|'),
        r.description,
      ]
        .map(csvEscape)
        .join(',')
    )
  }
  return rows.join('\n') + '\n'
}
