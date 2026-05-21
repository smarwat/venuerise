import type { QuestionnaireAnswer } from '@/lib/enterprise/evidence/questionnaire-types'
import { EVIDENCE_CONTROLS } from '@/lib/enterprise/evidence/control-map'

/**
 * Phase 9J — Security questionnaire question catalog.
 *
 * Static mapping from buyer/security-team questions to VenueRise
 * evidence controls. Each answer:
 *   - Cites the evidence control id(s) backing it.
 *   - Carries buyer-safe wording (review before sending).
 *   - Names limitations honestly (never overstates).
 *
 * The 12 sections cover the question families that appear across
 * CAIQ, SIG-Lite, VSAQ, and operator-written security
 * questionnaires. Not every section maps 1:1 to every framework;
 * the `format` arg on `buildQuestionnaireResponse` slices the
 * relevant subset.
 *
 * ── HONESTY RULES ─────────────────────────────────────────────────────
 *   `yes`            — control is fully implemented + active.
 *   `partial`        — control exists but with gaps; gaps named
 *                      in `limitations`.
 *   `manual`         — control is a human process; the artifact
 *                      is a runbook/doc, not an enforced path.
 *   `planned`        — committed roadmap item, NOT shipped.
 *   `no`             — feature genuinely not implemented.
 *   `not_applicable` — question doesn't apply to VenueRise.
 *
 * Adding overconfident `yes` answers without code backing them
 * is the worst possible failure mode of this file — it would
 * land us in a contract breach. Code review enforces honesty.
 */

interface QuestionEntry {
  questionId: string
  questionText: string
  status: QuestionnaireAnswer['status']
  shortAnswer: string
  evidenceControlIds: string[]
  limitations?: string[]
}

interface SectionEntry {
  id: string
  title: string
  description: string
  questions: QuestionEntry[]
}

/**
 * Lookup: from evidence control id to the artifact references the
 * Phase 9I catalog already published. Centralized so questionnaire
 * answers and the Phase 9I evidence report stay in lockstep —
 * editing artifacts in `control-map.ts` automatically updates
 * what the questionnaire surfaces.
 */
export function artifactsForControl(
  controlId: string
): QuestionnaireAnswer['references'] {
  const control = EVIDENCE_CONTROLS.find((c) => c.id === controlId)
  return control ? control.artifacts : []
}

/**
 * Merge limitations declared at the question level with any
 * limitations the underlying evidence controls carry. Deduped
 * verbatim (case-sensitive — limitation strings should already be
 * normalized by the authors).
 */
export function limitationsForAnswer(
  controlIds: string[],
  questionLimitations: string[]
): string[] {
  const set = new Set<string>(questionLimitations)
  for (const controlId of controlIds) {
    const control = EVIDENCE_CONTROLS.find((c) => c.id === controlId)
    if (!control) continue
    for (const limit of control.limitations) {
      set.add(limit)
    }
  }
  return [...set]
}

