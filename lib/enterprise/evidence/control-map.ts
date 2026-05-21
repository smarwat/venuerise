import type { EvidenceControl } from '@/lib/enterprise/evidence/types'

/**
 * Phase 9I — Static evidence control map.
 *
 * Single source of truth for "what controls does VenueRise have."
 * Built by hand: every row reflects a control that actually
 * exists in the codebase. Adding a new control here without the
 * matching implementation is a lie; reviewers should be able to
 * follow every artifact reference to real code.
 *
 * STATUS HONESTY RULES:
 *   - `implemented`     — code path actively enforces the control
 *                         AND we can point at the file that does
 *                         the enforcing.
 *   - `partial`         — control is enforced but with gaps that
 *                         are explicitly listed in `limitations`.
 *   - `manual`          — control is a human process; the artifact
 *                         is a runbook or doc.
 *   - `unknown`         — live verification requires env vars or
 *                         third-party state we can't read at
 *                         report-build time.
 *   - `not_applicable`  — control category exists in SOC 2
 *                         vocabulary but doesn't apply to VenueRise.
 */

export const EVIDENCE_CONTROLS: ReadonlyArray<EvidenceControl> = [
  // ── Access control ─────────────────────────────────────────────────────
  {
    id: 'rbac-matrix',
    title: 'Role-based access control with documented matrix',
    category: 'access_control',
    soc2Categories: ['security', 'confidentiality'],
    status: 'implemented',
    description:
      'Every API route enforces a role gate via requireAdmin / requireVenueRole + a documented role set (ADMIN_ROLES / SALES_ROLES / owner-only). Cross-tenant 403 collapses to 404 to prevent venue enumeration.',
    artifacts: [
      { kind: 'file', reference: 'lib/auth/roles.ts', label: 'VENUE_ROLES constant' },
      { kind: 'file', reference: 'lib/auth/require-admin.ts', label: 'requireAdmin helper' },
      { kind: 'file', reference: 'lib/auth/tenant-access.ts', label: 'requireVenueRole + 403→404 collapse' },
      { kind: 'doc', reference: 'docs/RBAC-MATRIX.md', label: 'Per-route role matrix' },
    ],
    limitations: [
      'Cross-tenant probe (scripts/check-cross-tenant-rbac.mjs) is operator-run, not in CI.',
    ],
    recommendedNext: [
      'Add the cross-tenant probe to a staging smoke pipeline once seeded test tenants are stable.',
    ],
  },
  {
    id: 'owner-vs-admin-split',
    title: 'Owner-only mutation gates on billing-class actions',
    category: 'access_control',
    soc2Categories: ['security'],
    status: 'implemented',
    description:
      'SSO connection mutations, restore intents, and SSO-affecting team role changes require strict owner role (not ADMIN_ROLES). Application-layer gate + RLS policies fail closed independently.',
    artifacts: [
      { kind: 'file', reference: 'app/api/admin/security/sso-connections/route.ts' },
      { kind: 'file', reference: 'app/api/admin/security/sso-connections/[id]/route.ts' },
      { kind: 'file', reference: 'app/api/admin/security/restore-intents/route.ts' },
      { kind: 'file', reference: 'supabase/migrations/030_enterprise_sso_readiness.sql' },
    ],
    limitations: [],
    recommendedNext: [],
  },

  // ── Audit logging ──────────────────────────────────────────────────────
  {
    id: 'enterprise-audit-log',
    title: 'Enterprise audit log over every sensitive write',
    category: 'audit_logging',
    soc2Categories: ['security', 'processing_integrity'],
    status: 'implemented',
    description:
      'Every mutating route writes to public.audit_events via recordAuditEvent. Sanitized before/after snapshots, salted-SHA-256 IP hash, request id correlation. EnterpriseAuditEventsCard surfaces the feed; CSV export available.',
    artifacts: [
      { kind: 'file', reference: 'lib/enterprise/audit-events.ts' },
      { kind: 'route', reference: '/api/admin/audit-events' },
      { kind: 'file', reference: 'components/dashboard/settings/EnterpriseAuditEventsCard.tsx' },
      { kind: 'file', reference: 'supabase/migrations/027_enterprise_audit_events.sql' },
      { kind: 'script', reference: 'scripts/check-audit-coverage.mjs' },
      { kind: 'audit_action', reference: 'lib/enterprise/audit-actions.ts', label: 'AUDIT_ACTIONS catalog' },
    ],
    limitations: [
      'audit_events is RLS-gated for read but not WORM at the database level.',
    ],
    recommendedNext: [
      'External append-only sink for tamper-evident compliance contexts.',
    ],
  },
  {
    id: 'audit-event-mirror',
    title: 'Tamper-evidence mirror table',
    category: 'audit_logging',
    soc2Categories: ['security'],
    status: 'partial',
    description:
      'Every audit_events insert attempts a best-effort mirror write to public.audit_event_mirror (owner-only SELECT; no RLS write policies). Gated by AUDIT_MIRROR_ENABLED=1.',
    artifacts: [
      { kind: 'file', reference: 'lib/enterprise/audit-mirror.ts' },
      { kind: 'file', reference: 'supabase/migrations/028_audit_event_mirror.sql' },
      { kind: 'health_flag', reference: 'enterprise_audit_mirror' },
    ],
    limitations: [
      'Not true WORM — an admin with DB access can DELETE FROM audit_event_mirror.',
      'Mirror is gated by env; default OFF in new environments.',
    ],
    recommendedNext: [
      'Append-only object storage sink as a third copy.',
    ],
  },
  {
    id: 'audit-coverage-scanner',
    title: 'Audit coverage regression guard',
    category: 'audit_logging',
    soc2Categories: ['security'],
    status: 'implemented',
    description:
      'Static scanner asserts every mutating route file contains recordAuditEvent or an explicit AUDIT_EXEMPT marker. Wired into npm run verify.',
    artifacts: [
      { kind: 'script', reference: 'scripts/check-audit-coverage.mjs' },
      { kind: 'doc', reference: 'docs/AUDIT-COVERAGE.md' },
    ],
    limitations: [
      'String-grep based — catches missing calls, does not validate placement.',
    ],
    recommendedNext: [],
  },

  // ── Security operations ────────────────────────────────────────────────
  {
    id: 'autonomous-sending-disabled',
    title: 'Autonomous sending explicitly disabled',
    category: 'security_operations',
    soc2Categories: ['security', 'processing_integrity'],
    status: 'implemented',
    description:
      'No code path sends customer-facing messages or schedules tours without explicit operator approval. Verified via the autonomous_sending_still_disabled health flag carried forward since Phase 8AX.',
    artifacts: [
      { kind: 'health_flag', reference: 'autonomous_sending_still_disabled' },
      { kind: 'doc', reference: 'docs/PRODUCT-THESIS.md' },
    ],
    limitations: [],
    recommendedNext: [],
  },
  {
    id: 'rate-limit-coverage',
    title: 'Per-route rate limiting with coverage scanner',
    category: 'security_operations',
    soc2Categories: ['security', 'availability'],
    status: 'implemented',
    description:
      'Every mutating + sensitive admin GET route calls rateLimit* or carries an explicit RATE_LIMIT_EXEMPT / webhook / public marker. Catalog of canonical keys in lib/rate-limit-catalog.ts.',
    artifacts: [
      { kind: 'file', reference: 'lib/rate-limit.ts' },
      { kind: 'file', reference: 'lib/rate-limit-catalog.ts' },
      { kind: 'script', reference: 'scripts/check-rate-limit-coverage.mjs' },
      { kind: 'doc', reference: 'docs/RATE-LIMIT-COVERAGE.md' },
    ],
    limitations: [
      'Disabled fallback (mode=disabled) when Upstash env unset — production deploys must set both env vars.',
    ],
    recommendedNext: [],
  },
  {
    id: 'abuse-monitoring',
    title: 'Abuse event recording on rate-limit blocks',
    category: 'monitoring',
    soc2Categories: ['security'],
    status: 'implemented',
    description:
      'Every rate-limit block fires a fire-and-forget recordAbuseEvent into public.abuse_events. AbuseMonitorCard surfaces top routes / reasons / limiter keys + recent rows. Admin-readable; CSV export.',
    artifacts: [
      { kind: 'file', reference: 'lib/enterprise/abuse-events.ts' },
      { kind: 'file', reference: 'supabase/migrations/029_abuse_events.sql' },
      { kind: 'route', reference: '/api/admin/security/abuse-events' },
      { kind: 'file', reference: 'components/dashboard/settings/AbuseMonitorCard.tsx' },
    ],
    limitations: [
      'Public-route blocks (widget, CSP) write venue_id NULL and are not surfaced in venue-scoped card.',
    ],
    recommendedNext: [
      'Cross-venue abuse dashboard at infra-team scope.',
    ],
  },
  {
    id: 'security-headers-csp-report',
    title: 'Security headers + CSP report-only telemetry',
    category: 'security_operations',
    soc2Categories: ['security', 'confidentiality'],
    status: 'implemented',
    description:
      'HSTS (prod-only), X-Content-Type-Options, Referrer-Policy, Permissions-Policy with powerful APIs disabled, X-Frame-Options SAMEORIGIN (widget exception), enforced Content-Security-Policy frame-ancestors, and Content-Security-Policy-Report-Only with /api/security/csp-report sink.',
    artifacts: [
      { kind: 'file', reference: 'next.config.js' },
      { kind: 'route', reference: '/api/security/csp-report' },
      { kind: 'health_flag', reference: 'security_headers_report_only' },
    ],
    limitations: [
      "Report-only CSP keeps 'unsafe-inline' / 'unsafe-eval' for script-src / style-src; tightening requires nonce middleware.",
    ],
    recommendedNext: [
      'Migrate to per-request nonces via Next.js experimental middleware.',
    ],
  },
  {
    id: 'no-raw-ip-storage',
    title: 'No raw IP storage anywhere',
    category: 'confidentiality',
    soc2Categories: ['confidentiality', 'privacy'],
    status: 'implemented',
    description:
      'Every audit row, abuse row, and SSO login event stores a salted-SHA-256 fingerprint via maskIpForAudit. Raw IPs are read only as rate-limit identifiers and never persisted.',
    artifacts: [
      { kind: 'file', reference: 'lib/enterprise/audit-events.ts', label: 'maskIpForAudit' },
    ],
    limitations: [
      'AUDIT_IP_HASH_SECRET falls back to SUPABASE_JWT_SECRET in dev — production should set a dedicated 32+ char secret.',
    ],
    recommendedNext: [],
  },
  {
    id: 'webhook-signature-verification',
    title: 'Webhook signature verification before mutation',
    category: 'security_operations',
    soc2Categories: ['security', 'processing_integrity'],
    status: 'implemented',
    description:
      'Stripe + Resend webhooks verify HMAC signatures before any database mutation. Signature failure rejects the request. Documented as RATE_LIMIT_EXEMPT / AUDIT_EXEMPT with rationale.',
    artifacts: [
      { kind: 'route', reference: '/api/stripe/webhook' },
      { kind: 'route', reference: '/api/resend/webhook' },
      { kind: 'doc', reference: 'docs/AUDIT-COVERAGE.md' },
    ],
    limitations: [],
    recommendedNext: [],
  },

  // ── Vendor / SSO readiness ─────────────────────────────────────────────
  {
    id: 'sso-readiness',
    title: 'Enterprise SSO scaffolding (placeholder adapter)',
    category: 'access_control',
    soc2Categories: ['security'],
    status: 'partial',
    description:
      'sso_connections + sso_login_events tables; owner-only mutations; SsoProviderAdapter interface; admin endpoints + UI cards. The vendor adapter is a placeholder — no real SAML/OIDC exchange yet. JIT-provisioned users would default to viewer/coordinator only (DB CHECK constraint).',
    artifacts: [
      { kind: 'file', reference: 'supabase/migrations/030_enterprise_sso_readiness.sql' },
      { kind: 'file', reference: 'lib/enterprise/sso/types.ts' },
      { kind: 'file', reference: 'lib/enterprise/sso/provider.ts' },
      { kind: 'route', reference: '/api/auth/sso/initiate' },
      { kind: 'route', reference: '/api/auth/sso/callback' },
      { kind: 'doc', reference: 'docs/SSO-READINESS.md' },
    ],
    limitations: [
      'No real SAML/OIDC exchange. No SCIM. No JIT user creation. Adapter is placeholder.',
    ],
    recommendedNext: [
      'Wire WorkOS adapter (recommended default in docs/SSO-READINESS.md).',
    ],
  },
  {
    id: 'sso-login-events',
    title: 'SSO login event audit feed',
    category: 'audit_logging',
    soc2Categories: ['security'],
    status: 'implemented',
    description:
      'Every initiate / callback writes a row in sso_login_events with outcome (initiated/success/failed/blocked) + reason. Operator-readable via SsoLoginEventsCard with top-N chips + CSV export.',
    artifacts: [
      { kind: 'route', reference: '/api/admin/security/sso-login-events' },
      { kind: 'file', reference: 'components/dashboard/settings/SsoLoginEventsCard.tsx' },
    ],
    limitations: [
      'Public-route style venue_id NULL rows are filtered out of the venue-scoped card.',
    ],
    recommendedNext: [],
  },

  // ── Availability + DR ──────────────────────────────────────────────────
  {
    id: 'backup-posture',
    title: 'Backup posture surface with policy targets',
    category: 'availability',
    soc2Categories: ['availability'],
    status: 'partial',
    description:
      'BackupPostureCard surfaces RTO/RPO/retention/dry-run targets plus a per-check breakdown. Management API smoke probe verifies token reachability; live PITR/last-backup checks degrade to unknown until the Supabase Management API endpoint is wired past project-info.',
    artifacts: [
      { kind: 'file', reference: 'lib/enterprise/disaster-recovery/policy.ts' },
      { kind: 'file', reference: 'lib/enterprise/disaster-recovery/backup-posture.ts' },
      { kind: 'route', reference: '/api/admin/security/backup-posture' },
      { kind: 'file', reference: 'components/dashboard/settings/BackupPostureCard.tsx' },
      { kind: 'script', reference: 'scripts/check-backup-posture.mjs' },
    ],
    limitations: [
      'Live PITR + last-backup metadata is `unknown` without SUPABASE_PROJECT_REF + SUPABASE_ACCESS_TOKEN.',
      'Management API call only verifies token reach, not PITR window.',
    ],
    recommendedNext: [
      'Wire Supabase PITR-specific endpoint when Management API shape is confirmed on the project plan.',
    ],
  },
  {
    id: 'dr-runbook',
    title: 'Disaster recovery runbook with 7 incident classes',
    category: 'incident_response',
    soc2Categories: ['availability'],
    status: 'manual',
    description:
      'Operator-facing runbook covering single lead deletion, venue corruption, billing data issues, RBAC mistakes, full project corruption, webhook replay bugs, and accidental migrations. Restore decision tree + Supabase workflow + quarterly dry-run checklist.',
    artifacts: [
      { kind: 'doc', reference: 'docs/DISASTER-RECOVERY.md' },
    ],
    limitations: [
      'Manual process — dry-run completion is tracked in a separate doc, not in the audit feed.',
    ],
    recommendedNext: [
      'Add DR_DRY_RUN_COMPLETED audit action so BackupPostureCard can auto-flag overdue drills.',
    ],
  },
  {
    id: 'restore-intent-audit',
    title: 'Restore intent audit trail (non-destructive)',
    category: 'incident_response',
    soc2Categories: ['availability', 'security'],
    status: 'implemented',
    description:
      'RestoreIntentCard captures operator intent; recordRestoreIntent writes restore_intent_recorded / _cancelled / _completed_outside_app audit rows. Product UI never executes a restore — flag restore_executed_by_product=false is hard-coded into every row.',
    artifacts: [
      { kind: 'file', reference: 'lib/enterprise/disaster-recovery/restore-intent.ts' },
      { kind: 'route', reference: '/api/admin/security/restore-intents' },
      { kind: 'file', reference: 'components/dashboard/settings/RestoreIntentCard.tsx' },
      { kind: 'audit_action', reference: 'RESTORE_INTENT_RECORDED' },
    ],
    limitations: [],
    recommendedNext: [],
  },
  {
    id: 'no-destructive-restore-from-app',
    title: 'No destructive restore can be triggered from the product',
    category: 'incident_response',
    soc2Categories: ['security', 'availability'],
    status: 'implemented',
    description:
      'Product UI is read-only on disaster recovery. Real restores happen via Supabase dashboard / support workflow only. Three explicit non-destructive notices on the RestoreIntentCard.',
    artifacts: [
      { kind: 'file', reference: 'components/dashboard/settings/RestoreIntentCard.tsx' },
      { kind: 'doc', reference: 'docs/DISASTER-RECOVERY.md' },
    ],
    limitations: [],
    recommendedNext: [],
  },

  // ── Data lifecycle ─────────────────────────────────────────────────────
  {
    id: 'data-export',
    title: 'Venue-scoped JSON data export',
    category: 'data_lifecycle',
    soc2Categories: ['privacy', 'confidentiality'],
    status: 'implemented',
    description:
      'POST /api/admin/data-export returns a venue-scoped JSON snapshot (cap 8 MB). Operator-readable. Audit row data_export_requested captures section counts + estimated bytes (NEVER the payload).',
    artifacts: [
      { kind: 'file', reference: 'lib/enterprise/data-export.ts' },
      { kind: 'route', reference: '/api/admin/data-export' },
      { kind: 'file', reference: 'components/dashboard/settings/DataLifecycleCard.tsx' },
    ],
    limitations: [
      'Inline-only; oversize venues get 413 with no async path yet.',
    ],
    recommendedNext: [
      'Async export to object storage with signed-URL download for oversize venues.',
    ],
  },
  {
    id: 'lead-pii-redaction',
    title: 'Lead PII soft redaction',
    category: 'data_lifecycle',
    soc2Categories: ['privacy', 'confidentiality'],
    status: 'implemented',
    description:
      'POST /api/admin/leads/[leadId]/redact-pii removes name/email/phone/notes + pii metadata while preserving conversations/tours/audit history. Synthetic email + Redacted Lead name keep referential integrity intact.',
    artifacts: [
      { kind: 'file', reference: 'lib/enterprise/pii-redaction.ts' },
      { kind: 'route', reference: '/api/admin/leads/[leadId]/redact-pii' },
    ],
    limitations: [
      'No conversation-level PII redaction; messages.content still carries customer text.',
      'No bulk redaction.',
    ],
    recommendedNext: [
      'Conversation-level redaction action.',
    ],
  },
  {
    id: 'retention-posture',
    title: 'Retention posture visibility',
    category: 'data_lifecycle',
    soc2Categories: ['privacy'],
    status: 'partial',
    description:
      'DataLifecycleCard surfaces audit mirror, digest retention, audit log, and PII redaction availability. Digest retention is enforced by a weekly Inngest cron; audit log + abuse events have no auto-deletion yet.',
    artifacts: [
      { kind: 'file', reference: 'components/dashboard/settings/DataLifecycleCard.tsx' },
      { kind: 'file', reference: 'lib/jobs/functions/digest-audit-retention.ts' },
    ],
    limitations: [
      'No retention on audit_events / abuse_events / sso_login_events yet.',
    ],
    recommendedNext: [
      'Apply the digest retention pattern to other audit-class tables.',
    ],
  },

  // ── Monitoring ─────────────────────────────────────────────────────────
  {
    id: 'health-flags',
    title: 'Health route flag inventory',
    category: 'monitoring',
    soc2Categories: ['availability', 'security'],
    status: 'implemented',
    description:
      'Every feature phase mounts named health flags on /api/health so an external monitor can detect missing surfaces post-deploy. ADMIN_ENDPOINT_COUNT tracks the admin route surface; monitors alert on drift.',
    artifacts: [
      { kind: 'route', reference: '/api/health' },
    ],
    limitations: [
      'Flag values are static `mounted`; they reflect deploy presence, not runtime success.',
    ],
    recommendedNext: [],
  },
  {
    id: 'cross-tenant-probe',
    title: 'Automated cross-tenant probe smoke harness',
    category: 'security_operations',
    soc2Categories: ['security'],
    status: 'partial',
    description:
      'scripts/check-cross-tenant-rbac.mjs probes 8 routes × 2 passes for 403→404 collapse posture. Operator-run (requires seeded test tenants); skips cleanly when env is missing.',
    artifacts: [
      { kind: 'script', reference: 'scripts/check-cross-tenant-rbac.mjs' },
    ],
    limitations: [
      'Not in CI — requires seeded test tenants.',
    ],
    recommendedNext: [
      'Seed test tenants in staging + add the probe to a pre-deploy gate.',
    ],
  },

  // ── Change management ──────────────────────────────────────────────────
  {
    id: 'audited-write-paths',
    title: 'Audited migration + write-path lineage',
    category: 'change_management',
    soc2Categories: ['security', 'processing_integrity'],
    status: 'implemented',
    description:
      'Every schema change ships as a numbered SQL migration with inline rationale + commented rollback. Every audit/abuse/sso/restore-intent row carries phase context so an auditor can trace which feature introduced each control.',
    artifacts: [
      { kind: 'file', reference: 'supabase/migrations/', label: 'Migration history' },
      { kind: 'doc', reference: 'docs/RUNBOOK.md' },
    ],
    limitations: [
      'No CI gate that asserts new migrations have rollback comments.',
    ],
    recommendedNext: [],
  },

  // ── Vendor management ──────────────────────────────────────────────────
  {
    id: 'secrets-rotation-runbook',
    title: 'Documented secret rotation cadence',
    category: 'vendor_management',
    soc2Categories: ['security'],
    status: 'manual',
    description:
      'docs/RUNBOOK.md Phase 9E section catalogs every secret: cadence (quarterly/annually/event), what it controls, what rotation invalidates, dual-secret requirements, verification, rollback. Includes Supabase service role, Stripe, Resend, Anthropic, audit IP hash, etc.',
    artifacts: [
      { kind: 'doc', reference: 'docs/RUNBOOK.md', label: 'Phase 9E secrets table' },
    ],
    limitations: [
      'Manual rotation — no automated enforcement of the cadence.',
    ],
    recommendedNext: [
      'Calendar reminder + audit action on rotation completion.',
    ],
  },
  {
    id: 'vendor-registry-maintained',
    title: 'Vendor + subprocessor registry maintained in code',
    category: 'vendor_management',
    soc2Categories: ['security', 'confidentiality'],
    status: 'implemented',
    description:
      'lib/enterprise/vendor-risk/vendor-registry.ts is the single source of truth for every third-party processor: name, purpose, criticality, disclosure status, data categories, evidence references (env/package/doc), known limitations, review owner, review cadence. The admin VendorRiskCard surfaces it inline; markdown + CSV exports audit (vendor_risk_report_exported). A static scanner (check-vendor-risk.mjs) asserts the registry stays in sync with the codebase.',
    artifacts: [
      { kind: 'file', reference: 'lib/enterprise/vendor-risk/types.ts' },
      { kind: 'file', reference: 'lib/enterprise/vendor-risk/vendor-registry.ts' },
      { kind: 'file', reference: 'lib/enterprise/vendor-risk/report.ts' },
      { kind: 'route', reference: '/api/admin/security/vendor-risk-report' },
      { kind: 'file', reference: 'components/dashboard/settings/VendorRiskCard.tsx' },
      { kind: 'script', reference: 'scripts/check-vendor-risk.mjs' },
      { kind: 'doc', reference: 'docs/VENDOR-RISK.md' },
    ],
    limitations: [
      'Registry can drift if a new vendor is added without updating the row — the scanner only flags packages it knows about.',
      'Last-reviewed dates default to null until an operator runs the registry review.',
    ],
    recommendedNext: [
      'Calendar reminder on review cadence + audit action on registry edit.',
    ],
  },
  {
    id: 'subprocessor-disclosure',
    title: 'Buyer-safe subprocessor disclosure pack',
    category: 'vendor_management',
    soc2Categories: ['confidentiality', 'privacy'],
    status: 'implemented',
    description:
      'GET /api/admin/security/subprocessor-disclosure renders only vendors flagged disclosureStatus="public". Evidence references (env vars + package names) are stripped before render so the shape is safe for procurement. SubprocessorDisclosureCard surfaces it inline. Markdown + CSV exports audit (subprocessor_disclosure_exported). No public /security/subprocessors page yet — disclosure ships from the admin surface and is reviewed before sending.',
    artifacts: [
      { kind: 'route', reference: '/api/admin/security/subprocessor-disclosure' },
      { kind: 'file', reference: 'components/dashboard/settings/SubprocessorDisclosureCard.tsx' },
      { kind: 'doc', reference: 'docs/VENDOR-RISK.md' },
    ],
    limitations: [
      'No public /security/subprocessors page yet — disclosure is admin-export only.',
      'Buyer-safe description is human-curated per row; operator must keep it in sync with vendor behaviour.',
    ],
    recommendedNext: [
      'Optional public /security/subprocessors page once disclosure copy has been reviewed by legal.',
    ],
  },
  // ── Incident response (Phase 9L) ───────────────────────────────────────
  {
    id: 'incident-response-records',
    title: 'Incident response records + timeline',
    category: 'incident_response',
    soc2Categories: ['security', 'availability'],
    status: 'implemented',
    description:
      'public.incidents + public.incident_timeline_events back a first-class incident record with severity / status / category / source vocabulary that mirrors the policy in lib/enterprise/incidents/policy.ts. Owner/admin can create + update; every change writes a typed audit row (incident_created / incident_updated / incident_resolved / incident_alert_sent / incident_candidates_detected). IncidentResponseCard surfaces the feed in-product with summary stats, candidate detection, per-row timeline, status update controls, and CSV export.',
    artifacts: [
      { kind: 'file', reference: 'lib/enterprise/incidents/types.ts' },
      { kind: 'file', reference: 'lib/enterprise/incidents/policy.ts' },
      { kind: 'file', reference: 'lib/enterprise/incidents/incidents.ts' },
      { kind: 'file', reference: 'supabase/migrations/032_incident_response.sql' },
      { kind: 'route', reference: '/api/admin/security/incidents' },
      { kind: 'route', reference: '/api/admin/security/incidents/[id]' },
      { kind: 'file', reference: 'components/dashboard/settings/IncidentResponseCard.tsx' },
      { kind: 'doc', reference: 'docs/INCIDENT-RESPONSE.md' },
    ],
    limitations: [
      'Incident records are RLS-gated but not WORM at the DB level — admins with direct DB access can delete rows.',
      'No 24/7 on-call rotation; response targets are best-effort (see docs/INCIDENT-RESPONSE.md).',
    ],
    recommendedNext: [
      'External append-only sink for incident records on compliance contexts.',
    ],
  },
  {
    id: 'incident-alert-routing',
    title: 'Incident alert routing (env-gated)',
    category: 'incident_response',
    soc2Categories: ['security', 'availability'],
    status: 'partial',
    description:
      'lib/enterprise/incidents/alert-routing.ts ships Slack + PagerDuty + Sentry channel adapters. Routing is env-gated via INCIDENT_ALERTS_ENABLED + INCIDENT_SLACK_WEBHOOK_URL + INCIDENT_PAGERDUTY_ROUTING_KEY; when env is absent the helper returns `skipped_disabled` / `skipped_unconfigured` outcomes and NEVER throws. Webhook URLs and routing keys NEVER appear in logs, responses, or audit metadata. Per-attempt rows land in public.incident_alert_deliveries with the operator-readable label only.',
    artifacts: [
      { kind: 'file', reference: 'lib/enterprise/incidents/alert-routing.ts' },
      { kind: 'route', reference: '/api/admin/security/incidents/[id]/alert' },
      { kind: 'audit_action', reference: 'INCIDENT_ALERT_SENT' },
    ],
    limitations: [
      'Alerts are disabled by default — operator must opt in via INCIDENT_ALERTS_ENABLED + at least one channel env var.',
      'Slack/PagerDuty delivery is best-effort; failed deliveries surface in the IncidentResponseCard but do NOT retry automatically.',
      'Customer notification is NEVER automatic — every customer-facing message routes through legal/operator review.',
    ],
    recommendedNext: [
      'Optional retry-with-backoff for failed channel deliveries once alert noise floor is well-understood.',
    ],
  },
  {
    id: 'post-incident-review-template',
    title: 'Post-incident review template + threshold policy',
    category: 'incident_response',
    soc2Categories: ['security'],
    status: 'manual',
    description:
      'lib/enterprise/incidents/policy.ts encodes the severity matrix + post-incident review requirement (required for SEV1 + SEV2 by default). The /api/admin/security/incidents/[id] PATCH accepts a `postmortem` field that appends a timeline event with kind `postmortem_added`. The static `scripts/build-incident-response-pack.mjs` emits a runbook + PIR markdown template for off-line use.',
    artifacts: [
      { kind: 'file', reference: 'lib/enterprise/incidents/policy.ts' },
      { kind: 'script', reference: 'scripts/build-incident-response-pack.mjs' },
      { kind: 'doc', reference: 'docs/INCIDENT-RESPONSE.md' },
    ],
    limitations: [
      'PIR completion is operator-tracked via the timeline event; there is no automated reminder cron.',
      'PIR markdown is stored inline in the timeline; for long PIRs an external doc with the URL in `external_reference` is preferred.',
    ],
    recommendedNext: [
      'Optional reminder cron when a SEV1/SEV2 resolves without a PIR within 7 days.',
    ],
  },
  // ── Data privacy + DSR readiness (Phase 9M) ────────────────────────────
  {
    id: 'privacy-data-inventory',
    title: 'Privacy data inventory',
    category: 'data_lifecycle',
    soc2Categories: ['privacy', 'confidentiality'],
    status: 'implemented',
    description:
      'lib/enterprise/privacy/data-inventory.ts catalogs every customer/personal data category processed by VenueRise: source tables, sensitivity, retention basis, exportable/deletable flags, vendor subprocessors. The PrivacyReadinessCard surfaces it in-product with markdown + CSV exports (audited).',
    artifacts: [
      { kind: 'file', reference: 'lib/enterprise/privacy/types.ts' },
      { kind: 'file', reference: 'lib/enterprise/privacy/data-inventory.ts' },
      { kind: 'route', reference: '/api/admin/privacy/readiness' },
      { kind: 'file', reference: 'components/dashboard/settings/PrivacyReadinessCard.tsx' },
      { kind: 'doc', reference: 'docs/PRIVACY-DSR-READINESS.md' },
    ],
    limitations: [
      'Operational basis is plain-language; legal basis under GDPR Art. 6 / CCPA requires legal review.',
      'Inventory rows can drift if a new schema column is added without updating the inventory; manual PR review still required.',
    ],
    recommendedNext: [
      'Optional schema-introspection scanner that flags new tables/columns missing from the inventory.',
    ],
  },
  {
    id: 'privacy-retention-policy',
    title: 'Retention policy map',
    category: 'data_lifecycle',
    soc2Categories: ['privacy'],
    status: 'partial',
    description:
      'lib/enterprise/privacy/retention-policy.ts documents per-category retention TARGETS + reason + deletion behaviour + exceptions + automation status. Only categories whose automationStatus === "implemented" have a cron enforcing the window today (auth sessions, digest retention sweeper from Phase 8AA). Everything else is partial/manual; security/audit logs accumulate.',
    artifacts: [
      { kind: 'file', reference: 'lib/enterprise/privacy/retention-policy.ts' },
      { kind: 'doc', reference: 'docs/PRIVACY-DSR-READINESS.md' },
    ],
    limitations: [
      'No automated retention sweeper for audit_events / abuse_events / sso_login_events / incidents yet.',
      'Vendor-side retention (Sentry, Vercel, Resend) is governed by vendor plan, not enforced here.',
    ],
    recommendedNext: [
      'Add retention sweepers for audit-class tables after the windows are confirmed with legal.',
    ],
  },
  {
    id: 'dsr-request-tracking',
    title: 'DSR request tracking + timeline',
    category: 'data_lifecycle',
    soc2Categories: ['privacy', 'security'],
    status: 'implemented',
    description:
      'public.dsr_requests + public.dsr_timeline_events back a first-class DSR workflow with status / type / risk-level vocabulary backed by CHECK constraints. Typed audit actions per lifecycle step (dsr_request_created / _updated / _fulfilled / _denied / _cancelled). DsrRequestsCard surfaces the queue in-product with operator workflow + identity verification + legal review notes. Owner/admin only.',
    artifacts: [
      { kind: 'file', reference: 'lib/enterprise/privacy/dsr.ts' },
      { kind: 'file', reference: 'supabase/migrations/033_privacy_dsr_readiness.sql' },
      { kind: 'route', reference: '/api/admin/privacy/dsr-requests' },
      { kind: 'route', reference: '/api/admin/privacy/dsr-requests/[id]' },
      { kind: 'file', reference: 'components/dashboard/settings/DsrRequestsCard.tsx' },
    ],
    limitations: [
      'No anonymous DSR intake yet — DSRs are created by operators on behalf of subjects.',
      'Identity verification is operator-asserted (Mark identity verified button); no automated verification flow.',
      'Like audit_events + abuse_events, dsr_requests is RLS-gated but not WORM at the DB level.',
    ],
    recommendedNext: [
      'Public DSR intake endpoint behind tight abuse protection + identity-verification gating.',
    ],
  },
  {
    id: 'dsr-export-preview',
    title: 'DSR export preview (metadata-only)',
    category: 'data_lifecycle',
    soc2Categories: ['privacy', 'confidentiality'],
    status: 'partial',
    description:
      'POST /api/admin/privacy/dsr-requests/[id]/export-preview returns the LIST of categories that would be searched for the subject + which are restricted from export (audit / abuse / SSO / incident logs). Does NOT fetch subject data. Audited via dsr_export_previewed.',
    artifacts: [
      { kind: 'file', reference: 'lib/enterprise/privacy/export-preview.ts' },
      { kind: 'route', reference: '/api/admin/privacy/dsr-requests/[id]/export-preview' },
    ],
    limitations: [
      'Metadata-only; real exports require operator action through the appropriate existing export flow (operator data export, etc.) under legal review.',
    ],
    recommendedNext: [],
  },
  {
    id: 'dsr-deletion-review',
    title: 'DSR deletion review (non-destructive)',
    category: 'data_lifecycle',
    soc2Categories: ['privacy', 'security'],
    status: 'partial',
    description:
      'POST /api/admin/privacy/dsr-requests/[id]/deletion-review returns a checklist of what could be deleted, anonymized, or must be retained for the subject (security/billing exceptions). Does NOT delete anything. Audited via dsr_deletion_reviewed.',
    artifacts: [
      { kind: 'file', reference: 'lib/enterprise/privacy/deletion-review.ts' },
      { kind: 'route', reference: '/api/admin/privacy/dsr-requests/[id]/deletion-review' },
    ],
    limitations: [
      'Non-destructive checklist only; real deletion requires operator action under legal review and must honor security/billing retention exceptions.',
    ],
    recommendedNext: [],
  },
  // ── Trust Center foundation (Phase 9N) ─────────────────────────────────
  {
    id: 'trust-center-public-summary',
    title: 'Public Trust Center summary',
    category: 'change_management',
    soc2Categories: ['security', 'confidentiality'],
    status: 'implemented',
    description:
      'Public `/trust` page renders curated PUBLIC_TRUST_SECTIONS + the vendor registry filtered to disclosureStatus === "public". Includes explicit known limitations + the "not SOC 2 certified" disclaimer. Reviewed before each curated copy change.',
    artifacts: [
      { kind: 'file', reference: 'lib/enterprise/trust-center/policy.ts' },
      { kind: 'file', reference: 'lib/enterprise/trust-center/artifacts.ts' },
      { kind: 'file', reference: 'app/(marketing)/trust/page.tsx' },
      { kind: 'doc', reference: 'docs/TRUST-CENTER.md' },
    ],
    limitations: [
      'Public copy is curated; updates require a code change + reviewer approval.',
      'Public page is cache-revalidated every 5 minutes; very recent registry changes propagate after the cache window.',
    ],
    recommendedNext: [
      'Optional CMS-backed copy + scheduled review reminder.',
    ],
  },
  {
    id: 'trust-center-gated-packets',
    title: 'Gated Trust Center packets',
    category: 'access_control',
    soc2Categories: ['security', 'confidentiality'],
    status: 'implemented',
    description:
      'Bearer-token grants (public.trust_access_grants) gate access to packets at three scopes: summary_only / standard_packet / full_packet. The artifact builder enforces scope inclusion + visibility (internal_only artifacts NEVER emit). Default expiry 14 days, max 90. Tokens stored as salted-SHA-256 hash; plaintext returned ONCE at creation.',
    artifacts: [
      { kind: 'file', reference: 'lib/enterprise/trust-center/access.ts' },
      { kind: 'file', reference: 'supabase/migrations/034_trust_center_foundation.sql' },
      { kind: 'route', reference: '/api/admin/security/trust-center/grants' },
      { kind: 'route', reference: '/api/trust/access/[token]/artifact' },
      { kind: 'file', reference: 'app/trust/access/[token]/page.tsx' },
      { kind: 'audit_action', reference: 'TRUST_ACCESS_GRANT_CREATED' },
    ],
    limitations: [
      'Bearer-token model — anyone with the URL can access until expiry/revocation. Operator must share carefully.',
      'No PDF renderer shipped; markdown / CSV / JSON only.',
      'No NDA-gating beyond the token itself; legal review still required before sending.',
    ],
    recommendedNext: [
      'Optional NDA-acceptance gate before download.',
      'PDF renderer for packets that need to be archived as static documents.',
    ],
  },
  {
    id: 'trust-access-tracking',
    title: 'Trust Center access event log',
    category: 'audit_logging',
    soc2Categories: ['security'],
    status: 'implemented',
    description:
      'public.trust_access_events records grant_created / grant_revoked / grant_accessed / artifact_downloaded / grant_expired / access_denied. IP + user agent are stored as salted-SHA-256 fingerprints only. Admin export via /api/admin/security/trust-center/access-events (CSV audited). Per-grant access counts + last-accessed timestamps surface in the admin card.',
    artifacts: [
      { kind: 'route', reference: '/api/admin/security/trust-center/access-events' },
      { kind: 'file', reference: 'components/dashboard/settings/TrustAccessGrantsCard.tsx' },
      { kind: 'audit_action', reference: 'TRUST_ARTIFACT_DOWNLOADED' },
    ],
    limitations: [
      'IP and user-agent values are fingerprinted; reversing them is not possible.',
    ],
    recommendedNext: [],
  },
  // ── Compliance operations calendar (Phase 9O) ──────────────────────────
  {
    id: 'compliance-operations-calendar',
    title: 'Compliance operations calendar',
    category: 'change_management',
    soc2Categories: ['security', 'availability'],
    status: 'implemented',
    description:
      'public.compliance_review_events + lib/enterprise/compliance-ops/{policy,calendar,freshness}.ts track operator-initiated reviews against a 17-row static policy spanning vendor risk, privacy, DR, backup, incident, trust center, questionnaire, evidence pack, SSO, coverage scanners, RBAC, headers, data lifecycle. Owner/admin RBAC. Typed audit actions per lifecycle step (compliance_events_seeded / compliance_review_created / _completed / _waived / _updated). ComplianceCalendarCard surfaces it inline.',
    artifacts: [
      { kind: 'file', reference: 'lib/enterprise/compliance-ops/types.ts' },
      { kind: 'file', reference: 'lib/enterprise/compliance-ops/policy.ts' },
      { kind: 'file', reference: 'lib/enterprise/compliance-ops/calendar.ts' },
      { kind: 'file', reference: 'supabase/migrations/035_compliance_ops_calendar.sql' },
      { kind: 'route', reference: '/api/admin/security/compliance/calendar' },
      { kind: 'file', reference: 'components/dashboard/settings/ComplianceCalendarCard.tsx' },
      { kind: 'doc', reference: 'docs/COMPLIANCE-OPS.md' },
    ],
    limitations: [
      'Calendar tracks OPERATOR-INITIATED reviews — does NOT prove continuous compliance.',
      'No external alerting in 9O (no Slack / email reminders for upcoming reviews).',
      'Like audit_events + abuse_events, compliance_review_events is RLS-gated but not WORM.',
    ],
    recommendedNext: [
      'Optional reminder cron that surfaces upcoming/overdue reviews in the operator digest.',
    ],
  },
  {
    id: 'evidence-freshness-tracking',
    title: 'Evidence freshness tracking',
    category: 'change_management',
    soc2Categories: ['security'],
    status: 'partial',
    description:
      'lib/enterprise/compliance-ops/freshness.ts cross-references compliance_review_events against the static policy + per-area staleAfterDays threshold to produce a soft stale signal. Markdown + CSV exports audited via compliance_freshness_exported.',
    artifacts: [
      { kind: 'file', reference: 'lib/enterprise/compliance-ops/freshness.ts' },
      { kind: 'route', reference: '/api/admin/security/compliance/freshness' },
    ],
    limitations: [
      'Stale flag is derived from the most-recent completed event timestamp — a control whose underlying state has drifted in reality but whose review was marked complete will appear fresh until the next review window.',
      'No real-time attestation of the underlying control.',
    ],
    recommendedNext: [],
  },
  {
    id: 'recurring-review-workflow',
    title: 'Recurring review operator workflow (manual)',
    category: 'change_management',
    soc2Categories: ['security'],
    status: 'manual',
    description:
      'Operators run the per-area review process (vendor walk, DR dry-run, tabletop, etc.) outside the product and record completion via the ComplianceCalendarCard. Each review captures notes + optional evidence URL pointing at the out-of-band artifact. Waiver requires an explicit reason.',
    artifacts: [
      { kind: 'doc', reference: 'docs/COMPLIANCE-OPS.md' },
      { kind: 'doc', reference: 'docs/RUNBOOK.md', label: 'Phase 9O runbook section' },
    ],
    limitations: [
      'Operator-asserted — completion only attests that the operator ran the review, not that every underlying control is in its expected state.',
      'No automated rotation, no automated artifact refresh.',
    ],
    recommendedNext: [
      'Optional reminder cron + digest integration in a future phase.',
    ],
  },
  // ── Contract commitments register (Phase 9P) ───────────────────────────
  {
    id: 'contract-commitments-register',
    title: 'Contract commitments register',
    category: 'change_management',
    soc2Categories: ['security', 'confidentiality'],
    status: 'implemented',
    description:
      'public.contract_commitments + contract_commitment_events back an operator-recorded register of customer-specific contractual / security / privacy commitments (MSA / DPA / security addendum / order form / trust grant / email / other). Owner/admin RBAC. Typed audit actions per lifecycle step (commitment_created / _updated / _status_changed / _fulfilled / _reviewed / commitments_exported / commitments_readiness_exported). CommitmentsRegisterCard surfaces it inline.',
    artifacts: [
      { kind: 'file', reference: 'lib/enterprise/commitments/types.ts' },
      { kind: 'file', reference: 'lib/enterprise/commitments/policy.ts' },
      { kind: 'file', reference: 'lib/enterprise/commitments/commitments.ts' },
      { kind: 'file', reference: 'supabase/migrations/036_contract_commitments.sql' },
      { kind: 'route', reference: '/api/admin/security/commitments' },
      { kind: 'file', reference: 'components/dashboard/settings/CommitmentsRegisterCard.tsx' },
      { kind: 'doc', reference: 'docs/CONTRACT-COMMITMENTS.md' },
    ],
    limitations: [
      'Operator-recorded. Platform does NOT autonomously parse contracts or auto-create commitments from uploaded documents.',
      'Tracking / readiness workflow ONLY — not legal advice and not contractual compliance proof.',
      'Like audit_events + abuse_events, contract_commitments is RLS-gated but not WORM at the DB level.',
    ],
    recommendedNext: [
      'Optional cross-link from trust_access_grants to commitments seeded by a buyer grant.',
    ],
  },
  {
    id: 'customer-obligation-tracking',
    title: 'Customer-specific obligation tracking',
    category: 'change_management',
    soc2Categories: ['security'],
    status: 'implemented',
    description:
      'Each commitment row captures buyer identity + source type + commitment area + status + risk level + owner + due / review timestamps + evidence URL. Status transitions + risk changes + fulfilment + reviews emit typed timeline events for the trail. Owner/admin only.',
    artifacts: [
      { kind: 'file', reference: 'lib/enterprise/commitments/commitments.ts' },
      { kind: 'route', reference: '/api/admin/security/commitments/[id]' },
    ],
    limitations: [
      'No DELETE — operators move commitments to status `withdrawn` so the trail stays intact.',
    ],
    recommendedNext: [],
  },
  {
    id: 'unsupported-commitment-warning-workflow',
    title: 'Unsupported commitment warning workflow',
    category: 'change_management',
    soc2Categories: ['security'],
    status: 'partial',
    description:
      'lib/enterprise/commitments/policy.ts encodes per-area support posture (sso: partial, scim: not_supported, availability: partial, incident_response: partial, privacy: partial, data_retention: partial, ai_use: partial, subprocessor: partial, data_residency: partial). detectUnsupportedRiskFlags() returns soft warnings when a recorded commitment references one of these areas or carries critical risk in a sensitive area. Operators are NOT blocked from recording; the warning exists so the operator can rectify with the buyer.',
    artifacts: [
      { kind: 'file', reference: 'lib/enterprise/commitments/policy.ts' },
      { kind: 'file', reference: 'lib/enterprise/commitments/readiness.ts' },
      { kind: 'route', reference: '/api/admin/security/commitments/readiness' },
      { kind: 'file', reference: 'components/dashboard/settings/CommitmentsReadinessCard.tsx' },
    ],
    limitations: [
      'Warnings are soft signals — they do not prevent the operator from recording an unsupported commitment.',
      'Support posture is hand-maintained in policy.ts; new partial / not-supported areas need explicit operator updates.',
    ],
    recommendedNext: [
      'Optional alerting tie-in once the Phase 9L incident alert routing is enabled.',
    ],
  },
  {
    id: 'vendor-assurance-review',
    title: 'Vendor security/legal assurance review (manual)',
    category: 'vendor_management',
    soc2Categories: ['security'],
    status: 'manual',
    description:
      'DPA, SCC, SOC 2, and ISO assurance evidence is collected outside this repository. Every vendor row in the registry defaults to assuranceStatus="manual_review_required" unless verified evidence is on file. Operators run the review per the cadence column on each row.',
    artifacts: [
      { kind: 'doc', reference: 'docs/VENDOR-RISK.md', label: 'Review workflow + cadence' },
    ],
    limitations: [
      'No automated DPA/SCC/SOC 2 verification — every row remains manual_review_required by default.',
      'Evidence artifacts (DPA PDFs, SOC 2 reports) live outside the repository to keep secrets and licensed material out of source control.',
    ],
    recommendedNext: [
      'Track vendor review completion in an external register and reflect lastReviewedAt back into the registry.',
    ],
  },
]
