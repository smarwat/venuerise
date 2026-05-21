import type {
  TrustAccessScope,
  TrustArtifactType,
  TrustArtifactVisibility,
} from '@/lib/enterprise/trust-center/types'

/**
 * Phase 9N — Trust Center policy constants.
 *
 * Single source of truth for disclaimers, scope rules, and
 * "what must never be published publicly." Updating any of
 * these constants is a deliberate policy change — update
 * `docs/TRUST-CENTER.md` in the same PR so buyer-facing
 * artifacts stay in sync.
 */

export const TRUST_CENTER_DISCLAIMER =
  'Trust materials are provided for security review purposes and do not represent a third-party certification, legal advice, or contractual commitment unless separately agreed in writing.'

export const TRUST_CENTER_PRODUCT_NAME = 'VenueRise'

/**
 * Default + max access grant expiry. Bearer tokens are
 * intentionally short-lived; the operator can re-grant on
 * request.
 */
export const DEFAULT_GRANT_EXPIRY_DAYS = 14
export const MAX_GRANT_EXPIRY_DAYS = 90

/**
 * Public-safe section ids. Any section the public summary
 * emits is whitelisted here so an accidental addition fails
 * code review.
 */
export const PUBLIC_SECTION_IDS: ReadonlyArray<string> = [
  'security-overview',
  'access-control',
  'data-protection',
  'subprocessors',
  'privacy-dsr',
  'backup-dr',
  'incident-response',
  'sso-readiness',
  'certification-posture',
]

/**
 * Per-artifact visibility default. The artifact builder
 * cross-checks this map before emitting an artifact at a given
 * scope; an artifact whose visibility is `internal_only` is
 * never emitted regardless of scope.
 */
export const ARTIFACT_VISIBILITY: Record<
  TrustArtifactType,
  TrustArtifactVisibility
> = {
  security_overview: 'public',
  subprocessor_disclosure: 'public',
  privacy_readiness: 'gated',
  questionnaire_response: 'gated',
  buyer_security_summary: 'gated',
  evidence_report: 'gated',
  vendor_risk_report: 'gated',
  incident_response_summary: 'gated',
  disaster_recovery_summary: 'gated',
  soc2_evidence_map: 'gated',
  custom: 'internal_only',
}

/**
 * Scope inclusion matrix. The artifact builder uses this to
 * decide which artifacts each scope can emit.
 *
 * Honesty:
 *   - `summary_only` carries only the buyer-safe public
 *     summary + subprocessor list. Suitable for an initial
 *     procurement contact who hasn't signed an NDA.
 *   - `standard_packet` adds the gated security questionnaire
 *     + privacy readiness + DR summary + incident summary —
 *     the "post-NDA but pre-deep-dive" tier.
 *   - `full_packet` adds the SOC 2 evidence map + vendor risk
 *     report + evidence report — the "active enterprise
 *     security review" tier.
 *   - `custom` is reserved for operator-curated shares; the
 *     artifact builder logs a warning if used today (no
 *     curation UI in 9N).
 */
export const SCOPE_INCLUDES: Record<
  TrustAccessScope,
  ReadonlyArray<TrustArtifactType>
> = {
  summary_only: ['security_overview', 'subprocessor_disclosure'],
  standard_packet: [
    'security_overview',
    'subprocessor_disclosure',
    'buyer_security_summary',
    'questionnaire_response',
    'privacy_readiness',
    'disaster_recovery_summary',
    'incident_response_summary',
  ],
  full_packet: [
    'security_overview',
    'subprocessor_disclosure',
    'buyer_security_summary',
    'questionnaire_response',
    'privacy_readiness',
    'disaster_recovery_summary',
    'incident_response_summary',
    'evidence_report',
    'vendor_risk_report',
    'soc2_evidence_map',
  ],
  custom: [],
}

/**
 * What is NEVER published on the public page or emitted by
 * any artifact renderer at any scope. Enforced by the
 * artifact builder + reviewed in code review.
 */
