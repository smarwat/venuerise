/**
 * Phase 8AX — Safe Autopilot Guardrails.
 *
 * Pure module. No Supabase, no React, no env. The /api/ai/draft
 * route imports `detectDraftRiskFlags` + `computeAutopilotDecision`
 * to classify each variant; the LeadDetailDrawer reads the decision
 * to render the pill + helper; the admin audit route + calibration
 * panel project the same shape so the operator-facing surfaces
 * never disagree with the row data.
 *
 * Important: this phase ships ONLY the safety classifier. It does
 * NOT introduce autonomous sending, autonomous scheduling, or any
 * code path that emits a message without an operator clicking
 * Approve & send. Phase 8AY is the simulation layer that will
 * record "would have sent" decisions; Phase 8AZ+ may eventually
 * graduate the gate to allow autonomous sends — but only after the
 * calibration panel proves the system can be trusted.
 *
 * Keeping the helper pure lets us:
 *   - unit-test every rule independently
 *   - share the same decision logic across the regenerate path,
 *     the audit row detail, and the calibration readiness breakdown
 *   - swap rules later without grepping three route files
 *   - audit the rule changes via a single PR diff
 */

// ---------------------------------------------------------------------------
// Decision shape
// ---------------------------------------------------------------------------

/**
 * Tri-state autopilot decision. Each branch carries an
 * operator-readable label + helper sentence + the reason codes
 * that fired (so the audit/calibration surfaces can summarize
 * "why this row was blocked" without re-running the rules).
 *
 * `confidence` echoes the input's `finalConfidence` so consumers
 * (drawer pill tooltip, CSV export) can render the score alongside
 * the decision without re-threading the input.
 */
export type AutopilotMode = 'eligible' | 'review_required' | 'blocked'

export interface AutopilotDecision {
  mode: AutopilotMode
  label: string
  helper: string
  reasons: string[]
  confidence: number | null
}

/**
 * Reason codes. Stable strings — the audit row detail joins them
 * into a comma-separated list and the calibration panel may chart
 * them later. New codes go at the bottom; never rename.
 */
export type AutopilotReason =
  // Eligible-side
  | 'high_confidence'
  | 'no_risk_flags'
  | 'healthy_context'
  | 'clean_operator_history'
  // Review-side
  | 'medium_confidence'
  | 'edits_before_send'
  | 'high_score_medium_confidence'
  | 'context_needs_more'
  | 'soft_risk_only'
  // Blocked-side
  | 'low_final_confidence'
  | 'low_heuristic_confidence'
  | 'selected_variant_was_low_confidence'
  | 'pricing_risk'
  | 'policy_risk'
  | 'availability_risk'
  | 'context_gap_plus_low_confidence'

// ---------------------------------------------------------------------------
// Risk detection (deterministic keyword scan)
// ---------------------------------------------------------------------------

/**
 * Per-variant risk flags. Used both by the decision helper and by
 * the audit surfaces (so operators can see "pricing risk" even if
 * the decision wasn't blocked outright — e.g. when confidence was
 * high enough to push it to review_required instead).
 */
export interface DraftRiskFlags {
  hasPricingQuestion: boolean
  hasPolicyQuestion: boolean
  hasAvailabilityClaim: boolean
}

/**
 * Lightweight keyword detector. Deliberately deterministic — no
 * model call, no LLM-driven classification. The goal is to catch
 * the OBVIOUS pricing/policy/availability surfaces before
 * autonomy is enabled; the operator review path catches the rest.
 *
 * Word-boundary matches keep false positives down (e.g. "available"
 * inside "unavailable" is fine; "alcohol" inside "alcoholfree" is
 * not a real word so we let it match — we'd rather over-flag than
 * miss a policy reply).
 */
