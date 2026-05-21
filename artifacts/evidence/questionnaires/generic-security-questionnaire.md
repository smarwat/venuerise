# VenueRise Security Questionnaire Response (Static Pack)

_Generated: 2026-05-20T18:29:51.969Z_
_Format: generic_

> This response is provided for security review purposes only. It is generated from VenueRise's internal evidence map and DOES NOT represent a third-party certification or legal attestation. Operators MUST review every answer before sending to a buyer.

_Authoritative version lives behind `/api/admin/security/questionnaire-response` (admin/owner only). This static pack is suitable for security-questionnaire responses where a live session is not available._

## Summary

- Total questions: **58**
- Yes: 32
- Partial: 14
- Manual: 7
- Planned: 2
- No: 3
- Not applicable: 0

## Company / Product Security Overview

_High-level posture, certifications claimed, attestations available._

### Is your product SOC 2 certified?

- **Answer:** `no`

VenueRise is not currently SOC 2 certified. The platform organizes its existing controls into a SOC 2-style evidence map (docs/SOC2-EVIDENCE-MAP.md) and exposes an internal evidence report endpoint for security reviewers. Formal certification requires an auditor engagement + observation period; that has not happened yet.

### Provide a short overview of your product security posture.

- **Answer:** `partial`

Every sensitive write produces a structured audit row (Phase 9A) with sanitized snapshots. Every mutating route is role-gated + rate-limited (Phase 9B/9F). Tamper-evidence mirror table (Phase 9C). Data export + PII redaction (Phase 9D). Security headers + CSP report-only telemetry (Phase 9E). Abuse monitoring (Phase 9F). SSO readiness scaffold (Phase 9G — vendor adapter pending). Backup posture + non-destructive restore-intent audit (Phase 9H). Consolidated evidence center (Phase 9I).

## Access Control

_Authentication, role-based access, multi-tenant isolation._

### Does your platform enforce role-based access control across all administrative routes?

- **Answer:** `yes`

Yes. Every API route enforces a role gate (requireAdmin / requireVenueRole) with documented role sets (owner, admin, sales_manager, coordinator, viewer). Per-route matrix in docs/RBAC-MATRIX.md.

### How is data isolated between tenants?

- **Answer:** `yes`

Every table that holds tenant data carries venue_id with row-level security policies. Cross-tenant access attempts return 404 (not 403) to prevent venue enumeration. An operator-run cross-tenant probe (scripts/check-cross-tenant-rbac.mjs) verifies the 403→404 collapse across 8 representative routes.

### Are administrative actions restricted to least-privilege roles?

- **Answer:** `yes`

Billing-class actions (SSO connection management, restore intents) require strict owner role, not admin. Application-layer gate + RLS policies enforce independently. Documented in docs/RBAC-MATRIX.md.

## Authentication / SSO

_Authentication providers, MFA, SAML/OIDC support, JIT provisioning._

### How do users authenticate today?

- **Answer:** `yes`

Email/password and magic-link authentication via Supabase Auth. Session cookies are HTTP-only + Secure in production.

### Is multi-factor authentication supported?

- **Answer:** `planned`

MFA support relies on Supabase Auth + the chosen identity provider; native enrollment UI inside VenueRise is on the roadmap. Customers requiring MFA today should enforce it via their SSO IDP once SSO is wired (Phase 9G readiness).

### Do you support SAML or OIDC SSO?

- **Answer:** `partial`

SSO scaffolding is in place — connection management, audit feed, owner-only mutations, vendor adapter interface (WorkOS / Clerk / Stytch / Supabase SSO / custom OIDC). The real SAML/OIDC exchange is wired vendor-by-vendor per buyer requirement; today the adapter resolves to a placeholder returning structured 

### Do you support SCIM provisioning?

- **Answer:** `planned`

SCIM provisioning is on the SSO roadmap. The connection row carries a SCIM-enabled flag; the endpoint is not mounted yet. Documented in docs/SSO-READINESS.md.

## Audit Logging

_Audit trail coverage, retention, tamper evidence._

### Are administrative actions logged to an audit trail?

- **Answer:** `yes`

Every sensitive write produces a structured audit row in public.audit_events with sanitized before/after snapshots, salted-SHA-256 IP fingerprint, request id, and actor identity. A regression scanner (npm run check:audit-coverage) asserts every mutating route is instrumented or carries an explicit exemption marker.

### How are audit logs protected against tampering?

