import 'server-only'
import type {
  BuyerSecuritySummary,
  BuyerSecuritySummarySection,
} from '@/lib/enterprise/evidence/questionnaire-types'

/**
 * Phase 9J — Buyer-facing security summary builder.
 *
 * Produces a SHORT prose summary suitable for a sales-call
 * follow-up email. Distinct from the questionnaire (which is
 * question-by-question) and the evidence report (which lists
 * every control). The summary is meant to give a security
 * reviewer a 3-minute read that frames the deeper material.
 *
 * Honesty rules carry forward from Phase 9I + 9J:
 *   - Never claims SOC 2 certification.
 *   - Names limitations in `knownLimitations`.
 *   - Frames roadmap items as "planned" in `plannedImprovements`,
 *     not "imminent" or "coming soon".
 *
 * Edit cadence: every time a Phase 9X ships a new
 * customer-visible control, add the relevant paragraph here +
 * update the matching entry in the questionnaire map +
 * docs/SOC2-EVIDENCE-MAP.md customer-facing snippets so all
 * three surfaces stay in lockstep.
 */

const DISCLAIMER =
  'This summary is provided for security review purposes. It is generated from VenueRise\'s internal evidence and DOES NOT represent a third-party certification or legal attestation. Operators MUST review before sending to a buyer.'

const OVERVIEW =
  'VenueRise is a multi-tenant SaaS for wedding-venue operators. The platform ships a documented enterprise security posture: role-based access control with a per-route matrix, structured audit logging on every sensitive write with a tamper-evidence mirror table, per-route rate limiting with abuse monitoring, security headers + CSP report-only telemetry, owner-only billing-class actions, SSO scaffolding for SAML/OIDC, data export + lead-level PII redaction, point-in-time backups with a documented disaster-recovery runbook, and an internal SOC 2-style evidence map. VenueRise is NOT currently SOC 2 certified — formal certification requires an auditor + observation period.'