export const NEVER_PUBLISH_PUBLICLY: ReadonlyArray<string> = [
  'Internal-only vendor rows (stripe-cli, optional alert vendors before promotion).',
  'Environment variable names from any vendor evidence reference.',
  'NPM package names from any vendor evidence reference.',
  'Raw audit_event rows (the public route emits aggregate metadata only).',
  'Raw incident records or post-incident review markdown.',
  'Raw DSR records, subject identities, or legal review notes.',
  'Customer message content, lead PII, or operator personal data.',
  'Webhook URLs, routing keys, or any vendor secret.',
  'Stripe customer or subscription identifiers.',
  'Service-role tokens, signing keys, or any value from process.env.',
  'Vendor evidence PDFs (DPA / SOC 2 reports) unless explicitly approved by legal and uploaded outside this repository.',
]

/**
 * Section copy for the public trust summary. Hand-curated +
 * reviewed before publishing. Each section is checked against
 * the `PUBLIC_SECTION_IDS` whitelist.
 *
 * Edit cadence: every time a Phase 9X ships a new
 * customer-visible control, add or update the relevant
 * paragraph here + update the matching entry in the
 * questionnaire map + docs/SOC2-EVIDENCE-MAP.md customer-
 * facing snippets so all three surfaces stay in lockstep.
 */
export interface PublicSectionCopy {
  id: string
  title: string
  body: string
  bullets: string[]
}

export const PUBLIC_TRUST_HEADLINE =
  'VenueRise is a multi-tenant SaaS for wedding-venue operators with a documented enterprise security posture. The Trust Center summarises the controls a security or procurement reviewer typically asks about.'

