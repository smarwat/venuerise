# SOC 2 Evidence Map — Phase 9I

## Purpose

This document maps VenueRise's existing platform controls to the
SOC 2 Trust Service Criteria (TSC) vocabulary. It is meant to:

1. Give a security reviewer / procurement contact one place to
   see what controls exist + where the evidence lives in code.
2. Make security questionnaire responses faster + more accurate.
3. Give a future formal SOC 2 audit a head start on scoping.

## Certification disclaimer

**VenueRise is NOT SOC 2 certified.** This document does not
claim certification, audit readiness, or compliance attestation.

Formal SOC 2 requires:

1. **A licensed auditor** (CPA firm authorized to perform SOC 2
   examinations).
2. **Scoped system description** — what's in / out of scope,
   defined boundaries.
3. **Control design review** — does the design meet the criteria.
4. **Observation period** — typically 6–12 months of operation
   under the documented controls.
5. **Evidence collection** — sample-based testing across the
   observation period.
6. **Exceptions / remediation** — documented gaps + fix
   timelines.

What this doc + the supporting code give you:

- A control catalog (the static `EVIDENCE_CONTROLS` map at
  `lib/enterprise/evidence/control-map.ts`).
- A live report endpoint
  (`GET /api/admin/security/evidence-report`) + admin UI card
  (`SecurityEvidenceCenter`).
- A local pack generator (`npm run build:evidence-pack`) that
  emits markdown + CSV + JSON to `artifacts/evidence/`.
- A regression scanner (`npm run check:evidence-packaging`).

These are evidence-organization tools, not certification.

## Trust Service Criteria mapping

### Security (CC, the common criteria)

Controls currently supported:

- Role-based access control with documented matrix
  (`docs/RBAC-MATRIX.md` + every admin route's
  `requireAdmin`/`requireVenueRole` gate).
- Owner-only mutation gates on billing-class actions (SSO
  connections, restore intents).
- Enterprise audit log over every sensitive write
  (`public.audit_events` + `recordAuditEvent`).
- Tamper-evidence mirror (`audit_event_mirror`, owner-only
  SELECT, no write policies).
- Per-route rate limiting + coverage scanner
  (`lib/rate-limit.ts` + `scripts/check-rate-limit-coverage.mjs`).
- Abuse event recording on rate-limit blocks (`abuse_events` +
  `AbuseMonitorCard`).
- Security headers + CSP report-only telemetry
  (`next.config.js` + `/api/security/csp-report`).
- No raw IP storage — salted-SHA-256 fingerprint everywhere.
- Webhook signature verification (Stripe + Resend) before any
  mutation.
- No destructive restore from the product (Phase 9H).

Evidence artifacts:

- `lib/auth/*` source files (role gate enforcement).
- `audit_events` rows (queryable by any owner/admin via the
  EnterpriseAuditEventsCard).
- `abuse_events` rows (AbuseMonitorCard).
- `npm run check:audit-coverage` output.
- `npm run check:rate-limit-coverage` output.
- `npm run check:cross-tenant-rbac` output (operator-run).
- Header check via `curl -I` on any dashboard URL.

Manual evidence still required (for an actual audit):

- Employee security training records.
- Vendor risk assessments.
- Background check policy for staff with prod access.
- Acceptable use policy signed by employees.
- Security incident log (we have technical incidents in
  audit_events; an audit wants the human-process log too).

Gaps / limitations:

- `audit_events` is not WORM-level. Mirror table closes the REST
  attack surface but not DB-level admin access.
- No automated cross-tenant probe in CI yet (operator-run only).
- Report-only CSP keeps `'unsafe-inline'` for now.

### Availability

Controls currently supported:

- Backup posture surface with policy targets (RTO 4h, RPO 24h,
  retention 7d floor, quarterly dry-runs) —
  `BackupPostureCard`.
- Disaster recovery runbook with 7 incident classes
  (`docs/DISASTER-RECOVERY.md`).
- Restore intent audit trail
  (`recordRestoreIntent` →
  `audit_events.action='restore_intent_recorded'`).
- No destructive restore from the product UI.
- Health route flag inventory (`/api/health`) for external
  monitor alerting.
- Rate limiting protects availability under abuse load.

Evidence artifacts:

- `docs/DISASTER-RECOVERY.md`.
- BackupPostureCard screenshots / live state.
- `npm run check:backup-posture` output.
- Quarterly dry-run log (operator-maintained doc).
- Health endpoint payload.

Manual evidence still required:

- Documented uptime SLA in customer MSA.
- Status page / customer communication channel for incidents.
- On-call rotation roster.
- Past incident postmortems.

Gaps / limitations:

- Live PITR + last-backup checks degrade to `unknown` without
  Supabase Management API env vars.
- Quarterly dry-run completion is tracked in a separate doc,
  not in the audit feed (yet).
- No formal RTO/RPO contract — the targets in
  `policy.ts` are the system's internal aim, not legal
  commitments.

### Confidentiality

Controls currently supported:

- No raw IP storage — every audit + abuse + SSO event stores
  the salted-SHA-256 fingerprint.
- Lead PII redaction (`/api/admin/leads/[leadId]/redact-pii`)
  with soft-redaction + audit trail.
- Sanitized snapshots — `recordAuditEvent` drops known sensitive
  keys (password, secret, token, api_key, authorization,
  cookie, webhook_payload, raw_body, stripe_secret,
  anthropic_api_key) before storage.
- 4 KB cap on jsonb snapshots; 240-char cap on user-agent.
- Secrets rotation runbook (`docs/RUNBOOK.md` Phase 9E
  section) — per-secret cadence + blast radius.
- Owner-only SELECT on `audit_event_mirror` (stricter than the
  primary audit feed).

Evidence artifacts:

- `lib/enterprise/audit-events.ts` source — the sanitizer.
- Sample audit rows showing redacted snapshots.
- `lib/enterprise/pii-redaction.ts`.

Manual evidence still required:

- Data classification policy (what data is public / internal /
  confidential / restricted).
- Encryption-at-rest verification (Supabase Postgres ships with
  this; need vendor attestation document).
- Encryption-in-transit verification (HTTPS-only enforced via
  HSTS in production).

Gaps / limitations:

- Conversation message bodies are stored without redaction at
  the row level. Lead PII redaction touches the lead row, not
  the messages.
- AUDIT_IP_HASH_SECRET falls back to SUPABASE_JWT_SECRET in dev.
  Production should set a dedicated 32+ char secret.

### Processing integrity

Controls currently supported:

- Enterprise audit log captures every operator-initiated
  mutation with before/after snapshots.
- Autonomous sending explicitly disabled — no AI-driven message
  send or tour schedule without human approval.
- Webhook signature verification before any state mutation.
- Migration history with inline rationale + rollback comments.

Evidence artifacts:

- `audit_events` rows for any operator action.
- `autonomous_sending_still_disabled` health flag.
- `supabase/migrations/` directory.

Manual evidence still required:

- Code review / merge gate evidence (we use git; an audit wants
  the policy doc).
- Production deploy approvals.
- Rollback procedures (we have them in `RUNBOOK.md`; an audit
  wants the test evidence too).

Gaps / limitations:

- No automated end-to-end test of the audit pipeline (e.g.
  "every PATCH on leads must produce exactly one audit row").

### Privacy

Controls currently supported:

- Lead PII redaction endpoint
  (`/api/admin/leads/[leadId]/redact-pii`).
- Venue data export (`POST /api/admin/data-export`) for owner
  data-subject-access requests.
- IP fingerprinting (no raw IP storage).
- Sanitized audit snapshots.
- Retention posture surface (`DataLifecycleCard`).

Evidence artifacts:

- `lib/enterprise/data-export.ts`.
- `lib/enterprise/pii-redaction.ts`.
- Sample export JSON.
- Digest audit retention cron (Phase 8AB).

Manual evidence still required:

- Privacy notice / data processing agreement template.
- Subprocessor list (Supabase, Stripe, Resend, Anthropic,
  Inngest, Upstash, Sentry).
- DPA signing process.
- Data deletion request response template.

Gaps / limitations:

- No conversation-level PII redaction (messages.content still
  carries customer text after lead-level redaction).
- No automated retention on `audit_events`, `abuse_events`,
  `sso_login_events` yet.
