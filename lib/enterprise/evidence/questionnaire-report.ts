import 'server-only'
import { log } from '@/lib/log'
import {
  QUESTIONNAIRE_SECTIONS,
  artifactsForControl,
  limitationsForAnswer,
} from '@/lib/enterprise/evidence/questionnaire-map'
import { buildEvidenceReport } from '@/lib/enterprise/evidence/report'
import type {
  QuestionnaireAnswer,
  QuestionnaireFormat,
  QuestionnaireResponse,
  QuestionnaireResponseSummary,
  QuestionnaireSection,
} from '@/lib/enterprise/evidence/questionnaire-types'

/**
 * Phase 9J — Security questionnaire response builder.
 *
 * Assembles the QuestionnaireResponse surfaced by the admin
 * endpoint + the SecurityQuestionnaireCard. Three
 * responsibilities:
 *
 *   1. Filter the static section catalog by the requested
 *      `format`. Today every section ships in `generic`; the
 *      framework-specific variants (caiq-lite / sig-lite /
 *      vsaq-lite) slice subsets keyed to the canonical question
 *      ids those frameworks use.
 *   2. Hydrate each answer with artifact references + limitations
 *      pulled from the Phase 9I evidence control map. Editing
 *      the artifact list in `control-map.ts` automatically
 *      updates the questionnaire surface.
 *   3. Emit the standard disclaimer + summary counts +
 *      embed the Phase 9I evidence-report summary so a reviewer
 *      gets both surfaces in one file.
 *
 * The disclaimer is identical across every export so downstream
 * tools can grep for it. The "REVIEW BEFORE SENDING" rule is
 * baked into the disclaimer copy.
 */

const DISCLAIMER =
  'This response is provided for security review purposes only. It is generated from VenueRise\'s internal evidence map and DOES NOT represent a third-party certification or legal attestation. Operators MUST review every answer before sending to a buyer. See docs/ENTERPRISE-SALES-READINESS.md for the review checklist.'

/**
 * Question ids included for each framework. The `generic`
 * variant gets everything; the others are narrow slices the
 * framework's canonical question set actually asks. When a
 * buyer hands you a specific CAIQ row, look up the matching id
 * here + paste the resulting answer.
 *
 * The lists are intentionally illustrative — formal CAIQ has
 * 261 questions. A future phase can expand these to the full
 * mappings as buyer demand surfaces specific gaps.
 */
const FORMAT_QUESTION_IDS: Record<QuestionnaireFormat, ReadonlyArray<string> | 'all'> = {
  generic: 'all',
  'caiq-lite': [
    'soc2-certification',
    'product-security-overview',
    'rbac-implementation',
    'tenant-isolation',
    'sso-saml-oidc',
    'audit-coverage',
    'audit-tamper-evidence',
    'rate-limiting',
    'data-at-rest',
    'data-in-transit',
    'backup-strategy',
    'disaster-recovery',
    'subprocessors',
    'webhook-security',
    'no-raw-ip',
    'data-residency',
  ],
  'sig-lite': [
    'soc2-certification',
    'product-security-overview',
    'rbac-implementation',
    'least-privilege',
    'mfa-support',
    'sso-saml-oidc',
    'audit-coverage',
    'audit-retention',
    'rate-limiting',
    'abuse-detection',
    'pii-handling',
    'data-export',
    'backup-strategy',
    'disaster-recovery',
    'incident-process',
    'secrets-rotation',
  ],
  'vsaq-lite': [
    'product-security-overview',
    'rbac-implementation',
    'tenant-isolation',
    'sso-saml-oidc',
    'audit-coverage',
    'rate-limiting',
    'pii-handling',
    'backup-strategy',
    'incident-process',
    'webhook-security',
    'no-raw-ip',
    'pii-redaction-self-service',
  ],
}

function questionIdsForFormat(format: QuestionnaireFormat): Set<string> | 'all' {
  const value = FORMAT_QUESTION_IDS[format]
  if (value === 'all') return 'all'
  return new Set(value)
}

function summarize(
  sections: QuestionnaireSection[]
): QuestionnaireResponseSummary {
  const summary: QuestionnaireResponseSummary = {
    totalQuestions: 0,
    yes: 0,
    partial: 0,
    manual: 0,
    planned: 0,
    no: 0,
    notApplicable: 0,
  }
  for (const section of sections) {
    for (const answer of section.answers) {
      summary.totalQuestions += 1
      if (answer.status === 'yes') summary.yes += 1
      else if (answer.status === 'partial') summary.partial += 1
      else if (answer.status === 'manual') summary.manual += 1
      else if (answer.status === 'planned') summary.planned += 1
      else if (answer.status === 'no') summary.no += 1
      else if (answer.status === 'not_applicable') summary.notApplicable += 1
    }
  }
  return summary
}