export function detectDraftRiskFlags(draft: string): DraftRiskFlags {
  if (typeof draft !== 'string' || draft.trim().length === 0) {
    return {
      hasPricingQuestion: false,
      hasPolicyQuestion: false,
      hasAvailabilityClaim: false,
    }
  }
  const text = draft.toLowerCase()
  return {
    hasPricingQuestion: PRICING_PATTERNS.some((rx) => rx.test(text)),
    hasPolicyQuestion: POLICY_PATTERNS.some((rx) => rx.test(text)),
    hasAvailabilityClaim: AVAILABILITY_PATTERNS.some((rx) => rx.test(text)),
  }
}

// Use word boundaries (\b) where the term is a single word so
// "price" doesn't fire on "surprise". Multi-word phrases stay as
// raw substrings — they're already specific enough.
const PRICING_PATTERNS: RegExp[] = [
  /\bprice\b/,
  /\bpricing\b/,
  /\bcost\b/,
  /\bcosts\b/,
  /\bpackage\b/,
  /\bpackages\b/,
  /\bdeposit\b/,
  /\bfee\b/,
  /\bfees\b/,
  /\$/,
]

const POLICY_PATTERNS: RegExp[] = [
  /\bcancel(?:lation|s|led|ing)?\b/,
  /\brefund\b/,
  /\balcohol\b/,
  /outside catering/,
  /\binsurance\b/,
  /\bcontract\b/,
]

const AVAILABILITY_PATTERNS: RegExp[] = [
  /\bavailable\b/,
  /we have/,
  /open on/,
  /\bslot\b/,
  /date is free/,
  /is open/,
]

// ---------------------------------------------------------------------------
// Decision rules
// ---------------------------------------------------------------------------

/**
 * Input shape consumed by `computeAutopilotDecision`. Every field
 * is optional except `finalConfidence` — the helper degrades
 * gracefully when we don't yet know operator history (first-time
 * draft, pre-8AW row, etc.) by emitting `review_required` instead
 * of either extreme.
 */
export interface AutopilotInput {
  finalConfidence: number | null
  modelConfidence?: number | null
  heuristicConfidence?: number | null
  selectedVariantWasLowConfidence?: boolean | null
  operatorOutcome?: string | null
  editDistanceBucket?: string | null
  leadStage?: string | null
  leadScore?: number | null
  hasPricingQuestion?: boolean
  hasPolicyQuestion?: boolean
  hasAvailabilityClaim?: boolean
  venueContextSignal?: 'healthy' | 'needs_more_context' | null
}

const ELIGIBLE_LABEL = 'Autopilot eligible'
const REVIEW_LABEL = 'Review required'
const BLOCKED_LABEL = 'Autopilot blocked'

const ELIGIBLE_HELPER =
  'This draft is low-risk, but still requires operator approval.'
const REVIEW_HELPER =
  'Review before sending. The system detected medium confidence or context gaps.'
const BLOCKED_HELPER =
  'Do not auto-send. Operator review is required because this draft may involve pricing, policy, availability, or low confidence.'

/**
 * Decide whether a variant clears the autopilot bar. Three layers:
 *
 *   1. Hard blockers (pricing/policy/availability/very-low
 *      confidence/explicitly-flagged low_confidence selection)
 *      always force `blocked`. These are the categories where
 *      the AI can do reputational damage if it gets a fact wrong.
 *   2. Soft signals (medium confidence, edits-before-send,
 *      high lead score + only-medium confidence, context-needs-
 *      more) downgrade an otherwise-eligible variant to
 *      `review_required`.
 *   3. If none of the above fire and the positive thresholds
 *      pass, return `eligible`.
 *
 * When `finalConfidence` is `null` (very rare — pre-8AV row
 * replayed somehow), default to `review_required`: we don't have
 * the signal to clear it for autopilot, but we shouldn't block it
 * either.
 */