const SECTIONS: BuyerSecuritySummarySection[] = [
  {
    id: 'access-control',
    title: 'Access control',
    body:
      'Every API route enforces role-based access via documented role sets (owner / admin / sales_manager / coordinator / viewer). Cross-tenant access attempts return 404 (not 403) to prevent venue enumeration. Owner-only mutation gates apply to billing-class actions (SSO connection management, restore intents). A static scanner verifies coverage on every build.',
    bullets: [
      'Per-route RBAC matrix documented internally.',
      'Cross-tenant 403→404 collapse on every admin surface.',
      'Owner-only role required for SSO + restore intents.',
    ],
  },
  {
    id: 'audit-logging',
    title: 'Audit logging',
    body:
      'Every sensitive write produces a structured row in an audit table with sanitized before/after snapshots, salted-SHA-256 IP fingerprint, request id, and actor identity. A mirror table provides tamper-evidence; admin operators read the feed via an in-product card or CSV export. A regression scanner asserts every mutating route is instrumented or carries an explicit exemption marker.',
    bullets: [
      'Audit-events table with sanitized snapshots + 4 KB cap.',
      'Owner-only mirror table; no RLS write policies.',
      'Static coverage scanner in CI.',
    ],
  },
  {
    id: 'backup-dr',
    title: 'Backup + disaster recovery',
    body:
      'Daily managed backups with point-in-time recovery via Supabase. Recovery Time Objective: 4 hours. Recovery Point Objective: 24 hours. Quarterly disaster-recovery dry runs. Restores are performed through approved Supabase workflows by VenueRise staff; the product UI NEVER executes a restore. Operators file restore intents via an audit-only endpoint before any out-of-app work begins.',
    bullets: [
      'Daily backups + PITR via Supabase.',
      'RTO 4h / RPO 24h targets.',
      'Quarterly dry-runs against a clone project.',
      'No destructive restore from the product UI.',
    ],
  },
  {
    id: 'sso-readiness',
    title: 'SSO readiness',
    body:
      'SSO scaffolding is in place: connection management table with owner-only mutations, login-event audit feed, vendor adapter interface (WorkOS / Clerk / Stytch / Supabase SSO / custom OIDC), and admin UI. Real SAML/OIDC exchange is wired vendor-by-vendor per buyer requirement; today the adapter resolves to a placeholder that returns structured "not configured" errors. Wiring a real adapter is a single-file change.',
    bullets: [
      'SAML + OIDC connection rows persisted.',
      'Owner-only connection mutations.',
      'JIT-provisioned users would default to viewer/coordinator only (DB-enforced).',
      'No SCIM yet.',
    ],
  },
  {
    id: 'data-protection',
    title: 'Data protection',
    body:
      'AES-256 encryption at rest at the storage layer (Supabase). HTTPS-only via HSTS in production. Lead-level PII supports soft redaction while preserving operational history. Audit snapshots are sanitized at write time — sensitive keys (password, secret, token, authorization, cookie, webhook_payload, etc.) are recursively dropped. No raw IPs are stored anywhere; the salted-SHA-256 fingerprint is used.',
    bullets: [
      'AES-256 at rest (Supabase).',
      'HSTS-enforced HTTPS in production.',
      'No raw IP storage.',
      'Lead PII soft redaction endpoint.',
    ],
  },
  {
    id: 'rate-limit-abuse',
    title: 'Rate limiting + abuse monitoring',
    body:
      'Every mutating + sensitive admin endpoint is rate-limited via Upstash Redis sliding-window buckets. Rate-limit blocks populate an abuse-events table; operators see top routes, reasons, and limiter keys via an in-product card. Coverage is enforced by a static scanner.',
    bullets: [
      'Upstash sliding-window per-route budgets.',
      'Abuse events table surfaced via venue-scoped card.',
      'Static coverage scanner.',
    ],
  },
  {
    id: 'incident-response',
    title: 'Incident response',
    body:
      'Documented runbook covers detection, triage, restore decision tree, and post-incident review across 7 incident classes from single-lead deletion through full-project corruption. Audit events + abuse events + structured logs (pino) + Sentry feed the technical evidence chain.',
    bullets: [
      'Runbook with 7 incident classes.',
      'Dual approval required for project-wide restores.',
      'Restore intent audit trail before any out-of-app action.',
    ],
  },
  {
    id: 'incident-response-detail',
    title: 'Incident response (operational detail)',
    body:
      'First-class incident records live in public.incidents + public.incident_timeline_events with severity / status / category / source vocabulary backed by CHECK constraints + the policy in lib/enterprise/incidents/policy.ts. Operator workflow: triage → status updates → optional alert routing (Slack / PagerDuty / Sentry, all env-gated) → post-incident review for SEV1/SEV2. Conservative detectors over abuse_events, sso_login_events, backup_posture, and a health-flag stub return CANDIDATES the operator decides whether to materialise. No autonomous remediation; no auto-resolve. VenueRise does NOT staff a 24/7 on-call rotation and does NOT offer an uptime SLA contract — response targets in the policy are best-effort. Customer notification routes through legal/operator review for every security event.',
    bullets: [
      'public.incidents + public.incident_timeline_events; typed audit actions per lifecycle step.',
      'Operator-triggered conservative detectors over existing security signals.',
      'Env-gated alert routing (INCIDENT_ALERTS_ENABLED + Slack / PagerDuty webhook env vars).',
      'No 24/7 staffed on-call; response targets are best-effort.',
      'Customer notification requires legal/operator review — never automatic.',
    ],
  },
  {
    id: 'privacy-dsr-readiness',
    title: 'Privacy + DSR readiness',
    body:
      'A static data inventory catalogs every customer/personal data category processed (lib/enterprise/privacy/data-inventory.ts). Per-category retention targets + reason + automation status live in lib/enterprise/privacy/retention-policy.ts. Data Subject Requests are tracked via public.dsr_requests + dsr_timeline_events with operator workflow (received → triage → identity_verification → in_progress → awaiting_legal_review → fulfilled / denied / cancelled). Export preview is metadata-only; deletion review is non-destructive — real exports and deletions are performed by the operator under legal review using the existing operator data export and lead-level PII redaction flows. VenueRise does NOT claim GDPR / CCPA / LGPD compliance in this summary; review with counsel is required.',
    bullets: [
      'Data inventory + retention policy maintained in code.',
      'DSR workflow with typed audit actions per lifecycle step.',
      'Export preview is metadata-only; deletion review is non-destructive.',
      'No autonomous fulfilment — every export and deletion routes through operator + legal review.',
      'VenueRise does NOT sell customer data and does NOT train AI models on customer data internally; vendor (Anthropic) contractual posture requires legal verification.',
    ],
  },
  {
    id: 'trust-center',
    title: 'Trust Center',
    body:
      'A public Trust Center page (/trust) summarises VenueRise security + privacy posture for buyers. Deeper materials (buyer security summary, security questionnaire response, subprocessor disclosure, privacy readiness, incident response summary, DR summary, evidence report, vendor risk report, SOC 2 evidence map) ship via bearer-token grants scoped to summary_only / standard_packet / full_packet. Tokens are short-lived (default 14 days, max 90), revocable, and tracked — every access event is logged with a salted-SHA-256 fingerprint. Operator + legal review is required before sending any grant URL externally.',
    bullets: [
      'Public Trust Center page with curated copy + explicit known limitations.',
      'Bearer-token grants for buyer packets (default 14-day expiry, max 90).',
      'Trust artifact builder enforces scope inclusion + visibility — internal-only artifacts NEVER emit.',
      'Per-grant access events logged with fingerprinted IP / user-agent.',
      'Trust materials are NOT a SOC 2 certification.',
    ],
  },
  {
    id: 'compliance-operations',
    title: 'Compliance operations + evidence freshness',
    body:
      'A static 17-row policy in lib/enterprise/compliance-ops/policy.ts assigns a cadence to every readiness area (vendor risk / privacy / DR / backup / incident / trust center / questionnaire / evidence pack / SSO / coverage scanners / RBAC / headers / data lifecycle). Operators record completion via the ComplianceCalendarCard — public.compliance_review_events persists every review with status, evidence URL, and notes. A freshness evaluator surfaces stale areas as a soft signal. The calendar does NOT prove continuous compliance and does NOT auto-rotate secrets, refresh trust artifacts, or send external alerts.',
    bullets: [
      'Operator-controlled review calendar covering 17 readiness areas.',
      'Typed audit actions per review lifecycle step (seeded / created / completed / waived / updated).',
      'Soft staleness flag derived from completion records.',
      'No autonomous rotation, no autonomous artifact refresh, no external alerting.',
    ],
  },
  {
    id: 'legal-contract-operations',
    title: 'Legal / contract operations readiness',
    body:
      'A first-class contract commitments register (public.contract_commitments + contract_commitment_events) tracks customer-specific commitments recorded from MSAs, DPAs, security addenda, order forms, trust grants, or email exchanges. Each commitment carries area + status + risk level + owner + due / review dates + evidence URL. Status / risk / fulfilment / review transitions are explicit operator actions that emit typed timeline + audit events. A soft "unsupported-risk" detector surfaces commitments referencing capabilities that are currently partial or not supported (SCIM, SSO, 24/7 monitoring, automated DSR fulfilment, AI-vendor training-use claims). Operators are NOT blocked from recording — the warning exists so the gap can be rectified with the buyer.',
    bullets: [
      'Operator-recorded commitments register with typed lifecycle audit actions.',
      'Soft unsupported-risk detector surfaces capabilities the product does not fully support today.',
      'Per-commitment review + due dates with overdue + 30-day counters.',
      'No autonomous contract parsing, no auto-promise generation, no auto-DELETE — operators withdraw instead.',
      'NOT legal advice and NOT contractual compliance proof.',
    ],
  },
  {
    id: 'vendor-subprocessors',
    title: 'Vendors + subprocessors',
    body:
      'A vendor registry is maintained inside the platform (lib/enterprise/vendor-risk/vendor-registry.ts) covering every production third-party processor: purpose, criticality, data categories, evidence references, known limitations, review owner, and review cadence. A buyer-safe subprocessor disclosure is generated on demand from the same source. Vendor legal/security evidence (DPA, SCC, SOC 2, ISO) is collected outside the repository; rows default to "manual review required" until verified. We do not claim contractual posture for any vendor in automated responses — legal review is required before relying on a specific commitment.',
    bullets: [
      'Static vendor registry in code, with admin + buyer-safe export.',
      'Production subprocessors: Supabase, Vercel, Stripe, Resend, Anthropic, Inngest, Upstash, Sentry.',
      'Vendor evidence (DPA / SCC / SOC 2) tracked outside repo; status defaults to manual_review_required.',
      'Buyer-facing disclosure reviewed before sharing.',
    ],
  },
]

