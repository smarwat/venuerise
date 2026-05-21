# VenueRise Trust Center (public)

_Generated: 2026-05-20T18:29:52.583Z_

> Trust materials are provided for security review purposes and do not represent a third-party certification, legal advice, or contractual commitment unless separately agreed in writing.



## Product security overview

VenueRise enforces role-based access control on every authenticated route, audits every sensitive write, and applies per-route rate limiting. Operator workflows are operator-controlled — no autonomous customer-facing messaging.

- Per-route RBAC + tenant isolation with cross-tenant 404 collapse.
- Structured audit logging on every sensitive write.
- Per-route rate limiting with abuse event recording.
- No autonomous customer-facing message sending.

## Access control

Owner / admin / sales_manager / coordinator / viewer roles are enforced at the application layer and policed by row-level security at the database. Owner-only mutation gates apply to billing-class actions including SSO connection management, restore intents, and demo mode.

- Documented per-route role matrix.
- Cross-tenant access returns 404 to prevent enumeration.
- Owner-only gates on billing-class actions.

## Data protection

AES-256 at rest at the storage layer. HTTPS enforced via HSTS in production. No raw IP addresses are stored anywhere in the application database — a salted-SHA-256 fingerprint is used. Audit snapshots are sanitised at write time (password / secret / token / cookie / webhook_payload keys are recursively dropped).

- AES-256 at rest (Supabase).
- HSTS-enforced HTTPS in production.
- No raw IP storage; salted-SHA-256 fingerprints only.
- Sanitised audit snapshots.

## Subprocessors

Production subprocessors are maintained inside the platform and exported on demand from the admin Trust Center. The buyer-facing disclosure includes vendor name, category, data categories, criticality, and risk tier.

- Production subprocessors: Supabase, Vercel, Stripe, Resend, Anthropic, Inngest, Upstash, Sentry.
- Disclosure is reviewed before sharing externally.
- Vendor security/legal evidence (DPA / SOC 2 / SCC) tracked outside the repository.

## Privacy + data subject requests

A static data inventory + retention policy map document every category of customer / personal data processed. Operator-controlled DSR workflow tracks access / export / deletion / correction / opt-out requests. Export preview is metadata-only; deletion review is non-destructive — real exports and deletions are performed by the operator under legal review.

- Data inventory + retention policy maintained in code.
- Operator-tracked DSR workflow with typed audit actions.
- Operator + legal review required for every export / deletion.
- VenueRise does not sell customer data and does not train AI models on customer data internally.

## Backup + disaster recovery

Daily managed backups with point-in-time recovery via Supabase. Recovery Time Objective: 4 hours. Recovery Point Objective: 24 hours. Quarterly disaster-recovery dry runs. Restores are performed through approved Supabase workflows — the product UI NEVER executes a restore.

- Daily backups + PITR.
- RTO 4h / RPO 24h targets.
- Quarterly dry-runs against a clone project.
- No destructive restore from the product UI.

## Incident response

Documented severity matrix (SEV1 — SEV4) with first-response, update cadence, and mitigation targets. First-class incident records + timeline + alert routing helpers (Slack / PagerDuty / Sentry, env-gated). VenueRise does NOT staff a 24/7 on-call rotation and does NOT offer an uptime SLA contract — response targets are best-effort.

- Severity matrix + PIR template documented.
- Operator-triggered conservative detectors over security signals.
- Env-gated alert routing.
- Customer notification requires legal / operator review for every security event.

## SSO readiness

SAML / OIDC scaffolding is in place: connection rows + login-event audit feed + vendor adapter interface. Real SAML / OIDC exchange is wired vendor-by-vendor per buyer requirement; today the adapter resolves to a placeholder returning structured "not configured" errors. JIT-provisioned users would default to viewer/coordinator only (DB-enforced).

- SAML + OIDC connection rows + audit feed.
- Vendor adapter is a placeholder today.
- No SCIM provisioning yet.

## Certification posture

VenueRise is NOT currently SOC 2 certified. An internal SOC 2-style evidence map cross-references existing controls to Trust Service Criteria. Formal SOC 2 certification requires an auditor engagement and observation period — engagement is on the planned-improvements list.

- NOT SOC 2 certified.
- Internal SOC 2-style evidence map maintained.
- Vendor SOC 2 / DPA / SCC posture verified per vendor outside this repository.

## Production subprocessors

- Supabase
- Anthropic
- Stripe
- Resend
- Upstash
- Inngest
- Vercel
- Sentry

## Known limitations

- Not SOC 2 certified. Formal certification requires an auditor + observation window.
- No 24/7 staffed on-call rotation; incident response targets are best-effort.
- No uptime SLA contract.
- Real SAML / OIDC adapter not wired; SSO is in readiness mode.
- No SCIM provisioning yet.
- DSRs are tracked and operator-routed; no anonymous DSR intake page yet.
- Vendor (Anthropic) AI training-use posture requires legal verification of the active contract.
- No customer-facing self-service deletion UI.