- **Answer:** `partial`

A mirror table (public.audit_event_mirror) receives a copy of every audit_events row with owner-only SELECT and no RLS write policies — the REST surface cannot mutate the mirror. This is tamper-EVIDENCE, not tamper-PROOF; an admin with direct DB access can still delete rows. A future phase may add an external append-only sink for compliance contexts.

### How long are audit logs retained?

- **Answer:** `manual`

audit_events rows are retained indefinitely today; manual purge via SQL editor only. The DataLifecycleCard on /dashboard/settings/billing surfaces the current retention posture. A future phase will apply the existing digest-retention sweeper pattern.

### Who can access audit logs?

- **Answer:** `yes`

Owner + admin roles can read audit_events for their venue via RLS. The mirror table is owner-only SELECT. Both surfaces have CSV export. No public access. No raw IPs are ever stored.

## Monitoring / Abuse Detection

_Rate limiting, abuse events, anomaly detection, health monitoring._

### Are all mutating endpoints rate-limited?

- **Answer:** `yes`

Yes. Every mutating + sensitive admin GET route calls a rateLimit* wrapper or carries an explicit exemption marker. Coverage is enforced by a static scanner (npm run check:rate-limit-coverage). Catalog of canonical keys in lib/rate-limit-catalog.ts.

### How do you detect and surface abuse?

- **Answer:** `yes`

Every rate-limit block writes a row in public.abuse_events (Phase 9F). The AbuseMonitorCard on /dashboard/settings/billing surfaces top routes, reasons, and limiter keys per venue. CSV export for security reviewers.

### How is platform health monitored?

- **Answer:** `yes`

A /api/health endpoint exposes named feature flags and rate-limiter status. External monitors alert on flag drift or missing surfaces. The ADMIN_ENDPOINT_COUNT constant tracks the admin route surface; alerts fire when post-deploy count changes unexpectedly.

## Rate Limiting

_Per-route throttling design + limits._

### What is your rate-limit strategy?

- **Answer:** `yes`

Upstash Redis sliding-window with per-bucket budgets: widget (10/min/IP+venue), AI generation (60/min/user-resource), user actions (30/min/user), CSP report (60/min/IP), SSO auth (10/min/IP+domain). When Upstash env is unset the limiter fails open + logs; production deploys are alerted via /api/health.

## Data Protection

_Encryption, PII handling, data residency._

### Is data encrypted at rest?

- **Answer:** `yes`

Supabase Postgres provides AES-256 encryption at rest at the storage layer. Vendor attestation is available from Supabase under their compliance program.

### Is data encrypted in transit?

- **Answer:** `yes`

HTTPS enforced via HSTS in production (max-age 2 years, includeSubDomains, preload). All vendor API calls (Supabase, Stripe, Resend, Anthropic) are TLS-only.

### How is customer PII handled?

- **Answer:** `partial`

Lead-level PII (name, email, phone, notes) supports soft redaction via /api/admin/leads/[leadId]/redact-pii while preserving operational history. Audit snapshots are sanitized at write time — sensitive keys (password, secret, token, etc.) are recursively dropped and snapshots are capped at 4 KB. No raw IPs are stored anywhere; the salted-SHA-256 fingerprint is used instead.

### Can customers export their data?

- **Answer:** `yes`

Owner/admin can export the full venue-scoped dataset (leads, conversations, messages, tours, ai_actions, optional audit_events) as JSON via POST /api/admin/data-export. The DataLifecycleCard on /dashboard/settings/billing surfaces the export button. Cap 8 MB inline; oversize export path is on the roadmap.

## Backup / Disaster Recovery

_Backup cadence, recovery objectives, restore process._

### What is your backup strategy?

- **Answer:** `yes`

Daily managed backups with point-in-time recovery via Supabase. RTO target 4 hours, RPO target 24 hours, retention floor 7 days. The BackupPostureCard surfaces policy targets + a per-check breakdown. Live PITR verification depends on Supabase Management API env vars (optional).

### Do you have a documented disaster recovery process?

- **Answer:** `yes`

docs/DISASTER-RECOVERY.md covers 7 incident classes (single-lead deletion through full-project corruption), restore decision tree, Supabase workflow, dual-approval requirement for project-wide restores, and a quarterly dry-run checklist. Restores are NEVER executed from the product — operators file restore intents via the audit-only RestoreIntentCard and perform the actual restore through approved Supabase workflows.

## Incident Response

