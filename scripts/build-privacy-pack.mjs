#!/usr/bin/env node
// Phase 9M — Local privacy + DSR readiness pack generator.
//
// Writes a static pack to `artifacts/evidence/privacy/`
// without requiring a running server or any Supabase
// credentials. Operators use this for off-line review and to
// share with procurement / legal.
//
// Output:
//   - artifacts/evidence/privacy/privacy-readiness-report.md
//   - artifacts/evidence/privacy/data-inventory.csv
//   - artifacts/evidence/privacy/retention-policy.csv
//   - artifacts/evidence/privacy/dsr-workflow.md
//   - artifacts/evidence/privacy/privacy-summary.json
//
// Honesty:
//   - The pack documents intent. It does NOT claim GDPR/CCPA
//     compliance. It does NOT contain subject data.
//   - Operators MUST review before sending externally.
//
// Source: parses `lib/enterprise/privacy/data-inventory.ts` +
// `retention-policy.ts` as text using the same regex-extraction
// pattern as the Phase 9I evidence pack + Phase 9K vendor pack
// + Phase 9L incident pack. No TypeScript runtime needed.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const INV_PATH = join(
  ROOT,
  'lib',
  'enterprise',
  'privacy',
  'data-inventory.ts'
)
const RET_PATH = join(
  ROOT,
  'lib',
  'enterprise',
  'privacy',
  'retention-policy.ts'
)
const OUT_DIR = join(ROOT, 'artifacts', 'evidence', 'privacy')

const DISCLAIMER =
  'Privacy readiness is not a legal compliance attestation. VenueRise does NOT claim GDPR / CCPA / LGPD compliance in this automated summary. Operator + counsel review is required before any external claim. DSRs are tracked, NOT auto-fulfilled. Export preview is metadata-only. Deletion review is non-destructive.'

// ── Field extractors ─────────────────────────────────────────────────────

function field(chunk, key) {
  const re = new RegExp(
    `${key}:\\s*(['"\`])((?:\\\\.|(?!\\1).)*)\\1`,
    's'
  )
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
  // Capture key: [ ... ] using bracket-depth walking so nested
  // brackets inside strings don't trip us.
  const idx = chunk.indexOf(`${key}:`)
  if (idx === -1) return []
  const open = chunk.indexOf('[', idx)
  if (open === -1) return []
  let depth = 0
  let close = -1
  for (let i = open; i < chunk.length; i += 1) {
    const ch = chunk[i]
    if (ch === '[') depth += 1
    else if (ch === ']') {
      depth -= 1
      if (depth === 0) {
        close = i
        break
      }
    }
  }
  if (close === -1) return []
  const inner = chunk.slice(open + 1, close)
  const items = []
  const re = /'((?:\\.|[^'\\])*)'/g
  let m
  while ((m = re.exec(inner)) !== null) {
    items.push(m[1])
  }
  return items
}

// ── Inventory extractor ──────────────────────────────────────────────────

