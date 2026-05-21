#!/usr/bin/env node
// Phase 9L — Local incident response pack generator.
//
// Writes a static pack to `artifacts/evidence/incidents/`
// without requiring a running server, Supabase credentials, or
// even a configured alert webhook. Operators use this for
// off-line review and to share the runbook + PIR template with
// procurement / security review.
//
// Output:
//   - artifacts/evidence/incidents/incident-response-runbook.md
//   - artifacts/evidence/incidents/post-incident-review-template.md
//   - artifacts/evidence/incidents/incident-severity-matrix.csv
//   - artifacts/evidence/incidents/incident-response-summary.json
//
// Honesty:
//   - The pack documents the INTENT encoded in
//     lib/enterprise/incidents/policy.ts. It does NOT claim that
//     a 24/7 on-call rotation is in place. It does NOT claim
//     contractual SLAs.
//   - Operators MUST review before sharing externally.
//
// The script duplicates the policy constants verbatim instead
// of importing the TS source so it can run with `node` on a
// machine without a TypeScript runtime.

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const OUT_DIR = join(ROOT, 'artifacts', 'evidence', 'incidents')

const DISCLAIMER =
  "These targets describe VenueRise's intended incident response. VenueRise does NOT currently staff a 24/7 on-call rotation and does NOT offer an uptime SLA contract. Detectors are conservative + operator-triggered; no autonomous remediation occurs. Customer notification for any security event requires legal/operator review before sending."

// Duplicated from lib/enterprise/incidents/policy.ts. When that
// file changes, update this constant in the same PR (the
// check-incident-response scanner asserts the policy file
// exists; staying in sync is a code-review discipline).
const SEVERITY_POLICY = [
  {
    severity: 'sev1',
    label: 'SEV1 — Critical',
    definition:
      'Confirmed customer data breach, full platform outage, irreversible data loss, or active account takeover with operator confirmation.',
    targetFirstResponseMinutes: 15,
    targetUpdateCadenceMinutes: 60,
    targetMitigationMinutes: 240,
    postIncidentReviewRequired: true,
    customerNotification: 'required_legal_review',
    escalation:
      'Owner + platform on-call. Legal review for any customer notification BEFORE sending. No public statements without operator sign-off.',
    examples: [
      'Confirmed unauthorized access to customer data.',
      'Platform unavailable for >30 minutes affecting all venues.',
      'Backup posture has failed with no recoverable snapshot.',
    ],
  },
  {
    severity: 'sev2',
    label: 'SEV2 — Major',
    definition:
      'Major tenant impact, suspected unauthorized access pending confirmation, backup posture in critical state, or widespread degradation.',
    targetFirstResponseMinutes: 60,
    targetUpdateCadenceMinutes: 240,
    targetMitigationMinutes: 1440,
    postIncidentReviewRequired: true,
    customerNotification: 'recommended_legal_review',
    escalation:
      'Owner + platform team. Engage legal if customer-facing notification likely. Update prospects in active procurement reviews if affected.',
    examples: [
      'Repeated SSO failures from a known buyer domain over a multi-hour window.',
      'Rate-limit storm affecting widget intake for a high-traffic venue.',
      'Backup posture check returning `critical` with operator-verifiable evidence.',
    ],
  },
  {
    severity: 'sev3',
    label: 'SEV3 — Minor',
    definition:
      'Suspicious pattern, repeated SSO failures within a single tenant, abuse spike, vendor security concern, or single-tenant impact.',
    targetFirstResponseMinutes: 240,
    targetUpdateCadenceMinutes: 1440,
    targetMitigationMinutes: 4320,
    postIncidentReviewRequired: false,
    customerNotification: 'operator_discretion',
    escalation:
      'Venue owner + platform team during business hours. Document in the timeline and resolve within the target window.',
    examples: [
      'Single-venue abuse spike attributed to a misconfigured embed.',
      'Vendor security advisory affecting a non-critical subprocessor.',
      'CSP report cluster indicating a third-party script issue.',
    ],
  },
  {
    severity: 'sev4',
    label: 'SEV4 — Informational',
    definition:
      'Informational or manual-review item that the operator wants tracked. No customer impact expected.',
    targetFirstResponseMinutes: 1440,
    targetUpdateCadenceMinutes: 10080,
    targetMitigationMinutes: 10080,
    postIncidentReviewRequired: false,
    customerNotification: 'not_required',
    escalation:
      'Owner discretion. Track in the IncidentResponseCard so the audit trail exists.',
    examples: [
      'Scheduled vendor review noted as an incident for traceability.',
      'Tabletop exercise outcomes captured for the runbook.',
    ],
  },
]

