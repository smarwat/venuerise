# VenueRise Incident Response Runbook

_Generated: 2026-05-20T18:29:52.271Z_

> These targets describe VenueRise's intended incident response. VenueRise does NOT currently staff a 24/7 on-call rotation and does NOT offer an uptime SLA contract. Detectors are conservative + operator-triggered; no autonomous remediation occurs. Customer notification for any security event requires legal/operator review before sending.

## 1. Severity matrix

### SEV1 — Critical

Confirmed customer data breach, full platform outage, irreversible data loss, or active account takeover with operator confirmation.

- **Target first response**: 15 minutes
- **Target update cadence**: every 60 minutes
- **Target mitigation**: 240 minutes
- **Post-incident review required**: yes
- **Customer notification**: required_legal_review
- **Escalation**: Owner + platform on-call. Legal review for any customer notification BEFORE sending. No public statements without operator sign-off.

Examples:
- Confirmed unauthorized access to customer data.
- Platform unavailable for >30 minutes affecting all venues.
- Backup posture has failed with no recoverable snapshot.

### SEV2 — Major

Major tenant impact, suspected unauthorized access pending confirmation, backup posture in critical state, or widespread degradation.

- **Target first response**: 60 minutes
- **Target update cadence**: every 240 minutes
- **Target mitigation**: 1440 minutes
- **Post-incident review required**: yes
- **Customer notification**: recommended_legal_review
- **Escalation**: Owner + platform team. Engage legal if customer-facing notification likely. Update prospects in active procurement reviews if affected.

Examples:
- Repeated SSO failures from a known buyer domain over a multi-hour window.
- Rate-limit storm affecting widget intake for a high-traffic venue.
- Backup posture check returning `critical` with operator-verifiable evidence.

### SEV3 — Minor

Suspicious pattern, repeated SSO failures within a single tenant, abuse spike, vendor security concern, or single-tenant impact.

- **Target first response**: 240 minutes
- **Target update cadence**: every 1440 minutes
- **Target mitigation**: 4320 minutes
- **Post-incident review required**: no
- **Customer notification**: operator_discretion
- **Escalation**: Venue owner + platform team during business hours. Document in the timeline and resolve within the target window.

Examples:
- Single-venue abuse spike attributed to a misconfigured embed.
- Vendor security advisory affecting a non-critical subprocessor.
- CSP report cluster indicating a third-party script issue.

### SEV4 — Informational

Informational or manual-review item that the operator wants tracked. No customer impact expected.

- **Target first response**: 1440 minutes
- **Target update cadence**: every 10080 minutes
- **Target mitigation**: 10080 minutes
- **Post-incident review required**: no
- **Customer notification**: not_required
- **Escalation**: Owner discretion. Track in the IncidentResponseCard so the audit trail exists.

Examples:
- Scheduled vendor review noted as an incident for traceability.
- Tabletop exercise outcomes captured for the runbook.

## 2. Detection sources

Conservative detectors run against persistent signals. They are operator-triggered (`/api/admin/security/incidents/detect`) — there is no autonomous detection cron.

- **abuse_events**: window 60m, threshold 25 rows, suggested severity sev3.
- **sso_login_events**: window 60m, threshold 10 failed/blocked outcomes, suggested severity sev3.
- **backup_posture**: candidate only when overall status is `warning` or `critical`. Suggested severity sev2 (`critical` upgrades to SEV2).
- **health_check**: stub today; returns warnings + zero candidates. Runtime health probing is on the planned-improvements list.

## 3. Alert routing

Env-gated end-to-end. Master toggle: `INCIDENT_ALERTS_ENABLED`. Per-channel env vars: `INCIDENT_SLACK_WEBHOOK_URL`, `INCIDENT_PAGERDUTY_ROUTING_KEY`. When env is absent, helpers return `skipped_disabled` / `skipped_unconfigured` and never throw. Webhook URLs and routing keys are NEVER logged, returned, or stored — only the operator-readable label appears in `incident_alert_deliveries`.

- **slack** → `#incident-alerts` — fires at sev3 and above.
- **pagerduty** → `venuerise-platform` — fires at sev2 and above.
- **sentry** → `venuerise (issues)` — fires at sev3 and above.

## 4. Incident lifecycle

1. **Declare** — owner/admin opens incident via the
   IncidentResponseCard or POST `/api/admin/security/incidents`.
   Severity + category + source set at creation.
2. **Triage** — operator moves status to `investigating`. Add
   notes to the timeline. Optionally send alert via POST
   `/api/admin/security/incidents/[id]/alert`.
3. **Mitigate** — operator moves status to `mitigated` once
   customer-visible impact is contained. `mitigated_at` is
   stamped automatically.
4. **Resolve** — operator moves status to `resolved` once root
   cause is addressed. `resolved_at` + `resolved_by` are
   stamped automatically. The audit row is `incident_resolved`.
5. **Post-incident review** — REQUIRED for SEV2 and above. Append via PATCH `postmortem` field; lands as a timeline event with kind `postmortem_added`. Use the template in this pack.

## 5. What is automated vs manual

| Concern | Automated | Manual |
|---|---|---|
| Incident detection | Operator-triggered detectors | Operator review of every candidate before materialisation |
| Audit trail | All create/update/resolve/alert writes are typed audit actions | Operator interpretation of the trail |
| Status transitions | Lifecycle timestamps stamped automatically | Status moves require an explicit operator PATCH |
| Alert routing | Env-gated Slack/PagerDuty/Sentry delivery | Operator chooses when to fire (per-incident button) |
| Customer notification | Never — no automatic outreach | Routed through legal/operator review for every security event |
| Remediation | None — no auto-revert, no auto-block | All remediation is operator-led |

## 6. Customer notification caveat

No customer-facing notification fires automatically from this system. The customer-notification policy column on each severity row indicates whether legal review is required (SEV1), recommended (SEV2), at operator discretion (SEV3), or not required (SEV4). The product does not include a status page or buyer-facing breach notification flow today. Breach notification timing depends on each buyer's contractual SLA and is confirmed per contract, not encoded in product.

## 7. Tabletop exercise checklist

1. Schedule quarterly. Capture the date + participants in the IncidentResponseCard as a SEV4 informational row.
2. Pick a scenario from the severity-matrix examples.
3. Walk through: detection path → triage owner → alert posture → mitigation → resolution → PIR.
4. Note gaps (missing runbook page, ambiguous threshold, env var that should be set).
5. File follow-up incidents (SEV4) for each gap with an `external_reference` pointing at the tracker.

## 8. Known limitations

- No 24/7 staffed on-call rotation.
- No uptime SLA contract.
- Alert routing is OFF by default; operator must opt in.
- Customer notification requires legal/operator review.
- Detectors are conservative and operator-triggered, not a continuous cron.
- Health-flag detector is a stub.
- incident_alert_deliveries are stored without webhook URLs / routing keys — only operator-readable labels.
- Slack/PagerDuty webhooks are not enabled unless env vars are configured.

## 9. What NOT to claim to buyers

- Do NOT claim 24/7 monitoring unless the on-call rotation is staffed AND a paging vendor is wired.
- Do NOT claim "we will notify you within X hours of a breach" without legal review of the underlying contract.
- Do NOT claim uptime SLA — there is no SLA contract.
- Do NOT promise automated remediation. None exists.
