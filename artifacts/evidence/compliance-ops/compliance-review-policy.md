# VenueRise Compliance Review Policy

_Generated: 2026-05-20T18:29:52.737Z_

> The compliance operations calendar tracks operator-initiated reviews of internal controls. It does NOT prove continuous compliance. It does NOT auto-rotate secrets, auto-refresh trust artifacts, or send external alerts. Completion is operator-marked; waivers carry an explicit reason. Stale-flagging is a soft signal, not a control failure.

17 policy items across operator-intended cadence.

## Cadence summary

| Cadence | Count |
|---|---:|
| monthly | 7 |
| quarterly | 8 |
| semiannual | 2 |
| annual | 0 |
| ad_hoc | 0 |

## Per-area policy

### Vendor risk registry review

- **Area**: vendor_risk
- **Cadence**: quarterly
- **Owner role**: platform
- **Stale after**: 120 days

Walk every row in lib/enterprise/vendor-risk/vendor-registry.ts. Confirm DPA / SCC / SOC 2 evidence is current outside the repo. Update lastReviewedAt + assuranceStatus.

**Recommended action**: Run `npm run build:vendor-risk-pack` after editing; confirm the static pack matches the live admin export.

**Evidence references**
- `docs/VENDOR-RISK.md`
- `lib/enterprise/vendor-risk/vendor-registry.ts`
- `scripts/build-vendor-risk-pack.mjs`

**Buyer impact if stale**: Procurement questionnaire answers may reference vendor posture that is no longer accurate.

### Subprocessor disclosure review

- **Area**: subprocessors
- **Cadence**: quarterly
- **Owner role**: platform
- **Stale after**: 100 days

Verify the buyer-facing subprocessor list is current. Promote / demote disclosureStatus as relationships change. Confirm buyer-safe descriptions still match vendor behaviour.

**Recommended action**: Regenerate buyer subprocessor disclosure + Trust Center pack; share with active enterprise prospects per sub-processor change SLA.

**Evidence references**
- `docs/VENDOR-RISK.md`
- `docs/TRUST-CENTER.md`
- `app/api/admin/security/subprocessor-disclosure/route.ts`

**Buyer impact if stale**: Public Trust Center page + gated buyer disclosure may understate / overstate the production vendor set.

### Privacy data inventory review

- **Area**: privacy_dsr
- **Cadence**: quarterly
- **Owner role**: platform
- **Stale after**: 120 days

Walk every row in lib/enterprise/privacy/data-inventory.ts. Confirm source tables + sensitivity + vendor links match the current schema. Add rows for any new data categories.

**Recommended action**: Run `npm run build:privacy-pack` after editing; confirm the static pack matches the live admin export.

**Evidence references**
- `docs/PRIVACY-DSR-READINESS.md`
- `lib/enterprise/privacy/data-inventory.ts`

**Buyer impact if stale**: Privacy readiness exports may misstate the data categories processed.

### Retention policy review

- **Area**: retention_policy
- **Cadence**: semiannual
- **Owner role**: legal
- **Stale after**: 210 days

Confirm per-category retention windows still match operational + legal intent. Audit / abuse / SSO / incident sweepers are not yet wired — flag any tables that have grown materially.

**Recommended action**: If a category needs a real sweeper, file a follow-up phase. Update the policy row and lastReviewedAt.

**Evidence references**
- `docs/PRIVACY-DSR-READINESS.md`
- `lib/enterprise/privacy/retention-policy.ts`

**Buyer impact if stale**: Retention answers in the security questionnaire may misstate the operative posture.

### Data lifecycle (export / redact / DSR) review

- **Area**: data_lifecycle
- **Cadence**: semiannual
- **Owner role**: platform
- **Stale after**: 210 days

Spot-check operator data export, lead PII redaction, and DSR workflow end-to-end. Confirm no anonymous DSR intake has been introduced without an abuse plan.

**Recommended action**: Run an internal end-to-end DSR (test subject) and record the timeline in the calendar entry notes.