const POSTMORTEM_REQUIRED_AT_OR_ABOVE = 'sev2'

const DEFAULT_ALERT_ROUTES = [
  { channel: 'slack', targetLabel: '#incident-alerts', minSeverity: 'sev3' },
  {
    channel: 'pagerduty',
    targetLabel: 'venuerise-platform',
    minSeverity: 'sev2',
  },
  { channel: 'sentry', targetLabel: 'venuerise (issues)', minSeverity: 'sev3' },
]

const DETECTOR_DEFAULTS = {
  abuseSpike: { windowMinutes: 60, minRows: 25, suggestedSeverity: 'sev3' },
  ssoFailureSpike: {
    windowMinutes: 60,
    minRows: 10,
    suggestedSeverity: 'sev3',
  },
  backupPosture: {
    windowMinutes: 1440,
    minRows: 1,
    suggestedSeverity: 'sev2',
  },
  healthCheck: { windowMinutes: 60, minRows: 1, suggestedSeverity: 'sev2' },
}

// ── Runbook markdown ─────────────────────────────────────────────────────

function renderRunbook() {
  const lines = []
  lines.push('# VenueRise Incident Response Runbook')
  lines.push('')
  lines.push(`_Generated: ${new Date().toISOString()}_`)
  lines.push('')
  lines.push('> ' + DISCLAIMER)
  lines.push('')

  lines.push('## 1. Severity matrix')
  lines.push('')
  for (const row of SEVERITY_POLICY) {
    lines.push(`### ${row.label}`)
    lines.push('')
    lines.push(row.definition)
    lines.push('')
    lines.push(
      `- **Target first response**: ${row.targetFirstResponseMinutes} minutes`
    )
    lines.push(
      `- **Target update cadence**: every ${row.targetUpdateCadenceMinutes} minutes`
    )
    lines.push(
      `- **Target mitigation**: ${row.targetMitigationMinutes} minutes`
    )
    lines.push(
      `- **Post-incident review required**: ${row.postIncidentReviewRequired ? 'yes' : 'no'}`
    )
    lines.push(`- **Customer notification**: ${row.customerNotification}`)
    lines.push(`- **Escalation**: ${row.escalation}`)
    lines.push('')
    lines.push('Examples:')
    for (const ex of row.examples) lines.push(`- ${ex}`)
    lines.push('')
  }

  lines.push('## 2. Detection sources')
  lines.push('')
  lines.push(
    'Conservative detectors run against persistent signals. They are operator-triggered (`/api/admin/security/incidents/detect`) — there is no autonomous detection cron.'
  )
  lines.push('')
  lines.push(
    `- **abuse_events**: window ${DETECTOR_DEFAULTS.abuseSpike.windowMinutes}m, threshold ${DETECTOR_DEFAULTS.abuseSpike.minRows} rows, suggested severity ${DETECTOR_DEFAULTS.abuseSpike.suggestedSeverity}.`
  )
  lines.push(
    `- **sso_login_events**: window ${DETECTOR_DEFAULTS.ssoFailureSpike.windowMinutes}m, threshold ${DETECTOR_DEFAULTS.ssoFailureSpike.minRows} failed/blocked outcomes, suggested severity ${DETECTOR_DEFAULTS.ssoFailureSpike.suggestedSeverity}.`
  )
  lines.push(
    `- **backup_posture**: candidate only when overall status is \`warning\` or \`critical\`. Suggested severity ${DETECTOR_DEFAULTS.backupPosture.suggestedSeverity} (\`critical\` upgrades to SEV2).`
  )
  lines.push(
    `- **health_check**: stub today; returns warnings + zero candidates. Runtime health probing is on the planned-improvements list.`
  )
  lines.push('')

  lines.push('## 3. Alert routing')
  lines.push('')
  lines.push(
    'Env-gated end-to-end. Master toggle: `INCIDENT_ALERTS_ENABLED`. Per-channel env vars: `INCIDENT_SLACK_WEBHOOK_URL`, `INCIDENT_PAGERDUTY_ROUTING_KEY`. When env is absent, helpers return `skipped_disabled` / `skipped_unconfigured` and never throw. Webhook URLs and routing keys are NEVER logged, returned, or stored — only the operator-readable label appears in `incident_alert_deliveries`.'
  )
  lines.push('')
  for (const route of DEFAULT_ALERT_ROUTES) {
    lines.push(
      `- **${route.channel}** → \`${route.targetLabel}\` — fires at ${route.minSeverity} and above.`
    )
  }
  lines.push('')

  lines.push('## 4. Incident lifecycle')
  lines.push('')
  lines.push('1. **Declare** — owner/admin opens incident via the')
  lines.push('   IncidentResponseCard or POST `/api/admin/security/incidents`.')
  lines.push('   Severity + category + source set at creation.')
  lines.push('2. **Triage** — operator moves status to `investigating`. Add')
  lines.push('   notes to the timeline. Optionally send alert via POST')
  lines.push('   `/api/admin/security/incidents/[id]/alert`.')
  lines.push('3. **Mitigate** — operator moves status to `mitigated` once')
  lines.push('   customer-visible impact is contained. `mitigated_at` is')
  lines.push('   stamped automatically.')
  lines.push('4. **Resolve** — operator moves status to `resolved` once root')
  lines.push('   cause is addressed. `resolved_at` + `resolved_by` are')
  lines.push('   stamped automatically. The audit row is `incident_resolved`.')
  lines.push(
    `5. **Post-incident review** — REQUIRED for ${POSTMORTEM_REQUIRED_AT_OR_ABOVE.toUpperCase()} and above. Append via PATCH \`postmortem\` field; lands as a timeline event with kind \`postmortem_added\`. Use the template in this pack.`
  )
  lines.push('')

  lines.push('## 5. What is automated vs manual')
  lines.push('')
  lines.push('| Concern | Automated | Manual |')
  lines.push('|---|---|---|')
  lines.push('| Incident detection | Operator-triggered detectors | Operator review of every candidate before materialisation |')
  lines.push('| Audit trail | All create/update/resolve/alert writes are typed audit actions | Operator interpretation of the trail |')
  lines.push('| Status transitions | Lifecycle timestamps stamped automatically | Status moves require an explicit operator PATCH |')
  lines.push('| Alert routing | Env-gated Slack/PagerDuty/Sentry delivery | Operator chooses when to fire (per-incident button) |')
  lines.push('| Customer notification | Never — no automatic outreach | Routed through legal/operator review for every security event |')
  lines.push('| Remediation | None — no auto-revert, no auto-block | All remediation is operator-led |')
  lines.push('')

  lines.push('## 6. Customer notification caveat')
  lines.push('')
  lines.push(
    'No customer-facing notification fires automatically from this system. The customer-notification policy column on each severity row indicates whether legal review is required (SEV1), recommended (SEV2), at operator discretion (SEV3), or not required (SEV4). The product does not include a status page or buyer-facing breach notification flow today. Breach notification timing depends on each buyer\'s contractual SLA and is confirmed per contract, not encoded in product.'
  )
  lines.push('')

  lines.push('## 7. Tabletop exercise checklist')
  lines.push('')
  lines.push(
    '1. Schedule quarterly. Capture the date + participants in the IncidentResponseCard as a SEV4 informational row.'
  )
  lines.push('2. Pick a scenario from the severity-matrix examples.')
  lines.push('3. Walk through: detection path → triage owner → alert posture → mitigation → resolution → PIR.')
  lines.push('4. Note gaps (missing runbook page, ambiguous threshold, env var that should be set).')
  lines.push('5. File follow-up incidents (SEV4) for each gap with an `external_reference` pointing at the tracker.')
  lines.push('')

  lines.push('## 8. Known limitations')
  lines.push('')
  lines.push('- No 24/7 staffed on-call rotation.')
  lines.push('- No uptime SLA contract.')
  lines.push('- Alert routing is OFF by default; operator must opt in.')
  lines.push('- Customer notification requires legal/operator review.')
  lines.push('- Detectors are conservative and operator-triggered, not a continuous cron.')
  lines.push('- Health-flag detector is a stub.')
  lines.push('- incident_alert_deliveries are stored without webhook URLs / routing keys — only operator-readable labels.')
  lines.push('- Slack/PagerDuty webhooks are not enabled unless env vars are configured.')
  lines.push('')
  lines.push('## 9. What NOT to claim to buyers')
  lines.push('')
  lines.push('- Do NOT claim 24/7 monitoring unless the on-call rotation is staffed AND a paging vendor is wired.')
  lines.push('- Do NOT claim "we will notify you within X hours of a breach" without legal review of the underlying contract.')
  lines.push('- Do NOT claim uptime SLA — there is no SLA contract.')
  lines.push('- Do NOT promise automated remediation. None exists.')
  lines.push('')
  return lines.join('\n')
}