function extractInventory(src) {
  const arr = src.match(
    /PRIVACY_DATA_INVENTORY[^=]*=\s*\[([\s\S]+?)\n\]\s*$/m
  )
  const body = arr ? arr[1] : src
  // Each row starts with `  {\n    id: '...'`. Split on outer
  // `id:` markers.
  const chunks = body.split(/\n\s*\{\s*\n?\s*id:/).slice(1)
  const out = []
  for (const raw of chunks) {
    const chunk = 'id:' + raw
    const id = field(chunk, 'id')
    if (!id) continue
    out.push({
      id,
      category: field(chunk, 'category') ?? 'unknown',
      displayName: field(chunk, 'displayName') ?? '',
      description: field(chunk, 'description') ?? '',
      sensitivity: field(chunk, 'sensitivity') ?? 'low',
      retentionBasis: field(chunk, 'retentionBasis') ?? 'operational',
      defaultRetention: field(chunk, 'defaultRetention') ?? '',
      exportable: boolField(chunk, 'exportable') ?? false,
      deletable: boolField(chunk, 'deletable') ?? false,
      correctionSupported: boolField(chunk, 'correctionSupported') ?? false,
      controlStatus: field(chunk, 'controlStatus') ?? 'unknown',
      vendorIds: listField(chunk, 'vendorIds'),
      sources: listField(chunk, 'sources'),
      knownLimitations: listField(chunk, 'knownLimitations'),
    })
  }
  return out
}

function extractRetention(src) {
  const arr = src.match(
    /RETENTION_POLICY_ITEMS[^=]*=\s*\[([\s\S]+?)\n\]\s*$/m
  )
  const body = arr ? arr[1] : src
  const chunks = body.split(/\n\s*\{\s*\n?\s*category:/).slice(1)
  const out = []
  for (const raw of chunks) {
    const chunk = 'category:' + raw
    const category = field(chunk, 'category')
    if (!category) continue
    out.push({
      category,
      defaultWindow: field(chunk, 'defaultWindow') ?? '',
      reason: field(chunk, 'reason') ?? '',
      deletionBehavior: field(chunk, 'deletionBehavior') ?? '',
      exportBehavior: field(chunk, 'exportBehavior') ?? '',
      automationStatus: field(chunk, 'automationStatus') ?? 'unknown',
      exceptions: listField(chunk, 'exceptions'),
    })
  }
  return out
}

// ── Renderers ────────────────────────────────────────────────────────────

function csvEscape(value) {
  const s = String(value ?? '')
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"'
  return s
}

function renderReadinessMarkdown(generatedAt, inventory, retention) {
  const lines = []
  lines.push('# VenueRise Privacy Readiness')
  lines.push('')
  lines.push(`_Generated: ${generatedAt}_`)
  lines.push('')
  lines.push('> ' + DISCLAIMER)
  lines.push('')
  lines.push('## Summary')
  lines.push('')
  lines.push(`- Total data categories: **${inventory.length}**`)
  lines.push(
    `- High/restricted sensitivity: **${inventory.filter((i) => i.sensitivity === 'high' || i.sensitivity === 'restricted').length}**`
  )
  lines.push(
    `- Export-ready: **${inventory.filter((i) => i.exportable).length}**`
  )
  lines.push(
    `- Deletion-ready: **${inventory.filter((i) => i.deletable).length}**`
  )
  lines.push(`- Retention policy rows: **${retention.length}**`)
  lines.push('')
  lines.push('## Data inventory')
  lines.push('')
  for (const item of inventory) {
    lines.push(`### ${item.displayName}`)
    lines.push('')
    lines.push(`- **Category**: ${item.category}`)
    lines.push(`- **Sensitivity**: ${item.sensitivity}`)
    lines.push(`- **Retention basis**: ${item.retentionBasis}`)
    lines.push(`- **Default retention**: ${item.defaultRetention}`)
    lines.push(
      `- **Exportable**: ${item.exportable ? 'yes' : 'no'} · **Deletable**: ${item.deletable ? 'yes' : 'no'} · **Correction**: ${item.correctionSupported ? 'yes' : 'no'}`
    )
    lines.push(`- **Control status**: ${item.controlStatus}`)
    lines.push(
      `- **Subprocessors**: ${item.vendorIds.length > 0 ? item.vendorIds.join(', ') : 'none'}`
    )
    lines.push('')
    if (item.description) lines.push(item.description)
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
  for (const r of retention) {
    lines.push(`### ${r.category}`)
    lines.push('')
    lines.push(`- **Default window**: ${r.defaultWindow}`)
    lines.push(`- **Reason**: ${r.reason}`)
    lines.push(`- **Deletion behaviour**: ${r.deletionBehavior}`)
    lines.push(`- **Export behaviour**: ${r.exportBehavior}`)
    lines.push(`- **Automation status**: ${r.automationStatus}`)
    if (r.exceptions.length > 0) {
      lines.push('')
      lines.push('Exceptions:')
      for (const e of r.exceptions) lines.push(`- ${e}`)
    }
    lines.push('')
  }
  return lines.join('\n')
}

function renderInventoryCsv(inventory) {
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
  for (const i of inventory) {
    rows.push(
      [
        i.id,
        i.category,
        i.displayName,
        i.sensitivity,
        i.retentionBasis,
        i.defaultRetention,
        i.exportable ? 'true' : 'false',
        i.deletable ? 'true' : 'false',
        i.correctionSupported ? 'true' : 'false',
        i.controlStatus,
        i.vendorIds.join('|'),
        String(i.knownLimitations.length),
      ]
        .map(csvEscape)
        .join(',')
    )
  }
  return rows.join('\n') + '\n'
}

function renderRetentionCsv(retention) {
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
  for (const r of retention) {
    rows.push(
      [
        r.category,
        r.defaultWindow,
        r.reason,
        r.deletionBehavior,
        r.exportBehavior,
        r.automationStatus,
        String(r.exceptions.length),
      ]
        .map(csvEscape)
        .join(',')
    )
  }
  return rows.join('\n') + '\n'
}

function renderDsrWorkflow(generatedAt) {
  return `# VenueRise DSR Workflow

_Generated: ${generatedAt}_

> ${DISCLAIMER}

## 1. Intake

Today: operators file DSRs on the subject's behalf via the
DsrRequestsCard on /dashboard/settings/billing. No public DSR
intake endpoint exists yet.

## 2. Status lifecycle

\`received\` → \`triage\` → \`identity_verification\` →
\`in_progress\` → \`awaiting_legal_review\` → terminal status
(\`fulfilled\` / \`denied\` / \`cancelled\`).

Each transition writes a typed audit row
(\`dsr_request_updated\`, plus terminal-state actions:
\`dsr_request_fulfilled\` / \`dsr_request_denied\` /
\`dsr_request_cancelled\`).

## 3. Identity verification

Operator-asserted via the **Mark identity verified** button on
the DSR detail. Stamps \`identity_verified_at\` and writes an
\`identity_verified\` timeline event.

## 4. Export preview (metadata-only)

\`POST /api/admin/privacy/dsr-requests/[id]/export-preview\`
returns the LIST of categories that would be searched + which
are restricted (audit / abuse / SSO / incident logs).
Does NOT fetch subject data. Audited via
\`dsr_export_previewed\`.

Real exports are performed by the operator under legal review
using the existing operator data export
(\`/api/admin/data-export\`) + lead-level PII redaction
(\`/api/admin/leads/[leadId]/redact-pii\`) flows.

## 5. Deletion review (non-destructive)

\`POST /api/admin/privacy/dsr-requests/[id]/deletion-review\`
returns a checklist: deletable / anonymizable / retention
exception applies. Does NOT delete anything. Audited via
\`dsr_deletion_reviewed\`.

## 6. Closure

Status \`fulfilled\` / \`denied\` / \`cancelled\` stamps the
matching close timestamp + \`closed_by\` + writes the matching
audit action.

## 7. What is automated vs manual

| Concern | Automated | Manual |
|---|---|---|
| Tracking | DSR record + timeline + audit actions | Operator-driven status transitions |
| Identity verification | Timestamp stamping | Operator confirmation |
| Export preview | Category scope enumeration | Real export under legal review |
| Deletion review | Checklist generation | Real deletion under legal review |
| Customer notification | Never automatic | Operator + legal review |

## 8. What NOT to claim

- Do NOT claim GDPR/CCPA/LGPD compliance — privacy readiness
  is not a legal attestation.
- Do NOT claim 30-day fulfilment windows unless contractually
  committed.
- Do NOT promise automated subject-initiated deletion.
- Do NOT claim "we do not use your data to train AI models"
  for vendor processing without confirmed contract terms.

## 9. Known limitations

- No anonymous DSR intake page yet.
- No automated identity-verification flow.
- Export preview is metadata-only.
- Deletion review is non-destructive.
- Conversation-level redaction not yet shipped.
- Audit / abuse / SSO / incident log retention sweepers not
  yet wired.
- Vendor AI processing terms (Anthropic training-use posture)
  require legal verification of the active contract.
`
}

function renderSummaryJson(generatedAt, inventory, retention) {
  return (
    JSON.stringify(
      {
        generatedAt,
        disclaimer: DISCLAIMER,
        counts: {
          totalCategories: inventory.length,
          highOrRestrictedSensitivity: inventory.filter(
            (i) => i.sensitivity === 'high' || i.sensitivity === 'restricted'
          ).length,
          exportReady: inventory.filter((i) => i.exportable).length,
          deletionReady: inventory.filter((i) => i.deletable).length,
          retentionPolicyRows: retention.length,
        },
      },
      null,
      2
    ) + '\n'
  )
}

// ── Main ─────────────────────────────────────────────────────────────────

function main() {
  if (!existsSync(INV_PATH) || !existsSync(RET_PATH)) {
    console.error(
      `✗ privacy source files not found at ${INV_PATH} or ${RET_PATH}`
    )
    process.exit(1)
  }
  const inventory = extractInventory(readFileSync(INV_PATH, 'utf8'))
  const retention = extractRetention(readFileSync(RET_PATH, 'utf8'))
  if (inventory.length === 0 || retention.length === 0) {
    console.error('✗ extractor returned empty list — extractor likely broken')
    process.exit(1)
  }
  const generatedAt = new Date().toISOString()
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true })

  const readinessPath = join(OUT_DIR, 'privacy-readiness-report.md')
  const invCsvPath = join(OUT_DIR, 'data-inventory.csv')
  const retCsvPath = join(OUT_DIR, 'retention-policy.csv')
  const dsrPath = join(OUT_DIR, 'dsr-workflow.md')
  const jsonPath = join(OUT_DIR, 'privacy-summary.json')

  writeFileSync(
    readinessPath,
    renderReadinessMarkdown(generatedAt, inventory, retention)
  )
  writeFileSync(invCsvPath, renderInventoryCsv(inventory))
  writeFileSync(retCsvPath, renderRetentionCsv(retention))
  writeFileSync(dsrPath, renderDsrWorkflow(generatedAt))
  writeFileSync(
    jsonPath,
    renderSummaryJson(generatedAt, inventory, retention)
  )

  console.log('✓ Privacy pack generated')
  console.log(`  ${readinessPath}`)
  console.log(`  ${invCsvPath}`)
  console.log(`  ${retCsvPath}`)
  console.log(`  ${dsrPath}`)
  console.log(`  ${jsonPath}`)
  console.log('')
  console.log(
    `  ${inventory.length} data categories · ${retention.length} retention rows`
  )
  console.log('')
  console.log(
    'Note: this is a STATIC pack. The live readiness summary lives behind /api/admin/privacy/readiness.'
  )
}

main()