export const QUESTIONNAIRE_SECTIONS: ReadonlyArray<SectionEntry> = [
  // ── 1. Company / Product Security Overview ───────────────────────────
  {
    id: 'product-security-overview',
    title: 'Company / Product Security Overview',
    description:
      'High-level posture, certifications claimed, attestations available.',
    questions: [
      {
        questionId: 'soc2-certification',
        questionText: 'Is your product SOC 2 certified?',
        status: 'no',
        shortAnswer:
          'VenueRise is not currently SOC 2 certified. The platform organizes its existing controls into a SOC 2-style evidence map (docs/SOC2-EVIDENCE-MAP.md) and exposes an internal evidence report endpoint for security reviewers. Formal certification requires an auditor engagement + observation period; that has not happened yet.',
        evidenceControlIds: [],
        limitations: [
          'No third-party SOC 2 audit. No observation window. No Type I or Type II report.',
        ],
      },
      {
        questionId: 'product-security-overview',
        questionText: 'Provide a short overview of your product security posture.',
        status: 'partial',
        shortAnswer:
          'Every sensitive write produces a structured audit row (Phase 9A) with sanitized snapshots. Every mutating route is role-gated + rate-limited (Phase 9B/9F). Tamper-evidence mirror table (Phase 9C). Data export + PII redaction (Phase 9D). Security headers + CSP report-only telemetry (Phase 9E). Abuse monitoring (Phase 9F). SSO readiness scaffold (Phase 9G — vendor adapter pending). Backup posture + non-destructive restore-intent audit (Phase 9H). Consolidated evidence center (Phase 9I).',
        evidenceControlIds: [
          'enterprise-audit-log',
          'rbac-matrix',
          'rate-limit-coverage',
          'audit-event-mirror',
          'data-export',
          'lead-pii-redaction',
          'security-headers-csp-report',
          'abuse-monitoring',
          'sso-readiness',
          'backup-posture',
          'autonomous-sending-disabled',
        ],
      },
    ],
  },

  // ── 2. Access Control ────────────────────────────────────────────────
  {
    id: 'access-control',
    title: 'Access Control',
    description: 'Authentication, role-based access, multi-tenant isolation.',
    questions: [
      {
        questionId: 'rbac-implementation',
        questionText:
          'Does your platform enforce role-based access control across all administrative routes?',
        status: 'yes',
        shortAnswer:
          'Yes. Every API route enforces a role gate (requireAdmin / requireVenueRole) with documented role sets (owner, admin, sales_manager, coordinator, viewer). Per-route matrix in docs/RBAC-MATRIX.md.',
        evidenceControlIds: ['rbac-matrix', 'owner-vs-admin-split'],
      },
      {
        questionId: 'tenant-isolation',
        questionText:
          'How is data isolated between tenants?',
        status: 'yes',
        shortAnswer:
          'Every table that holds tenant data carries venue_id with row-level security policies. Cross-tenant access attempts return 404 (not 403) to prevent venue enumeration. An operator-run cross-tenant probe (scripts/check-cross-tenant-rbac.mjs) verifies the 403→404 collapse across 8 representative routes.',
        evidenceControlIds: ['rbac-matrix', 'cross-tenant-probe'],
        limitations: [],
      },
      {
        questionId: 'least-privilege',
        questionText:
          'Are administrative actions restricted to least-privilege roles?',
        status: 'yes',
        shortAnswer:
          'Billing-class actions (SSO connection management, restore intents) require strict owner role, not admin. Application-layer gate + RLS policies enforce independently. Documented in docs/RBAC-MATRIX.md.',
        evidenceControlIds: ['owner-vs-admin-split'],
      },
    ],
  },

  // ── 3. Authentication / SSO ──────────────────────────────────────────
  {
    id: 'authentication-sso',
    title: 'Authentication / SSO',
    description:
      'Authentication providers, MFA, SAML/OIDC support, JIT provisioning.',
    questions: [
      {
        questionId: 'primary-auth',
        questionText: 'How do users authenticate today?',
        status: 'yes',
        shortAnswer:
          'Email/password and magic-link authentication via Supabase Auth. Session cookies are HTTP-only + Secure in production.',
        evidenceControlIds: [],
      },
      {
        questionId: 'mfa-support',
        questionText: 'Is multi-factor authentication supported?',
        status: 'planned',
        shortAnswer:
          'MFA support relies on Supabase Auth + the chosen identity provider; native enrollment UI inside VenueRise is on the roadmap. Customers requiring MFA today should enforce it via their SSO IDP once SSO is wired (Phase 9G readiness).',
        evidenceControlIds: ['sso-readiness'],
      },
      {
        questionId: 'sso-saml-oidc',
        questionText: 'Do you support SAML or OIDC SSO?',
        status: 'partial',
        shortAnswer:
          'SSO scaffolding is in place — connection management, audit feed, owner-only mutations, vendor adapter interface (WorkOS / Clerk / Stytch / Supabase SSO / custom OIDC). The real SAML/OIDC exchange is wired vendor-by-vendor per buyer requirement; today the adapter resolves to a placeholder returning structured "not configured" errors. Wiring a real adapter is a single-file change documented in docs/SSO-READINESS.md.',
        evidenceControlIds: ['sso-readiness', 'sso-login-events'],
        limitations: [
          'No real SAML/OIDC exchange yet. No SCIM provisioning. No JIT user creation. Adapter is placeholder.',
        ],
      },
      {
        questionId: 'scim-provisioning',
        questionText: 'Do you support SCIM provisioning?',
        status: 'planned',
        shortAnswer:
          'SCIM provisioning is on the SSO roadmap. The connection row carries a SCIM-enabled flag; the endpoint is not mounted yet. Documented in docs/SSO-READINESS.md.',
        evidenceControlIds: ['sso-readiness'],
        limitations: ['No SCIM endpoint yet.'],
      },
    ],
  },

  // ── 4. Audit Logging ─────────────────────────────────────────────────
  {
    id: 'audit-logging',
    title: 'Audit Logging',
    description: 'Audit trail coverage, retention, tamper evidence.',
    questions: [
      {
        questionId: 'audit-coverage',
        questionText:
          'Are administrative actions logged to an audit trail?',
        status: 'yes',
        shortAnswer:
          'Every sensitive write produces a structured audit row in public.audit_events with sanitized before/after snapshots, salted-SHA-256 IP fingerprint, request id, and actor identity. A regression scanner (npm run check:audit-coverage) asserts every mutating route is instrumented or carries an explicit exemption marker.',
        evidenceControlIds: [
          'enterprise-audit-log',
          'audit-coverage-scanner',
        ],
      },
      {
        questionId: 'audit-tamper-evidence',
        questionText: 'How are audit logs protected against tampering?',
        status: 'partial',
        shortAnswer:
          'A mirror table (public.audit_event_mirror) receives a copy of every audit_events row with owner-only SELECT and no RLS write policies — the REST surface cannot mutate the mirror. This is tamper-EVIDENCE, not tamper-PROOF; an admin with direct DB access can still delete rows. A future phase may add an external append-only sink for compliance contexts.',
        evidenceControlIds: ['audit-event-mirror', 'enterprise-audit-log'],
      },
      {
        questionId: 'audit-retention',
        questionText: 'How long are audit logs retained?',
        status: 'manual',
        shortAnswer:
          'audit_events rows are retained indefinitely today; manual purge via SQL editor only. The DataLifecycleCard on /dashboard/settings/billing surfaces the current retention posture. A future phase will apply the existing digest-retention sweeper pattern.',
        evidenceControlIds: ['retention-posture'],
        limitations: ['No automated retention on audit_events yet.'],
      },
      {
        questionId: 'audit-access',
        questionText: 'Who can access audit logs?',
        status: 'yes',
        shortAnswer:
          'Owner + admin roles can read audit_events for their venue via RLS. The mirror table is owner-only SELECT. Both surfaces have CSV export. No public access. No raw IPs are ever stored.',
        evidenceControlIds: [
          'enterprise-audit-log',
          'audit-event-mirror',
          'no-raw-ip-storage',
        ],
      },
    ],
  },

  // ── 5. Monitoring / Abuse Detection ──────────────────────────────────
  {
    id: 'monitoring-abuse',
    title: 'Monitoring / Abuse Detection',
    description:
      'Rate limiting, abuse events, anomaly detection, health monitoring.',
    questions: [
      {
        questionId: 'rate-limiting',
        questionText: 'Are all mutating endpoints rate-limited?',
        status: 'yes',
        shortAnswer:
          'Yes. Every mutating + sensitive admin GET route calls a rateLimit* wrapper or carries an explicit exemption marker. Coverage is enforced by a static scanner (npm run check:rate-limit-coverage). Catalog of canonical keys in lib/rate-limit-catalog.ts.',
        evidenceControlIds: ['rate-limit-coverage'],
      },
      {
        questionId: 'abuse-detection',
        questionText: 'How do you detect and surface abuse?',
        status: 'yes',
        shortAnswer:
          'Every rate-limit block writes a row in public.abuse_events (Phase 9F). The AbuseMonitorCard on /dashboard/settings/billing surfaces top routes, reasons, and limiter keys per venue. CSV export for security reviewers.',
        evidenceControlIds: ['abuse-monitoring'],
      },
      {
        questionId: 'health-monitoring',
        questionText: 'How is platform health monitored?',
        status: 'yes',
        shortAnswer:
          'A /api/health endpoint exposes named feature flags and rate-limiter status. External monitors alert on flag drift or missing surfaces. The ADMIN_ENDPOINT_COUNT constant tracks the admin route surface; alerts fire when post-deploy count changes unexpectedly.',
        evidenceControlIds: ['health-flags'],
      },
    ],
  },

  // ── 6. Rate Limiting (kept as a section because security questionnaires ask explicitly) ──
  {
    id: 'rate-limiting-detail',
    title: 'Rate Limiting',
    description: 'Per-route throttling design + limits.',
    questions: [
      {
        questionId: 'rate-limit-strategy',
        questionText: 'What is your rate-limit strategy?',
        status: 'yes',
        shortAnswer:
          'Upstash Redis sliding-window with per-bucket budgets: widget (10/min/IP+venue), AI generation (60/min/user-resource), user actions (30/min/user), CSP report (60/min/IP), SSO auth (10/min/IP+domain). When Upstash env is unset the limiter fails open + logs; production deploys are alerted via /api/health.',
        evidenceControlIds: ['rate-limit-coverage'],
      },
    ],
  },

  // ── 7. Data Protection ───────────────────────────────────────────────
  {
    id: 'data-protection',
    title: 'Data Protection',
    description: 'Encryption, PII handling, data residency.',
    questions: [
      {
        questionId: 'data-at-rest',
        questionText: 'Is data encrypted at rest?',
        status: 'yes',
        shortAnswer:
          'Supabase Postgres provides AES-256 encryption at rest at the storage layer. Vendor attestation is available from Supabase under their compliance program.',
        evidenceControlIds: [],
      },
      {
        questionId: 'data-in-transit',
        questionText: 'Is data encrypted in transit?',
        status: 'yes',
        shortAnswer:
          'HTTPS enforced via HSTS in production (max-age 2 years, includeSubDomains, preload). All vendor API calls (Supabase, Stripe, Resend, Anthropic) are TLS-only.',
        evidenceControlIds: ['security-headers-csp-report'],
      },
      {
        questionId: 'pii-handling',
        questionText: 'How is customer PII handled?',
        status: 'partial',
        shortAnswer:
          'Lead-level PII (name, email, phone, notes) supports soft redaction via /api/admin/leads/[leadId]/redact-pii while preserving operational history. Audit snapshots are sanitized at write time — sensitive keys (password, secret, token, etc.) are recursively dropped and snapshots are capped at 4 KB. No raw IPs are stored anywhere; the salted-SHA-256 fingerprint is used instead.',
        evidenceControlIds: [
          'lead-pii-redaction',
          'no-raw-ip-storage',
          'enterprise-audit-log',
        ],
        limitations: [
          'Conversation message bodies are not redacted at the row level — only the lead row.',
        ],
      },
      {
        questionId: 'data-export',
        questionText: 'Can customers export their data?',
        status: 'yes',
        shortAnswer:
          'Owner/admin can export the full venue-scoped dataset (leads, conversations, messages, tours, ai_actions, optional audit_events) as JSON via POST /api/admin/data-export. The DataLifecycleCard on /dashboard/settings/billing surfaces the export button. Cap 8 MB inline; oversize export path is on the roadmap.',
        evidenceControlIds: ['data-export'],
      },
    ],
  },

  // ── 8. Backup / Disaster Recovery ────────────────────────────────────
  {
    id: 'backup-dr',
    title: 'Backup / Disaster Recovery',
    description: 'Backup cadence, recovery objectives, restore process.',
    questions: [
      {
        questionId: 'backup-strategy',
        questionText: 'What is your backup strategy?',
        status: 'yes',
        shortAnswer:
          'Daily managed backups with point-in-time recovery via Supabase. RTO target 4 hours, RPO target 24 hours, retention floor 7 days. The BackupPostureCard surfaces policy targets + a per-check breakdown. Live PITR verification depends on Supabase Management API env vars (optional).',
        evidenceControlIds: ['backup-posture'],
        limitations: [
          'Live PITR + last-backup metadata is `unknown` without SUPABASE_PROJECT_REF + SUPABASE_ACCESS_TOKEN.',
        ],
      },
      {
        questionId: 'disaster-recovery',
        questionText: 'Do you have a documented disaster recovery process?',
        status: 'yes',
        shortAnswer:
          'docs/DISASTER-RECOVERY.md covers 7 incident classes (single-lead deletion through full-project corruption), restore decision tree, Supabase workflow, dual-approval requirement for project-wide restores, and a quarterly dry-run checklist. Restores are NEVER executed from the product — operators file restore intents via the audit-only RestoreIntentCard and perform the actual restore through approved Supabase workflows.',
        evidenceControlIds: [
          'dr-runbook',
          'restore-intent-audit',
          'no-destructive-restore-from-app',
        ],
      },
    ],
  },

  // ── 9. Incident Response ─────────────────────────────────────────────
  {
    id: 'incident-response',
    title: 'Incident Response',
    description: 'Incident handling, post-mortems, customer communication.',
    questions: [
      {
        questionId: 'incident-process',
        questionText: 'Do you have an incident response process?',
        status: 'yes',
        shortAnswer:
          'Yes. Documented runbook (docs/INCIDENT-RESPONSE.md + docs/RUNBOOK.md + docs/DISASTER-RECOVERY.md) covers severity matrix (SEV1–SEV4), target first-response + update + mitigation times, detection sources, alert routing, customer notification posture, and post-incident review. First-class incident records live in public.incidents + public.incident_timeline_events with typed audit actions (incident_created / incident_updated / incident_resolved / incident_alert_sent).',
        evidenceControlIds: ['incident-response-records', 'dr-runbook'],
      },
      {
        questionId: 'incident-detection',
        questionText: 'How are incidents detected?',
        status: 'partial',
        shortAnswer:
          'Operator-triggered detection over existing signals: abuse_events (rate-limit blocks), sso_login_events (failed/blocked outcomes), backup_posture (warning/critical), and a health-flag stub. Detectors are CONSERVATIVE — thresholds in lib/enterprise/incidents/policy.ts default to a 60-minute observation window and double-digit row counts. Detectors return candidate incidents; the operator decides whether to materialise via `create=true` on the detect endpoint. No autonomous detection cron is mounted.',
        evidenceControlIds: ['incident-response-records', 'abuse-monitoring'],
        limitations: [
          'Detection is operator-triggered, not a continuous background cron.',
          'Health-flag detector is a stub; runtime health probing is on the planned-improvements list.',
        ],
      },
      {
        questionId: 'incident-customer-notification',
        questionText:
          'Do you notify customers of security incidents?',
        status: 'manual',
        shortAnswer:
          'Customer notification for any security incident requires legal/operator review before sending. The policy in lib/enterprise/incidents/policy.ts defaults SEV1 to `required_legal_review` and SEV2 to `recommended_legal_review`. The product does NOT send customer-facing notifications automatically; outreach happens through the operator\'s existing communication channels after legal review.',
        evidenceControlIds: ['incident-response-records'],
        limitations: [
          'No in-product customer status page yet.',
          'Breach notification timing depends on the buyer\'s contractual SLA — confirmed per contract, not encoded in product.',
        ],
      },
      {
        questionId: 'incident-postmortem',
        questionText: 'Do you perform post-incident reviews?',
        status: 'partial',
        shortAnswer:
          'Yes. Post-incident review is REQUIRED for SEV1 + SEV2 by policy (lib/enterprise/incidents/policy.ts → POSTMORTEM_REQUIRED_AT_OR_ABOVE). The /api/admin/security/incidents/[id] PATCH accepts a `postmortem` field that appends a timeline event with kind `postmortem_added`. A static PIR markdown template ships under scripts/build-incident-response-pack.mjs for off-line use. Completion is operator-tracked; no automated reminder cron is mounted yet.',
        evidenceControlIds: ['post-incident-review-template', 'incident-response-records'],
        limitations: [
          'PIR completion is operator-tracked via the timeline event; no automated reminder when a SEV1/SEV2 resolves without a PIR.',
        ],
      },
      {
        questionId: 'monitoring-24x7',
        questionText: 'Do you have 24/7 monitoring?',
        status: 'no',
        shortAnswer:
          'VenueRise does NOT currently staff a 24/7 on-call rotation and does NOT offer an uptime SLA contract. Detection is operator-triggered against persistent signal sources (abuse, audit, SSO, backup); env-gated alert routing to Slack / PagerDuty / Sentry exists, but escalation timing depends on whether the operator has wired a paging vendor and configured the rotation. Customers requiring 24/7 staffed monitoring should treat this as a gap in the readiness checklist.',
        evidenceControlIds: ['incident-alert-routing'],
        limitations: [
          'No staffed 24/7 on-call rotation.',
          'No uptime SLA contract.',
          'Alert routing to PagerDuty is env-gated; pager response depends on the operator\'s rotation.',
        ],
      },
      {
        questionId: 'restore-intent-audit',
        questionText:
          'Is operator intent to restore data audited even when the product does not execute the restore?',
        status: 'yes',
        shortAnswer:
          'Yes. Operators file restore intents via the audit-only RestoreIntentCard; the row lands in audit_events with action restore_intent_recorded + restore_executed_by_product:false. The product UI never executes a restore.',
        evidenceControlIds: ['restore-intent-audit'],
      },
    ],
  },

  // ── 10. Vendor / Infrastructure ──────────────────────────────────────
  {
    id: 'vendor-infrastructure',
    title: 'Vendor / Infrastructure',
    description: 'Hosting, subprocessors, vendor security posture.',
    questions: [
      {
        questionId: 'hosting',
        questionText: 'Where is the product hosted?',
        status: 'yes',
        shortAnswer:
          'Next.js application on Vercel (US region by default). Database + auth on Supabase (Postgres, US region by default). Rate-limit cache on Upstash Redis. Error tracking on Sentry.',
        evidenceControlIds: [],
      },
      {
        questionId: 'use-subprocessors',
        questionText: 'Do you use subprocessors?',
        status: 'yes',
        shortAnswer:
          'Yes. A subprocessor disclosure is maintained inside the platform; vendor names + categories + buyer-safe descriptions are versioned in code (lib/enterprise/vendor-risk/vendor-registry.ts). The buyer-facing disclosure can be exported as markdown or CSV via the admin SubprocessorDisclosureCard.',
        evidenceControlIds: ['vendor-registry-maintained', 'subprocessor-disclosure'],
      },
      {
        questionId: 'subprocessors',
        questionText: 'Can you provide a list of subprocessors?',
        status: 'yes',
        shortAnswer:
          'Yes. Production subprocessors include Supabase (database, auth), Vercel (hosting), Stripe (billing), Resend (transactional email), Anthropic (AI generation), Inngest (background jobs), Upstash (rate-limit cache), and Sentry (error tracking). Each row carries a buyer-safe description + data category list. The full list is generated on demand via /api/admin/security/subprocessor-disclosure and is reviewed before sending.',
        evidenceControlIds: ['subprocessor-disclosure'],
      },
      {
        questionId: 'vendor-security-review',
        questionText: 'Do you review vendor security posture?',
        status: 'manual',
        shortAnswer:
          'Vendor assurance status is tracked in lib/enterprise/vendor-risk/vendor-registry.ts; every row carries a review owner + review cadence. Legal/security evidence (DPA, SCC, SOC 2, ISO) is collected outside this repository and confirmed against the vendor\'s current artifacts at the cadence noted on each row. Legal review may be required before contractual representation.',
        evidenceControlIds: ['vendor-assurance-review'],
        limitations: [
          'Vendor evidence (DPA PDFs, SOC 2 reports) lives outside the repository.',
          'Review completion is recorded by updating lastReviewedAt on the registry row; there is no automated enforcement of the cadence.',
        ],
      },
      {
        questionId: 'vendor-dpa',
        questionText: 'Do you have DPAs with vendors?',
        status: 'manual',
        shortAnswer:
          'Vendor DPAs (Data Processing Agreements) and SCCs (Standard Contractual Clauses) are tracked outside the repository as part of vendor contracts. Each registry row defaults to assuranceStatus="manual_review_required" until evidence is confirmed. We do NOT claim contractual posture in this automated response — legal review is required before relying on DPA / SCC commitments for a specific vendor.',
        evidenceControlIds: ['vendor-assurance-review'],
        limitations: [
          'DPA / SCC evidence is not stored in source control.',
          'Status is "manual_review_required" by default on every vendor.',
        ],
      },
      {
        questionId: 'data-processing-location',
        questionText: 'Where is customer data processed?',
        status: 'yes',
        shortAnswer:
          'Customer data is processed by the production subprocessors disclosed above. Primary database + auth + storage processing happens at Supabase (US region by default; region selection depends on the active Supabase project configuration). Serverless route execution + edge functions run at Vercel (US region by default). AI inference happens at Anthropic. Email delivery happens at Resend. Region selection per vendor can be confirmed against the active vendor configuration.',
        evidenceControlIds: ['vendor-registry-maintained'],
      },
      {
        questionId: 'webhook-security',
        questionText: 'How are inbound webhooks secured?',
        status: 'yes',
        shortAnswer:
          'Stripe and Resend webhooks verify HMAC signatures before any database mutation. Signature failure rejects the request. The full payload is never logged in plain.',
        evidenceControlIds: ['webhook-signature-verification'],
      },
      {
        questionId: 'secrets-rotation',
        questionText: 'What is your secret rotation cadence?',
        status: 'manual',
        shortAnswer:
          'Per-secret cadence documented in docs/RUNBOOK.md Phase 9E section: quarterly for service-role keys + Stripe + Resend + Anthropic + Supabase anon key; annually for token-signing secrets (digest unsubscribe, tour action, audit IP hash); event-driven for webhook signing secrets.',
        evidenceControlIds: ['secrets-rotation-runbook'],
        limitations: [
          'Manual rotation — no automated enforcement of the cadence.',
        ],
      },
    ],
  },

  // ── 11. Privacy / Data Minimization ──────────────────────────────────
  {
    id: 'privacy-data-min',
    title: 'Privacy / Data Minimization',
    description:
      'What data is collected, why, retention, redaction.',
    questions: [
      {
        questionId: 'no-raw-ip',
        questionText: 'Are raw IP addresses stored?',
        status: 'yes',
        shortAnswer:
          'No raw IPs are stored anywhere in the database. Every audit + abuse + SSO login event row stores a salted-SHA-256 fingerprint via maskIpForAudit. The salt rotates per environment via AUDIT_IP_HASH_SECRET.',
        evidenceControlIds: ['no-raw-ip-storage'],
      },
      {
        questionId: 'pii-redaction-self-service',
        questionText:
          'Can customers request deletion of PII for individual records?',
        status: 'partial',
        shortAnswer:
          'Operators redact lead-level PII via /api/admin/leads/[leadId]/redact-pii on the customer\'s behalf. Conversation-level PII (message bodies) is not yet redacted independently; that\'s on the roadmap. There is no customer-facing self-service deletion UI.',
        evidenceControlIds: ['lead-pii-redaction'],
        limitations: [
          'No conversation-level redaction.',
          'No customer-facing self-service deletion.',
        ],
      },
      {
        questionId: 'data-residency',
        questionText: 'Where is customer data stored?',
        status: 'yes',
        shortAnswer:
          'Customer data lives in the configured Supabase region (US by default; other regions available per Supabase plan). EU-resident customers can be provisioned on a Supabase EU project on request.',
        evidenceControlIds: [],
      },
      {
        questionId: 'dsr-support',
        questionText: 'Do you support data subject requests (DSRs)?',
        status: 'yes',
        shortAnswer:
          'Yes. An operator-controlled DSR workflow tracks access, export, deletion, correction, restrict-processing, and opt-out requests via public.dsr_requests + dsr_timeline_events. Lifecycle: received → triage → identity_verification → in_progress → awaiting_legal_review → fulfilled / denied / cancelled. Every state transition writes a typed audit row. No anonymous DSR intake yet — DSRs are filed by the operator on the subject\'s behalf today.',
        evidenceControlIds: ['dsr-request-tracking'],
        limitations: [
          'No anonymous DSR intake page yet (planned).',
          'Identity verification is operator-asserted; no automated verification flow.',
        ],
      },
      {
        questionId: 'dsr-export-delete',
        questionText: 'Can customers request deletion or export of their data?',
        status: 'partial',
        shortAnswer:
          'Yes via the DSR workflow. The product ships a metadata-only export PREVIEW + a non-destructive deletion REVIEW that enumerates scope; real exports and deletions are performed by the operator under legal review using the existing operator data export + lead-level PII redaction flows. Conversation-level redaction is on the planned-improvements list.',
        evidenceControlIds: [
          'dsr-export-preview',
          'dsr-deletion-review',
          'data-export',
          'lead-pii-redaction',
        ],
        limitations: [
          'Export preview is metadata-only — does NOT fetch subject data.',
          'Deletion review is non-destructive — does NOT delete anything.',
          'No conversation-level PII redaction.',
        ],
      },
      {
        questionId: 'retention-policy',
        questionText: 'Do you have a data retention policy?',
        status: 'partial',
        shortAnswer:
          'Yes — lib/enterprise/privacy/retention-policy.ts documents per-category windows + reason + deletion behaviour + exceptions + automation status. Auth sessions + digest sends are auto-pruned today; lead / conversation / billing categories are operator-driven; audit / abuse / SSO / incident log retention targets 365 days but the sweeper is not yet wired (currently accumulates).',
        evidenceControlIds: ['privacy-retention-policy', 'retention-posture'],
        limitations: [
          'No automated retention sweeper for audit-class tables yet.',
          'Vendor-side retention is governed by each vendor plan.',
        ],
      },
      {
        questionId: 'audit-logs-retained',
        questionText: 'Do you store audit and security logs?',
        status: 'yes',
        shortAnswer:
          'Yes. Every sensitive write produces a row in public.audit_events with sanitized before/after snapshots + salted-SHA-256 IP fingerprint (Phase 9A). Rate-limit blocks land in public.abuse_events (Phase 9F). SSO initiate/callback outcomes land in public.sso_login_events (Phase 9G). Incident records + timelines + alert deliveries land in the Phase 9L tables. None of these tables stores raw IPs; deletion is restricted because the logs may be required for security or legal review.',
        evidenceControlIds: [
          'enterprise-audit-log',
          'abuse-monitoring',
          'sso-login-events',
          'no-raw-ip-storage',
          'incident-response-records',
        ],
      },
      {
        questionId: 'automatic-deletion',
        questionText: 'Do you automatically delete personal data?',
        status: 'partial',
        shortAnswer:
          'Partial. Authentication sessions expire automatically; digest send rows are pruned by the Phase 8AA weekly sweeper. Lead / conversation / tour / billing data is NOT auto-deleted — operator-driven via the existing lead PII redaction flow + DSR workflow. Security / audit / abuse / SSO / incident log retention targets 365 days but the sweeper is not yet wired (currently accumulates). We do NOT silently delete subject data.',
        evidenceControlIds: ['privacy-retention-policy'],
        limitations: [
          'Audit / abuse / SSO / incident retention sweepers not yet wired.',
        ],
      },
      {
        questionId: 'no-data-sale',
        questionText: 'Do you sell customer data?',
        status: 'no',
        shortAnswer:
          'No. VenueRise does not sell customer data. Customer data is processed solely to operate the platform for the venue tenant + the production subprocessors disclosed in the subprocessor list. This is a policy position; legal review is required before a contractual representation.',
        evidenceControlIds: ['subprocessor-disclosure'],
      },
      {
        questionId: 'ai-training-use',
        questionText:
          'Do you use customer data to train AI models?',
        status: 'manual',
        shortAnswer:
          'VenueRise does NOT train any AI models on customer data internally. AI inference happens at Anthropic (lead qualification + reply drafting + brand-voice calibration). Anthropic\'s contractual posture on training use (e.g. zero-retention, training exclusion) is governed by the active Anthropic plan and contract; verification of that posture requires legal review of the Anthropic agreement and is not asserted automatically here.',
        evidenceControlIds: ['vendor-assurance-review'],
        limitations: [
          'Vendor contract terms (Anthropic zero-retention / training exclusion) require legal verification per the active plan.',
          'Do NOT claim "we do not use your data for training" in customer communication without confirmed contract terms.',
        ],
      },
    ],
  },

  // ── 12. Change Management ────────────────────────────────────────────
  {
    id: 'change-management',
    title: 'Change Management',
    description: 'Schema changes, deployments, rollback.',
    questions: [
      {
        questionId: 'schema-migrations',
        questionText: 'How are schema changes managed?',
        status: 'yes',
        shortAnswer:
          'Every schema change ships as a numbered SQL migration with inline rationale + commented rollback. Migration files live in supabase/migrations/ and are applied via Supabase MCP from a controlled environment. Every audit row carries phase context so an auditor can trace which feature introduced each control.',
        evidenceControlIds: ['audited-write-paths'],
      },
      {
        questionId: 'deployment-process',
        questionText: 'How are deploys handled?',
        status: 'manual',
        shortAnswer:
          'Vercel preview deploys per branch; production deploy on merge to main. Migration application is operator-driven via Supabase MCP. Health flags + ADMIN_ENDPOINT_COUNT drift alert post-deploy.',
        evidenceControlIds: ['health-flags'],
        limitations: [
          'No automated CI gate that asserts new migrations have rollback comments.',
        ],
      },
      {
        questionId: 'trust-center-available',
        questionText: 'Do you provide a Trust Center?',
        status: 'yes',
        shortAnswer:
          'Yes. The public Trust Center at /trust shows a curated security/privacy posture summary, production subprocessor list, incident response posture, backup/DR targets, and explicit known limitations. The page is server-rendered and reviewed before each copy change.',
        evidenceControlIds: ['trust-center-public-summary'],
      },
      {
        questionId: 'trust-center-buyer-access',
        questionText:
          'Can buyers access security documentation under access control?',
        status: 'yes',
        shortAnswer:
          'Yes. Active procurement reviews can request a bearer-token grant scoped to summary_only / standard_packet / full_packet. Default 14-day expiry, max 90 days, revocable on request. Tokens are stored as a salted-SHA-256 hash; the plaintext is returned ONCE at creation. Operator + legal review is required before sending.',
        evidenceControlIds: ['trust-center-gated-packets'],
      },
      {
        questionId: 'trust-center-access-tracking',
        questionText:
          'Do you track access to shared security materials?',
        status: 'yes',
        shortAnswer:
          'Yes. Every grant creation, revocation, access, artifact download, expiry, and access-denied event lands in public.trust_access_events with a salted-SHA-256 IP + user-agent fingerprint. The TrustAccessGrantsCard surfaces per-grant access counts + last-accessed timestamps; admin CSV export of the event feed is audited.',
        evidenceControlIds: ['trust-access-tracking'],
      },
      {
        questionId: 'security-documentation-review-cadence',
        questionText: 'How often do you review security documentation?',
        status: 'partial',
        shortAnswer:
          'A static compliance review policy in lib/enterprise/compliance-ops/policy.ts assigns a cadence (monthly / quarterly / semiannual / annual) to every readiness area: vendor risk + privacy + DR + backup + incident + trust center + questionnaire + evidence pack + SSO + coverage scanners + RBAC + headers + data lifecycle. Operators record completion via the ComplianceCalendarCard. We do NOT claim continuous monitoring.',
        evidenceControlIds: [
          'compliance-operations-calendar',
          'recurring-review-workflow',
        ],
        limitations: [
          'Completion is operator-marked; no automated attestation of underlying controls.',
        ],
      },
      {
        questionId: 'compliance-task-tracking',
        questionText: 'Do you track recurring compliance tasks?',
        status: 'yes',
        shortAnswer:
          'Yes. public.compliance_review_events records every operator review with status (upcoming / due / overdue / completed / waived), evidence URL, and review notes. Typed audit actions cover create / seed / complete / waive / update. Owner/admin only.',
        evidenceControlIds: ['compliance-operations-calendar'],
      },
      {
        questionId: 'evidence-freshness',
        questionText: 'How do you ensure evidence remains current?',
        status: 'partial',
        shortAnswer:
          'lib/enterprise/compliance-ops/freshness.ts cross-references the static policy + most-recent completed review timestamp + per-area staleAfterDays threshold to produce a soft stale signal surfaced in the ComplianceCalendarCard. Pack generators (`npm run build:evidence-pack` / `build:questionnaire-pack` / etc.) are operator-triggered to refresh static artifacts.',
        evidenceControlIds: ['evidence-freshness-tracking'],
        limitations: [
          'Stale flag is derived from completion records, not real-time attestation of the underlying control.',
          'No external reminder alerting in this phase.',
        ],
      },
      {
        questionId: 'customer-specific-commitment-tracking',
        questionText:
          'Do you track customer-specific security commitments?',
        status: 'yes',
        shortAnswer:
          'Yes. public.contract_commitments + contract_commitment_events back an operator-recorded register. Each row captures buyer identity + source type (MSA / DPA / security addendum / order form / trust grant / email / other) + commitment area + status + risk level + owner + due / review dates + evidence URL. Owner/admin only. Typed audit actions per lifecycle step.',
        evidenceControlIds: [
          'contract-commitments-register',
          'customer-obligation-tracking',
        ],
      },
      {
        questionId: 'unsupported-commitment-prevention',
        questionText:
          'How do you prevent commitments to capabilities you do not support?',
        status: 'partial',
        shortAnswer:
          'lib/enterprise/commitments/policy.ts encodes per-area support posture (sso: partial, scim: not_supported, availability: partial, incident_response: partial, privacy: partial, data_retention: partial, ai_use: partial, subprocessor: partial, data_residency: partial). When an operator records a commitment in one of these areas, the CommitmentsReadinessCard surfaces a soft warning explaining the gap. Operators are NOT blocked — the warning exists so the gap is rectified with the buyer before marking the commitment active.',
        evidenceControlIds: ['unsupported-commitment-warning-workflow'],
        limitations: [
          'Warnings are advisory; the platform does NOT block operators from recording an unsupported commitment.',
        ],
      },
      {
        questionId: 'contract-security-review-management',
        questionText:
          'How are contractual security reviews managed?',
        status: 'partial',
        shortAnswer:
          'Operator-controlled review dates on each commitment row. The compliance operations calendar (Phase 9O) carries a quarterly RBAC matrix review + monthly trust-center copy / artifact review + cadence-driven vendor / privacy / DR reviews. The commitments register surfaces overdue review counts + upcoming reviews; operators record completion via the CommitmentsRegisterCard. Legal review remains an operator + counsel responsibility.',
        evidenceControlIds: [
          'contract-commitments-register',
          'compliance-operations-calendar',
        ],
        limitations: [
          'No external reminder alerting; operators pull the readiness summary on cadence.',
          'Legal review of contract terms is an operator + counsel responsibility, NOT a platform attestation.',
        ],
      },
    ],
  },
]
