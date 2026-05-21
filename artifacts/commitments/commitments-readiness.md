# VenueRise Contract Commitments — Support Posture

_Generated: 2026-05-20T18:40:39.612Z_

> This register tracks operator-recorded commitments. It is not legal advice and does not prove contractual compliance. Commitments are operator-recorded and operator-reviewed; the platform does NOT autonomously parse contracts and does NOT auto-create commitments from uploaded documents.

## Per-area support posture

The list below documents which commitment areas surface an unsupported-risk warning today. Areas not listed are treated as `supported`.

| Area | Status | Reason |
|---|---|---|
| sso | partial | SSO is in readiness mode. The vendor adapter is a placeholder today; real SAML/OIDC exchange is wired per buyer requirement. Do NOT commit to live SAML/OIDC without confirming the adapter has been activated. |
| scim | not_supported | SCIM provisioning is NOT live in any environment today. Commitments referencing SCIM should remain `at_risk` until the SCIM endpoint is shipped behind the existing SSO connection row. |
| availability | partial | VenueRise does NOT staff a 24/7 on-call rotation and does NOT offer an uptime SLA contract. Internal RTO 4h / RPO 24h are best-effort targets, not contractual commitments. |
| incident_response | partial | Incident alert routing is env-gated and OFF by default. Customer notification requires legal/operator review — there is no automated breach notification flow. Do NOT commit to a fixed-time notification SLA without legal sign-off. |
| privacy | partial | DSR fulfillment is operator + legal reviewed, not automated. Export preview is metadata-only; deletion review is non-destructive. Do NOT commit to a guaranteed DSR fulfillment window without confirming operator capacity. |
| data_retention | partial | Audit / abuse / SSO / incident log retention sweepers are not yet wired; those tables currently accumulate. Commitments to specific retention windows for those categories require operator follow-through. |
| ai_use | partial | AI inference happens at Anthropic. Their contractual posture on training-use / zero-retention is governed by the active Anthropic plan and requires legal verification. Do NOT commit to "no vendor training" without confirmed contract terms. |
| subprocessor | partial | Subprocessor list changes propagate via the operator-recorded vendor registry. There is no automated subprocessor-change notification cron. Commitments to a fixed notice period require operator follow-through. |
| data_residency | partial | Customer data lives in the configured Supabase region (US by default). EU-resident customers can be provisioned on a Supabase EU project on request. Commitments to a specific region need to match the active Supabase project for the venue. |

## Readiness summary template

Use the live `/api/admin/security/commitments/readiness` endpoint (or the CommitmentsReadinessCard) to produce the tenant-specific summary. Headline counts:

- Total commitments
- Active commitments
- High + critical risk counts
- Overdue review count
- Due within 30 days
- Unsupported-risk flag count

## Notes

- This is a STATIC pack documenting the per-area support posture only.
- The pack does NOT contain any tenant's recorded commitments.
- Operators must review before sharing externally; per-tenant readiness exports happen via the admin route + CommitmentsReadinessCard.