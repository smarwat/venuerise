# Incident response

_Phase 9L — Incident Response Automation + Alert Routing._

This document is the operator-facing companion to:

- `lib/enterprise/incidents/types.ts`
- `lib/enterprise/incidents/policy.ts`
- `lib/enterprise/incidents/incidents.ts`
- `lib/enterprise/incidents/detectors.ts`
- `lib/enterprise/incidents/alert-routing.ts`
- `supabase/migrations/032_incident_response.sql`
- `app/api/admin/security/incidents/*`
- `components/dashboard/settings/IncidentResponseCard.tsx`
- `scripts/build-incident-response-pack.mjs`
- `scripts/check-incident-response.mjs`

---

## 1. Purpose

Earlier 9X phases produced rich operational signals — audit
events, abuse events, SSO login events, backup posture, CSP
reports, vendor risk advisories. Phase 9L consolidates those
into first-class **incident records** with severity, status,
assignment, alert routing, and post-incident review.

The goal is procurement-ready evidence that "we have a process"
plus an in-product surface the operator actually uses. Phase 9L
is NOT a paging vendor. It is NOT a 24/7 monitoring claim. It is
NOT autonomous remediation.

---

## 2. Incident severity matrix

Encoded in `lib/enterprise/incidents/policy.ts`. The
build-incident-response-pack generator emits a CSV mirror at
`artifacts/evidence/incidents/incident-severity-matrix.csv`.

| Severity | Definition | Target first response | Update cadence | Target mitigation | PIR required | Customer notification |
|---|---|---:|---:|---:|---|---|
| **SEV1** | Confirmed breach, full outage, irreversible data loss | 15 min | every 60 min | 4 h | **yes** | required + legal review |
| **SEV2** | Major tenant impact, suspected unauthorized access, backup posture critical | 60 min | every 4 h | 24 h | **yes** | recommended + legal review |
| **SEV3** | Suspicious pattern, single-tenant impact, vendor concern | 4 h | daily | 3 d | no | operator discretion |
| **SEV4** | Informational / manual-review tracking | 24 h | weekly | 7 d | no | not required |

These are TARGETS, not contractual SLAs. VenueRise does NOT
staff a 24/7 on-call rotation and does NOT offer an uptime SLA
contract.

---

## 3. Response roles

- **Venue owner** — accountable for declaring SEV1/SEV2,
  approving customer notification, and authorising any
  out-of-app remediation.
- **Platform team (admin role)** — primary triage. Moves the
  incident through investigating → mitigated → resolved.
- **Legal** — engaged for any customer-facing notification at
  SEV1/SEV2; consulted at SEV3 if a buyer is impacted.
- **Sales** — informed when an affected buyer is in an active
  procurement review.

The `assigned_to` field on each incident captures the current
owner. Reassignment fires a `assigned` timeline event +
`incident_updated` audit row.

---

## 4. Detection sources

Operator-triggered detectors against persistent signal tables:

| Source | Threshold default | Suggested severity |
|---|---|---|
| `abuse_events` | 25 rows on same (route, reason) in 60 min | SEV3 |
| `sso_login_events` (failed + blocked) | 10 rows in 60 min | SEV3 |
| `backup_posture` (status warning/critical) | n/a | SEV3 / SEV2 |
| `health_check` (stub) | — | SEV2 |

Thresholds in `lib/enterprise/incidents/policy.ts →
DETECTOR_DEFAULTS`. A noisy detector is worse than a missed
one — tune up only after the real noise is fixed.

Detection runs via `POST /api/admin/security/incidents/detect`.
The route returns CANDIDATES; the operator decides whether to
materialise via `create=true`. No autonomous detection cron is
mounted.

---

## 5. Alert routing

Env-gated end-to-end.

| Env var | Effect |
|---|---|
| `INCIDENT_ALERTS_ENABLED` | Master toggle. Must be `true`/`1` for any alert to fire. |
| `INCIDENT_SLACK_WEBHOOK_URL` | Enables Slack channel. Server-only secret. |
| `INCIDENT_PAGERDUTY_ROUTING_KEY` | Enables PagerDuty Events API v2. Server-only secret. |

When env is absent, alert helpers return `skipped_disabled` /
`skipped_unconfigured` outcomes and never throw. The
`incident_alert_deliveries` row carries the operator-readable
label only ("#incident-alerts", "venuerise-platform") — webhook
URLs and routing keys are NEVER logged, returned, or stored.

Default route matrix (`DEFAULT_ALERT_ROUTES` in policy.ts):