export function computeAutopilotDecision(
  input: AutopilotInput
): AutopilotDecision {
  const reasons: AutopilotReason[] = []
  const finalConf = clampOrNull(input.finalConfidence)
  const heurConf = clampOrNull(input.heuristicConfidence ?? null)

  // ----- Hard blockers ---------------------------------------------------
  if (input.hasPricingQuestion) reasons.push('pricing_risk')
  if (input.hasPolicyQuestion) reasons.push('policy_risk')
  if (input.hasAvailabilityClaim) reasons.push('availability_risk')
  if (input.selectedVariantWasLowConfidence === true) {
    reasons.push('selected_variant_was_low_confidence')
  }
  if (finalConf !== null && finalConf < 65) {
    reasons.push('low_final_confidence')
  }
  if (heurConf !== null && heurConf < 55) {
    reasons.push('low_heuristic_confidence')
  }
  // "Context gap PLUS low-ish confidence" is its own blocker tier:
  // either signal alone is soft, the combination is hard.
  if (
    input.venueContextSignal === 'needs_more_context' &&
    finalConf !== null &&
    finalConf < 80
  ) {
    reasons.push('context_gap_plus_low_confidence')
  }
  if (reasons.length > 0) {
    return buildDecision('blocked', dedupe(reasons), finalConf)
  }

  // ----- Soft signals (force review) -------------------------------------
  const softReasons: AutopilotReason[] = []
  if (finalConf !== null && finalConf >= 65 && finalConf < 85) {
    softReasons.push('medium_confidence')
  }
  if (
    input.editDistanceBucket === 'moderate' ||
    input.editDistanceBucket === 'major'
  ) {
    softReasons.push('edits_before_send')
  }
  if (
    typeof input.leadScore === 'number' &&
    input.leadScore >= 70 &&
    finalConf !== null &&
    finalConf < 85
  ) {
    softReasons.push('high_score_medium_confidence')
  }
  if (input.venueContextSignal === 'needs_more_context') {
    softReasons.push('context_needs_more')
  }
  // `finalConfidence === null` — we don't have the signal. Fall to
  // review rather than block (don't punish missing data) or
  // eligible (don't pretend we have a signal).
  if (finalConf === null) {
    softReasons.push('medium_confidence')
  }
  if (softReasons.length > 0) {
    return buildDecision('review_required', dedupe(softReasons), finalConf)
  }

  // ----- Eligible --------------------------------------------------------
  const positives: AutopilotReason[] = []
  if (finalConf !== null && finalConf >= 85) positives.push('high_confidence')
  if (heurConf === null || heurConf >= 75) positives.push('no_risk_flags')
  if (input.venueContextSignal !== 'needs_more_context') {
    positives.push('healthy_context')
  }
  if (
    input.operatorOutcome !== 'sent_after_edit' &&
    input.editDistanceBucket !== 'moderate' &&
    input.editDistanceBucket !== 'major'
  ) {
    positives.push('clean_operator_history')
  }
  // Defensive: if the positive set is empty (heuristic < 75 +
  // finalConf < 85 — but neither hit a soft tier earlier), bias to
  // review.
  if (positives.length === 0) {
    return buildDecision(
      'review_required',
      ['medium_confidence'],
      finalConf
    )
  }
  return buildDecision('eligible', dedupe(positives), finalConf)
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function buildDecision(
  mode: AutopilotMode,
  reasons: string[],
  confidence: number | null
): AutopilotDecision {
  if (mode === 'eligible') {
    return {
      mode,
      label: ELIGIBLE_LABEL,
      helper: ELIGIBLE_HELPER,
      reasons,
      confidence,
    }
  }
  if (mode === 'review_required') {
    return {
      mode,
      label: REVIEW_LABEL,
      helper: REVIEW_HELPER,
      reasons,
      confidence,
    }
  }
  return {
    mode,
    label: BLOCKED_LABEL,
    helper: BLOCKED_HELPER,
    reasons,
    confidence,
  }
}

function clampOrNull(n: number | null | undefined): number | null {
  if (n === null || n === undefined) return null
  if (!Number.isFinite(n)) return null
  return Math.max(0, Math.min(100, Math.round(n)))
}

function dedupe<T extends string>(arr: ReadonlyArray<T>): T[] {
  const seen = new Set<T>()
  const out: T[] = []
  for (const v of arr) {
    if (!seen.has(v)) {
      seen.add(v)
      out.push(v)
    }
  }
  return out
}