**Evidence references**
- `docs/PRIVACY-DSR-READINESS.md`
- `app/api/admin/data-export/route.ts`
- `app/api/admin/leads/[leadId]/redact-pii/route.ts`

**Buyer impact if stale**: DSR workflow may have regressed without operator notice.

### Disaster recovery dry-run

- **Area**: disaster_recovery
- **Cadence**: quarterly
- **Owner role**: owner
- **Stale after**: 100 days

Run a tabletop or live restore drill against a Supabase clone project. Walk the docs/DISASTER-RECOVERY.md decision tree. Capture observed RTO / RPO + gaps.

**Recommended action**: File any gaps as SEV4 incidents via the IncidentResponseCard; update the DR runbook.

**Evidence references**
- `docs/DISASTER-RECOVERY.md`
- `lib/enterprise/disaster-recovery/policy.ts`

**Buyer impact if stale**: Buyer security review asking about last DR drill date will surface an out-of-date answer.

### Backup posture review

- **Area**: backup_posture
- **Cadence**: monthly
- **Owner role**: platform
- **Stale after**: 45 days

Open the BackupPostureCard. Confirm Management API token reachability + PITR retention target. Run `npm run check:backup-posture` if env vars are set.

**Recommended action**: Note any check that returned warning / critical. File incidents for repeated criticals.

**Evidence references**
- `docs/DISASTER-RECOVERY.md`
- `lib/enterprise/disaster-recovery/backup-posture.ts`

**Buyer impact if stale**: Backup posture answers may not reflect the current Supabase plan / retention.

### Incident tabletop exercise

- **Area**: incident_response
- **Cadence**: quarterly
- **Owner role**: platform
- **Stale after**: 100 days

Pick a scenario from docs/INCIDENT-RESPONSE.md §2 examples. Walk through detection path → triage owner → alert posture → mitigation → resolution → PIR. Capture the exercise as a SEV4 row in IncidentResponseCard for traceability.

**Recommended action**: File gaps as follow-up SEV4 incidents with the policy + runbook references in `external_reference`.

**Evidence references**
- `docs/INCIDENT-RESPONSE.md`
- `lib/enterprise/incidents/policy.ts`

**Buyer impact if stale**: Buyer asks "when was your last tabletop?" — operator should be able to answer recently.

### Trust Center public copy review

- **Area**: trust_center
- **Cadence**: monthly
- **Owner role**: platform
- **Stale after**: 45 days

Open /trust as an unauthenticated user. Confirm curated copy is current, public subprocessor list matches the registry, known limitations are accurate.

**Recommended action**: Edit PUBLIC_TRUST_SECTIONS / PUBLIC_KNOWN_LIMITATIONS as needed. Page revalidates every 5 minutes after deploy.

**Evidence references**
- `docs/TRUST-CENTER.md`
- `lib/enterprise/trust-center/policy.ts`
- `app/(marketing)/trust/page.tsx`

**Buyer impact if stale**: Public Trust Center may carry outdated security posture statements.

### Trust Center gated artifact review

- **Area**: trust_center
- **Cadence**: monthly
- **Owner role**: platform
- **Stale after**: 45 days

Run `npm run build:trust-center-pack` and review the standard + full packet markdown end-to-end. Verify gated artifacts still render the buyer-safe content from 9I–9M sources.

**Recommended action**: If any artifact body has drifted, fix the source module then regenerate.

**Evidence references**
- `docs/TRUST-CENTER.md`
- `lib/enterprise/trust-center/artifacts.ts`
- `scripts/build-trust-center-pack.mjs`

**Buyer impact if stale**: Buyer downloads from active grants may include stale artifact content.

### Security questionnaire review

- **Area**: security_questionnaire
- **Cadence**: monthly
- **Owner role**: platform
- **Stale after**: 45 days

Walk every answer in lib/enterprise/evidence/questionnaire-map.ts. Confirm statuses + shortAnswer + limitations reflect the current platform state.

**Recommended action**: Run `npm run build:questionnaire-pack` and diff the generated markdown against the previous version.