- **Slack** → `#incident-alerts` — fires at SEV3 and above.
- **PagerDuty** → `venuerise-platform` — fires at SEV2 and above.
- **Sentry** → `venuerise (issues)` — fires at SEV3 and above.

Operators tune these per the noise floor they want.

---

## 6. What is automated vs manual

| Concern | Automated | Manual |
|---|---|---|
| Detection | Operator-triggered detectors (button) | Reviewing each candidate before materialising |
| Audit trail | Typed audit actions per lifecycle step | Operator interpretation of the trail |
| Status transitions | `mitigated_at` / `resolved_at` stamped automatically | Status moves require an explicit operator PATCH |
| Alert delivery | Env-gated Slack/PagerDuty/Sentry helpers | Operator chooses when to fire (per-incident button) |
| Customer notification | **Never** — no automatic outreach | Routed through legal/operator review for every security event |
| Remediation | **None** — no auto-revert, no auto-block | All remediation is operator-led |

---

## 7. Customer notification caveat

The product does NOT include a customer-facing status page or
automated breach notification flow. The customer-notification
column on each severity row in the policy indicates the default
intent (required, recommended, operator discretion, not
required); the actual notification timing for any specific
buyer depends on their contract and is confirmed per contract
with legal, not encoded in product.

When in doubt: legal review before sending.

---

## 8. Incident lifecycle

1. **Declare** — owner/admin opens an incident via the
   IncidentResponseCard (`+ New Incident`) or POST
   `/api/admin/security/incidents`. Severity + category +
   source set at creation.
2. **Triage** — operator moves status to `investigating`. Add
   notes to the timeline. Optionally fire alert via POST
   `/api/admin/security/incidents/[id]/alert`.
3. **Mitigate** — operator moves status to `mitigated` once
   customer-visible impact is contained. `mitigated_at` is
   stamped automatically.
4. **Resolve** — operator moves status to `resolved` once root
   cause is addressed. `resolved_at` + `resolved_by` are
   stamped automatically. Audit row is `incident_resolved`.
5. **Post-incident review** — REQUIRED for SEV1 + SEV2. Append
   via PATCH `postmortem` field; lands as a timeline event with
   kind `postmortem_added`. Use the template in the static
   pack.

---

## 9. Post-incident review template

The static pack at
`artifacts/evidence/incidents/post-incident-review-template.md`
ships the template. Sections: summary, what happened, detection
path, mitigation steps, root cause, customer impact, what went
well, what went poorly, action items, followups to runbook.

For long PIRs, store the markdown in a shared doc and reference
the URL in the incident's `external_reference` field instead of
pasting the whole document into the timeline.

---

## 10. Tabletop exercise checklist

1. Schedule **quarterly**. Capture the date + participants in
   the IncidentResponseCard as a SEV4 informational row.
2. Pick a scenario from the severity-matrix examples.
3. Walk through: detection path → triage owner → alert posture
   → mitigation → resolution → PIR.
4. Note gaps (missing runbook page, ambiguous threshold, env
   var that should be set).
5. File follow-up incidents (SEV4) for each gap with an
   `external_reference` pointing at the tracker.

---

## 11. What NOT to claim to buyers

- Do NOT claim 24/7 monitoring unless the on-call rotation is
  staffed AND a paging vendor is wired.
- Do NOT claim "we will notify you within X hours of a breach"
  without legal review of the underlying contract.
- Do NOT claim an uptime SLA — there is no SLA contract.
- Do NOT promise automated remediation. None exists.
- Do NOT publish webhook URLs or routing keys — the helper
  intentionally never returns or logs them.

---

## 12. Known limitations

- No 24/7 staffed on-call rotation.
- No uptime SLA contract.
- Alert routing is OFF by default; operator must opt in via
  `INCIDENT_ALERTS_ENABLED` + the matching channel env vars.
- Detectors are conservative and operator-triggered, not a
  continuous background cron.
- Health-flag detector is a stub; runtime health probing is on
  the planned-improvements list.
- Customer breach notification requires legal/operator review;
  no automatic outreach.
- Slack/PagerDuty webhooks are not enabled unless env vars are
  configured.
- Like `audit_events` + `abuse_events`, the incident tables are
  RLS-gated but not WORM at the database level.
- PIR completion is operator-tracked via the timeline event;
  no automated reminder cron yet.
- `incident_alert_deliveries` rows store only operator-readable
  labels; raw webhook URLs and routing keys never appear.

---

## 13. Honesty disclaimer (carried in every render)

