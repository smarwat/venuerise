# VenueRise Security Evidence Report (Static Pack)

_Generated: 2026-05-20T18:29:51.817Z_

> This report is an internal evidence package and does not represent a third-party SOC 2 attestation. Formal SOC 2 requires an auditor, scoped system description, control design review, observation period, evidence collection, and exceptions/remediation. See docs/SOC2-EVIDENCE-MAP.md for the gap inventory.

_Authoritative version lives behind `/api/admin/security/evidence-report` (admin/owner only). This static pack is suitable for security-questionnaire responses where a live session is not available._

## Summary

- Total controls: **44**
- Implemented: 28
- Partial: 11
- Manual: 5
- Unknown: 0
- Not applicable: 0

## Controls

### access control

| Title | Status | SOC 2 | Refs |
|---|---|---|---:|
| Role-based access control with documented matrix | `implemented` | security, confidentiality | 4 |
| Owner-only mutation gates on billing-class actions | `implemented` | security | 2 |
| Enterprise SSO scaffolding (placeholder adapter) | `partial` | security | 6 |
| Gated Trust Center packets | `implemented` | security, confidentiality | 4 |

### audit logging

| Title | Status | SOC 2 | Refs |
|---|---|---|---:|
| Enterprise audit log over every sensitive write | `implemented` | security, processing_integrity | 6 |
| Tamper-evidence mirror table | `partial` | security | 3 |
| Audit coverage regression guard | `implemented` | security | 2 |
| SSO login event audit feed | `implemented` | security | 2 |
| Trust Center access event log | `implemented` | security | 3 |

### security operations

| Title | Status | SOC 2 | Refs |
|---|---|---|---:|
| Autonomous sending explicitly disabled | `implemented` | security, processing_integrity | 2 |
| Per-route rate limiting with coverage scanner | `implemented` | security, availability | 4 |
| Security headers + CSP report-only telemetry | `implemented` | security, confidentiality | 3 |
| Webhook signature verification before mutation | `implemented` | security, processing_integrity | 3 |
| Automated cross-tenant probe smoke harness | `partial` | security | 1 |

### monitoring

| Title | Status | SOC 2 | Refs |
|---|---|---|---:|
| Abuse event recording on rate-limit blocks | `implemented` | security | 4 |
| Health route flag inventory | `implemented` | availability, security | 1 |

### confidentiality

| Title | Status | SOC 2 | Refs |
|---|---|---|---:|
| No raw IP storage anywhere | `implemented` | confidentiality, privacy | 1 |

### availability

| Title | Status | SOC 2 | Refs |
|---|---|---|---:|
| Backup posture surface with policy targets | `partial` | availability | 5 |

### incident response

| Title | Status | SOC 2 | Refs |
|---|---|---|---:|
| Disaster recovery runbook with 7 incident classes | `manual` | availability | 1 |
| Restore intent audit trail (non-destructive) | `implemented` | availability, security | 4 |
| No destructive restore can be triggered from the product | `implemented` | security, availability | 2 |
| Incident response records + timeline | `implemented` | security, availability | 6 |
| Incident alert routing (env-gated) | `partial` | security, availability | 2 |
| Post-incident review template + threshold policy | `manual` | security | 3 |

### data lifecycle

| Title | Status | SOC 2 | Refs |
|---|---|---|---:|
| Venue-scoped JSON data export | `implemented` | privacy, confidentiality | 3 |
| Lead PII soft redaction | `implemented` | privacy, confidentiality | 2 |
| Retention posture visibility | `partial` | privacy | 2 |
| Privacy data inventory | `implemented` | privacy, confidentiality | 5 |
| Retention policy map | `partial` | privacy | 2 |
| DSR request tracking + timeline | `implemented` | privacy, security | 4 |
| DSR export preview (metadata-only) | `partial` | privacy, confidentiality | 2 |
| DSR deletion review (non-destructive) | `partial` | privacy, security | 2 |

### change management

| Title | Status | SOC 2 | Refs |
|---|---|---|---:|
| Audited migration + write-path lineage | `implemented` | security, processing_integrity | 2 |
| Public Trust Center summary | `implemented` | security, confidentiality | 4 |
| Compliance operations calendar | `implemented` | security, availability | 7 |
| Evidence freshness tracking | `partial` | security | 2 |
| Recurring review operator workflow (manual) | `manual` | security | 2 |
| Contract commitments register | `implemented` | security, confidentiality | 7 |
| Customer-specific obligation tracking | `implemented` | security | 2 |
| Unsupported commitment warning workflow | `partial` | security | 4 |

### vendor management

| Title | Status | SOC 2 | Refs |
|---|---|---|---:|
| Documented secret rotation cadence | `manual` | security | 1 |
| Vendor + subprocessor registry maintained in code | `implemented` | security, confidentiality | 7 |
| Buyer-safe subprocessor disclosure pack | `implemented` | confidentiality, privacy | 3 |
| Vendor security/legal assurance review (manual) | `manual` | security | 1 |

For full descriptions + artifact references + limitations / recommended-next items, generate the live report:

```
curl -H "cookie: <session>" \
  https://your-host/api/admin/security/evidence-report?format=markdown \
  -o security-evidence-report-live.md
```