- No customer-facing self-service deletion (operators do it on
  the customer's behalf).

## Evidence artifacts inventory

The following artifacts live in the repo + are produced /
referenced by Phase 9I code:

| Artifact | Location | How to refresh |
|---|---|---|
| Audit coverage scanner output | terminal | `npm run check:audit-coverage` |
| Rate-limit coverage scanner output | terminal | `npm run check:rate-limit-coverage` |
| Backup posture scanner output | terminal | `npm run check:backup-posture` |
| Evidence packaging scanner output | terminal | `npm run check:evidence-packaging` |
| Local evidence pack (markdown/CSV/JSON) | `artifacts/evidence/` | `npm run build:evidence-pack` |
| RBAC matrix doc | `docs/RBAC-MATRIX.md` | Update on every new admin route |
| DR runbook | `docs/DISASTER-RECOVERY.md` | Update on incident-class changes |
| SSO readiness doc | `docs/SSO-READINESS.md` | Update on vendor decision |
| Rate-limit coverage doc | `docs/RATE-LIMIT-COVERAGE.md` | Update on new mutating routes |
| Audit coverage doc | `docs/AUDIT-COVERAGE.md` | Update on new mutating routes |
| AbuseMonitorCard | `/dashboard/settings/billing` | Live; admin/owner only |
| SecurityEvidenceCenter | `/dashboard/settings/billing` | Live; admin/owner only |
| Live evidence report | `GET /api/admin/security/evidence-report` | JSON / markdown / CSV |
| Health flags | `GET /api/health` | Snapshot at any time |

## Security questionnaire snippets

Use these verbatim in customer security questionnaires. They
reflect the actual platform posture; update here when the
underlying control changes so all surfaces stay in lockstep.

**Access control.** "VenueRise enforces role-based access control
on every administrative route. Owner, admin, sales_manager,
coordinator, and viewer roles are documented per route in our
internal RBAC matrix. Cross-tenant access attempts return 404
(not 403) to prevent venue enumeration. Owner-only mutation
gates apply to billing-class actions (SSO connection management,
restore intents)."

**Audit logging.** "Every sensitive write produces a structured
audit row in `public.audit_events` with sanitized before/after
snapshots, salted-SHA-256 IP fingerprint, request id, and actor
identity. A mirror table provides tamper-evidence; admin
operators can read the feed via an in-product card or export
CSV. A regression scanner asserts every mutating route is
either instrumented or explicitly exempted with a documented
reason."

**Rate limiting.** "Every mutating + sensitive admin route is
rate-limited via Upstash Redis. Coverage is enforced by a
static scanner in CI. Rate-limit blocks fire abuse-event rows
visible to owner/admin operators via an in-product card."

**Abuse monitoring.** "Rate-limit blocks land in a venue-scoped
abuse-events table. The in-product Abuse Monitor card surfaces
top routes, reasons, and limiter keys; CSV export available."

**Backup / DR.** "Daily managed backups with point-in-time
recovery via Supabase. Recovery Time Objective: 4 hours.
Recovery Point Objective: 24 hours. Quarterly disaster-recovery
dry runs. Restores are performed through approved Supabase
workflows by VenueRise staff; the product UI never executes a
restore."

**SSO readiness.** "VenueRise's SSO scaffolding is in place
(SAML + OIDC tables, owner-only connection management, audit
feed) with a vendor adapter pattern that supports WorkOS,
Clerk, Stytch, Supabase SSO, or a custom OIDC adapter. Real
SAML/OIDC exchange is wired vendor-by-vendor per buyer
requirement."

**Incident response.** "Documented runbook covering 7 incident
classes from single-lead deletion to full-project corruption.
Restore decision tree + Supabase workflow + dual-approval
requirement for project-wide restores. Quarterly dry-run
cadence."

**Data privacy / IP hashing.** "No raw IP addresses are stored
anywhere in the database. Every audit + abuse + SSO event row
stores a salted-SHA-256 fingerprint via a dedicated helper
(`maskIpForAudit`). The salt rotates per environment via
`AUDIT_IP_HASH_SECRET`."

## Known gaps

These are the items a formal SOC 2 audit would call out. They
are documented here so we're explicit about what's NOT in place
yet.

- **No third-party SOC 2 audit.** No auditor engagement, no
  observation period, no Type I or Type II report.
- **No formal vendor risk register.** We use Supabase, Stripe,
  Resend, Anthropic, Inngest, Upstash, Sentry. Each vendor's
  own SOC 2 / security posture is acknowledged but not
  catalogued in-product.
- **No automated PITR verification.** The backup posture card's
  live PITR check requires the Phase 9H Supabase Management API
  env vars; when absent it shows `unknown`.
- **No real SAML/OIDC exchange.** Phase 9G is readiness — the
  vendor adapter is a placeholder.
- **No SCIM provisioning.** Flag exists on the connection row;
  no endpoint mounted.
- **No automated policy acceptance tracking.** Customer-facing
  policies (privacy, terms) live in the marketing site; product
  doesn't track acceptance.
- **No employee security training evidence inside the product.**
  Lives in HR systems (auditor reviews those separately).
- **No conversation-level PII redaction.** Lead-level redaction
  preserves message history.
- **No retention on audit / abuse / SSO event tables.** Digest
  audit retention exists; the others accumulate.
- **No automated cross-tenant probe in CI.** Operator-run only.
- **No formal SLA contract.** RTO/RPO are internal targets.

The right next step after Phase 9I is engaging an auditor to
review the existing controls + scope what the gap-closure
roadmap looks like before committing to an observation period.

## Phase 9K addendum — Vendor management controls

Phase 9K added three controls to `EVIDENCE_CONTROLS` under the
`vendor_management` category:

| Control | Status | Notes |
|---|---|---|
| `vendor-registry-maintained` | implemented | `lib/enterprise/vendor-risk/vendor-registry.ts` is the source of truth for every third-party processor. Static scanner (`scripts/check-vendor-risk.mjs`) asserts the registry stays in sync with the codebase. |
| `subprocessor-disclosure` | implemented | `/api/admin/security/subprocessor-disclosure` renders only vendors with `disclosureStatus === 'public'`. Evidence references stripped. Markdown + CSV exports audited via `subprocessor_disclosure_exported`. |
| `vendor-assurance-review` | manual | DPA / SCC / SOC 2 / ISO evidence is collected outside this repository. Every vendor row defaults to `assuranceStatus = 'manual_review_required'` until verified by legal. |

### What this adds to a SOC 2 conversation

- TSC `CC9.2` (vendor risk) — the registry + cadence column
  give an auditor a single artifact to follow. Last-reviewed
  dates surface stale entries.
- TSC `CC6.7` (third-party transmission) — the data-categories
  column on each vendor row maps the buyer's data flow to each
  processor at a glance.
- TSC `C1.1` (confidentiality) — the buyer-safe disclosure is
  the artifact that customers cite in their own SOC 2 reports
  when describing VenueRise as a subprocessor.

### What this still does NOT add

- **No automated vendor attestation verification.** Vendor
  SOC 2 reports are not parsed; expiry / scope changes are
  caught by the manual review process, not by code.
- **No formal SOC 2 certification for VenueRise.** Phase 9K
  packages the vendor management control surface; engagement
  with an auditor + observation window are still pending.

See `docs/VENDOR-RISK.md` for the full review workflow,
buyer-question scripts, and known limitations.

## Phase 9L addendum — Incident response controls

Phase 9L added three controls to `EVIDENCE_CONTROLS` under the
`incident_response` category:

| Control | Status | Notes |
|---|---|---|
| `incident-response-records` | implemented | First-class `public.incidents` + `public.incident_timeline_events` records with severity / status / category / source vocabulary backed by CHECK constraints + the policy in `lib/enterprise/incidents/policy.ts`. Typed audit actions cover every lifecycle step (`incident_created` / `incident_updated` / `incident_resolved` / `incident_alert_sent` / `incident_candidates_detected`). IncidentResponseCard surfaces the feed inline. |
| `incident-alert-routing` | partial | Slack + PagerDuty + Sentry channel adapters in `lib/enterprise/incidents/alert-routing.ts`. Env-gated (`INCIDENT_ALERTS_ENABLED` + per-channel env vars); skipped outcomes when env is absent; webhook URLs + routing keys NEVER leave the server. |
| `post-incident-review-template` | manual | Policy encodes PIR threshold (SEV1 + SEV2 required). PATCH `postmortem` field appends a `postmortem_added` timeline event. Static markdown template ships via `scripts/build-incident-response-pack.mjs`. |

### What this adds to a SOC 2 conversation

- **TSC CC7.3** (system operations — incident management) — the
  incidents table + timeline + audit actions give an auditor a
  single artifact chain to follow from detection through
  resolution.
- **TSC CC7.4** (incident response + recovery) — the policy
  module encodes the severity matrix + target response times +
  PIR threshold; the runbook ships in the static pack and
  references the broader DR runbook (Phase 9H).
- **TSC CC2.3** (communication during incidents) — the
  customer-notification policy column documents the intended
  posture (legal-review-required for SEV1) and the platform
  enforces "no automatic outreach" by NOT having a customer
  notification code path.

### What this still does NOT add

- **No 24/7 staffed on-call rotation.** Severity targets are
  best-effort; absence of staffing is documented honestly.
- **No uptime SLA contract.** Targets in policy.ts are
  internal, not contractual.
- **No autonomous detection cron.** Detectors are
  operator-triggered.
- **No automated customer breach notification.** Every
  customer-facing message routes through legal review.

See `docs/INCIDENT-RESPONSE.md` for the full operator workflow,
buyer-question scripts, and known limitations.

## Phase 9M addendum — Privacy + DSR controls

Phase 9M added five controls to `EVIDENCE_CONTROLS` under
`data_lifecycle`:

| Control | Status | Notes |
|---|---|---|
| `privacy-data-inventory` | implemented | Static inventory of every customer/personal data category (15 rows) with source tables, sensitivity, retention basis, vendor subprocessor links. PrivacyReadinessCard surfaces it; markdown + CSV exports audited. |
| `privacy-retention-policy` | partial | Per-category retention targets + reason + automation status. Auth sessions + digest sends are auto-pruned; audit / abuse / SSO / incident sweepers not yet wired (currently accumulate). |
| `dsr-request-tracking` | implemented | `public.dsr_requests` + `dsr_timeline_events` + 5 admin routes. Typed audit actions per lifecycle step. Owner/admin only. |
| `dsr-export-preview` | partial | Metadata-only export preview. Does NOT fetch subject data. Audited. |
| `dsr-deletion-review` | partial | Non-destructive deletion review with retention-exception flags. Does NOT delete anything. Audited. |

### What this adds to a SOC 2 conversation

- **TSC P3.1** (privacy notice / data collection) — the static
  inventory + retention policy give an auditor a clear data
  flow.
- **TSC P4.x** (use / retention / disposal) — retention policy
  per category + DSR workflow back the controls.
- **TSC P5.x** (access / correction / disposal by subjects) —
  the DSR workflow + the existing operator data export +
  lead-level PII redaction back the subject rights controls.
- **TSC CC2.x** (communication) — the buyer security summary
  + questionnaire generator + privacy pack provide the
  customer-facing communication channel.

### What this still does NOT add

- **No GDPR / CCPA / LGPD compliance attestation.** Privacy
  readiness ≠ legal compliance.
- **No automated DSR fulfilment.** Every export / deletion
  routes through operator + legal review.
- **No anonymous DSR intake.** DSRs are filed by operators
  today.
- **No retention sweeper for audit-class tables.** Sweepers
  are on the planned-improvements list.
- **No verified vendor training-exclusion claim.** Anthropic
  contract terms require legal verification.

See `docs/PRIVACY-DSR-READINESS.md` for the full operator
workflow + buyer-question scripts + known limitations.

## Phase 9N addendum — Trust Center controls

Phase 9N added three controls to `EVIDENCE_CONTROLS`:

| Control | Status | Notes |
|---|---|---|
| `trust-center-public-summary` | implemented | Curated `/trust` page renders `PUBLIC_TRUST_SECTIONS` + buyer-disclosable subprocessor list + explicit known limitations + standard disclaimer. |
| `trust-center-gated-packets` | implemented | Bearer-token grants gate access to packets at three scopes (summary_only / standard_packet / full_packet). Tokens are salted-SHA-256 hashed; plaintext returned ONCE. Default 14-day expiry, max 90. |
| `trust-access-tracking` | implemented | `public.trust_access_events` records every grant_created / revoked / accessed / artifact_downloaded / expired / access_denied with salted-SHA-256 IP + user-agent fingerprints. Admin CSV export audited. |

### What this adds to a SOC 2 conversation

- **TSC CC2.x** (communication) — the Trust Center is the
  durable communication artifact a buyer can cite during
  their own SOC 2 work.
- **TSC CC6.1** (logical access — gated material) — bearer
  tokens with expiry, revocation, and per-attempt access log.
- **TSC C1.x** (confidentiality) — internal-only artifacts
  never emit; public surface ships only curated copy.

### What this still does NOT add

- **No SOC 2 certification.** Trust Center packages controls;
  it does not satisfy the auditor.
- **No NDA-acceptance gate** beyond the bearer token itself.
- **No PDF renderer.**
- **No customer-facing self-service status page** (incident
  posture is documented but not live).

See `docs/TRUST-CENTER.md` for the full operator workflow +
public-vs-gated rules + known limitations.

## Phase 9O addendum — Compliance operations + freshness controls

Phase 9O added three controls to `EVIDENCE_CONTROLS` under
`change_management`:

| Control | Status | Notes |
|---|---|---|
| `compliance-operations-calendar` | implemented | `public.compliance_review_events` + 17-row static policy + 3 admin routes + ComplianceCalendarCard. Typed audit actions per lifecycle step. |
| `evidence-freshness-tracking` | partial | Cross-references completed event records + per-area staleAfterDays threshold to produce a soft stale signal. Markdown + CSV exports audited. |
| `recurring-review-workflow` | manual | Operators run the per-area review outside the product and record completion in the calendar. No autonomous attestation. |

### What this adds to a SOC 2 conversation

- **TSC CC4.x** (monitoring activities) — the calendar +
  freshness summary give an auditor a single artifact showing
  the operator's review cadence + completion history.
- **TSC CC9.x** (risk mitigation) — recurring review of
  vendor risk, SSO readiness, incident tabletop, DR dry-run
  map directly to the criteria.
- **TSC A1.x** (availability) — DR + backup posture review
  cadence + completion records support the availability
  control narrative.

### Review cadence summary (per policy module)

- Monthly: backup posture, trust center copy + artifacts,
  security questionnaire, evidence pack, audit + rate-limit
  coverage scanners.
- Quarterly: vendor risk, subprocessors, privacy data
  inventory, DR dry-run, incident tabletop, SSO readiness,
  RBAC matrix, security headers.
- Semiannual: retention policy, data lifecycle.

### What this still does NOT add

- **Not continuous compliance monitoring.** Completion is
  operator-marked.
- **Not real-time control verification.** The platform does
  not introspect vendor certificate expiry, DPA terms, or
  underlying control state.
- **No external alerting.** Reminders + escalation are
  operator-pull only in 9O.

See `docs/COMPLIANCE-OPS.md` for the full operator workflow,
buyer-question scripts, and known limitations.

## Phase 9P addendum — Contract commitments controls

Phase 9P added three controls to `EVIDENCE_CONTROLS` under
`change_management`:

| Control | Status | Notes |
|---|---|---|
| `contract-commitments-register` | implemented | `public.contract_commitments` + `contract_commitment_events` + three admin routes + CommitmentsRegisterCard. Typed audit per lifecycle step. |
| `customer-obligation-tracking` | implemented | Per-commitment buyer identity + source + area + status + risk + owner + dates + evidence URL + timeline. |
| `unsupported-commitment-warning-workflow` | partial | Soft unsupported-risk detector flags commitments referencing partial / not-supported capabilities. Operators are NOT blocked from recording. |

### What this adds to a SOC 2 conversation

- **TSC CC2.x** (communication of commitments) — the register
  + readiness export give an auditor a single artifact showing
  what was promised, to whom, and the operator's current
  status.
- **TSC CC9.x** (risk mitigation) — unsupported-risk flags
  document gaps between commitment + capability, and the
  operator's review cadence demonstrates active mitigation.
- **TSC C1.x** (confidentiality) — the register is RLS-gated
  owner/admin only; buyer identity + commitment notes never
  appear in any public-facing artifact.

### What this still does NOT add

- **Not legal advice.** The register tracks operator-recorded
  commitments and surfaces warnings; it does not produce
  contractual interpretations.
- **No autonomous contract parsing.** Every commitment is
  hand-entered.
- **No auto-attestation.** The platform does not verify the
  underlying capability matches the recorded commitment —
  that is operator judgement.

See `docs/CONTRACT-COMMITMENTS.md` for the full operator
workflow + per-area support posture + known limitations.