_Incident handling, post-mortems, customer communication._

### Do you have an incident response process?

- **Answer:** `yes`

Yes. Documented runbook (docs/INCIDENT-RESPONSE.md + docs/RUNBOOK.md + docs/DISASTER-RECOVERY.md) covers severity matrix (SEV1–SEV4), target first-response + update + mitigation times, detection sources, alert routing, customer notification posture, and post-incident review. First-class incident records live in public.incidents + public.incident_timeline_events with typed audit actions (incident_created / incident_updated / incident_resolved / incident_alert_sent).

### How are incidents detected?

- **Answer:** `partial`

Operator-triggered detection over existing signals: abuse_events (rate-limit blocks), sso_login_events (failed/blocked outcomes), backup_posture (warning/critical), and a health-flag stub. Detectors are CONSERVATIVE — thresholds in lib/enterprise/incidents/policy.ts default to a 60-minute observation window and double-digit row counts. Detectors return candidate incidents; the operator decides whether to materialise via `create=true` on the detect endpoint. No autonomous detection cron is mounted.

### Do you notify customers of security incidents?

- **Answer:** `manual`

Customer notification for any security incident requires legal/operator review before sending. The policy in lib/enterprise/incidents/policy.ts defaults SEV1 to `required_legal_review` and SEV2 to `recommended_legal_review`. The product does NOT send customer-facing notifications automatically; outreach happens through the operator's existing communication channels after legal review.

### Do you perform post-incident reviews?

- **Answer:** `partial`

Yes. Post-incident review is REQUIRED for SEV1 + SEV2 by policy (lib/enterprise/incidents/policy.ts → POSTMORTEM_REQUIRED_AT_OR_ABOVE). The /api/admin/security/incidents/[id] PATCH accepts a `postmortem` field that appends a timeline event with kind `postmortem_added`. A static PIR markdown template ships under scripts/build-incident-response-pack.mjs for off-line use. Completion is operator-tracked; no automated reminder cron is mounted yet.

### Do you have 24/7 monitoring?

- **Answer:** `no`

VenueRise does NOT currently staff a 24/7 on-call rotation and does NOT offer an uptime SLA contract. Detection is operator-triggered against persistent signal sources (abuse, audit, SSO, backup); env-gated alert routing to Slack / PagerDuty / Sentry exists, but escalation timing depends on whether the operator has wired a paging vendor and configured the rotation. Customers requiring 24/7 staffed monitoring should treat this as a gap in the readiness checklist.

### Is operator intent to restore data audited even when the product does not execute the restore?

- **Answer:** `yes`

Yes. Operators file restore intents via the audit-only RestoreIntentCard; the row lands in audit_events with action restore_intent_recorded + restore_executed_by_product:false. The product UI never executes a restore.

## Vendor / Infrastructure

_Hosting, subprocessors, vendor security posture._

### Where is the product hosted?

- **Answer:** `yes`

Next.js application on Vercel (US region by default). Database + auth on Supabase (Postgres, US region by default). Rate-limit cache on Upstash Redis. Error tracking on Sentry.

### Do you use subprocessors?

- **Answer:** `yes`

Yes. A subprocessor disclosure is maintained inside the platform; vendor names + categories + buyer-safe descriptions are versioned in code (lib/enterprise/vendor-risk/vendor-registry.ts). The buyer-facing disclosure can be exported as markdown or CSV via the admin SubprocessorDisclosureCard.

### Can you provide a list of subprocessors?

- **Answer:** `yes`

Yes. Production subprocessors include Supabase (database, auth), Vercel (hosting), Stripe (billing), Resend (transactional email), Anthropic (AI generation), Inngest (background jobs), Upstash (rate-limit cache), and Sentry (error tracking). Each row carries a buyer-safe description + data category list. The full list is generated on demand via /api/admin/security/subprocessor-disclosure and is reviewed before sending.

### Do you review vendor security posture?

- **Answer:** `manual`

Vendor assurance status is tracked in lib/enterprise/vendor-risk/vendor-registry.ts; every row carries a review owner + review cadence. Legal/security evidence (DPA, SCC, SOC 2, ISO) is collected outside this repository and confirmed against the vendor's current artifacts at the cadence noted on each row. Legal review may be required before contractual representation.

### Do you have DPAs with vendors?

- **Answer:** `manual`

Vendor DPAs (Data Processing Agreements) and SCCs (Standard Contractual Clauses) are tracked outside the repository as part of vendor contracts. Each registry row defaults to assuranceStatus=