// ── PIR template ─────────────────────────────────────────────────────────

function renderPostmortemTemplate() {
  return `# Post-Incident Review — VenueRise

> ${DISCLAIMER}

## Summary

- **Incident id**:
- **Title**:
- **Severity** (sev1 / sev2 / sev3 / sev4):
- **Status**:
- **Detected at**:
- **Mitigated at**:
- **Resolved at**:
- **Time to mitigation**:
- **Time to resolution**:
- **Owner / scribe**:

## What happened

(One paragraph plain English; what the customer / operator experienced.)

## Detection path

(How was this caught — operator report, abuse detector candidate, SSO failure
spike, backup posture warning, vendor advisory, other?)

## Mitigation steps

1.
2.
3.

## Root cause

(Code path / config drift / vendor incident / human action. Be specific —
this is the section that drives the action items.)

## Customer impact

- Tenants affected:
- Data categories touched:
- Customer notification posture (required_legal_review / recommended_legal_review / operator_discretion / not_required):
- Notification sent? (yes / no / pending legal review):

## What went well

-
-

## What went poorly

-
-

## Action items

| # | Item | Owner | Due | Ticket |
|---|---|---|---|---|
| 1 |  |  |  |  |
| 2 |  |  |  |  |

## Followups to runbook

(Update docs/INCIDENT-RESPONSE.md, docs/RUNBOOK.md, or
lib/enterprise/incidents/policy.ts if this incident exposed an ambiguity in
the documented intent. Reference the PR.)
`
}

