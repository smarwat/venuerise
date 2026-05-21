import 'server-only'
import {
  buildBuyerSecuritySummary,
  renderBuyerSecuritySummaryMarkdown,
} from '@/lib/enterprise/evidence/security-summary'
import {
  buildQuestionnaireResponse,
  renderQuestionnaireMarkdown,
  renderQuestionnaireCsv,
} from '@/lib/enterprise/evidence/questionnaire-report'
import {
  buildEvidenceReport,
  renderEvidenceReportMarkdown,
  renderEvidenceReportCsv,
} from '@/lib/enterprise/evidence/report'
import {
  buildVendorRiskSummary,
  buildSubprocessorDisclosure,
  renderSubprocessorDisclosureMarkdown,
  renderSubprocessorDisclosureCsv,
  renderVendorRiskMarkdown,
  renderVendorRiskCsv,
} from '@/lib/enterprise/vendor-risk/report'
import { buildPrivacyReadinessSummary, renderPrivacyReadinessMarkdown } from '@/lib/enterprise/privacy/readiness'
import {
  SEVERITY_POLICY,
  INCIDENT_RESPONSE_DISCLAIMER,
} from '@/lib/enterprise/incidents/policy'
import { BACKUP_POSTURE_POLICY } from '@/lib/enterprise/disaster-recovery/policy'
import {
  ARTIFACT_VISIBILITY,
  PUBLIC_KNOWN_LIMITATIONS,
  PUBLIC_TRUST_HEADLINE,
  PUBLIC_TRUST_SECTIONS,
  SCOPE_INCLUDES,
  TRUST_CENTER_DISCLAIMER,
} from '@/lib/enterprise/trust-center/policy'
import type {
  TrustAccessScope,
  TrustArtifactFormat,
  TrustArtifactManifestItem,
  TrustArtifactType,
  TrustCenterPublicSummary,
  TrustPacketSummary,
} from '@/lib/enterprise/trust-center/types'
import { VENDOR_REGISTRY } from '@/lib/enterprise/vendor-risk/vendor-registry'

/**
 * Phase 9N — Trust Center artifact builder.
 *
 * All builders pull from the existing 9I–9M sources of truth.
 * The public summary uses the curated `PUBLIC_TRUST_SECTIONS`
 * copy + the vendor registry filtered to public-disclosable
 * rows. Gated artifacts re-render the existing buyer
 * security summary / questionnaire / evidence report /
 * vendor risk / privacy readiness / incident policy / DR
 * policy markdown.
 *
 * NEVER:
 *   - Reads `process.env` values into artifacts.
 *   - Emits internal-only vendor rows.
 *   - Includes raw audit / incident / DSR / customer data.
 *   - Returns webhook URLs or routing keys.
 *
 * All renderers carry the identical `TRUST_CENTER_DISCLAIMER`
 * string so downstream consumers can grep for it.
 */

// ── Public summary ──────────────────────────────────────────────────────

export async function buildPublicTrustSummary(): Promise<TrustCenterPublicSummary> {
  // Build the buyer-safe subprocessor list straight from the
  // vendor registry's `disclosureStatus === 'public'` rows.
  // Internal-only vendors (stripe-cli, optional alert vendors
  // before promotion) are filtered out.
  const publicSubprocessorNames = VENDOR_REGISTRY.filter(
    (v) => v.disclosureStatus === 'public'
  ).map((v) => v.name)

  return {
    generatedAt: new Date().toISOString(),
    disclaimer: TRUST_CENTER_DISCLAIMER,
    headline: PUBLIC_TRUST_HEADLINE,
    publicSubprocessorNames,
    sections: PUBLIC_TRUST_SECTIONS.map((s) => ({
      id: s.id,
      title: s.title,
      body: s.body,
      bullets: s.bullets,
    })),
    knownLimitations: [...PUBLIC_KNOWN_LIMITATIONS],
  }
}

// ── Manifest ──────────────────────────────────────────────────────────────

function artifactTitle(type: TrustArtifactType): string {
  const map: Record<TrustArtifactType, string> = {
    security_overview: 'Security overview',
    subprocessor_disclosure: 'Subprocessor disclosure',
    privacy_readiness: 'Privacy + DSR readiness',
    questionnaire_response: 'Security questionnaire response',
    buyer_security_summary: 'Buyer security summary',
    evidence_report: 'Evidence report',
    vendor_risk_report: 'Vendor risk report',
    incident_response_summary: 'Incident response summary',
    disaster_recovery_summary: 'Disaster recovery summary',
    soc2_evidence_map: 'SOC 2 evidence map (internal)',
    custom: 'Custom artifact',
  }
  return map[type]
}