export const PUBLIC_TRUST_SECTIONS: ReadonlyArray<PublicSectionCopy> = [
  {
    id: 'security-overview',
    title: 'Product security overview',
    body:
      'VenueRise enforces role-based access control on every authenticated route, audits every sensitive write, and applies per-route rate limiting. Operator workflows are operator-controlled — no autonomous customer-facing messaging.',
    bullets: [
      'Per-route RBAC + tenant isolation with cross-tenant 404 collapse.',
      'Structured audit logging on every sensitive write.',
      'Per-route rate limiting with abuse event recording.',
      'No autonomous customer-facing message sending.',
    ],
  },
  {
    id: 'access-control',
    title: 'Access control',
    body:
      'Owner / admin / sales_manager / coordinator / viewer roles are enforced at the application layer and policed by row-level security at the database. Owner-only mutation gates apply to billing-class actions including SSO connection management, restore intents, and demo mode.',
    bullets: [
      'Documented per-route role matrix.',
      'Cross-tenant access returns 404 to prevent enumeration.',
      'Owner-only gates on billing-class actions.',
    ],
  },
  {
    id: 'data-protection',
    title: 'Data protection',
    body:
      'AES-256 at rest at the storage layer. HTTPS enforced via HSTS in production. No raw IP addresses are stored anywhere in the application database — a salted-SHA-256 fingerprint is used. Audit snapshots are sanitised at write time (password / secret / token / cookie / webhook_payload keys are recursively dropped).',
    bullets: [
      'AES-256 at rest (Supabase).',
      'HSTS-enforced HTTPS in production.',
      'No raw IP storage; salted-SHA-256 fingerprints only.',
      'Sanitised audit snapshots.',
    ],
  },
  {
    id: 'subprocessors',
    title: 'Subprocessors',
    body:
      'Production subprocessors are maintained inside the platform and exported on demand from the admin Trust Center. The buyer-facing disclosure includes vendor name, category, data categories, criticality, and risk tier.',
    bullets: [
      'Production subprocessors: Supabase, Vercel, Stripe, Resend, Anthropic, Inngest, Upstash, Sentry.',
      'Disclosure is reviewed before sharing externally.',
      'Vendor security/legal evidence (DPA / SOC 2 / SCC) tracked outside the repository.',
    ],
  },
  {
    id: 'privacy-dsr',
    title: 'Privacy + data subject requests',
    body:
      'A static data inventory + retention policy map document every category of customer / personal data processed. Operator-controlled DSR workflow tracks access / export / deletion / correction / opt-out requests. Export preview is metadata-only; deletion review is non-destructive — real exports and deletions are performed by the operator under legal review.',
    bullets: [
      'Data inventory + retention policy maintained in code.',
      'Operator-tracked DSR workflow with typed audit actions.',
      'Operator + legal review required for every export / deletion.',
      'VenueRise does not sell customer data and does not train AI models on customer data internally.',
    ],
  },
  {
    id: 'backup-dr',
    title: 'Backup + disaster recovery',
    body:
      'Daily managed backups with point-in-time recovery via Supabase. Recovery Time Objective: 4 hours. Recovery Point Objective: 24 hours. Quarterly disaster-recovery dry runs. Restores are performed through approved Supabase workflows — the product UI NEVER executes a restore.',
    bullets: [
      'Daily backups + PITR.',
      'RTO 4h / RPO 24h targets.',
      'Quarterly dry-runs against a clone project.',
      'No destructive restore from the product UI.',
    ],
  },
  {
    id: 'incident-response',
    title: 'Incident response',
    body:
      'Documented severity matrix (SEV1 — SEV4) with first-response, update cadence, and mitigation targets. First-class incident records + timeline + alert routing helpers (Slack / PagerDuty / Sentry, env-gated). VenueRise does NOT staff a 24/7 on-call rotation and does NOT offer an uptime SLA contract — response targets are best-effort.',
    bullets: [
      'Severity matrix + PIR template documented.',
      'Operator-triggered conservative detectors over security signals.',
      'Env-gated alert routing.',
      'Customer notification requires legal / operator review for every security event.',
    ],
  },
  {
    id: 'sso-readiness',
    title: 'SSO readiness',
    body:
      'SAML / OIDC scaffolding is in place: connection rows + login-event audit feed + vendor adapter interface. Real SAML / OIDC exchange is wired vendor-by-vendor per buyer requirement; today the adapter resolves to a placeholder returning structured "not configured" errors. JIT-provisioned users would default to viewer/coordinator only (DB-enforced).',
    bullets: [
      'SAML + OIDC connection rows + audit feed.',
      'Vendor adapter is a placeholder today.',
      'No SCIM provisioning yet.',
    ],
  },
  {
    id: 'certification-posture',
    title: 'Certification posture',
    body:
      'VenueRise is NOT currently SOC 2 certified. An internal SOC 2-style evidence map cross-references existing controls to Trust Service Criteria. Formal SOC 2 certification requires an auditor engagement and observation period — engagement is on the planned-improvements list.',
    bullets: [
      'NOT SOC 2 certified.',
      'Internal SOC 2-style evidence map maintained.',
      'Vendor SOC 2 / DPA / SCC posture verified per vendor outside this repository.',
    ],
  },
]

export const PUBLIC_KNOWN_LIMITATIONS: ReadonlyArray<string> = [
  'Not SOC 2 certified. Formal certification requires an auditor + observation window.',
  'No 24/7 staffed on-call rotation; incident response targets are best-effort.',
  'No uptime SLA contract.',
  'Real SAML / OIDC adapter not wired; SSO is in readiness mode.',
  'No SCIM provisioning yet.',
  'DSRs are tracked and operator-routed; no anonymous DSR intake page yet.',
  'Vendor (Anthropic) AI training-use posture requires legal verification of the active contract.',
  'No customer-facing self-service deletion UI.',
]

export function validateExpiryDays(days: number | undefined): number {
  const d = days ?? DEFAULT_GRANT_EXPIRY_DAYS
  if (Number.isNaN(d) || d <= 0) return DEFAULT_GRANT_EXPIRY_DAYS
  if (d > MAX_GRANT_EXPIRY_DAYS) return MAX_GRANT_EXPIRY_DAYS
  return Math.floor(d)
}
