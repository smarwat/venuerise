import 'server-only'
import { log } from '@/lib/log'
import { EVIDENCE_CONTROLS } from '@/lib/enterprise/evidence/control-map'
import type {
  EvidenceControl,
  EvidenceControlStatus,
  EvidenceReport,
  EvidenceReportSummary,
} from '@/lib/enterprise/evidence/types'
import { getBackupPosture } from '@/lib/enterprise/disaster-recovery/backup-posture'

/**
 * Phase 9I — Evidence report builder.
 *
 * Server-only. Assembles the EvidenceReport surfaced by the
 * admin endpoint + the SecurityEvidenceCenter card + the local
 * build-evidence-pack script. Three responsibilities:
 *
 *   1. Read the static control map verbatim.
 *   2. Roll up status counts so the card can render the
 *      summary chips without re-counting.
 *   3. Pull the Phase 9H backup posture snapshot best-effort.
 *      If the helper degrades or throws (it shouldn't — the
 *      helper itself wraps in try/catch), record a warning and
 *      omit the snapshot. Never throws back to the caller.
 *
 * ── HONESTY POSTURE ─────────────────────────────────────────────────────
 * The disclaimer string is fixed + identical across every export
 * so downstream consumers (auditors, sales engineers) can grep
 * for it. The auditor-facing version lives in
 * docs/SOC2-EVIDENCE-MAP.md.
 */

const DISCLAIMER =
  'This report is an internal evidence package and does not represent a third-party SOC 2 attestation. Formal SOC 2 requires an auditor, scoped system description, control design review, observation period, evidence collection, and exceptions/remediation. See docs/SOC2-EVIDENCE-MAP.md for the gap inventory.'

function summarize(controls: ReadonlyArray<EvidenceControl>): EvidenceReportSummary {
  const summary: EvidenceReportSummary = {
    total: controls.length,
    implemented: 0,
    partial: 0,
    manual: 0,
    unknown: 0,
    notApplicable: 0,
  }
  const counters: Record<EvidenceControlStatus, keyof EvidenceReportSummary> = {
    implemented: 'implemented',
    partial: 'partial',
    manual: 'manual',
    unknown: 'unknown',
    not_applicable: 'notApplicable',
  }
  for (const c of controls) {
    const key = counters[c.status]
    summary[key] = (summary[key] as number) + 1
  }
  return summary
}

export async function buildEvidenceReport(): Promise<EvidenceReport> {
  const warnings: string[] = []

  let backupPostureSnapshot: EvidenceReport['backupPosture']
  try {
    const posture = await getBackupPosture()
    backupPostureSnapshot = {
      status: posture.status,
      rtoHours: posture.rtoHours,
      rpoHours: posture.rpoHours,
      retentionDays: posture.retentionDays,
      dryRunCadence: posture.dryRunCadence,
      lastCheckedAt: posture.lastCheckedAt,
    }
    if (posture.status === 'unknown') {
      warnings.push(
        'Backup posture status is `unknown` — Supabase Management API env vars not configured. Policy targets still apply.'
      )
    }
  } catch (err) {
    // Defensive — getBackupPosture wraps in try/catch internally
    // and never throws. This second layer is for future-proofing.
    log.warn({ err }, 'evidence.report.backup_posture_threw')
    warnings.push(
      'Backup posture helper threw unexpectedly; the report continues without that section.'
    )
  }

  return {
    generatedAt: new Date().toISOString(),
    disclaimer: DISCLAIMER,
    summary: summarize(EVIDENCE_CONTROLS),
    // Spread to materialize as a mutable array — the report
    // type expects EvidenceControl[] (not ReadonlyArray).
    // The control map module remains the source of truth; the
    // copy here is by-value safe because EvidenceControl rows
    // are pure data.
    controls: [...EVIDENCE_CONTROLS],
    backupPosture: backupPostureSnapshot,
    warnings,
  }
}

/**
 * Render the report as operator-readable markdown. Used by the
 * admin endpoint's `format=markdown` branch + the local
 * `build-evidence-pack` script. Keeps the same structure across
 * both surfaces so the file an operator downloads matches what
 * the script writes to `artifacts/evidence/`.
 */