### Where is customer data processed?

- **Answer:** `yes`

Customer data is processed by the production subprocessors disclosed above. Primary database + auth + storage processing happens at Supabase (US region by default; region selection depends on the active Supabase project configuration). Serverless route execution + edge functions run at Vercel (US region by default). AI inference happens at Anthropic. Email delivery happens at Resend. Region selection per vendor can be confirmed against the active vendor configuration.

### How are inbound webhooks secured?

- **Answer:** `yes`

Stripe and Resend webhooks verify HMAC signatures before any database mutation. Signature failure rejects the request. The full payload is never logged in plain.

### What is your secret rotation cadence?

- **Answer:** `manual`

Per-secret cadence documented in docs/RUNBOOK.md Phase 9E section: quarterly for service-role keys + Stripe + Resend + Anthropic + Supabase anon key; annually for token-signing secrets (digest unsubscribe, tour action, audit IP hash); event-driven for webhook signing secrets.

## Privacy / Data Minimization

_What data is collected, why, retention, redaction._

### Are raw IP addresses stored?

- **Answer:** `yes`

No raw IPs are stored anywhere in the database. Every audit + abuse + SSO login event row stores a salted-SHA-256 fingerprint via maskIpForAudit. The salt rotates per environment via AUDIT_IP_HASH_SECRET.

### Can customers request deletion of PII for individual records?

- **Answer:** `partial`

Operators redact lead-level PII via /api/admin/leads/[leadId]/redact-pii on the customer's behalf. Conversation-level PII (message bodies) is not yet redacted independently; that's on the roadmap. There is no customer-facing self-service deletion UI.

### Where is customer data stored?

- **Answer:** `yes`

Customer data lives in the configured Supabase region (US by default; other regions available per Supabase plan). EU-resident customers can be provisioned on a Supabase EU project on request.

### Do you support data subject requests (DSRs)?

- **Answer:** `yes`

Yes. An operator-controlled DSR workflow tracks access, export, deletion, correction, restrict-processing, and opt-out requests via public.dsr_requests + dsr_timeline_events. Lifecycle: received → triage → identity_verification → in_progress → awaiting_legal_review → fulfilled / denied / cancelled. Every state transition writes a typed audit row. No anonymous DSR intake yet — DSRs are filed by the operator on the subject's behalf today.

### Can customers request deletion or export of their data?

- **Answer:** `partial`

Yes via the DSR workflow. The product ships a metadata-only export PREVIEW + a non-destructive deletion REVIEW that enumerates scope; real exports and deletions are performed by the operator under legal review using the existing operator data export + lead-level PII redaction flows. Conversation-level redaction is on the planned-improvements list.

### Do you have a data retention policy?

- **Answer:** `partial`

Yes — lib/enterprise/privacy/retention-policy.ts documents per-category windows + reason + deletion behaviour + exceptions + automation status. Auth sessions + digest sends are auto-pruned today; lead / conversation / billing categories are operator-driven; audit / abuse / SSO / incident log retention targets 365 days but the sweeper is not yet wired (currently accumulates).

### Do you store audit and security logs?

- **Answer:** `yes`

Yes. Every sensitive write produces a row in public.audit_events with sanitized before/after snapshots + salted-SHA-256 IP fingerprint (Phase 9A). Rate-limit blocks land in public.abuse_events (Phase 9F). SSO initiate/callback outcomes land in public.sso_login_events (Phase 9G). Incident records + timelines + alert deliveries land in the Phase 9L tables. None of these tables stores raw IPs; deletion is restricted because the logs may be required for security or legal review.

### Do you automatically delete personal data?

- **Answer:** `partial`

Partial. Authentication sessions expire automatically; digest send rows are pruned by the Phase 8AA weekly sweeper. Lead / conversation / tour / billing data is NOT auto-deleted — operator-driven via the existing lead PII redaction flow + DSR workflow. Security / audit / abuse / SSO / incident log retention targets 365 days but the sweeper is not yet wired (currently accumulates). We do NOT silently delete subject data.

### Do you sell customer data?

- **Answer:** `no`

No. VenueRise does not sell customer data. Customer data is processed solely to operate the platform for the venue tenant + the production subprocessors disclosed in the subprocessor list. This is a policy position; legal review is required before a contractual representation.

### Do you use customer data to train AI models?

- **Answer:** `manual`