function artifactDescription(type: TrustArtifactType): string {
  const map: Record<TrustArtifactType, string> = {
    security_overview:
      'High-level security posture suitable for an initial procurement contact.',
    subprocessor_disclosure:
      'Buyer-safe list of production subprocessors with data categories + risk tier.',
    privacy_readiness:
      'Data inventory + retention policy + DSR posture (operator-tracked workflow).',
    questionnaire_response:
      'Pre-filled answers to common security questionnaire questions. Operator MUST review before sending.',
    buyer_security_summary:
      'Short prose summary suitable for a sales-call follow-up email.',
    evidence_report:
      'Consolidated SOC 2-style evidence report cross-referencing existing controls.',
    vendor_risk_report:
      'Internal vendor + assurance registry. Not for buyer share without review.',
    incident_response_summary:
      'Severity matrix + response targets + alert routing posture.',
    disaster_recovery_summary:
      'RTO / RPO + backup posture + restore intent audit.',
    soc2_evidence_map:
      'TSC cross-walk for an auditor or buyer security review.',
    custom: 'Operator-curated artifact (manual upload — not auto-generated).',
  }
  return map[type]
}

function artifactFormats(type: TrustArtifactType): TrustArtifactFormat[] {
  // Most artifacts support markdown + json. Subprocessor +
  // vendor + questionnaire + evidence renderers additionally
  // support CSV.
  const csvCapable: ReadonlyArray<TrustArtifactType> = [
    'subprocessor_disclosure',
    'questionnaire_response',
    'evidence_report',
    'vendor_risk_report',
  ]
  return csvCapable.includes(type)
    ? ['markdown', 'csv', 'json']
    : ['markdown', 'json']
}

export async function buildTrustArtifactManifest(
  scope: TrustAccessScope
): Promise<TrustArtifactManifestItem[]> {
  const includedTypes = SCOPE_INCLUDES[scope]
  const allTypes: ReadonlyArray<TrustArtifactType> = [
    'security_overview',
    'subprocessor_disclosure',
    'buyer_security_summary',
    'questionnaire_response',
    'privacy_readiness',
    'disaster_recovery_summary',
    'incident_response_summary',
    'evidence_report',
    'vendor_risk_report',
    'soc2_evidence_map',
  ]
  return allTypes.map((type) => {
    const visibility = ARTIFACT_VISIBILITY[type]
    const included = (includedTypes as ReadonlyArray<TrustArtifactType>).includes(
      type
    )
    let scopeNote = included
      ? `Included in ${scope}.`
      : `Not included in ${scope}.`
    if (visibility === 'internal_only') {
      scopeNote = 'Internal-only — never emitted to a buyer-facing scope.'
    }
    return {
      type,
      title: artifactTitle(type),
      description: artifactDescription(type),
      visibility,
      formats: artifactFormats(type),
      includedInScope: included && visibility !== 'internal_only',
      scopeNote,
    }
  })
}

// ── Packet ────────────────────────────────────────────────────────────────

export async function buildTrustPacket(
  scope: TrustAccessScope
): Promise<TrustPacketSummary> {
  const warnings: string[] = []
  if (scope === 'custom') {
    warnings.push(
      'Scope `custom` has no auto-built artifact list — operator curation flow is not shipped in 9N.'
    )
  }
  const artifacts = await buildTrustArtifactManifest(scope)
  const counts = {
    total: artifacts.length,
    included: artifacts.filter((a) => a.includedInScope).length,
    publicOnly: artifacts.filter((a) => a.visibility === 'public').length,
    gatedOnly: artifacts.filter((a) => a.visibility === 'gated').length,
  }
  return {
    generatedAt: new Date().toISOString(),
    disclaimer: TRUST_CENTER_DISCLAIMER,
    scope,
    artifacts,
    counts,
    warnings,
  }
}

// ── Renderers ─────────────────────────────────────────────────────────────

