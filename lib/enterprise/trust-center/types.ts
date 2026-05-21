/**
 * Phase 9N — Trust Center types.
 *
 * Shape for the operator-managed buyer-facing trust surface:
 * a public page with safe security/privacy posture, gated
 * access grants for prospects who need deeper evidence, and an
 * access event log so the operator knows which prospects
 * pulled which artifacts.
 *
 * Honesty rules carried throughout:
 *   - The Trust Center is NOT a SOC 2 certification. The
 *     public summary + every gated packet carries the same
 *     disclaimer string so downstream consumers can grep for
 *     it.
 *   - Gated tokens are BEARER credentials. Anyone with the URL
 *     can access the packet until expiry or revocation. The
 *     admin card warns the operator before they share.
 *   - Public surface ONLY emits content whose source is marked
 *     `disclosureStatus === 'public'` (vendor registry) or
 *     equivalent. Internal-only env names, package names,
 *     audit internals, raw incident records, raw DSR records,
 *     and customer data are NEVER published publicly.
 *   - No PDF renderer is shipped in 9N; markdown / CSV / JSON
 *     are the supported formats. `pdf_placeholder` exists in
 *     the format union so a future phase can wire it.
 */

export type TrustArtifactType =
  | 'security_overview'
  | 'subprocessor_disclosure'
  | 'privacy_readiness'
  | 'questionnaire_response'
  | 'buyer_security_summary'
  | 'evidence_report'
  | 'vendor_risk_report'
  | 'incident_response_summary'
  | 'disaster_recovery_summary'
  | 'soc2_evidence_map'
  | 'custom'

export const TRUST_ARTIFACT_TYPES: ReadonlyArray<TrustArtifactType> = [
  'security_overview',
  'subprocessor_disclosure',
  'privacy_readiness',
  'questionnaire_response',
  'buyer_security_summary',
  'evidence_report',
  'vendor_risk_report',
  'incident_response_summary',
  'disaster_recovery_summary',
  'soc2_evidence_map',
  'custom',
]

export type TrustArtifactVisibility = 'public' | 'gated' | 'internal_only'

export type TrustAccessStatus = 'active' | 'expired' | 'revoked'

export type TrustAccessScope =
  | 'summary_only'
  | 'standard_packet'
  | 'full_packet'
  | 'custom'

export const TRUST_ACCESS_SCOPES: ReadonlyArray<TrustAccessScope> = [
  'summary_only',
  'standard_packet',
  'full_packet',
  'custom',
]

export type TrustArtifactFormat = 'json' | 'markdown' | 'csv' | 'pdf_placeholder'

export const TRUST_ARTIFACT_FORMATS: ReadonlyArray<TrustArtifactFormat> = [
  'json',
  'markdown',
  'csv',
  'pdf_placeholder',
]

// ── Public summary ────────────────────────────────────────────────────────

export interface TrustCenterPublicSection {
  id: string
  title: string
  /** Buyer-safe paragraph. Reviewed before publishing. */
  body: string
  bullets?: string[]
}

export interface TrustCenterPublicSummary {
  generatedAt: string
  /** Identical disclaimer carried in every render. */
  disclaimer: string
  /** One-line product-security headline. */
  headline: string
  /** Subprocessor name list (buyer-safe). */
  publicSubprocessorNames: string[]
  sections: TrustCenterPublicSection[]
  /** Explicit, honest known limitations. */
  knownLimitations: string[]
}

// ── Artifact manifest ────────────────────────────────────────────────────

export interface TrustArtifactManifestItem {
  type: TrustArtifactType
  title: string
  description: string
  visibility: TrustArtifactVisibility
  formats: TrustArtifactFormat[]
  /** True when the artifact is included in the current scope. */
  includedInScope: boolean
  /** Operator-readable note about why it is or isn't included. */
  scopeNote: string
}

// ── Packet ────────────────────────────────────────────────────────────────

export interface TrustPacketSummary {
  generatedAt: string
  disclaimer: string
  scope: TrustAccessScope
  artifacts: TrustArtifactManifestItem[]
  /** Counts roll-up for the admin card / pack header. */
  counts: {
    total: number
    included: number
    publicOnly: number
    gatedOnly: number
  }
  warnings: string[]
}

// ── Access grant ─────────────────────────────────────────────────────────

export interface TrustAccessGrant {
  id: string
  venueId: string | null
  buyerName: string | null
  buyerEmail: string | null
  buyerCompany: string | null
  scope: TrustAccessScope
  status: TrustAccessStatus
  /** Hash only — raw token is returned ONCE at creation. */
  tokenHash: string
  expiresAt: string
  createdBy: string | null
  revokedBy: string | null
  revokedAt: string | null
  lastAccessedAt: string | null
  accessCount: number
  metadata: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

export interface TrustAccessGrantCreateInput {
  venueId: string
  buyerName?: string | null
  buyerEmail?: string | null
  buyerCompany?: string | null
  scope?: TrustAccessScope
  expiresInDays?: number
  metadata?: Record<string, unknown> | null
  createdBy: string | null
}

export interface TrustAccessGrantUpdateInput {
  grantId: string
  /** True triggers revocation. */
  revoke?: boolean
  buyerName?: string | null
  buyerEmail?: string | null
  buyerCompany?: string | null
  metadata?: Record<string, unknown> | null
  actorUserId: string | null
}

export type TrustAccessEventType =
  | 'grant_created'
  | 'grant_revoked'
  | 'grant_accessed'
  | 'artifact_downloaded'
  | 'grant_expired'
  | 'access_denied'

export interface TrustAccessEvent {
  id: string
  grantId: string | null
  venueId: string | null
  eventType: TrustAccessEventType
  artifactType: TrustArtifactType | null
  format: TrustArtifactFormat | null
  ipHash: string | null
  userAgentHash: string | null
  metadata: Record<string, unknown>
  createdAt: string
}

// ── Counts ────────────────────────────────────────────────────────────────

export interface TrustAccessGrantCounts {
  total: number
  active: number
  expired: number
  revoked: number
  accessedLast30d: number
}

// ── Settings (operator-facing) ───────────────────────────────────────────

export interface TrustCenterSettings {
  /** Publicly visible product name. Pulled from env or constant. */
  productName: string
  /** Public dashboard URL prefix used to build gated access URLs. */
  appUrl: string | null
  /** Operator-curated contact CTA on the public page. */
  contactPlaceholder: string
}

// ── Token validation result ──────────────────────────────────────────────

export type TrustAccessValidationReason =
  | 'invalid'
  | 'expired'
  | 'revoked'
  | 'unknown'
  | 'ok'

export interface TrustAccessValidation {
  ok: boolean
  reason: TrustAccessValidationReason
  grant: TrustAccessGrant | null
}