const KNOWN_LIMITATIONS: string[] = [
  'No 24/7 staffed on-call rotation; incident response targets are best-effort.',
  'No uptime SLA contract.',
  'Incident alert routing (Slack / PagerDuty / Sentry) is env-gated and OFF by default.',
  'Privacy readiness is documented + tracked but is NOT a legal compliance attestation; counsel review required before any GDPR / CCPA / LGPD claim.',
  'DSR workflow is operator-tracked; export preview is metadata-only and deletion review is non-destructive. Real exports / deletions are operator + legal reviewed.',
  'Vendor AI processing terms (Anthropic training-use posture) require legal verification of the active contract before claiming to a buyer.',
  'No automated retention sweeper for audit / abuse / SSO / incident tables yet.',
  'Not SOC 2 certified. No third-party auditor engagement, no observation window.',
  'Real SAML/OIDC adapter not wired; SSO is in readiness mode (Phase 9G).',
  'No SCIM provisioning yet.',
  'Audit log mirror is tamper-EVIDENT, not tamper-PROOF (admin with DB access can still delete rows).',
  'No conversation-level PII redaction; lead-level only.',
  'No automated retention sweeper on audit / abuse / SSO event tables yet.',
  'Live backup PITR verification requires optional Supabase Management API env vars.',
  'No customer-facing self-service data deletion UI.',
  'No formal uptime SLA contract; RTO/RPO are internal targets.',
]