export function renderTrustPacketMarkdown(packet: TrustPacketSummary): string {
  const lines: string[] = []
  lines.push('# VenueRise Trust Packet')
  lines.push('')
  lines.push(`_Scope: ${packet.scope} · Generated: ${packet.generatedAt}_`)
  lines.push('')
  lines.push('> ' + packet.disclaimer)
  lines.push('')
  lines.push('## Manifest')
  lines.push('')
  lines.push('| Artifact | Visibility | Included | Formats |')
  lines.push('|---|---|---|---|')
  for (const a of packet.artifacts) {
    lines.push(
      `| ${a.title} | ${a.visibility} | ${a.includedInScope ? 'yes' : 'no'} | ${a.formats.join(', ')} |`
    )
  }
  if (packet.warnings.length > 0) {
    lines.push('')
    lines.push('## Warnings')
    lines.push('')
    for (const w of packet.warnings) lines.push(`- ${w}`)
  }
  lines.push('')
  lines.push('## Notes')
  lines.push('')
  lines.push('- Operator must review every artifact before sharing externally.')
  lines.push('- This packet does NOT represent a SOC 2 certification.')
  lines.push('- Internal-only artifacts (custom) are never emitted to a buyer-facing scope.')
  return lines.join('\n')
}

export function renderPublicTrustSummaryMarkdown(
  summary: TrustCenterPublicSummary
): string {
  const lines: string[] = []
  lines.push('# VenueRise Trust Center')
  lines.push('')
  lines.push(`_Generated: ${summary.generatedAt}_`)
  lines.push('')
  lines.push('> ' + summary.disclaimer)
  lines.push('')
  lines.push(summary.headline)
  lines.push('')
  for (const s of summary.sections) {
    lines.push(`## ${s.title}`)
    lines.push('')
    lines.push(s.body)
    if (s.bullets && s.bullets.length > 0) {
      lines.push('')
      for (const b of s.bullets) lines.push(`- ${b}`)
    }
    lines.push('')
  }
  lines.push('## Production subprocessors')
  lines.push('')
  for (const n of summary.publicSubprocessorNames) {
    lines.push(`- ${n}`)
  }
  lines.push('')
  lines.push('## Known limitations')
  lines.push('')
  for (const k of summary.knownLimitations) {
    lines.push(`- ${k}`)
  }
  return lines.join('\n')
}

/**
 * Render an incident-response summary in buyer-safe form.
 * Pulls from the policy module ONLY (no live incident rows).
 */
function renderIncidentResponseSummaryMarkdown(): string {
  const lines: string[] = []
  lines.push('# Incident response summary')
  lines.push('')
  lines.push('> ' + INCIDENT_RESPONSE_DISCLAIMER)
  lines.push('')
  lines.push('## Severity matrix')
  lines.push('')
  lines.push(
    '| Severity | First response | Update cadence | Mitigation | PIR required | Customer notification |'
  )
  lines.push('|---|---:|---:|---:|---|---|')
  for (const row of SEVERITY_POLICY) {
    lines.push(
      `| ${row.label} | ${row.targetFirstResponseMinutes}m | every ${row.targetUpdateCadenceMinutes}m | ${row.targetMitigationMinutes}m | ${row.postIncidentReviewRequired ? 'yes' : 'no'} | ${row.customerNotification} |`
    )
  }
  lines.push('')
  lines.push('Targets are best-effort. VenueRise does NOT staff a 24/7 on-call rotation and does NOT offer an uptime SLA contract.')
  return lines.join('\n')
}

function renderDisasterRecoverySummaryMarkdown(): string {
  const lines: string[] = []
  lines.push('# Disaster recovery summary')
  lines.push('')
  lines.push(
    '> Recovery Time Objective and Recovery Point Objective targets are internal operational goals, not contractual SLAs.'
  )
  lines.push('')
  lines.push(`- **Provider**: ${BACKUP_POSTURE_POLICY.provider}`)
  lines.push(`- **RTO target**: ${BACKUP_POSTURE_POLICY.rtoHours} hours`)
  lines.push(`- **RPO target**: ${BACKUP_POSTURE_POLICY.rpoHours} hours`)
  lines.push(
    `- **Minimum retention target**: ${BACKUP_POSTURE_POLICY.minRetentionDays} days`
  )
  lines.push(`- **Dry-run cadence**: ${BACKUP_POSTURE_POLICY.dryRunCadence}`)
  lines.push('')
  lines.push(BACKUP_POSTURE_POLICY.customerSummary)
  lines.push('')
  lines.push(
    'Restores are performed through approved Supabase workflows by VenueRise staff. The product UI NEVER executes a restore.'
  )
  return lines.join('\n')
}

