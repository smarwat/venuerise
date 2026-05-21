# VenueRise Security Summary (Static Pack)

_Generated: 2026-05-20T18:29:51.969Z_

> This summary is provided for security review purposes. It is generated from VenueRise's internal evidence and DOES NOT represent a third-party certification or legal attestation. Operators MUST review before sending to a buyer.

## Overview

VenueRise is a multi-tenant SaaS for wedding-venue operators. The platform ships a documented enterprise security posture: role-based access control with a per-route matrix, structured audit logging on every sensitive write with a tamper-evidence mirror table, per-route rate limiting with abuse monitoring, security headers + CSP report-only telemetry, owner-only billing-class actions, SSO scaffolding for SAML/OIDC, data export + lead-level PII redaction, point-in-time backups with a documented disaster-recovery runbook, and an internal SOC 2-style evidence map. VenueRise is NOT currently SOC 2 certified — formal certification requires an auditor + observation period.

## Known limitations

- No 24/7 staffed on-call rotation; incident response targets are best-effort.
- No uptime SLA contract.
- Incident alert routing (Slack / PagerDuty / Sentry) is env-gated and OFF by default.
- Privacy readiness is documented + tracked but is NOT a legal compliance attestation; counsel review required before any GDPR / CCPA / LGPD claim.
- DSR workflow is operator-tracked; export preview is metadata-only and deletion review is non-destructive. Real exports / deletions are operator + legal reviewed.
- Vendor AI processing terms (Anthropic training-use posture) require legal verification of the active contract before claiming to a buyer.
- No automated retention sweeper for audit / abuse / SSO / incident tables yet.
- Not SOC 2 certified. No third-party auditor engagement, no observation window.
- Real SAML/OIDC adapter not wired; SSO is in readiness mode (Phase 9G).
- No SCIM provisioning yet.
- Audit log mirror is tamper-EVIDENT, not tamper-PROOF (admin with DB access can still delete rows).
- No conversation-level PII redaction; lead-level only.
- No automated retention sweeper on audit / abuse / SSO event tables yet.
- Live backup PITR verification requires optional Supabase Management API env vars.
- No customer-facing self-service data deletion UI.
- No formal uptime SLA contract; RTO/RPO are internal targets.

## Planned improvements

- Wire a real SSO adapter (WorkOS recommended default) when a specific buyer requires it.
- Add a SCIM endpoint behind the existing connection row.
- Apply the digest-retention sweeper pattern to audit / abuse / SSO event tables.
- External append-only sink for tamper-PROOF audit storage on compliance contexts.
- Async export to object storage for venues that exceed the 8 MB inline cap.
- Conversation-level PII redaction.
- Automated cross-tenant probe in CI (currently operator-run).
- Engagement with a SOC 2 auditor for scoping + Type I readiness review.

_Authoritative version with full per-section detail lives behind `/api/admin/security/buyer-security-summary` (admin/owner only)._