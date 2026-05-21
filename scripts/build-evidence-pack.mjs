#!/usr/bin/env node
// Phase 9I — Local evidence pack generator.
//
// Writes a minimal evidence pack to `artifacts/evidence/` without
// requiring a running server or any Supabase credentials. The
// authoritative version of the report lives behind
// `/api/admin/security/evidence-report` (admin/owner only); this
// script produces a STATIC summary suitable for security
// questionnaires + procurement reviewers.
//
// What we generate:
//   - artifacts/evidence/security-evidence-report.md
//   - artifacts/evidence/security-evidence-controls.csv
//   - artifacts/evidence/security-evidence-summary.json
//
// What we DON'T do:
//   - Connect to Supabase. Backup posture live data is omitted;
//     operators run the in-app card for that.
//   - Hit the admin endpoint. Operators do that interactively;
//     the static pack is for the "before you have a session"
//     security-review case.
//
// Source: parses `lib/enterprise/evidence/control-map.ts` as
// text + extracts each control's id/title/category/status. The
// file shape is stable (rows are object literals with predictable
// keys); regex extraction is good enough for the static pack.
// Full descriptions + artifact references live in the TS source
// + in the in-app report.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const CONTROL_MAP_PATH = join(
  ROOT,
  'lib',
  'enterprise',
  'evidence',
  'control-map.ts'
)
const OUT_DIR = join(ROOT, 'artifacts', 'evidence')

const DISCLAIMER =
  'This report is an internal evidence package and does not represent a third-party SOC 2 attestation. Formal SOC 2 requires an auditor, scoped system description, control design review, observation period, evidence collection, and exceptions/remediation. See docs/SOC2-EVIDENCE-MAP.md for the gap inventory.'

function extractControls(source) {
  // Match each top-level `{ id: '...', title: '...', category: '...', soc2Categories: [...], status: '...', ... }`
  // block inside the EVIDENCE_CONTROLS array. We're permissive
  // about field order — the regex pulls each field independently
  // so reordering in the source doesn't break the parse.
  const blocks = []
  // Split on `},` followed by a newline + leading whitespace +
  // optional comment header. Each chunk should contain one
  // control's full literal.
  const arrayMatch = source.match(
    /EVIDENCE_CONTROLS[^=]*=\s*\[([\s\S]+?)\]\s*$/m
  )
  const body = arrayMatch ? arrayMatch[1] : source

  // Naive object-literal split — each control starts with `{ id:`.
  const chunks = body.split(/\n\s*\{\s*\n?\s*id:/).slice(1)
  for (const chunkRaw of chunks) {
    const chunk = 'id:' + chunkRaw
    const id = field(chunk, 'id')
    const title = field(chunk, 'title')
    const category = field(chunk, 'category')
    const status = field(chunk, 'status')
    if (!id || !title || !category || !status) continue
    const soc2Match = chunk.match(/soc2Categories:\s*\[([^\]]*)\]/)
    const soc2 = soc2Match
      ? soc2Match[1]
          .split(',')
          .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
          .filter(Boolean)
      : []
    const limitationsMatch = chunk.match(/limitations:\s*\[([\s\S]*?)\]/)
    const limitations = limitationsMatch
      ? countStringEntries(limitationsMatch[1])
      : 0
    const nextMatch = chunk.match(/recommendedNext:\s*\[([\s\S]*?)\]/)
    const recommendedNext = nextMatch ? countStringEntries(nextMatch[1]) : 0
    const artifactsMatch = chunk.match(/artifacts:\s*\[([\s\S]*?)\]/)
    const artifacts = artifactsMatch
      ? countArtifactEntries(artifactsMatch[1])
      : 0
    blocks.push({
      id,
      title,
      category,
      soc2Categories: soc2,
      status,
      artifacts,
      limitations,
      recommendedNext,
    })
  }
  return blocks
}

function field(chunk, name) {
  const re = new RegExp(`${name}:\\s*['"]([^'"]+)['"]`)
  const m = chunk.match(re)
  return m ? m[1] : null
}

