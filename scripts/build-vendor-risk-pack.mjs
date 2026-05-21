#!/usr/bin/env node
// Phase 9K — Local vendor risk + subprocessor disclosure pack
// generator.
//
// Writes a static pack to `artifacts/evidence/vendor-risk/`
// without requiring a running server or any Supabase
// credentials. Operators use this for offline security review
// where a live admin session isn't available.
//
// Output:
//   - artifacts/evidence/vendor-risk/vendor-risk-report.md
//   - artifacts/evidence/vendor-risk/vendor-risk-report.csv
//   - artifacts/evidence/vendor-risk/subprocessor-disclosure.md
//   - artifacts/evidence/vendor-risk/subprocessor-disclosure.csv
//   - artifacts/evidence/vendor-risk/vendor-risk-summary.json
//
// Source: parses `lib/enterprise/vendor-risk/vendor-registry.ts`
// as text. Same regex-extraction pattern as the Phase 9I
// `build-evidence-pack.mjs`. Full descriptions live in the TS
// source + in the live endpoint.
//
// Honesty rules:
//   - The pack carries the same disclaimer string as the
//     runtime endpoints — it is NOT a contractual representation.
//   - The pack is generated locally; operators MUST review
//     before sending to a buyer.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const REGISTRY_PATH = join(
  ROOT,
  'lib',
  'enterprise',
  'vendor-risk',
  'vendor-registry.ts'
)
const OUT_DIR = join(ROOT, 'artifacts', 'evidence', 'vendor-risk')

const DISCLAIMER =
  "This disclosure is for security review and procurement support. It is not legal advice or a contractual representation. Vendor SOC 2, DPA, SCC, and ISO posture must be verified against the vendor's current evidence before relying on any contractual commitment. Operators MUST review before sending to a buyer."

// ── Field extraction ─────────────────────────────────────────────────────

function field(chunk, key) {
  // Match `key: '...'` or `key: "..."` allowing escaped quotes.
  const re = new RegExp(`${key}:\\s*(['"])((?:\\\\.|(?!\\1).)*)\\1`)
  const m = chunk.match(re)
  if (!m) return null
  return m[2].replace(/\\'/g, "'").replace(/\\"/g, '"')
}

function boolField(chunk, key) {
  const re = new RegExp(`${key}:\\s*(true|false)`)
  const m = chunk.match(re)
  if (!m) return null
  return m[1] === 'true'
}

function listField(chunk, key) {
  // Match `key: [ ... ]` extracting all single-quoted strings.
  const re = new RegExp(`${key}:\\s*\\[([\\s\\S]*?)\\]`)
  const m = chunk.match(re)
  if (!m) return []
  const inner = m[1]
  const items = []
  const itemRe = /'((?:\\.|[^'\\])*)'/g
  let im
  while ((im = itemRe.exec(inner)) !== null) {
    items.push(im[1])
  }
  return items
}

