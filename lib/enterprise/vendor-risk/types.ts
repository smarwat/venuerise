/**
 * Phase 9K — Vendor risk + subprocessor disclosure types.
 *
 * Shape for the static vendor registry, the admin-facing vendor
 * risk report, and the buyer-facing subprocessor disclosure.
 *
 * Honesty rules (read `docs/VENDOR-RISK.md` for the full
 * explanation):
 *   - DPA / SCC / SOC 2 status defaults to
 *     `manual_review_required` unless the repo carries hard
 *     evidence. We never claim "compliant".
 *   - Every record carries a `reviewOwner` + `reviewCadence` so
 *     stale entries are visible.
 *   - The buyer-facing disclosure ONLY emits vendors whose
 *     `disclosureStatus === 'public'`. Internal-only and
 *     admin-only vendors stay inside the admin report.
 *   - The disclaimer string is identical across every export so
 *     downstream consumers can grep for it.
 */

export type VendorCriticality =
  | 'critical'
  | 'important'
  | 'optional'
  | 'development_only'

/**
 * Where a vendor record may appear.
 *  - `public`        — safe to expose on /security/subprocessors
 *  - `admin_only`    — surfaced in the admin VendorRiskCard but
 *                      not in the buyer disclosure
 *  - `internal_only` — operator/dev tooling; never leaves the
 *                      admin surface
 */
export type VendorDisclosureStatus =
  | 'public'
  | 'admin_only'
  | 'internal_only'

/**
 * Assurance status — the strongest claim we can make today
 * without legal review. Default to `manual_review_required` for
 * every contractual posture (DPA / SCC / SOC 2 / ISO).
 */
export type VendorAssuranceStatus =
  | 'verified'
  | 'manual_review_required'
  | 'unknown'
  | 'not_applicable'

/**
 * Coarse data categories. Buyer reviewers want a quick read on
 * "does this vendor see customer message content vs just an
 * IP fingerprint." Not a legal taxonomy — operational only.
 */
export type VendorDataCategory =
  | 'account_data'
  | 'lead_data'
  | 'message_content'
  | 'billing_data'
  | 'authentication_data'
  | 'audit_metadata'
  | 'usage_metadata'
  | 'support_metadata'
  | 'infrastructure_logs'
  | 'calendar_metadata'
  | 'email_metadata'
  | 'none'

export type VendorRiskTier = 'low' | 'medium' | 'high' | 'unknown'

/**
 * Reference to a piece of evidence in the codebase. Mirrors the
 * Phase 9I EvidenceArtifact shape so reviewers can follow
 * familiar conventions.
 *
 * IMPORTANT: `env` references hold the variable NAME only, never
 * the value. The registry render path strips anything that looks
 * like a value before producing markdown / CSV.
 */
export interface VendorEvidenceReference {
  kind: 'doc' | 'env' | 'package' | 'file' | 'route' | 'note'
  /** Repo-relative path, env var name, or buyer-safe note. */
  reference: string
  /** Optional short label for operator readability. */
  label?: string
}

export interface VendorRecord {
  /** Stable id — `kebab-case`. Used as the CSV row key. */
  id: string
  /** Public-facing vendor name (e.g. "Supabase"). */
  name: string
  /** Short category label (e.g. "Database + auth"). */
  category: string
  /** Buyer-safe description of why we use this vendor. */
  purpose: string
  criticality: VendorCriticality
  disclosureStatus: VendorDisclosureStatus
  /** Coarse buckets — see VendorDataCategory comment. */
  dataCategories: VendorDataCategory[]
  /**
   * True when the vendor is part of the production runtime.
   * Dev-only tools (e.g. a local Stripe CLI) set this to false.
   */
  productionUse: boolean
  /**
   * Buyer-safe description suitable for a public subprocessor
   * page. May be identical to `purpose` for low-risk vendors;
   * shorter / more cautious for vendors that touch message
   * content.
   */
  buyerSafeDescription: string
  riskTier: VendorRiskTier
  assuranceStatus: VendorAssuranceStatus
  evidence: VendorEvidenceReference[]
  /** Operator-visible caveats. Empty when none. */
  knownLimitations: string[]
  /** Who owns the next assurance review. */
  reviewOwner: string
  /** Plain-language cadence (e.g. "annually", "on renewal"). */
  reviewCadence: string
  /**
   * ISO date of the last operator review, or null when never
   * reviewed. Surfaced in the admin card so stale entries are
   * obvious.
   */
  lastReviewedAt: string | null
}

// ── Roll-up shapes ───────────────────────────────────────────────────────

export interface VendorRiskCounts {
  total: number
  production: number
  critical: number
  manualReviewRequired: number
  unknownAssurance: number
  publicDisclosable: number
}

export interface VendorRiskSummary {
  /** ISO timestamp the report was generated. */
  generatedAt: string
  /** Fixed disclaimer — never claims legal/contractual posture. */
  disclaimer: string
  counts: VendorRiskCounts
  vendors: VendorRecord[]
  /** Non-fatal warnings emitted during assembly. */
  warnings: string[]
}

/**
 * Buyer-safe shape. Only includes vendors whose disclosure
 * status is `public`. NEVER includes evidence env/package
 * references; only the buyer-safe description + category.
 */
export interface SubprocessorDisclosureRecord {
  id: string
  name: string
  category: string
  /** Identical to the registry `buyerSafeDescription`. */
  description: string
  dataCategories: VendorDataCategory[]
  criticality: VendorCriticality
  riskTier: VendorRiskTier
}

export interface SubprocessorDisclosure {
  generatedAt: string
  /** Disclaimer suitable for a public-facing page. */
  disclaimer: string
  /** Filtered to disclosureStatus === 'public'. */
  records: SubprocessorDisclosureRecord[]
  counts: {
    total: number
    productionDisclosed: number
  }
}