export function renderEvidenceReportMarkdown(report: EvidenceReport): string {
  const lines: string[] = []
  lines.push('# VenueRise Security Evidence Report')
  lines.push('')
  lines.push(`_Generated: ${report.generatedAt}_`)
  lines.push('')
  lines.push('> ' + report.disclaimer)
  lines.push('')
  lines.push('## Summary')
  lines.push('')
  lines.push(`- Total controls: **${report.summary.total}**`)
  lines.push(`- Implemented: ${report.summary.implemented}`)
  lines.push(`- Partial: ${report.summary.partial}`)
  lines.push(`- Manual: ${report.summary.manual}`)
  lines.push(`- Unknown: ${report.summary.unknown}`)
  lines.push(`- Not applicable: ${report.summary.notApplicable}`)
  lines.push('')

  if (report.backupPosture) {
    lines.push('## Backup posture snapshot')
    lines.push('')
    lines.push(`- Status: \`${report.backupPosture.status}\``)
    lines.push(`- RTO target: ${report.backupPosture.rtoHours}h`)
    lines.push(`- RPO target: ${report.backupPosture.rpoHours}h`)
    lines.push(`- Retention: ${report.backupPosture.retentionDays}d`)
    lines.push(`- Dry-run cadence: ${report.backupPosture.dryRunCadence}`)
    lines.push(`- Last checked: ${report.backupPosture.lastCheckedAt}`)
    lines.push('')
  }

  if (report.warnings.length > 0) {
    lines.push('## Warnings')
    lines.push('')
    for (const w of report.warnings) {
      lines.push(`- ${w}`)
    }
    lines.push('')
  }

  // Group controls by category for readability.
  const byCategory = new Map<string, EvidenceControl[]>()
  for (const c of report.controls) {
    const list = byCategory.get(c.category) ?? []
    list.push(c)
    byCategory.set(c.category, list)
  }

  for (const [category, controls] of byCategory.entries()) {
    lines.push(`## ${category.replace(/_/g, ' ')}`)
    lines.push('')
    for (const c of controls) {
      lines.push(`### ${c.title}`)
      lines.push('')
      lines.push(`- **Status:** \`${c.status}\``)
      lines.push(`- **SOC 2 categories:** ${c.soc2Categories.join(', ')}`)
      lines.push('')
      lines.push(c.description)
      lines.push('')
      if (c.artifacts.length > 0) {
        lines.push('**Artifacts:**')
        for (const a of c.artifacts) {
          const label = a.label ? ` — ${a.label}` : ''
          lines.push(`- \`${a.kind}\`: \`${a.reference}\`${label}`)
        }
        lines.push('')
      }
      if (c.limitations.length > 0) {
        lines.push('**Limitations:**')
        for (const l of c.limitations) {
          lines.push(`- ${l}`)
        }
        lines.push('')
      }
      if (c.recommendedNext.length > 0) {
        lines.push('**Recommended next:**')
        for (const r of c.recommendedNext) {
          lines.push(`- ${r}`)
        }
        lines.push('')
      }
    }
  }
  return lines.join('\n')
}

/**
 * Render the controls table as CSV. Header columns:
 *   id, title, category, soc2_categories, status, artifact_count, limitation_count
 *
 * Keeps the CSV narrow so a security questionnaire reviewer can
 * scan it without horizontal scrolling. The markdown export is
 * the place to read full descriptions.
 */
export function renderEvidenceReportCsv(report: EvidenceReport): string {
  const escape = (value: unknown): string => {
    if (value === null || value === undefined) return ''
    const s = String(value)
    if (/[",\n\r]/.test(s)) {
      return `"${s.replace(/"/g, '""')}"`
    }
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
  const rows = report.controls.map((c) =>
    [
      escape(c.id),
      escape(c.title),
      escape(c.category),
      escape(c.soc2Categories.join('|')),
      escape(c.status),
      escape(c.artifacts.length),
      escape(c.limitations.length),
      escape(c.recommendedNext.length),
    ].join(',')
  )
  return '﻿' + [header, ...rows].join('\r\n') + '\r\n'
}
