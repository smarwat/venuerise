#!/usr/bin/env node
// Phase 9J — Local questionnaire pack generator.
//
// Writes a static questionnaire pack + buyer security summary
// to `artifacts/evidence/questionnaires/` without requiring a
// running server or any Supabase credentials. Operators use
// this for security-questionnaire responses where a live
// session isn't available.
//
// Output:
//   - artifacts/evidence/questionnaires/generic-security-questionnaire.md
//   - artifacts/evidence/questionnaires/generic-security-questionnaire.csv
//   - artifacts/evidence/questionnaires/buyer-security-summary.md
//
// Source: parses `lib/enterprise/evidence/questionnaire-map.ts`
// as text. Same regex-extraction pattern as the Phase 9I
// `build-evidence-pack.mjs`. Full descriptions + per-control
// artifact references live in the TS source + in the live
// endpoint.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const MAP_PATH = join(
  ROOT,
  'lib',
  'enterprise',
  'evidence',
  'questionnaire-map.ts'
)
const SUMMARY_PATH = join(
  ROOT,
  'lib',
  'enterprise',
  'evidence',
  'security-summary.ts'
)
const OUT_DIR = join(ROOT, 'artifacts', 'evidence', 'questionnaires')

const DISCLAIMER =
  'This response is provided for security review purposes only. It is generated from VenueRise\'s internal evidence map and DOES NOT represent a third-party certification or legal attestation. Operators MUST review every answer before sending to a buyer.'

// ── Section extraction ───────────────────────────────────────────────────