// ── Severity CSV ─────────────────────────────────────────────────────────

function renderSeverityCsv() {
  const headers = [
    'severity',
    'label',
    'definition',
    'first_response_minutes',
    'update_cadence_minutes',
    'mitigation_minutes',
    'post_incident_review_required',
    'customer_notification',
    'escalation',
  ]
  const rows = [headers.join(',')]
  for (const r of SEVERITY_POLICY) {
    const cells = [
      r.severity,
      r.label,
      r.definition,
      String(r.targetFirstResponseMinutes),
      String(r.targetUpdateCadenceMinutes),
      String(r.targetMitigationMinutes),
      r.postIncidentReviewRequired ? 'true' : 'false',
      r.customerNotification,
      r.escalation,
    ].map((v) => {
      const s = String(v ?? '')
      return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
    })
    rows.push(cells.join(','))
  }
  return rows.join('\n') + '\n'
}

// ── Summary JSON ─────────────────────────────────────────────────────────

function renderSummaryJson() {
  return JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      disclaimer: DISCLAIMER,
      severityCount: SEVERITY_POLICY.length,
      postmortemRequiredAtOrAbove: POSTMORTEM_REQUIRED_AT_OR_ABOVE,
      alertRoutes: DEFAULT_ALERT_ROUTES,
      detectorDefaults: DETECTOR_DEFAULTS,
    },
    null,
    2
  ) + '\n'
}

// ── Main ─────────────────────────────────────────────────────────────────

function main() {
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true })

  const runbookPath = join(OUT_DIR, 'incident-response-runbook.md')
  const pirPath = join(OUT_DIR, 'post-incident-review-template.md')
  const csvPath = join(OUT_DIR, 'incident-severity-matrix.csv')
  const jsonPath = join(OUT_DIR, 'incident-response-summary.json')

  writeFileSync(runbookPath, renderRunbook())
  writeFileSync(pirPath, renderPostmortemTemplate())
  writeFileSync(csvPath, renderSeverityCsv())
  writeFileSync(jsonPath, renderSummaryJson())

  console.log('✓ Incident response pack generated')
  console.log(`  ${runbookPath}`)
  console.log(`  ${pirPath}`)
  console.log(`  ${csvPath}`)
  console.log(`  ${jsonPath}`)
  console.log('')
  console.log(
    `  ${SEVERITY_POLICY.length} severity rows · PIR required at or above ${POSTMORTEM_REQUIRED_AT_OR_ABOVE.toUpperCase()}`
  )
  console.log('')
  console.log(
    'Note: this is a STATIC pack. The live incident list lives behind /api/admin/security/incidents.'
  )
}

main()