> These targets describe VenueRise's intended incident response.
> VenueRise does NOT currently staff a 24/7 on-call rotation and
> does NOT offer an uptime SLA contract. Detectors are
> conservative + operator-triggered; no autonomous remediation
> occurs. Customer notification for any security event requires
> legal/operator review before sending.

Identical string across the runbook, the static pack, the admin
card subtitle/footer, and the evidence map control description
so downstream consumers can grep for it.

---

## 14. Phase 9M addendum — Incidents involving subject privacy

When an incident touches customer / personal data (subject
data breach, unauthorized access to lead PII, accidental
export to a third party), the Phase 9M **privacy + DSR
readiness** layer becomes part of the response.

Operator workflow when an incident may carry a privacy
dimension:

1. Open the incident in IncidentResponseCard. Set
   `category = 'privacy'` to mark it for legal triage.
2. **Engage legal early.** Severity SEV1/SEV2 incidents with
   privacy impact carry mandatory legal review per the
   policy in `lib/enterprise/incidents/policy.ts` →
   `customerNotification`.
3. If the affected subject(s) file a **DSR** as part of the
   response, open the DSR via DsrRequestsCard and cross-link
   via the DSR's `external_reference` field pointing at the
   incident id (e.g. `incident:<incident-uuid>`). The
   incident timeline can carry a `note_added` event linking
   back.
4. **Run the DSR export preview / deletion review** if
   subjects request access or deletion. Both are
   non-destructive (export preview is metadata-only; deletion
   review is a checklist).
5. **Customer notification** — never automatic. Use the
   policy column in the incident severity matrix +
   `docs/PRIVACY-DSR-READINESS.md` §11 buyer-language scripts.
   Legal review approves wording.
6. **Post-incident review** for SEV1/SEV2 documents what
   subject data was affected, retention exception decisions
   made under legal review, and any DSRs filed in response.

The privacy data inventory (§2 of
`docs/PRIVACY-DSR-READINESS.md`) is the authoritative source
for **what data could be affected** and **which
subprocessors might have touched it** — start there during
triage.

Honesty rules carried forward:

- Customer notification timing for any specific buyer
  depends on the buyer's contract and is confirmed per
  contract with legal, not encoded in product.
- DSRs filed in response to an incident are tracked, NOT
  auto-fulfilled.
- AI vendor (Anthropic) training-use posture for any
  affected lead content requires legal verification — see
  `docs/VENDOR-RISK.md` §13.

---

## 15. Phase 9N addendum — Trust Center exposure

The Phase 9N Trust Center includes an `incident_response_summary`
artifact at `standard_packet` and `full_packet` scope. This
artifact is generated from `lib/enterprise/incidents/policy.ts`
(severity matrix + targets + disclaimer) — it does NOT include
raw incident records or post-incident review content.

If a buyer has an active grant when an incident occurs:

1. The buyer's existing packet does NOT auto-update — the
   summary in the gated packet reflects the policy at the time
   of grant creation.
2. For active enterprise customers in a security review during
   an incident, share an out-of-band update via your normal
   customer-communication channel after legal review (per the
   incident severity policy's customer-notification column).
3. If a SEV1/SEV2 affects an active grant holder's data scope,
   consider revoking the grant + issuing a fresh one only
   after the incident is resolved + the PIR is filed.

The Trust Center is buyer COMMUNICATION infrastructure, not
buyer NOTIFICATION infrastructure. Incident notification still
routes through legal + operator review.

---

## 16. Phase 9O addendum — Tabletop cadence on the compliance calendar

The Phase 9O compliance operations calendar ships an explicit
`incident-tabletop` policy item:

- **Cadence:** quarterly
- **Stale after:** 100 days
- **Owner role:** platform
- **Recommended action:** Pick a scenario from §2 examples.
  Walk through detection path → triage → alert posture →
  mitigation → resolution → PIR. Capture the exercise as a
  SEV4 row in IncidentResponseCard for traceability.

When the calendar flags this review as overdue, operators
run the actual tabletop (see §10 of this document) and record
completion in ComplianceCalendarCard. The `evidenceUrl` can
point at:

- A SEV4 incident record created for the tabletop
  (`/dashboard/settings/billing` → IncidentResponseCard).
- A shared doc capturing the participants + scenario +
  observed gaps.
- A linked Linear / Jira ticket if the tabletop surfaced
  follow-up work.

Phase 9O also tracks `incident_response` indirectly via the
broader policy — operators reviewing the incident severity
matrix + alert routing posture can record that work under
`incident-tabletop` if they exercise the matrix end-to-end.
