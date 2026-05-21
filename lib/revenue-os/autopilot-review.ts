/**
 * Phase 8AZ — Autopilot Shadow Evaluation helpers.
 *
 * Pure module. No Supabase, no React, no env. The two admin
 * routes at /api/admin/ai/autopilot-reviews{,/[aiActionId]}, the
 * extended /api/admin/ai/autopilot-simulation summary, and the
 * AutopilotReviewQueue UI all pull their state-machine
 * vocabulary + rule-signal math from this file.
 *
 * Safety posture (repeated everywhere on purpose):
 *   - Review labels are a CALIBRATION signal, not a control. A
 *     row labeled `confirmed_guardrail_too_strict` does NOT
 *     weaken any guardrail rule automatically.
 *   - A row labeled `confirmed_operator_error` does NOT block
 *     the operator from sending similar drafts in the future.
 *   - Phase 8AZ ships zero autonomous sending. The
 *     `autonomous_sending_still_disabled` health flag (carried
 *     from 8AX) is the explicit assertion that this hasn't
 *     regressed.
 *
 * Keeping the helper pure lets us:
 *   - unit-test the state transitions independently
 *   - share the rule-signal math between the simulation panel +
 *     the review queue + the review summary block
 *   - rename a review state literal in exactly one place if it
 *     ever needs to change (a future autonomy phase may add a
 *     `confirmed_safe_for_autopilot` state, for example)
 */

// ---------------------------------------------------------------------------
// Review state vocabulary
// ---------------------------------------------------------------------------

/**
 * Five-state machine. `needs_review` is the implicit initial
 * state for any disagreement that hasn't been labeled yet — we
 * store it explicitly when the operator clicks anything, but
 * it's also the "default" rows fall into when there's no row in
 * `ai_action_reviews` for them.
 *
 *   - `needs_review`                       — pending operator
 *                                            verdict.
 *   - `confirmed_guardrail_too_strict`     — operator was right;
 *                                            the autopilot rule
 *                                            should have let
 *                                            this through.
 *   - `confirmed_guardrail_correct`        — autopilot was right
 *                                            to block / review;
 *                                            the operator's
 *                                            send was the
 *                                            mistake (or the
 *                                            edit was real
 *                                            extra work).
 *   - `confirmed_operator_error`           — operator overrode a
 *                                            guardrail block in
 *                                            a way that should
 *                                            be coached, not
 *                                            replicated.
 *   - `deferred`                           — operator explicitly
 *                                            parked the row for
 *                                            later; counts
 *                                            separately from
 *                                            `needs_review`.
 */
export type AutopilotReviewState =
  | 'needs_review'
  | 'confirmed_guardrail_too_strict'
  | 'confirmed_guardrail_correct'
  | 'confirmed_operator_error'
  | 'deferred'

/**
 * Allowed write-states. `needs_review` is implicit (no row =
 * needs review); the POST route refuses it explicitly so we
 * don't conflate "I forgot to label this" with "I actively
 * marked this as needing review."
 */
export type WritableAutopilotReviewState = Exclude<
  AutopilotReviewState,
  'needs_review'
>

const REVIEWED_STATES: ReadonlySet<AutopilotReviewState> = new Set<
  AutopilotReviewState
>([
  'confirmed_guardrail_too_strict',
  'confirmed_guardrail_correct',
  'confirmed_operator_error',
  'deferred',
])

/**
 * "Reviewed" = anything except `needs_review`. `deferred` counts
 * as reviewed because the operator has SEEN the row and made an
 * explicit decision (even if that decision is "later"). This
 * matches how `reviewed_disagreements_pct` is read by the
 * simulation panel — it answers "how much of the disagreement
 * volume has the operator looked at," not "how much have they
 * decided about."
 */
export function isReviewedState(state: AutopilotReviewState | null): boolean {
  if (state === null) return false
  return REVIEWED_STATES.has(state)
}

// ---------------------------------------------------------------------------
// Disagreement detection
// ---------------------------------------------------------------------------

/**
 * The review queue only renders disagreements — rows where the
 * 8AY simulation classified the operator as either more or less
 * conservative than autopilot. Aligned + unknown rows are
 * filtered out before they ever hit the queue. We expose a
 * tiny helper so the route + the UI agree on what "disagreement"
 * means without re-stringifying.
 */
export function isDisagreement(input: {
  operatorAlignment: string | null
}): boolean {
  return (
    input.operatorAlignment === 'operator_more_conservative' ||
    input.operatorAlignment === 'operator_less_conservative'
  )
}

/**
 * Default state for a freshly-surfaced disagreement: always
 * `needs_review`. Exposed as its own helper so a future phase
 * (e.g. "auto-defer rows older than 30 days") can change the
 * default in one place without rewiring callers.
 */