**Evidence references**
- `docs/ENTERPRISE-SALES-READINESS.md`
- `lib/enterprise/evidence/questionnaire-map.ts`

**Buyer impact if stale**: Pre-filled questionnaire responses to buyers may carry stale answers.

### Evidence pack regeneration

- **Area**: evidence_pack
- **Cadence**: monthly
- **Owner role**: platform
- **Stale after**: 45 days

Run `npm run build:evidence-pack` and review the static pack output. Confirm control statuses + limitations + recommendedNext fields are current.

**Recommended action**: Commit the regenerated artifacts/evidence/ directory if any content has changed.

**Evidence references**
- `docs/SOC2-EVIDENCE-MAP.md`
- `lib/enterprise/evidence/control-map.ts`
- `scripts/build-evidence-pack.mjs`

**Buyer impact if stale**: Full-packet trust grants would include an out-of-date evidence map.

### SSO readiness review

- **Area**: sso_readiness
- **Cadence**: quarterly
- **Owner role**: platform
- **Stale after**: 100 days

Inspect public.sso_connections + sso_login_events. Confirm placeholder adapter is still the right posture for the current customer mix. Update docs/SSO-READINESS.md if a real adapter is being wired.

**Recommended action**: If a buyer requires real SAML/OIDC, file the SSO-WORKOS-ADAPTER follow-up phase.

**Evidence references**
- `docs/SSO-READINESS.md`
- `lib/enterprise/sso/types.ts`

**Buyer impact if stale**: SSO answer in the questionnaire may misrepresent live capability.

### Audit coverage scanner review

- **Area**: audit_coverage
- **Cadence**: monthly
- **Owner role**: platform
- **Stale after**: 45 days

Run `npm run check:audit-coverage`. Confirm no new mutating routes have shipped without an audit row or AUDIT_EXEMPT marker.

**Recommended action**: Fill gaps in the offending route; record the policy event with the route path in notes.

**Evidence references**
- `docs/AUDIT-COVERAGE.md`
- `scripts/check-audit-coverage.mjs`

**Buyer impact if stale**: Buyer security review may catch an audited-class write that lacks an audit row.

### Rate-limit coverage scanner review

- **Area**: rate_limit_coverage
- **Cadence**: monthly
- **Owner role**: platform
- **Stale after**: 45 days

Run `npm run check:rate-limit-coverage`. Confirm no new mutating / sensitive admin GET routes lack a limiter or RATE_LIMIT_EXEMPT marker.

**Recommended action**: Wire the limiter via lib/rate-limit-catalog.ts; record the route path in notes.

**Evidence references**
- `docs/RATE-LIMIT-COVERAGE.md`
- `scripts/check-rate-limit-coverage.mjs`

**Buyer impact if stale**: Abuse posture may have drifted; AbuseMonitorCard may understate exposure.

### RBAC matrix review

- **Area**: access_control
- **Cadence**: quarterly
- **Owner role**: platform
- **Stale after**: 100 days

Walk docs/RBAC-MATRIX.md against the current admin route surface. Confirm cross-tenant 404 collapse posture + owner-only mutation gates still apply.

**Recommended action**: Run `npm run check:cross-tenant-rbac` against the seeded test tenants when available.

**Evidence references**
- `docs/RBAC-MATRIX.md`
- `lib/auth/roles.ts`
- `lib/auth/tenant-access.ts`

**Buyer impact if stale**: RBAC questionnaire answers may understate / overstate the gate.

### Security headers + CSP review

- **Area**: security_headers
- **Cadence**: quarterly
- **Owner role**: platform
- **Stale after**: 100 days

Inspect next.config.js headers + CSP report endpoint output. Confirm HSTS + Permissions-Policy + Content-Security-Policy targets still match policy.

**Recommended action**: Spot-check production response headers via curl. Tighten CSP report-only directives if a known noisy source is now silent.

**Evidence references**
- `next.config.js`
- `app/api/security/csp-report/route.ts`

**Buyer impact if stale**: Browser security questionnaire answer may overstate the live header posture.
