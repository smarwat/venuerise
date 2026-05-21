# VenueRise Compliance Freshness — Template

_Generated: 2026-05-20T18:29:52.737Z_

> The compliance operations calendar tracks operator-initiated reviews of internal controls. It does NOT prove continuous compliance. It does NOT auto-rotate secrets, auto-refresh trust artifacts, or send external alerts. Completion is operator-marked; waivers carry an explicit reason. Stale-flagging is a soft signal, not a control failure.

## Per-area template

Use this template to manually record review status when the
live admin route is unavailable (e.g. tabletop exercise, audit
prep). Replace placeholders before sharing externally.

| Area | Title | Last completed | Next due | Status | Stale |
|---|---|---|---|---|---|
| vendor_risk | Vendor risk registry review | YYYY-MM-DD | YYYY-MM-DD | completed / upcoming / overdue | yes / no |
| subprocessors | Subprocessor disclosure review | YYYY-MM-DD | YYYY-MM-DD | ... | ... |
| privacy_dsr | Privacy data inventory review | YYYY-MM-DD | YYYY-MM-DD | ... | ... |
| retention_policy | Retention policy review | YYYY-MM-DD | YYYY-MM-DD | ... | ... |
| disaster_recovery | Disaster recovery dry-run | YYYY-MM-DD | YYYY-MM-DD | ... | ... |
| backup_posture | Backup posture review | YYYY-MM-DD | YYYY-MM-DD | ... | ... |
| incident_response | Incident tabletop exercise | YYYY-MM-DD | YYYY-MM-DD | ... | ... |
| trust_center | Trust Center public copy review | YYYY-MM-DD | YYYY-MM-DD | ... | ... |
| trust_center | Trust Center gated artifact review | YYYY-MM-DD | YYYY-MM-DD | ... | ... |
| security_questionnaire | Security questionnaire review | YYYY-MM-DD | YYYY-MM-DD | ... | ... |
| evidence_pack | Evidence pack regeneration | YYYY-MM-DD | YYYY-MM-DD | ... | ... |
| sso_readiness | SSO readiness review | YYYY-MM-DD | YYYY-MM-DD | ... | ... |
| audit_coverage | Audit coverage scanner review | YYYY-MM-DD | YYYY-MM-DD | ... | ... |
| rate_limit_coverage | Rate-limit coverage scanner review | YYYY-MM-DD | YYYY-MM-DD | ... | ... |
| access_control | RBAC matrix review | YYYY-MM-DD | YYYY-MM-DD | ... | ... |
| security_headers | Security headers + CSP review | YYYY-MM-DD | YYYY-MM-DD | ... | ... |
| data_lifecycle | Data lifecycle review | YYYY-MM-DD | YYYY-MM-DD | ... | ... |

## Notes

- Live freshness data lives behind /api/admin/security/compliance/freshness.
- This template is for off-line review and pre-deploy planning.
- The platform does NOT auto-update this template.