VenueRise does NOT train any AI models on customer data internally. AI inference happens at Anthropic (lead qualification + reply drafting + brand-voice calibration). Anthropic's contractual posture on training use (e.g. zero-retention, training exclusion) is governed by the active Anthropic plan and contract; verification of that posture requires legal review of the Anthropic agreement and is not asserted automatically here.

## Change Management

_Schema changes, deployments, rollback._

### How are schema changes managed?

- **Answer:** `yes`

Every schema change ships as a numbered SQL migration with inline rationale + commented rollback. Migration files live in supabase/migrations/ and are applied via Supabase MCP from a controlled environment. Every audit row carries phase context so an auditor can trace which feature introduced each control.

### How are deploys handled?

- **Answer:** `manual`

Vercel preview deploys per branch; production deploy on merge to main. Migration application is operator-driven via Supabase MCP. Health flags + ADMIN_ENDPOINT_COUNT drift alert post-deploy.

### Do you provide a Trust Center?

- **Answer:** `yes`

Yes. The public Trust Center at /trust shows a curated security/privacy posture summary, production subprocessor list, incident response posture, backup/DR targets, and explicit known limitations. The page is server-rendered and reviewed before each copy change.

### Can buyers access security documentation under access control?

- **Answer:** `yes`

Yes. Active procurement reviews can request a bearer-token grant scoped to summary_only / standard_packet / full_packet. Default 14-day expiry, max 90 days, revocable on request. Tokens are stored as a salted-SHA-256 hash; the plaintext is returned ONCE at creation. Operator + legal review is required before sending.

### Do you track access to shared security materials?

- **Answer:** `yes`

Yes. Every grant creation, revocation, access, artifact download, expiry, and access-denied event lands in public.trust_access_events with a salted-SHA-256 IP + user-agent fingerprint. The TrustAccessGrantsCard surfaces per-grant access counts + last-accessed timestamps; admin CSV export of the event feed is audited.

### How often do you review security documentation?

- **Answer:** `partial`

A static compliance review policy in lib/enterprise/compliance-ops/policy.ts assigns a cadence (monthly / quarterly / semiannual / annual) to every readiness area: vendor risk + privacy + DR + backup + incident + trust center + questionnaire + evidence pack + SSO + coverage scanners + RBAC + headers + data lifecycle. Operators record completion via the ComplianceCalendarCard. We do NOT claim continuous monitoring.

### Do you track recurring compliance tasks?

- **Answer:** `yes`

Yes. public.compliance_review_events records every operator review with status (upcoming / due / overdue / completed / waived), evidence URL, and review notes. Typed audit actions cover create / seed / complete / waive / update. Owner/admin only.

### How do you ensure evidence remains current?

- **Answer:** `partial`

lib/enterprise/compliance-ops/freshness.ts cross-references the static policy + most-recent completed review timestamp + per-area staleAfterDays threshold to produce a soft stale signal surfaced in the ComplianceCalendarCard. Pack generators (`npm run build:evidence-pack` / `build:questionnaire-pack` / etc.) are operator-triggered to refresh static artifacts.

### Do you track customer-specific security commitments?

- **Answer:** `yes`

Yes. public.contract_commitments + contract_commitment_events back an operator-recorded register. Each row captures buyer identity + source type (MSA / DPA / security addendum / order form / trust grant / email / other) + commitment area + status + risk level + owner + due / review dates + evidence URL. Owner/admin only. Typed audit actions per lifecycle step.

### How do you prevent commitments to capabilities you do not support?

- **Answer:** `partial`

lib/enterprise/commitments/policy.ts encodes per-area support posture (sso: partial, scim: not_supported, availability: partial, incident_response: partial, privacy: partial, data_retention: partial, ai_use: partial, subprocessor: partial, data_residency: partial). When an operator records a commitment in one of these areas, the CommitmentsReadinessCard surfaces a soft warning explaining the gap. Operators are NOT blocked — the warning exists so the gap is rectified with the buyer before marking the commitment active.

### How are contractual security reviews managed?

- **Answer:** `partial`

Operator-controlled review dates on each commitment row. The compliance operations calendar (Phase 9O) carries a quarterly RBAC matrix review + monthly trust-center copy / artifact review + cadence-driven vendor / privacy / DR reviews. The commitments register surfaces overdue review counts + upcoming reviews; operators record completion via the CommitmentsRegisterCard. Legal review remains an operator + counsel responsibility.
