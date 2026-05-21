import type {
  EvidenceArtifact,
  EvidenceReportSummary,
} from '@/lib/enterprise/evidence/types'

/**
 * Phase 9J — Security questionnaire types.
 *
 * Shape for the auto-generated CAIQ-lite / SIG-lite / VSAQ-lite
 * response a security reviewer pastes into their workflow. The
 * answers themselves are derived from the Phase 9I evidence
 * control map; operators MUST review before sending.
 *
 * The "lite" suffix is deliberate: a real CAIQ has 261+
 * questions and is a contractual document. This module produces
 * a SHORT structured response keyed to the canonical question
 * vocabulary so an operator can pre-fill the obvious answers +
 * focus their time on the rest.
 *
 * Read `docs/ENTERPRISE-SALES-READINESS.md` for the operator
 * workflow + "review before sending" checklist.
 */

export type QuestionnaireFormat =
  | 'generic'
  | 'caiq-lite'
  | 'sig-lite'
  | 'vsaq-lite'

/**
 * Per-question answer discriminator. Mirrors the evidence
 * status vocabulary but adds `yes` (full implementation) and
 * `planned` (committed roadmap item, not yet shipped) so the
 * buyer-facing response can carry the right level of nuance.
 */
export type QuestionnaireAnswerStatus =
  | 'yes'
  | 'partial'
  | 'manual'
  | 'planned'
  | 'no'
  | 'not_applicable'

export interface QuestionnaireQuestion {
  /** Stable id — `kebab-case`. Used as the CSV row key. */
  id: string
  /** Verbatim question text in the buyer's vocabulary. */
  text: string
}

export interface QuestionnaireAnswer {
  question: QuestionnaireQuestion
  status: QuestionnaireAnswerStatus
  /**
   * Short paragraph the operator can paste verbatim. Buyer-safe
   * wording: avoids overstating, names limitations, points at
   * the runbook for detail.
   */
  shortAnswer: string
  /**
   * IDs from `EVIDENCE_CONTROLS` (Phase 9I) backing the answer.
   * Operators reviewing the response can follow these back to
   * code paths via the SecurityEvidenceCenter.
   */
  evidenceControlIds: string[]
  /** Repo-relative or URL artifact references. */
  references: EvidenceArtifact[]
  /** Operator-visible caveats. Surfaced in the export. */
  limitations: string[]
}

export interface QuestionnaireSection {
  id: string
  title: string
  /** One-line description shown above the answers. */
  description: string
  answers: QuestionnaireAnswer[]
}

export interface QuestionnaireResponseSummary {
  totalQuestions: number
  yes: number
  partial: number
  manual: number
  planned: number
  no: number
  notApplicable: number
}

export interface QuestionnaireResponse {
  format: QuestionnaireFormat
  generatedAt: string
  /**
   * Identical disclaimer string across every export. The
   * "review before sending" rule is baked into the message.
   */
  disclaimer: string
  summary: QuestionnaireResponseSummary
  sections: QuestionnaireSection[]
  /**
   * Optional embedded evidence-report summary so a reviewer
   * gets both surfaces in one file. NEVER includes secrets;
   * inherits the Phase 9I disclaimer posture.
   */
  evidenceSummary?: EvidenceReportSummary
  /**
   * Non-fatal warnings emitted during assembly. Examples:
   * "Backup posture is `unknown` — questionnaire reflects the
   * unverified state."
   */
  warnings: string[]
}

// ── Buyer-facing security summary ────────────────────────────────────────

export interface BuyerSecuritySummarySection {
  id: string
  title: string
  /** Buyer-safe paragraph. Reviewed before sending. */
  body: string
  /** Optional bullet list of supporting points. */
  bullets?: string[]
}

export interface BuyerSecuritySummary {
  generatedAt: string
  /** One-paragraph product security overview. */
  overview: string
  /** Disclaimer — never claims certification. */
  disclaimer: string
  sections: BuyerSecuritySummarySection[]
  /** Honest, operator-visible limitations. */
  knownLimitations: string[]
  /** Safe roadmap statements. */
  plannedImprovements: string[]
}

// ── Enterprise readiness checklist ───────────────────────────────────────

export type ReadinessItemStatus = 'ready' | 'partial' | 'missing'

export interface ReadinessChecklistItem {
  id: string
  title: string
  status: ReadinessItemStatus
  /** Short rationale displayed under the title. */
  detail: string
}

export interface ReadinessChecklist {
  generatedAt: string
  items: ReadinessChecklistItem[]
  summary: {
    total: number
    ready: number
    partial: number
    missing: number
  }
}
