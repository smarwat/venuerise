# VenueRise DSR Workflow

_Generated: 2026-05-20T18:29:52.428Z_

> Privacy readiness is not a legal compliance attestation. VenueRise does NOT claim GDPR / CCPA / LGPD compliance in this automated summary. Operator + counsel review is required before any external claim. DSRs are tracked, NOT auto-fulfilled. Export preview is metadata-only. Deletion review is non-destructive.

## 1. Intake

Today: operators file DSRs on the subject's behalf via the
DsrRequestsCard on /dashboard/settings/billing. No public DSR
intake endpoint exists yet.

## 2. Status lifecycle

`received` → `triage` → `identity_verification` →
`in_progress` → `awaiting_legal_review` → terminal status
(`fulfilled` / `denied` / `cancelled`).

Each transition writes a typed audit row
(`dsr_request_updated`, plus terminal-state actions:
`dsr_request_fulfilled` / `dsr_request_denied` /
`dsr_request_cancelled`).

## 3. Identity verification

Operator-asserted via the **Mark identity verified** button on
the DSR detail. Stamps `identity_verified_at` and writes an
`identity_verified` timeline event.

## 4. Export preview (metadata-only)

`POST /api/admin/privacy/dsr-requests/[id]/export-preview`
returns the LIST of categories that would be searched + which
are restricted (audit / abuse / SSO / incident logs).
Does NOT fetch subject data. Audited via
`dsr_export_previewed`.

Real exports are performed by the operator under legal review
using the existing operator data export
(`/api/admin/data-export`) + lead-level PII redaction
(`/api/admin/leads/[leadId]/redact-pii`) flows.

## 5. Deletion review (non-destructive)

`POST /api/admin/privacy/dsr-requests/[id]/deletion-review`
returns a checklist: deletable / anonymizable / retention
exception applies. Does NOT delete anything. Audited via
`dsr_deletion_reviewed`.

## 6. Closure

Status `fulfilled` / `denied` / `cancelled` stamps the
matching close timestamp + `closed_by` + writes the matching
audit action.

## 7. What is automated vs manual

| Concern | Automated | Manual |
|---|---|---|
| Tracking | DSR record + timeline + audit actions | Operator-driven status transitions |
| Identity verification | Timestamp stamping | Operator confirmation |
| Export preview | Category scope enumeration | Real export under legal review |
| Deletion review | Checklist generation | Real deletion under legal review |
| Customer notification | Never automatic | Operator + legal review |

## 8. What NOT to claim

- Do NOT claim GDPR/CCPA/LGPD compliance — privacy readiness
  is not a legal attestation.
- Do NOT claim 30-day fulfilment windows unless contractually
  committed.
- Do NOT promise automated subject-initiated deletion.
- Do NOT claim "we do not use your data to train AI models"
  for vendor processing without confirmed contract terms.

## 9. Known limitations

- No anonymous DSR intake page yet.
- No automated identity-verification flow.
- Export preview is metadata-only.
- Deletion review is non-destructive.
- Conversation-level redaction not yet shipped.
- Audit / abuse / SSO / incident log retention sweepers not
  yet wired.
- Vendor AI processing terms (Anthropic training-use posture)
  require legal verification of the active contract.