export function recommendedInitialReviewState(input: {
  operatorAlignment: string | null
}): AutopilotReviewState {
  // Currently uniform — `input` is unused beyond the type
  // gate, but we accept it so callers can pass the row shape
  // they already have. Suppress the unused warning explicitly.
  void input
  return 'needs_review'
}

// ---------------------------------------------------------------------------
// Reviewed-percentage helper
// ---------------------------------------------------------------------------

/**
 * Returns 0–1 ratio, or `null` when there's nothing to divide.
 * Used in the simulation summary so a future autonomy gate can
 * require, e.g., "≥ 80% of disagreements reviewed before this
 * venue is even eligible to OPT IN to autopilot consideration."
 */
export function computeReviewedDisagreementsPct(input: {
  totalDisagreements: number
  reviewedDisagreements: number
}): number | null {
  if (!Number.isFinite(input.totalDisagreements)) return null
  if (input.totalDisagreements <= 0) return null
  const reviewed = Math.max(
    0,
    Math.min(input.totalDisagreements, input.reviewedDisagreements)
  )
  return reviewed / input.totalDisagreements
}

// ---------------------------------------------------------------------------
// Per-rule signals
// ---------------------------------------------------------------------------

/**
 * One signal per risk rule (`pricing`, `policy`, `availability`,
 * plus anything new the 8AX detector adds later). `total`
 * counts every disagreement row that fired this rule;
 * `reviewed` is the subset that has a non-`needs_review` label.
 * `falsePositiveRate` answers "of the reviewed rows on this
 * rule, what fraction did the operator say the guardrail
 * was wrong about." Null when nothing reviewed yet.
 */
export interface AutopilotRuleSignal {
  rule: string
  total: number
  reviewed: number
  confirmedTooStrict: number
  confirmedCorrect: number
  confirmedOperatorError: number
  deferred: number
  falsePositiveRate: number | null
}

export interface RuleSignalRowInput {
  riskFlags: string[]
  reviewState: AutopilotReviewState | null
}

/**
 * Aggregate per-rule counts + false-positive rates over a row
 * window (usually the simulation endpoint's 30-day window). A
 * row contributes to EVERY rule listed in its `riskFlags`
 * array — so a draft that fired both `pricing` and `policy`
 * counts once in each rule's totals. That's the operator-
 * useful framing: "of all the rows where `pricing_risk` fired
 * AND I labeled them, how often was the rule wrong."
 *
 * Output is sorted by `total` descending so the UI can take the
 * top N rules without resorting. Ties broken by alphabetical
 * rule name for stable rendering.
 *
 * Rows whose `reviewState` is null OR `needs_review` only
 * contribute to `total` — they don't move any of the other
 * counters. That keeps false-positive rates honest: we never
 * count a not-yet-labeled row as evidence of either side.
 */
export function computeRuleSignals(
  rows: ReadonlyArray<RuleSignalRowInput>
): AutopilotRuleSignal[] {
  const byRule = new Map<string, AutopilotRuleSignal>()
  for (const r of rows) {
    if (!Array.isArray(r.riskFlags)) continue
    for (const rule of r.riskFlags) {
      if (typeof rule !== 'string' || rule.length === 0) continue
      let sig = byRule.get(rule)
      if (!sig) {
        sig = {
          rule,
          total: 0,
          reviewed: 0,
          confirmedTooStrict: 0,
          confirmedCorrect: 0,
          confirmedOperatorError: 0,
          deferred: 0,
          falsePositiveRate: null,
        }
        byRule.set(rule, sig)
      }
      sig.total += 1
      if (!isReviewedState(r.reviewState)) continue
      sig.reviewed += 1
      if (r.reviewState === 'confirmed_guardrail_too_strict') {
        sig.confirmedTooStrict += 1
      } else if (r.reviewState === 'confirmed_guardrail_correct') {
        sig.confirmedCorrect += 1
      } else if (r.reviewState === 'confirmed_operator_error') {
        sig.confirmedOperatorError += 1
      } else if (r.reviewState === 'deferred') {
        sig.deferred += 1
      }
    }
  }
  // Compute the FP rate now that totals are stable. Ratio is over
  // `reviewed` (not `total`) so a rule with 100 disagreements and
  // only 2 labeled doesn't look artificially safe.
  for (const sig of byRule.values()) {
    sig.falsePositiveRate =
      sig.reviewed === 0 ? null : sig.confirmedTooStrict / sig.reviewed
  }
  return Array.from(byRule.values()).sort((a, b) => {
    if (b.total !== a.total) return b.total - a.total
    return a.rule.localeCompare(b.rule)
  })
}