export async function buildQuestionnaireResponse(
  format: QuestionnaireFormat
): Promise<QuestionnaireResponse> {
  const wantedIds = questionIdsForFormat(format)
  const warnings: string[] = []

  const sections: QuestionnaireSection[] = []
  for (const sec of QUESTIONNAIRE_SECTIONS) {
    const answers: QuestionnaireAnswer[] = []
    for (const q of sec.questions) {
      if (wantedIds !== 'all' && !wantedIds.has(q.questionId)) continue
      const refs = q.evidenceControlIds.flatMap((id) => artifactsForControl(id))
      const limits = limitationsForAnswer(
        q.evidenceControlIds,
        q.limitations ?? []
      )
      answers.push({
        question: { id: q.questionId, text: q.questionText },
        status: q.status,
        shortAnswer: q.shortAnswer,
        evidenceControlIds: [...q.evidenceControlIds],
        references: refs,
        limitations: limits,
      })
    }
    if (answers.length === 0) continue
    sections.push({
      id: sec.id,
      title: sec.title,
      description: sec.description,
      answers,
    })
  }

  // Embed the Phase 9I evidence summary so reviewers see both
  // surfaces. Best-effort — if the builder degrades we surface
  // a warning rather than failing the questionnaire export.
  let evidenceSummary
  try {
    const report = await buildEvidenceReport()
    evidenceSummary = report.summary
    if (report.backupPosture?.status === 'unknown') {
      warnings.push(
        'Backup posture is `unknown` — the live Supabase Management API check requires SUPABASE_PROJECT_REF + SUPABASE_ACCESS_TOKEN env vars. The questionnaire response reflects the unverified state.'
      )
    }
    for (const w of report.warnings) warnings.push(w)
  } catch (err) {
    log.warn(
      { err, format },
      'questionnaire.report.evidence_summary_threw'
    )
    warnings.push(
      'Evidence report builder threw unexpectedly; questionnaire continues without the embedded summary.'
    )
  }

  return {
    format,
    generatedAt: new Date().toISOString(),
    disclaimer: DISCLAIMER,
    summary: summarize(sections),
    sections,
    evidenceSummary,
    warnings,
  }
}

/**
 * Render the questionnaire as operator-readable markdown. Used
 * by the admin endpoint's `download=markdown` branch + the local
 * `build-questionnaire-pack.mjs` script's reference shape. The
 * markdown is meant to be pasted into a security questionnaire
 * tool or sent as an attachment after review.
 */
export function renderQuestionnaireMarkdown(
  response: QuestionnaireResponse
): string {
  const lines: string[] = []
  lines.push('# VenueRise Security Questionnaire Response')
  lines.push('')
  lines.push(`_Format: ${response.format}_`)
  lines.push(`_Generated: ${response.generatedAt}_`)
  lines.push('')
  lines.push('> ' + response.disclaimer)
  lines.push('')
  lines.push('## Summary')
  lines.push('')
  lines.push(`- Total questions: **${response.summary.totalQuestions}**`)
  lines.push(`- Yes: ${response.summary.yes}`)
  lines.push(`- Partial: ${response.summary.partial}`)
  lines.push(`- Manual / documented process: ${response.summary.manual}`)
  lines.push(`- Planned (roadmap): ${response.summary.planned}`)
  lines.push(`- No: ${response.summary.no}`)
  lines.push(`- Not applicable: ${response.summary.notApplicable}`)
  lines.push('')

  if (response.evidenceSummary) {
    lines.push('## Embedded evidence summary (Phase 9I)')
    lines.push('')
    lines.push(`- Total controls: **${response.evidenceSummary.total}**`)
    lines.push(`- Implemented: ${response.evidenceSummary.implemented}`)
    lines.push(`- Partial: ${response.evidenceSummary.partial}`)
    lines.push(`- Manual: ${response.evidenceSummary.manual}`)
    lines.push(`- Unknown: ${response.evidenceSummary.unknown}`)
    lines.push('')
  }

  if (response.warnings.length > 0) {
    lines.push('## Warnings')
    lines.push('')
    for (const w of response.warnings) lines.push(`- ${w}`)
    lines.push('')
  }

  for (const section of response.sections) {
    lines.push(`## ${section.title}`)
    lines.push('')
    lines.push(`_${section.description}_`)
    lines.push('')
    for (const a of section.answers) {
      lines.push(`### ${a.question.text}`)
      lines.push('')
      lines.push(`- **Answer:** \`${a.status}\``)
      lines.push('')
      lines.push(a.shortAnswer)
      lines.push('')
      if (a.evidenceControlIds.length > 0) {
        lines.push(
          `**Evidence controls:** ${a.evidenceControlIds.map((id) => `\`${id}\``).join(', ')}`
        )
        lines.push('')
      }
      if (a.references.length > 0) {
        lines.push('**References:**')
        for (const ref of a.references) {
          const label = ref.label ? ` — ${ref.label}` : ''
          lines.push(`- \`${ref.kind}\`: \`${ref.reference}\`${label}`)
        }
        lines.push('')
      }
      if (a.limitations.length > 0) {
        lines.push('**Limitations:**')
        for (const limit of a.limitations) lines.push(`- ${limit}`)
        lines.push('')
      }
    }
  }
  return lines.join('\n')
}

/**
 * Render the questionnaire as CSV. One row per question. Columns
 * are narrow enough for a security-questionnaire reviewer to
 * scan without horizontal scrolling. Markdown carries the full
 * detail.
 */
export function renderQuestionnaireCsv(
  response: QuestionnaireResponse
): string {
  const escape = (value: unknown): string => {
    if (value === null || value === undefined) return ''
    const s = String(value)
    if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`
    return s
  }
  const header = [
    'section',
    'question_id',
    'question',
    'status',
    'short_answer',
    'evidence_control_ids',
    'reference_count',
    'limitation_count',
  ].join(',')
  const rows: string[] = []
  for (const section of response.sections) {
    for (const a of section.answers) {
      rows.push(
        [
          escape(section.title),
          escape(a.question.id),
          escape(a.question.text),
          escape(a.status),
          escape(a.shortAnswer),
          escape(a.evidenceControlIds.join('|')),
          escape(a.references.length),
          escape(a.limitations.length),
        ].join(',')
      )
    }
  }
  return '﻿' + [header, ...rows].join('\r\n') + '\r\n'
}

/**
 * Pure pass-through for the JSON branch — the route returns the
 * full structured QuestionnaireResponse without rendering.
 */
export function renderQuestionnaireJson(
  response: QuestionnaireResponse
): QuestionnaireResponse {
  return response
}
