#!/usr/bin/env node
// Phase 9P — Local commitments pack generator.
//
// Writes a static pack to `artifacts/commitments/` without
// requiring a running server or any Supabase credentials.
// Operators use this for off-line review of the per-area
// support posture (which areas surface unsupported-risk flags)
// and for sharing the readiness template with auditors.
//
// Output:
//   - artifacts/commitments/commitments-summary.json
//   - artifacts/commitments/commitments-readiness.md
//   - artifacts/commitments/commitments-readiness.csv
//
// Honesty:
//   - The pack documents the per-area support POSTURE — it
//     does NOT include any tenant's recorded commitments.
//   - Operators MUST review before sharing externally.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const POLICY_PATH = join(
  ROOT,
  'lib',
  'enterprise',
  'commitments',
  'policy.ts'
)
const OUT_DIR = join(ROOT, 'artifacts', 'commitments')

const DISCLAIMER =
  'This register tracks operator-recorded commitments. It is not legal advice and does not prove contractual compliance. Commitments are operator-recorded and operator-reviewed; the platform does NOT autonomously parse contracts and does NOT auto-create commitments from uploaded documents.'

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

function extractSupportPosture(src) {
  const arr = src.match(
    /COMMITMENT_AREA_SUPPORT[^=]*=\s*\[([\s\S]+?)\n\]\s*$/m
  )
  const body = arr ? arr[1] : src
  const chunks = body.split(/\n\s*\{\s*\n?\s*area:/).slice(1)
  const out = []
  for (const raw of chunks) {
    const chunk = 'area:' + raw
    const area = field(chunk, 'area')
    if (!area) continue
    out.push({
      area,
      status: field(chunk, 'status') ?? 'supported',
      reason: field(chunk, 'reason') ?? '',
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

function renderReadinessMarkdown(generatedAt, posture) {
  const lines = []
  lines.push('# VenueRise Contract Commitments — Support Posture')
  lines.push('')
  lines.push(`_Generated: ${generatedAt}_`)
  lines.push('')
  lines.push('> ' + DISCLAIMER)
  lines.push('')
  lines.push('## Per-area support posture')
  lines.push('')
  lines.push(
    'The list below documents which commitment areas surface an unsupported-risk warning today. Areas not listed are treated as `supported`.'
  )
  lines.push('')
  lines.push('| Area | Status | Reason |')
  lines.push('|---|---|---|')
  for (const p of posture) {
    lines.push(`| ${p.area} | ${p.status} | ${p.reason} |`)
  }
  lines.push('')
  lines.push('## Readiness summary template')
  lines.push('')
  lines.push(
    'Use the live `/api/admin/security/commitments/readiness` endpoint (or the CommitmentsReadinessCard) to produce the tenant-specific summary. Headline counts:'
  )
  lines.push('')
  lines.push('- Total commitments')
  lines.push('- Active commitments')
  lines.push('- High + critical risk counts')
  lines.push('- Overdue review count')
  lines.push('- Due within 30 days')
  lines.push('- Unsupported-risk flag count')
  lines.push('')
  lines.push('## Notes')
  lines.push('')
  lines.push(
    '- This is a STATIC pack documenting the per-area support posture only.'
  )
  lines.push(
    '- The pack does NOT contain any tenant\'s recorded commitments.'
  )
  lines.push(
    '- Operators must review before sharing externally; per-tenant readiness exports happen via the admin route + CommitmentsReadinessCard.'
  )
  return lines.join('\n')
}

function renderReadinessCsv(posture) {
  const headers = ['area', 'status', 'reason']
  const rows = [headers.join(',')]
  for (const p of posture) {
    rows.push([p.area, p.status, p.reason].map(csvEscape).join(','))
  }
  return rows.join('\n') + '\n'
}

function renderSummaryJson(generatedAt, posture) {
  const byStatus = {}
  for (const p of posture) {
    byStatus[p.status] = (byStatus[p.status] ?? 0) + 1
  }
  return (
    JSON.stringify(
      {
        generatedAt,
        disclaimer: DISCLAIMER,
        supportPostureRows: posture.length,
        byStatus,
      },
      null,
      2
    ) + '\n'
  )
}

// ── Main ─────────────────────────────────────────────────────────────────

function main() {
  if (!existsSync(POLICY_PATH)) {
    console.error(`✗ commitments policy not found at ${POLICY_PATH}`)
    process.exit(1)
  }
  const posture = extractSupportPosture(readFileSync(POLICY_PATH, 'utf8'))
  if (posture.length === 0) {
    console.error('✗ no posture rows extracted — extractor likely broken')
    process.exit(1)
  }
  const generatedAt = new Date().toISOString()
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true })

  const jsonPath = join(OUT_DIR, 'commitments-summary.json')
  const mdPath = join(OUT_DIR, 'commitments-readiness.md')
  const csvPath = join(OUT_DIR, 'commitments-readiness.csv')

  writeFileSync(jsonPath, renderSummaryJson(generatedAt, posture))
  writeFileSync(mdPath, renderReadinessMarkdown(generatedAt, posture))
  writeFileSync(csvPath, renderReadinessCsv(posture))

  console.log('✓ Commitments pack generated')
  console.log(`  ${jsonPath}`)
  console.log(`  ${mdPath}`)
  console.log(`  ${csvPath}`)
  console.log('')
  console.log(`  ${posture.length} per-area support posture rows`)
  console.log('')
  console.log(
    'Note: this is a STATIC pack. The live commitments register lives behind /api/admin/security/commitments.'
  )
}

main()
