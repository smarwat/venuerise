/**
 * Phase 9I — SOC 2 / enterprise evidence packaging.
 *
 * Types for the evidence report. The goal is NOT to claim SOC 2
 * certification. The goal is to package existing controls into a
 * shape an auditor can review + a buyer can read.
 *
 * Read `docs/SOC2-EVIDENCE-MAP.md` for the certification
 * disclaimer + what formal SOC 2 actually requires.
 */

/**
 * Per-control implementation status. Honesty matters here — the
 * `implemented` status should only be used for code paths that
 * actively enforce the control. Docs-only or human-process
 * controls get `manual`. Partial automation gets `partial`.
 * Env-dependent live checks get `unknown` when the env isn't
 * configured.
 */
export type EvidenceControlStatus =
  | 'implemented'
  | 'partial'
  | 'manual'
  | 'unknown'
  | 'not_applicable'

/**
 * Internal taxonomy. Cross-walks to SOC 2 Trust Service Criteria
 * via `soc2Categories` on each control row, but stays separate
 * because some controls don't fit cleanly into TSC vocabulary
 * (e.g. `vendor_management` straddles security + availability).
 */
export type EvidenceControlCategory =
  | 'access_control'
  | 'audit_logging'
  | 'change_management'
  | 'availability'
  | 'confidentiality'
  | 'incident_response'
  | 'monitoring'
  | 'vendor_management'
  | 'data_lifecycle'
  | 'security_operations'

/**
 * SOC 2 Trust Service Criteria. The product can map to multiple
 * (most security controls touch both `security` and
 * `confidentiality`). A formal audit scopes which criteria are
 * in scope; this enumeration just lets us tag controls.
 */
export type Soc2TrustServiceCategory =
  | 'security'
  | 'availability'
  | 'confidentiality'
  | 'processing_integrity'
  | 'privacy'

/**
 * Pointer to the artifact that demonstrates a control is
 * implemented. Operators clicking through the evidence report
 * should be able to follow these references to source code,
 * docs, or scanner output.
 */
export interface EvidenceArtifact {
  kind: 'file' | 'route' | 'script' | 'doc' | 'health_flag' | 'audit_action'
  /** Repo-relative path or identifier. */
  reference: string
  /** Short operator-readable label. */
  label?: string
}

export interface EvidenceControl {
  /** Stable id — `kebab-case`. Used as the report row key. */
  id: string
  title: string
  category: EvidenceControlCategory
  soc2Categories: Soc2TrustServiceCategory[]
  status: EvidenceControlStatus
  /** One-paragraph operator-readable description. */
  description: string
  /** Where to look in the codebase / docs. */
  artifacts: EvidenceArtifact[]
  /** Known caveats. Empty array when none. */
  limitations: string[]
  /** What we'd add to strengthen this control. Empty when N/A. */
  recommendedNext: string[]
}

/**
 * Counts roll-up shown at the top of the evidence center + on
 * the export header. Honest by construction: every control lands
 * in exactly one bucket.
 */
export interface EvidenceReportSummary {
  total: number
  implemented: number
  partial: number
  manual: number
  unknown: number
  notApplicable: number
}

export interface EvidenceReport {
  /** ISO timestamp the report was generated. */
  generatedAt: string
  /**
   * Fixed disclaimer string. Identical across every export so
   * downstream consumers can grep for it. The auditor-facing
   * version is in docs/SOC2-EVIDENCE-MAP.md.
   */
  disclaimer: string
  summary: EvidenceReportSummary
  controls: EvidenceControl[]
  /**
   * Optional snapshot of the Phase 9H backup posture (RTO/RPO/
   * status). Surfaced when the helper resolved; omitted when it
   * threw (the helper itself never throws — this is paranoia).
   */
  backupPosture?: {
    status: string
    rtoHours: number
    rpoHours: number
    retentionDays: number
    dryRunCadence: string
    lastCheckedAt: string
  }
  /**
   * Non-fatal warnings emitted during report assembly. Operators
   * see these in the card; auditors see them in the markdown.
   * Examples: "backup posture helper degraded to unknown",
   * "health flag snapshot unavailable in this runtime context."
   */
  warnings: string[]
}
