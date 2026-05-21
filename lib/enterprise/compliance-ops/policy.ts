import type {
  ComplianceReviewCadence,
  ComplianceReviewPolicyItem,
} from '@/lib/enterprise/compliance-ops/types'

/**
 * Phase 9O — Compliance review policy.
 *
 * Hand-maintained per-area review cadence. Each row is the
 * single source of truth for:
 *
 *   - The seed list used when an operator creates the calendar
 *     for a new venue.
 *   - The freshness evaluator (lastCompletedAt + staleAfterDays
 *     → stale flag).
 *   - The static policy markdown shipped in
 *     `artifacts/evidence/compliance-ops/`.
 *
 * Adjusting any of these constants is a deliberate policy
 * change. Update `docs/COMPLIANCE-OPS.md` in the same PR so
 * the buyer-facing artifacts stay in sync.
 */

export const COMPLIANCE_OPS_DISCLAIMER =
  'The compliance operations calendar tracks operator-initiated reviews of internal controls. It does NOT prove continuous compliance. It does NOT auto-rotate secrets, auto-refresh trust artifacts, or send external alerts. Completion is operator-marked; waivers carry an explicit reason. Stale-flagging is a soft signal, not a control failure.'

export const COMPLIANCE_REVIEW_POLICY: ReadonlyArray<ComplianceReviewPolicyItem> = [
  // ── Vendor + subprocessor ──────────────────────────────────────────────
  {
    id: 'vendor-risk-review',
    area: 'vendor_risk',
    title: 'Vendor risk registry review',
    cadence: 'quarterly',
    description:
      'Walk every row in lib/enterprise/vendor-risk/vendor-registry.ts. Confirm DPA / SCC / SOC 2 evidence is current outside the repo. Update lastReviewedAt + assuranceStatus.',
    ownerRole: 'platform',
    evidenceReferences: [
      'docs/VENDOR-RISK.md',
      'lib/enterprise/vendor-risk/vendor-registry.ts',
      'scripts/build-vendor-risk-pack.mjs',
    ],
    recommendedAction:
      'Run `npm run build:vendor-risk-pack` after editing; confirm the static pack matches the live admin export.',
    staleAfterDays: 120,
    buyerImpactIfStale:
      'Procurement questionnaire answers may reference vendor posture that is no longer accurate.',
  },
  {
    id: 'subprocessor-disclosure-review',
    area: 'subprocessors',
    title: 'Subprocessor disclosure review',
    cadence: 'quarterly',
    description:
      'Verify the buyer-facing subprocessor list is current. Promote / demote disclosureStatus as relationships change. Confirm buyer-safe descriptions still match vendor behaviour.',
    ownerRole: 'platform',
    evidenceReferences: [
      'docs/VENDOR-RISK.md',
      'docs/TRUST-CENTER.md',
      'app/api/admin/security/subprocessor-disclosure/route.ts',
    ],
    recommendedAction:
      'Regenerate buyer subprocessor disclosure + Trust Center pack; share with active enterprise prospects per sub-processor change SLA.',
    staleAfterDays: 100,
    buyerImpactIfStale:
      'Public Trust Center page + gated buyer disclosure may understate / overstate the production vendor set.',
  },

  // ── Privacy / DSR / retention ──────────────────────────────────────────
  {
    id: 'privacy-data-inventory-review',
    area: 'privacy_dsr',
    title: 'Privacy data inventory review',
    cadence: 'quarterly',
    description:
      'Walk every row in lib/enterprise/privacy/data-inventory.ts. Confirm source tables + sensitivity + vendor links match the current schema. Add rows for any new data categories.',
    ownerRole: 'platform',
    evidenceReferences: [
      'docs/PRIVACY-DSR-READINESS.md',
      'lib/enterprise/privacy/data-inventory.ts',
    ],
    recommendedAction:
      'Run `npm run build:privacy-pack` after editing; confirm the static pack matches the live admin export.',
    staleAfterDays: 120,
    buyerImpactIfStale:
      'Privacy readiness exports may misstate the data categories processed.',
  },
  {
    id: 'retention-policy-review',
    area: 'retention_policy',
    title: 'Retention policy review',
    cadence: 'semiannual',
    description:
      'Confirm per-category retention windows still match operational + legal intent. Audit / abuse / SSO / incident sweepers are not yet wired — flag any tables that have grown materially.',
    ownerRole: 'legal',
    evidenceReferences: [
      'docs/PRIVACY-DSR-READINESS.md',
      'lib/enterprise/privacy/retention-policy.ts',
    ],
    recommendedAction:
      'If a category needs a real sweeper, file a follow-up phase. Update the policy row and lastReviewedAt.',
    staleAfterDays: 210,
    buyerImpactIfStale:
      'Retention answers in the security questionnaire may misstate the operative posture.',
  },
  {
    id: 'data-lifecycle-review',
    area: 'data_lifecycle',
    title: 'Data lifecycle (export / redact / DSR) review',
    cadence: 'semiannual',
    description:
      'Spot-check operator data export, lead PII redaction, and DSR workflow end-to-end. Confirm no anonymous DSR intake has been introduced without an abuse plan.',
    ownerRole: 'platform',
    evidenceReferences: [
      'docs/PRIVACY-DSR-READINESS.md',
      'app/api/admin/data-export/route.ts',
      'app/api/admin/leads/[leadId]/redact-pii/route.ts',
    ],
    recommendedAction:
      'Run an internal end-to-end DSR (test subject) and record the timeline in the calendar entry notes.',
    staleAfterDays: 210,
    buyerImpactIfStale:
      'DSR workflow may have regressed without operator notice.',
  },

  // ── DR / backup ────────────────────────────────────────────────────────
  {
    id: 'dr-dry-run',
    area: 'disaster_recovery',
    title: 'Disaster recovery dry-run',
    cadence: 'quarterly',
    description:
      'Run a tabletop or live restore drill against a Supabase clone project. Walk the docs/DISASTER-RECOVERY.md decision tree. Capture observed RTO / RPO + gaps.',
    ownerRole: 'owner',
    evidenceReferences: [
      'docs/DISASTER-RECOVERY.md',
      'lib/enterprise/disaster-recovery/policy.ts',
    ],
    recommendedAction:
      'File any gaps as SEV4 incidents via the IncidentResponseCard; update the DR runbook.',
    staleAfterDays: 100,
    buyerImpactIfStale:
      'Buyer security review asking about last DR drill date will surface an out-of-date answer.',
  },
  {
    id: 'backup-posture-review',
    area: 'backup_posture',
    title: 'Backup posture review',
    cadence: 'monthly',
    description:
      'Open the BackupPostureCard. Confirm Management API token reachability + PITR retention target. Run `npm run check:backup-posture` if env vars are set.',
    ownerRole: 'platform',
    evidenceReferences: [
      'docs/DISASTER-RECOVERY.md',
      'lib/enterprise/disaster-recovery/backup-posture.ts',
    ],
    recommendedAction:
      'Note any check that returned warning / critical. File incidents for repeated criticals.',
    staleAfterDays: 45,
    buyerImpactIfStale:
      'Backup posture answers may not reflect the current Supabase plan / retention.',
  },

  // ── Incident response ──────────────────────────────────────────────────
  {
    id: 'incident-tabletop',
    area: 'incident_response',
    title: 'Incident tabletop exercise',
    cadence: 'quarterly',
    description:
      'Pick a scenario from docs/INCIDENT-RESPONSE.md §2 examples. Walk through detection path → triage owner → alert posture → mitigation → resolution → PIR. Capture the exercise as a SEV4 row in IncidentResponseCard for traceability.',
    ownerRole: 'platform',
    evidenceReferences: [
      'docs/INCIDENT-RESPONSE.md',
      'lib/enterprise/incidents/policy.ts',
    ],
    recommendedAction:
      'File gaps as follow-up SEV4 incidents with the policy + runbook references in `external_reference`.',
    staleAfterDays: 100,
    buyerImpactIfStale:
      'Buyer asks "when was your last tabletop?" — operator should be able to answer recently.',
  },

  // ── Trust Center ───────────────────────────────────────────────────────
  {
    id: 'trust-center-public-copy-review',
    area: 'trust_center',
    title: 'Trust Center public copy review',
    cadence: 'monthly',
    description:
      'Open /trust as an unauthenticated user. Confirm curated copy is current, public subprocessor list matches the registry, known limitations are accurate.',
    ownerRole: 'platform',
    evidenceReferences: [
      'docs/TRUST-CENTER.md',
      'lib/enterprise/trust-center/policy.ts',
      'app/(marketing)/trust/page.tsx',
    ],
    recommendedAction:
      'Edit PUBLIC_TRUST_SECTIONS / PUBLIC_KNOWN_LIMITATIONS as needed. Page revalidates every 5 minutes after deploy.',
    staleAfterDays: 45,
    buyerImpactIfStale:
      'Public Trust Center may carry outdated security posture statements.',
  },
  {
    id: 'trust-center-gated-artifact-review',
    area: 'trust_center',
    title: 'Trust Center gated artifact review',
    cadence: 'monthly',
    description:
      'Run `npm run build:trust-center-pack` and review the standard + full packet markdown end-to-end. Verify gated artifacts still render the buyer-safe content from 9I–9M sources.',
    ownerRole: 'platform',
    evidenceReferences: [
      'docs/TRUST-CENTER.md',
      'lib/enterprise/trust-center/artifacts.ts',
      'scripts/build-trust-center-pack.mjs',
    ],
    recommendedAction:
      'If any artifact body has drifted, fix the source module then regenerate.',
    staleAfterDays: 45,
    buyerImpactIfStale:
      'Buyer downloads from active grants may include stale artifact content.',
  },

  // ── Questionnaire + evidence pack ──────────────────────────────────────
  {
    id: 'security-questionnaire-review',
    area: 'security_questionnaire',
    title: 'Security questionnaire review',
    cadence: 'monthly',
    description:
      'Walk every answer in lib/enterprise/evidence/questionnaire-map.ts. Confirm statuses + shortAnswer + limitations reflect the current platform state.',
    ownerRole: 'platform',
    evidenceReferences: [
      'docs/ENTERPRISE-SALES-READINESS.md',
      'lib/enterprise/evidence/questionnaire-map.ts',
    ],
    recommendedAction:
      'Run `npm run build:questionnaire-pack` and diff the generated markdown against the previous version.',
    staleAfterDays: 45,
    buyerImpactIfStale:
      'Pre-filled questionnaire responses to buyers may carry stale answers.',
  },
  {
    id: 'evidence-pack-regeneration',
    area: 'evidence_pack',
    title: 'Evidence pack regeneration',
    cadence: 'monthly',
    description:
      'Run `npm run build:evidence-pack` and review the static pack output. Confirm control statuses + limitations + recommendedNext fields are current.',
    ownerRole: 'platform',
    evidenceReferences: [
      'docs/SOC2-EVIDENCE-MAP.md',
      'lib/enterprise/evidence/control-map.ts',
      'scripts/build-evidence-pack.mjs',
    ],
    recommendedAction:
      'Commit the regenerated artifacts/evidence/ directory if any content has changed.',
    staleAfterDays: 45,
    buyerImpactIfStale:
      'Full-packet trust grants would include an out-of-date evidence map.',
  },

  // ── SSO ────────────────────────────────────────────────────────────────
  {
    id: 'sso-readiness-review',
    area: 'sso_readiness',
    title: 'SSO readiness review',
    cadence: 'quarterly',
    description:
      'Inspect public.sso_connections + sso_login_events. Confirm placeholder adapter is still the right posture for the current customer mix. Update docs/SSO-READINESS.md if a real adapter is being wired.',
    ownerRole: 'platform',
    evidenceReferences: [
      'docs/SSO-READINESS.md',
      'lib/enterprise/sso/types.ts',
    ],
    recommendedAction:
      'If a buyer requires real SAML/OIDC, file the SSO-WORKOS-ADAPTER follow-up phase.',
    staleAfterDays: 100,
    buyerImpactIfStale:
      'SSO answer in the questionnaire may misrepresent live capability.',
  },

  // ── Coverage scanners ─────────────────────────────────────────────────
  {
    id: 'audit-coverage-review',
    area: 'audit_coverage',
    title: 'Audit coverage scanner review',
    cadence: 'monthly',
    description:
      'Run `npm run check:audit-coverage`. Confirm no new mutating routes have shipped without an audit row or AUDIT_EXEMPT marker.',
    ownerRole: 'platform',
    evidenceReferences: [
      'docs/AUDIT-COVERAGE.md',
      'scripts/check-audit-coverage.mjs',
    ],
    recommendedAction:
      'Fill gaps in the offending route; record the policy event with the route path in notes.',
    staleAfterDays: 45,
    buyerImpactIfStale:
      'Buyer security review may catch an audited-class write that lacks an audit row.',
  },
  {
    id: 'rate-limit-coverage-review',
    area: 'rate_limit_coverage',
    title: 'Rate-limit coverage scanner review',
    cadence: 'monthly',
    description:
      'Run `npm run check:rate-limit-coverage`. Confirm no new mutating / sensitive admin GET routes lack a limiter or RATE_LIMIT_EXEMPT marker.',
    ownerRole: 'platform',
    evidenceReferences: [
      'docs/RATE-LIMIT-COVERAGE.md',
      'scripts/check-rate-limit-coverage.mjs',
    ],
    recommendedAction:
      'Wire the limiter via lib/rate-limit-catalog.ts; record the route path in notes.',
    staleAfterDays: 45,
    buyerImpactIfStale:
      'Abuse posture may have drifted; AbuseMonitorCard may understate exposure.',
  },

  // ── Access control / headers ──────────────────────────────────────────
  {
    id: 'rbac-matrix-review',
    area: 'access_control',
    title: 'RBAC matrix review',
    cadence: 'quarterly',
    description:
      'Walk docs/RBAC-MATRIX.md against the current admin route surface. Confirm cross-tenant 404 collapse posture + owner-only mutation gates still apply.',
    ownerRole: 'platform',
    evidenceReferences: [
      'docs/RBAC-MATRIX.md',
      'lib/auth/roles.ts',
      'lib/auth/tenant-access.ts',
    ],
    recommendedAction:
      'Run `npm run check:cross-tenant-rbac` against the seeded test tenants when available.',
    staleAfterDays: 100,
    buyerImpactIfStale:
      'RBAC questionnaire answers may understate / overstate the gate.',
  },
  {
    id: 'security-headers-review',
    area: 'security_headers',
    title: 'Security headers + CSP review',
    cadence: 'quarterly',
    description:
      'Inspect next.config.js headers + CSP report endpoint output. Confirm HSTS + Permissions-Policy + Content-Security-Policy targets still match policy.',
    ownerRole: 'platform',
    evidenceReferences: [
      'next.config.js',
      'app/api/security/csp-report/route.ts',
    ],
    recommendedAction:
      'Spot-check production response headers via curl. Tighten CSP report-only directives if a known noisy source is now silent.',
    staleAfterDays: 100,
    buyerImpactIfStale:
      'Browser security questionnaire answer may overstate the live header posture.',
  },
]

/**
 * Cadence → next-due offset in days. Used by
 * `calculateNextDueAt` in the calendar helper.
 */
export function cadenceDays(cadence: ComplianceReviewCadence): number {
  switch (cadence) {
    case 'monthly':
      return 30
    case 'quarterly':
      return 90
    case 'semiannual':
      return 180
    case 'annual':
      return 365
    case 'ad_hoc':
      // Operator-supplied due date; default 30-day fallback when
      // the caller asks for a next-due offset.
      return 30
  }
}