function countStringEntries(body) {
  // Count single/double-quoted string literals — used to count
  // limitations / recommendedNext array entries without fully
  // parsing the literal.
  return (body.match(/['"]/g) ?? []).length / 2
}

function countArtifactEntries(body) {
  // Each artifact is an object literal `{ kind: '...', reference:
  // '...', label?: '...' }`. Count the `kind:` occurrences.
  return (body.match(/kind:/g) ?? []).length
}

function summarize(controls) {
  const summary = {
    total: controls.length,
    implemented: 0,
    partial: 0,
    manual: 0,
    unknown: 0,
    notApplicable: 0,
  }
  for (const c of controls) {
    if (c.status === 'implemented') summary.implemented++
    else if (c.status === 'partial') summary.partial++
    else if (c.status === 'manual') summary.manual++
    else if (c.status === 'unknown') summary.unknown++
    else if (c.status === 'not_applicable') summary.notApplicable++
  }
  return summary
}

function renderMarkdown(controls, summary, generatedAt) {
  const lines = []
  lines.push('# VenueRise Security Evidence Report (Static Pack)')
  lines.push('')
  lines.push(`_Generated: ${generatedAt}_`)
  lines.push('')
  lines.push('> ' + DISCLAIMER)
  lines.push('')
  lines.push(
    '_Authoritative version lives behind `/api/admin/security/evidence-report` (admin/owner only). This static pack is suitable for security-questionnaire responses where a live session is not available._'
  )
  lines.push('')
  lines.push('## Summary')
  lines.push('')
  lines.push(`- Total controls: **${summary.total}**`)
  lines.push(`- Implemented: ${summary.implemented}`)
  lines.push(`- Partial: ${summary.partial}`)
  lines.push(`- Manual: ${summary.manual}`)
  lines.push(`- Unknown: ${summary.unknown}`)
  lines.push(`- Not applicable: ${summary.notApplicable}`)
  lines.push('')
  lines.push('## Controls')
  lines.push('')
  // Group by category for readability.
  const byCategory = new Map()
  for (const c of controls) {
    const list = byCategory.get(c.category) ?? []
    list.push(c)
    byCategory.set(c.category, list)
  }
  for (const [cat, list] of byCategory.entries()) {
    lines.push(`### ${cat.replace(/_/g, ' ')}`)
    lines.push('')
    lines.push('| Title | Status | SOC 2 | Refs |')
    lines.push('|---|---|---|---:|')
    for (const c of list) {
      lines.push(
        `| ${c.title} | \`${c.status}\` | ${c.soc2Categories.join(', ')} | ${c.artifacts} |`
      )
    }
    lines.push('')
  }
  lines.push(
    'For full descriptions + artifact references + limitations / recommended-next items, generate the live report:'
  )
  lines.push('')
  lines.push('```')
  lines.push(
    'curl -H "cookie: <session>" \\\n  https://your-host/api/admin/security/evidence-report?format=markdown \\\n  -o security-evidence-report-live.md'
  )
  lines.push('```')
  lines.push('')
  return lines.join('\n')
}

function renderCsv(controls) {
  const escape = (value) => {
    if (value === null || value === undefined) return ''
    const s = String(value)
    if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`
    return s
  }
  const header = [
    'id',
    'title',
    'category',
    'soc2_categories',
    'status',
    'artifact_count',
    'limitation_count',
    'recommended_next_count',
  ].join(',')
  const rows = controls.map((c) =>
    [
      escape(c.id),
      escape(c.title),
      escape(c.category),
      escape(c.soc2Categories.join('|')),
      escape(c.status),
      escape(c.artifacts),
      escape(c.limitations),
      escape(c.recommendedNext),
    ].join(',')
  )
  return '﻿' + [header, ...rows].join('\r\n') + '\r\n'
}

// ── Run ─────────────────────────────────────────────────────────────────

if (!existsSync(CONTROL_MAP_PATH)) {
  console.error(
    `✗ Cannot find control map at ${CONTROL_MAP_PATH}. Has Phase 9I shipped?`
  )
  process.exit(1)
}

const source = readFileSync(CONTROL_MAP_PATH, 'utf8')
const controls = extractControls(source)
if (controls.length === 0) {
  console.error('✗ Extracted 0 controls. Control map shape may have changed.')
  process.exit(1)
}
const summary = summarize(controls)
const generatedAt = new Date().toISOString()

mkdirSync(OUT_DIR, { recursive: true })
const mdPath = join(OUT_DIR, 'security-evidence-report.md')
const csvPath = join(OUT_DIR, 'security-evidence-controls.csv')
const jsonPath = join(OUT_DIR, 'security-evidence-summary.json')

writeFileSync(mdPath, renderMarkdown(controls, summary, generatedAt))
writeFileSync(csvPath, renderCsv(controls))
writeFileSync(
  jsonPath,
  JSON.stringify(
    {
      generatedAt,
      disclaimer: DISCLAIMER,
      summary,
      controlCount: controls.length,
    },
    null,
    2
  )
)

console.log('✓ Evidence pack generated')
console.log(`  ${mdPath}`)
console.log(`  ${csvPath}`)
console.log(`  ${jsonPath}`)
console.log('')
console.log(
  `  ${summary.total} controls (${summary.implemented} implemented, ${summary.partial} partial, ${summary.manual} manual, ${summary.unknown} unknown)`
)
console.log('')
console.log(
  'Note: this is a STATIC pack. Live report (with backup posture snapshot) lives behind /api/admin/security/evidence-report.'
)
process.exit(0)