function renderSoc2EvidenceMapMarkdown(): string {
  return [
    '# SOC 2 evidence map (excerpt)',
    '',
    '> VenueRise is NOT currently SOC 2 certified. The evidence map cross-references existing controls to Trust Service Criteria for buyer / auditor review.',
    '',
    'See `docs/SOC2-EVIDENCE-MAP.md` for the full document. The internal control map (`lib/enterprise/evidence/control-map.ts`) is the source of truth.',
  ].join('\n')
}

/**
 * Render a single artifact at a given scope. The caller is
 * responsible for permission-gating (admin route vs. gated
 * token route). This helper enforces:
 *
 *   - Internal-only artifacts return an empty markdown body
 *     with a disclaimer.
 *   - Artifacts not in the requested scope return an empty
 *     body with a "not included in scope" note.
 */
export async function renderTrustArtifactMarkdown(
  type: TrustArtifactType,
  scope: TrustAccessScope
): Promise<string> {
  const visibility = ARTIFACT_VISIBILITY[type]
  const included = (
    SCOPE_INCLUDES[scope] as ReadonlyArray<TrustArtifactType>
  ).includes(type)
  if (visibility === 'internal_only') {
    return `# Artifact unavailable\n\n> ${TRUST_CENTER_DISCLAIMER}\n\nThis artifact (${type}) is internal-only and is never emitted to a buyer-facing scope.`
  }
  if (!included) {
    return `# Artifact not in scope\n\n> ${TRUST_CENTER_DISCLAIMER}\n\nThis artifact (${type}) is not included in the requested scope (${scope}).`
  }
  if (type === 'security_overview') {
    return renderPublicTrustSummaryMarkdown(await buildPublicTrustSummary())
  }
  if (type === 'subprocessor_disclosure') {
    return renderSubprocessorDisclosureMarkdown(
      await buildSubprocessorDisclosure()
    )
  }
  if (type === 'buyer_security_summary') {
    return renderBuyerSecuritySummaryMarkdown(await buildBuyerSecuritySummary())
  }
  if (type === 'questionnaire_response') {
    return renderQuestionnaireMarkdown(
      await buildQuestionnaireResponse('generic')
    )
  }
  if (type === 'privacy_readiness') {
    // Trust artifacts are tenant-agnostic; pass null venueId so
    // the readiness builder uses the platform-wide DSR counts
    // (will be 0 / 0 when called without a venue context).
    return renderPrivacyReadinessMarkdown(
      await buildPrivacyReadinessSummary(null)
    )
  }
  if (type === 'incident_response_summary') {
    return renderIncidentResponseSummaryMarkdown()
  }
  if (type === 'disaster_recovery_summary') {
    return renderDisasterRecoverySummaryMarkdown()
  }
  if (type === 'evidence_report') {
    return renderEvidenceReportMarkdown(await buildEvidenceReport())
  }
  if (type === 'vendor_risk_report') {
    return renderVendorRiskMarkdown(await buildVendorRiskSummary())
  }
  if (type === 'soc2_evidence_map') {
    return renderSoc2EvidenceMapMarkdown()
  }
  return `# Artifact not available\n\n> ${TRUST_CENTER_DISCLAIMER}`
}

export async function renderTrustArtifactCsv(
  type: TrustArtifactType,
  scope: TrustAccessScope
): Promise<string> {
  const visibility = ARTIFACT_VISIBILITY[type]
  const included = (
    SCOPE_INCLUDES[scope] as ReadonlyArray<TrustArtifactType>
  ).includes(type)
  if (visibility === 'internal_only' || !included) {
    return ''
  }
  if (type === 'subprocessor_disclosure') {
    return renderSubprocessorDisclosureCsv(await buildSubprocessorDisclosure())
  }
  if (type === 'questionnaire_response') {
    return renderQuestionnaireCsv(await buildQuestionnaireResponse('generic'))
  }
  if (type === 'evidence_report') {
    return renderEvidenceReportCsv(await buildEvidenceReport())
  }
  if (type === 'vendor_risk_report') {
    return renderVendorRiskCsv(await buildVendorRiskSummary())
  }
  return ''
}