function extractSections(source) {
  // Match `QUESTIONNAIRE_SECTIONS[...] = [ ... ]` body.
  const arrayMatch = source.match(
    /QUESTIONNAIRE_SECTIONS[^=]*=\s*\[([\s\S]+?)\n\]\s*$/m
  )
  const body = arrayMatch ? arrayMatch[1] : source
  // Each section starts with `{ id: '...', title: '...', ... }`.
  const sectionChunks = body.split(/\n\s*\{\s*\n?\s*id:/).slice(1)
  const sections = []
  for (const raw of sectionChunks) {
    const chunk = 'id:' + raw
    const id = field(chunk, 'id')
    const title = field(chunk, 'title')
    const description = field(chunk, 'description')
    if (!id || !title) continue
    const questions = extractQuestions(chunk)
    sections.push({ id, title, description, questions })
  }
  return sections
}

function extractQuestions(sectionChunk) {
  // Find `questions: [` and walk forward counting bracket depth
  // so we stop at the OUTERMOST closing bracket. The previous
  // non-greedy regex terminated at the first nested `]` (e.g.
  // inside a question's `limitations: [ ... ]`), dropping every
  // question that came after one with limitations.
  const start = sectionChunk.indexOf('questions:')
  if (start === -1) return []
  const openIdx = sectionChunk.indexOf('[', start)
  if (openIdx === -1) return []
  let depth = 0
  let closeIdx = -1
  for (let i = openIdx; i < sectionChunk.length; i += 1) {
    const ch = sectionChunk[i]
    if (ch === '[') depth += 1
    else if (ch === ']') {
      depth -= 1
      if (depth === 0) {
        closeIdx = i
        break
      }
    }
  }
  if (closeIdx === -1) return []
  const body = sectionChunk.slice(openIdx + 1, closeIdx)
  const chunks = body.split(/\n\s*\{\s*\n?\s*questionId:/).slice(1)
  const out = []
  for (const raw of chunks) {
    const chunk = 'questionId:' + raw
    const questionId = field(chunk, 'questionId')
    const questionText = field(chunk, 'questionText')
    const status = field(chunk, 'status')
    const shortAnswer = field(chunk, 'shortAnswer')
    if (!questionId || !questionText) continue
    out.push({
      questionId,
      questionText,
      status: status ?? 'partial',
      shortAnswer: shortAnswer ?? '',
    })
  }
  return out
}

function field(chunk, name) {
  const re = new RegExp(`${name}:\\s*['"]((?:[^'"\\\\]|\\\\.)+)['"]`)
  const m = chunk.match(re)
  return m ? m[1].replace(/\\'/g, "'") : null
}

function summarize(sections) {
  const summary = {
    totalQuestions: 0,
    yes: 0,
    partial: 0,
    manual: 0,
    planned: 0,
    no: 0,
    notApplicable: 0,
  }
  for (const sec of sections) {
    for (const q of sec.questions) {
      summary.totalQuestions += 1
      if (q.status === 'yes') summary.yes += 1
      else if (q.status === 'partial') summary.partial += 1
      else if (q.status === 'manual') summary.manual += 1
      else if (q.status === 'planned') summary.planned += 1
      else if (q.status === 'no') summary.no += 1
      else if (q.status === 'not_applicable') summary.notApplicable += 1
    }
  }
  return summary
}

function renderQuestionnaireMd(sections, summary, generatedAt) {
  const lines = []
  lines.push('# VenueRise Security Questionnaire Response (Static Pack)')
  lines.push('')
  lines.push(`_Generated: ${generatedAt}_`)
  lines.push(`_Format: generic_`)
  lines.push('')
  lines.push('> ' + DISCLAIMER)
  lines.push('')
  lines.push(
    '_Authoritative version lives behind `/api/admin/security/questionnaire-response` (admin/owner only). This static pack is suitable for security-questionnaire responses where a live session is not available._'
  )
  lines.push('')
  lines.push('## Summary')
  lines.push('')
  lines.push(`- Total questions: **${summary.totalQuestions}**`)
  lines.push(`- Yes: ${summary.yes}`)
  lines.push(`- Partial: ${summary.partial}`)
  lines.push(`- Manual: ${summary.manual}`)
  lines.push(`- Planned: ${summary.planned}`)
  lines.push(`- No: ${summary.no}`)
  lines.push(`- Not applicable: ${summary.notApplicable}`)
  lines.push('')
  for (const sec of sections) {
    lines.push(`## ${sec.title}`)
    if (sec.description) {
      lines.push('')
      lines.push(`_${sec.description}_`)
    }
    lines.push('')
    for (const q of sec.questions) {
      lines.push(`### ${q.questionText}`)
      lines.push('')
      lines.push(`- **Answer:** \`${q.status}\``)
      lines.push('')
      lines.push(q.shortAnswer)
      lines.push('')
    }
  }
  return lines.join('\n')
}

function renderQuestionnaireCsv(sections) {
  const escape = (value) => {
    if (value === null || value === undefined) return ''
    const s = String(value)
    if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`
    return s
  }
  const header = ['section', 'question_id', 'question', 'status', 'short_answer'].join(',')
  const rows = []
  for (const sec of sections) {
    for (const q of sec.questions) {
      rows.push(
        [
          escape(sec.title),
          escape(q.questionId),
          escape(q.questionText),
          escape(q.status),
          escape(q.shortAnswer),
        ].join(',')
      )
    }
  }
  return '﻿' + [header, ...rows].join('\r\n') + '\r\n'
}

// ── Buyer summary extraction ─────────────────────────────────────────────

function extractBuyerSummary(source) {
  const overview = extractConstString(source, 'OVERVIEW')
  const disclaimer = extractConstString(source, 'DISCLAIMER')
  const knownLimitations = extractStringArray(source, 'KNOWN_LIMITATIONS')
  const plannedImprovements = extractStringArray(source, 'PLANNED_IMPROVEMENTS')
  return { overview, disclaimer, knownLimitations, plannedImprovements }
}

function extractConstString(source, name) {
  const re = new RegExp(`const\\s+${name}\\s*=\\s*\\n?\\s*['"]([\\s\\S]+?)['"]\\s*$`, 'm')
  const m = source.match(re)
  return m ? m[1].replace(/\\'/g, "'") : null
}

function extractStringArray(source, name) {
  const re = new RegExp(`const\\s+${name}[^=]*=\\s*\\[([\\s\\S]+?)\\]`)
  const m = source.match(re)
  if (!m) return []
  const body = m[1]
  const items = []
  for (const match of body.matchAll(/['"]((?:[^'"\\]|\\.)+)['"]/g)) {
    items.push(match[1].replace(/\\'/g, "'"))
  }
  return items
}

function renderBuyerSummaryMd(summary, generatedAt) {
  const lines = []
  lines.push('# VenueRise Security Summary (Static Pack)')
  lines.push('')
  lines.push(`_Generated: ${generatedAt}_`)
  lines.push('')
  if (summary.disclaimer) {
    lines.push('> ' + summary.disclaimer)
    lines.push('')
  }
  if (summary.overview) {
    lines.push('## Overview')
    lines.push('')
    lines.push(summary.overview)
    lines.push('')
  }
  lines.push('## Known limitations')
  lines.push('')
  for (const l of summary.knownLimitations) lines.push(`- ${l}`)
  lines.push('')
  lines.push('## Planned improvements')
  lines.push('')
  for (const p of summary.plannedImprovements) lines.push(`- ${p}`)
  lines.push('')
  lines.push(
    '_Authoritative version with full per-section detail lives behind `/api/admin/security/buyer-security-summary` (admin/owner only)._'
  )
  return lines.join('\n')
}

// ── Run ─────────────────────────────────────────────────────────────────

if (!existsSync(MAP_PATH)) {
  console.error(`✗ Cannot find questionnaire map at ${MAP_PATH}. Has Phase 9J shipped?`)
  process.exit(1)
}
if (!existsSync(SUMMARY_PATH)) {
  console.error(`✗ Cannot find security summary at ${SUMMARY_PATH}.`)
  process.exit(1)
}

const mapSource = readFileSync(MAP_PATH, 'utf8')
const summarySource = readFileSync(SUMMARY_PATH, 'utf8')

const sections = extractSections(mapSource)
if (sections.length === 0) {
  console.error('✗ Extracted 0 sections. Questionnaire map shape may have changed.')
  process.exit(1)
}
const summary = summarize(sections)
const buyerSummary = extractBuyerSummary(summarySource)
const generatedAt = new Date().toISOString()

mkdirSync(OUT_DIR, { recursive: true })
const mdPath = join(OUT_DIR, 'generic-security-questionnaire.md')
const csvPath = join(OUT_DIR, 'generic-security-questionnaire.csv')
const buyerPath = join(OUT_DIR, 'buyer-security-summary.md')

writeFileSync(mdPath, renderQuestionnaireMd(sections, summary, generatedAt))
writeFileSync(csvPath, renderQuestionnaireCsv(sections))
writeFileSync(buyerPath, renderBuyerSummaryMd(buyerSummary, generatedAt))

console.log('✓ Questionnaire pack generated')
console.log(`  ${mdPath}`)
console.log(`  ${csvPath}`)
console.log(`  ${buyerPath}`)
console.log('')
console.log(
  `  ${sections.length} sections, ${summary.totalQuestions} questions (${summary.yes} yes, ${summary.partial} partial, ${summary.manual} manual, ${summary.planned} planned, ${summary.no} no)`
)
console.log('')
console.log(
  'Note: this is a STATIC pack. Live response (with embedded evidence summary) lives behind /api/admin/security/questionnaire-response.'
)
process.exit(0)