function objectListField(chunk, key) {
  // Pull each `{ ... }` chunk under `key: [ ... ]`.
  const re = new RegExp(`${key}:\\s*\\[([\\s\\S]*?)\\n\\s*\\]`)
  const m = chunk.match(re)
  if (!m) return []
  const body = m[1]
  const chunks = body.split(/\n\s*\{\s*\n?/).slice(1)
  const out = []
  for (const raw of chunks) {
    out.push('{\n' + raw)
  }
  return out
}

function lastReviewed(chunk) {
  // `lastReviewedAt: '...'` or `lastReviewedAt: null`.
  const reNull = /lastReviewedAt:\s*null/
  if (reNull.test(chunk)) return null
  return field(chunk, 'lastReviewedAt')
}

// ── Registry extraction ──────────────────────────────────────────────────

function extractRegistry(source) {
  const arrayMatch = source.match(
    /VENDOR_REGISTRY[^=]*=\s*\[([\s\S]+?)\n\]\s*$/m
  )
  const body = arrayMatch ? arrayMatch[1] : source
  // Each vendor row starts with `{ \n id: '...' ...` — split on
  // lines that begin a new outer-level object.
  const rows = body.split(/\n\s*\{\s*\n?\s*\/\/[^\n]*\n?\s*id:/).slice(1)
  const fallback = body.split(/\n\s*\{\s*\n\s*id:/).slice(1)
  const sourceChunks = rows.length > 0 ? rows : fallback
  const vendors = []
  for (const raw of sourceChunks) {
    const chunk = 'id:' + raw
    const id = field(chunk, 'id')
    const name = field(chunk, 'name')
    if (!id || !name) continue
    const category = field(chunk, 'category') ?? ''
    const purpose = field(chunk, 'purpose') ?? ''
    const criticality = field(chunk, 'criticality') ?? 'unknown'
    const disclosureStatus =
      field(chunk, 'disclosureStatus') ?? 'admin_only'
    const productionUse = boolField(chunk, 'productionUse') ?? false
    const buyerSafeDescription = field(chunk, 'buyerSafeDescription') ?? ''
    const riskTier = field(chunk, 'riskTier') ?? 'unknown'
    const assuranceStatus =
      field(chunk, 'assuranceStatus') ?? 'manual_review_required'
    const dataCategories = listField(chunk, 'dataCategories')
    const knownLimitations = listField(chunk, 'knownLimitations')
    const reviewOwner = field(chunk, 'reviewOwner') ?? ''
    const reviewCadence = field(chunk, 'reviewCadence') ?? ''
    const lastReviewedAt = lastReviewed(chunk)
    const evidence = objectListField(chunk, 'evidence').map((e) => ({
      kind: field(e, 'kind') ?? 'note',
      reference: field(e, 'reference') ?? '',
      label: field(e, 'label'),
    }))
    vendors.push({
      id,
      name,
      category,
      purpose,
      criticality,
      disclosureStatus,
      productionUse,
      buyerSafeDescription,
      riskTier,
      assuranceStatus,
      dataCategories,
      knownLimitations,
      reviewOwner,
      reviewCadence,
      lastReviewedAt,
      evidence,
    })
  }
  return vendors
}

function computeCounts(vendors) {
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

// ── Renderers ────────────────────────────────────────────────────────────

function csvEscape(value) {
  const s = String(value ?? '')
  if (/[",\n\r]/.test(s)) {
    return '"' + s.replace(/"/g, '""') + '"'
  }
  return s
}

function renderVendorMarkdown(generatedAt, vendors, counts) {
  const lines = []
  lines.push('# VenueRise Vendor Risk Report')
  lines.push('')
  lines.push(`_Generated: ${generatedAt}_`)
  lines.push('')
  lines.push('> ' + DISCLAIMER)
  lines.push('')
  lines.push('## Summary')
  lines.push('')
  lines.push(`- Total vendors: **${counts.total}**`)
  lines.push(`- Production runtime: **${counts.production}**`)
  lines.push(`- Critical: **${counts.critical}**`)
  lines.push(`- Manual-review-required: **${counts.manualReviewRequired}**`)
  lines.push(`- Unknown assurance: **${counts.unknownAssurance}**`)
  lines.push(`- Public-disclosable: **${counts.publicDisclosable}**`)
  lines.push('')
  lines.push('## Vendors')
  lines.push('')
  for (const v of vendors) {
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

function renderVendorCsv(vendors) {
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
  const rows = [headers.join(',')]
  for (const v of vendors) {
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

function renderDisclosureMarkdown(generatedAt, publicVendors) {
  const lines = []
  lines.push('# VenueRise Subprocessor Disclosure')
  lines.push('')
  lines.push(`_Generated: ${generatedAt}_`)
  lines.push('')
  lines.push('> ' + DISCLAIMER)
  lines.push('')
  lines.push(
    `${publicVendors.filter((v) => v.productionUse).length} production subprocessor(s) listed below.`
  )
  lines.push('')
  for (const v of publicVendors) {
    lines.push(`## ${v.name}`)
    lines.push('')
    lines.push(`- **Category**: ${v.category}`)
    lines.push(`- **Criticality**: ${v.criticality}`)
    lines.push(`- **Risk tier**: ${v.riskTier}`)
    lines.push(
      `- **Data categories**: ${
        v.dataCategories.length > 0 ? v.dataCategories.join(', ') : 'none'
      }`
    )
    lines.push('')
    lines.push(v.buyerSafeDescription)
    lines.push('')
  }
  return lines.join('\n')
}

function renderDisclosureCsv(publicVendors) {
  const headers = [
    'id',
    'name',
    'category',
    'criticality',
    'risk_tier',
    'data_categories',
    'description',
  ]
  const rows = [headers.join(',')]
  for (const v of publicVendors) {
    rows.push(
      [
        v.id,
        v.name,
        v.category,
        v.criticality,
        v.riskTier,
        v.dataCategories.join('|'),
        v.buyerSafeDescription,
      ]
        .map(csvEscape)
        .join(',')
    )
  }
  return rows.join('\n') + '\n'
}

// ── Main ─────────────────────────────────────────────────────────────────

function main() {
  if (!existsSync(REGISTRY_PATH)) {
    console.error(`✗ vendor registry not found at ${REGISTRY_PATH}`)
    process.exit(1)
  }
  const source = readFileSync(REGISTRY_PATH, 'utf8')
  const vendors = extractRegistry(source)
  if (vendors.length === 0) {
    console.error('✗ no vendors extracted from registry — extractor likely broken')
    process.exit(1)
  }
  const counts = computeCounts(vendors)
  const publicVendors = vendors.filter((v) => v.disclosureStatus === 'public')
  const generatedAt = new Date().toISOString()

  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true })

  const vendorMd = renderVendorMarkdown(generatedAt, vendors, counts)
  const vendorCsv = renderVendorCsv(vendors)
  const disclosureMd = renderDisclosureMarkdown(generatedAt, publicVendors)
  const disclosureCsv = renderDisclosureCsv(publicVendors)
  const summary = {
    generatedAt,
    disclaimer: DISCLAIMER,
    counts,
    vendorCount: vendors.length,
    publicCount: publicVendors.length,
  }

  writeFileSync(join(OUT_DIR, 'vendor-risk-report.md'), vendorMd)
  writeFileSync(join(OUT_DIR, 'vendor-risk-report.csv'), vendorCsv)
  writeFileSync(join(OUT_DIR, 'subprocessor-disclosure.md'), disclosureMd)
  writeFileSync(join(OUT_DIR, 'subprocessor-disclosure.csv'), disclosureCsv)
  writeFileSync(
    join(OUT_DIR, 'vendor-risk-summary.json'),
    JSON.stringify(summary, null, 2) + '\n'
  )

  console.log('✓ Vendor risk pack generated')
  console.log(`  ${join(OUT_DIR, 'vendor-risk-report.md')}`)
  console.log(`  ${join(OUT_DIR, 'vendor-risk-report.csv')}`)
  console.log(`  ${join(OUT_DIR, 'subprocessor-disclosure.md')}`)
  console.log(`  ${join(OUT_DIR, 'subprocessor-disclosure.csv')}`)
  console.log(`  ${join(OUT_DIR, 'vendor-risk-summary.json')}`)
  console.log('')
  console.log(
    `  ${counts.total} vendors (${counts.production} production, ${counts.critical} critical, ${counts.manualReviewRequired} manual-review-required, ${counts.publicDisclosable} public-disclosable)`
  )
  console.log('')
  console.log(
    'Note: this is a STATIC pack. Live report lives behind /api/admin/security/vendor-risk-report.'
  )
}

main()