const PLANNED_IMPROVEMENTS: string[] = [
  'Wire a real SSO adapter (WorkOS recommended default) when a specific buyer requires it.',
  'Add a SCIM endpoint behind the existing connection row.',
  'Apply the digest-retention sweeper pattern to audit / abuse / SSO event tables.',
  'External append-only sink for tamper-PROOF audit storage on compliance contexts.',
  'Async export to object storage for venues that exceed the 8 MB inline cap.',
  'Conversation-level PII redaction.',
  'Automated cross-tenant probe in CI (currently operator-run).',
  'Engagement with a SOC 2 auditor for scoping + Type I readiness review.',
]

export async function buildBuyerSecuritySummary(): Promise<BuyerSecuritySummary> {
  return {
    generatedAt: new Date().toISOString(),
    overview: OVERVIEW,
    disclaimer: DISCLAIMER,
    sections: SECTIONS,
    knownLimitations: KNOWN_LIMITATIONS,
    plannedImprovements: PLANNED_IMPROVEMENTS,
  }
}

/**
 * Render the buyer summary as markdown. Suitable for emailing
 * after a sales call (after operator review).
 */
export function renderBuyerSecuritySummaryMarkdown(
  summary: BuyerSecuritySummary
): string {
  const lines: string[] = []
  lines.push('# VenueRise Security Summary')
  lines.push('')
  lines.push(`_Generated: ${summary.generatedAt}_`)
  lines.push('')
  lines.push('> ' + summary.disclaimer)
  lines.push('')
  lines.push('## Overview')
  lines.push('')
  lines.push(summary.overview)
  lines.push('')
  for (const section of summary.sections) {
    lines.push(`## ${section.title}`)
    lines.push('')
    lines.push(section.body)
    if (section.bullets && section.bullets.length > 0) {
      lines.push('')
      for (const b of section.bullets) {
        lines.push(`- ${b}`)
      }
    }
    lines.push('')
  }
  lines.push('## Known limitations')
  lines.push('')
  for (const l of summary.knownLimitations) {
    lines.push(`- ${l}`)
  }
  lines.push('')
  lines.push('## Planned improvements')
  lines.push('')
  for (const p of summary.plannedImprovements) {
    lines.push(`- ${p}`)
  }
  lines.push('')
  return lines.join('\n')
}
