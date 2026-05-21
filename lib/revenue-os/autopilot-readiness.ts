/**
 * Phase 8BA — Per-Venue Autopilot Readiness Gate.
 *
 * Pure module. No Supabase, no React, no env. The admin
 * `/api/admin/ai/autopilot-readiness` route + the
 * AutopilotReadinessScorecard UI both consume
 * `computeAutopilotReadiness` so the verdict + gate list
 * displayed to the operator is byte-for-byte the verdict the
 * route returned.
 *
 * Safety posture (this is the file the rest of the read-only
 * safety stack converges on; the warnings below are the
 * contract):
 *
 *   - This helper produces a READINESS signal, not a control.
 *     Returning `eligible: true` does NOT enable autopilot.
 *     There is no autonomy toggle anywhere in the codebase.
 *   - The 8AX `autonomous_sending_still_disabled` health flag
 *     remains `mounted` after 8BA. Verify with
 *     `curl /api/health | jq '.checks.autonomous_sending_still_disabled'`.
 *   - A future opt-in autonomy phase must still add: explicit
 *     per-venue toggle, rollback, kill switch, monitoring, and
 *     customer-visible settings. None of those exist today.
 *
 * Why pure:
 *   - the gate thresholds are constants (below); changing them
 *     is a single PR diff against this file
 *   - the helper is trivially unit-testable for every gate
 *   - the route + the UI cannot disagree about the verdict
 *     because both call the same function with the same inputs
 */

// ---------------------------------------------------------------------------
// Gate thresholds — surface here so the docs + tests + UI agree
// ---------------------------------------------------------------------------

/**
 * Tunable thresholds. Keep these conservative; tightening is
 * safe, loosening should require a docs change + a phase prompt.
 *
 * Operational notes:
 *   - `MIN_SCORED_ROWS = 50` — below this a venue's simulation
 *     summary is too noisy to read meaningfully. The 8AY panel
 *     already gates `promising` readiness on ≥ 20 scored rows;
 *     we want at least 2.5x that before considering eligibility.
 *   - `MIN_REVIEWED_DISAGREEMENTS_PCT = 0.8` — operators have to
 *     have actually engaged with the queue. Without labels the
 *     rule signals are meaningless.
 *   - `MAX_RULE_FALSE_POSITIVE_RATE = 0.25` — no single rule
 *     may be false-firing more than a quarter of the time among
 *     labeled disagreements; otherwise autopilot would be
 *     blocking sends the operator confirmed were fine.
 *   - `MIN_WINDOW_DAYS_WITH_DATA = 14` — at least two operating
 *     weeks; prevents a 3-day burst of activity from passing.
 */
export const MIN_SCORED_ROWS = 50
export const MIN_REVIEWED_DISAGREEMENTS_PCT = 0.8
export const MAX_RULE_FALSE_POSITIVE_RATE = 0.25
export const MIN_WINDOW_DAYS_WITH_DATA = 14

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ReadinessGateKey =
  | 'simulation_readiness_promising'
  | 'min_scored_rows'
  | 'min_reviewed_disagreements_pct'
  | 'max_false_positive_rate_per_rule'
  | 'zero_operator_less_conservative_unreviewed'
  | 'min_window_days_with_data'

export interface ReadinessGate {
  key: ReadinessGateKey
  label: string
  passed: boolean
  /**
   * Whatever value drove the pass/fail decision. Strings for
   * gates that aren't numeric (e.g. simulation readiness =
   * `'promising'`); numbers for the rest. `null` when the
   * input wasn't available.
   */
  currentValue: number | string | null
  /** Operator-readable threshold ("≥ 50", "≥ 80%", etc.). */
  threshold: number | string
  /**
   * `blocking` gates flip the verdict to `not_eligible` when
   * they fail. `warning` gates can fail (in limited number)
   * and still leave the verdict at `watch` rather than
   * `not_eligible`. See `computeReadinessVerdict` for the
   * exact rule.
   */
  severity: 'blocking' | 'warning'
  /**
   * What the operator should do next to move this gate to
   * passing. `null` when the gate already passes — the UI
   * hides the next-step line in that case.
   */
  nextStep: string | null
}

export type AutonomyReadinessVerdict = 'not_eligible' | 'watch' | 'eligible'

export interface AutonomyReadiness {
  verdict: AutonomyReadinessVerdict
  /** True iff `verdict === 'eligible'`. Convenience for callers. */
  eligible: boolean
  /**
   * Short bullet sentences explaining the verdict. For
   * `not_eligible` and `watch` these are gate-derived;
   * `eligible` carries the boilerplate "all gates passing,
   * autonomy still disabled" line.
   */
  reasons: string[]
  /**
   * Caveats present on every `eligible` verdict — the
   * permanent "this does not enable autonomous sending"
   * disclaimer plus anything else we want to surface (sample
   * size warnings, etc.). Empty for non-eligible verdicts
   * (their full story is in `reasons`).
   */
  caveats: string[]
  gates: ReadinessGate[]
}

// ---------------------------------------------------------------------------
// Input shape
// ---------------------------------------------------------------------------

/**
 * Minimal input set the helper consumes. The admin endpoint
 * projects 8AY simulation output + 8AZ review output into this
 * shape; tests can supply fixtures directly.
 *
 * `ruleSignals` mirrors the shape produced by
 * `computeRuleSignals` from `autopilot-review.ts`, but we
 * don't import that type to keep this file dependency-free.
 */
export interface AutopilotReadinessInput {
  simulationReadiness: 'not_ready' | 'watch' | 'promising'
  totalScored: number
  reviewedDisagreementsPct: number | null
  ruleSignals: ReadonlyArray<{
    rule: string
    reviewed: number
    falsePositiveRate: number | null
  }>
  operatorLessConservativeUnreviewed: number
  windowDaysWithData: number
}

// ---------------------------------------------------------------------------
// Compute
// ---------------------------------------------------------------------------

/**
 * Evaluate every gate independently, then collapse to a verdict.
 *
 * Verdict rule:
 *   - `eligible`  — every gate passes.
 *   - `watch`     — every BLOCKING gate passes; at most ONE
 *                   warning gate fails. Lets a venue with one
 *                   soft miss still see a "you're almost there"
 *                   signal without flipping to "not eligible."
 *   - otherwise   — `not_eligible`.
 *
 * Severity assignments:
 *   - `simulation_readiness_promising`                     — blocking
 *   - `min_scored_rows`                                    — blocking
 *   - `zero_operator_less_conservative_unreviewed`         — blocking
 *     (the "dangerous direction" mismatches MUST be labeled
 *     before autonomy is considered)
 *   - `min_reviewed_disagreements_pct`                     — blocking
 *   - `max_false_positive_rate_per_rule`                   — warning
 *     (a single rule running hot is concerning, not yet
 *     disqualifying — the operator can investigate)
 *   - `min_window_days_with_data`                          — warning
 *     (sample-distribution check; a venue with concentrated
 *     activity can still be reasonably classified)
 */
export function computeAutopilotReadiness(
  input: AutopilotReadinessInput
): AutonomyReadiness {
  const gates: ReadinessGate[] = []

  // ----- simulation_readiness_promising (blocking) ---------------------
  {
    const passed = input.simulationReadiness === 'promising'
    gates.push({
      key: 'simulation_readiness_promising',
      label: 'Simulation readiness is promising',
      passed,
      currentValue: input.simulationReadiness,
      threshold: 'promising',
      severity: 'blocking',
      nextStep: passed
        ? null
        : "Keep approving + regenerating drafts. Simulation readiness will lift to 'promising' once the underlying ratios meet the 8AY thresholds.",
    })
  }

  // ----- min_scored_rows (blocking) ------------------------------------
  {
    const passed = input.totalScored >= MIN_SCORED_ROWS
    const deficit = Math.max(0, MIN_SCORED_ROWS - input.totalScored)
    gates.push({
      key: 'min_scored_rows',
      label: 'Enough scored drafts',
      passed,
      currentValue: input.totalScored,
      threshold: `≥ ${MIN_SCORED_ROWS}`,
      severity: 'blocking',
      nextStep: passed
        ? null
        : `Collect ${deficit} more scored draft${deficit === 1 ? '' : 's'}.`,
    })
  }

  // ----- min_reviewed_disagreements_pct (blocking) ---------------------
  {
    const value = input.reviewedDisagreementsPct
    const passed =
      value !== null && value >= MIN_REVIEWED_DISAGREEMENTS_PCT
    const thresholdPct = Math.round(MIN_REVIEWED_DISAGREEMENTS_PCT * 100)
    gates.push({
      key: 'min_reviewed_disagreements_pct',
      label: 'Disagreement coverage',
      passed,
      currentValue: value === null ? null : Math.round(value * 100),
      threshold: `≥ ${thresholdPct}%`,
      severity: 'blocking',
      nextStep: passed
        ? null
        : value === null
          ? 'Label disagreements in the review queue.'
          : `Review more disagreements (currently ${Math.round(
              value * 100
            )}% labeled).`,
    })
  }

  // ----- max_false_positive_rate_per_rule (warning) --------------------
  {
    // Only rules with at least one reviewed row can fail this gate —
    // a rule with 0 reviewed rows has a `null` FP rate and we
    // don't penalize it (the disagreement-coverage gate above is
    // what catches "operator hasn't reviewed enough").
    const worstRule = input.ruleSignals.reduce<
      { rule: string; rate: number } | null
    >((acc, r) => {
      if (typeof r.falsePositiveRate !== 'number') return acc
      if (!Number.isFinite(r.falsePositiveRate)) return acc
      if (r.reviewed <= 0) return acc
      if (!acc || r.falsePositiveRate > acc.rate) {
        return { rule: r.rule, rate: r.falsePositiveRate }
      }
      return acc
    }, null)
    const passed =
      worstRule === null || worstRule.rate <= MAX_RULE_FALSE_POSITIVE_RATE
    const thresholdPct = Math.round(MAX_RULE_FALSE_POSITIVE_RATE * 100)
    gates.push({
      key: 'max_false_positive_rate_per_rule',
      label: 'No rule is over-firing',
      passed,
      currentValue:
        worstRule === null
          ? null
          : `${worstRule.rule} · ${Math.round(worstRule.rate * 100)}%`,
      threshold: `≤ ${thresholdPct}% per rule`,
      severity: 'warning',
      nextStep:
        passed || worstRule === null
          ? null
          : `Investigate ${worstRule.rule}_risk. False-positive rate is ${Math.round(
              worstRule.rate * 100
            )}%.`,
    })
  }

  // ----- zero_operator_less_conservative_unreviewed (blocking) ---------
  {
    const count = input.operatorLessConservativeUnreviewed
    const passed = count === 0
    gates.push({
      key: 'zero_operator_less_conservative_unreviewed',
      label: 'Every dangerous mismatch is labeled',
      passed,
      currentValue: count,
      threshold: '= 0',
      severity: 'blocking',
      nextStep: passed
        ? null
        : `Label all operator-less-conservative rows before considering autonomy (${count} remaining).`,
    })
  }

  // ----- min_window_days_with_data (warning) ---------------------------
  {
    const passed = input.windowDaysWithData >= MIN_WINDOW_DAYS_WITH_DATA
    const deficit = Math.max(
      0,
      MIN_WINDOW_DAYS_WITH_DATA - input.windowDaysWithData
    )
    gates.push({
      key: 'min_window_days_with_data',
      label: 'Sample spans enough days',
      passed,
      currentValue: input.windowDaysWithData,
      threshold: `≥ ${MIN_WINDOW_DAYS_WITH_DATA} active days`,
      severity: 'warning',
      nextStep: passed
        ? null
        : `Wait for ${deficit} more active day${deficit === 1 ? '' : 's'} of data.`,
    })
  }

  const verdict = computeReadinessVerdict(gates)
  const reasons = buildReasons(gates, verdict)
  const caveats = buildCaveats(verdict)

  return {
    verdict,
    eligible: verdict === 'eligible',
    reasons,
    caveats,
    gates,
  }
}

function computeReadinessVerdict(
  gates: ReadonlyArray<ReadinessGate>
): AutonomyReadinessVerdict {
  const failingBlocking = gates.filter(
    (g) => !g.passed && g.severity === 'blocking'
  )
  const failingWarning = gates.filter(
    (g) => !g.passed && g.severity === 'warning'
  )
  if (failingBlocking.length === 0 && failingWarning.length === 0) {
    return 'eligible'
  }
  // A single warning miss with all blockers passing → `watch`.
  // Anything else (blocking miss, OR multiple warnings) →
  // `not_eligible`. We deliberately keep `watch` narrow so the
  // verdict's emerald state remains rare and meaningful.
  if (failingBlocking.length === 0 && failingWarning.length <= 1) {
    return 'watch'
  }
  return 'not_eligible'
}

function buildReasons(
  gates: ReadonlyArray<ReadinessGate>,
  verdict: AutonomyReadinessVerdict
): string[] {
  if (verdict === 'eligible') {
    return [
      'All readiness gates currently pass — the venue has enough safety evidence to be considered by a future opt-in autonomy phase.',
    ]
  }
  const failing = gates.filter((g) => !g.passed)
  if (failing.length === 0) {
    // Shouldn't happen — non-eligible verdict with zero failing
    // gates implies a bug in computeReadinessVerdict. Defensive
    // fallback so the UI doesn't render an empty list.
    return ['One or more readiness gates need attention.']
  }
  return failing.map((g) =>
    g.nextStep ? g.nextStep : `${g.label} did not pass.`
  )
}

function buildCaveats(verdict: AutonomyReadinessVerdict): string[] {
  if (verdict !== 'eligible') return []
  // The disclaimer is part of the contract — every `eligible`
  // verdict carries it. The UI displays it prominently; the
  // route returns it verbatim so a future cron / analytics
  // consumer can't accidentally read "eligible: true" as a
  // green light.
  return [
    'Autonomous sending is still disabled. This scorecard only measures whether a future opt-in could be considered.',
    'A future opt-in phase must still add explicit per-venue toggle, rollback, kill switch, monitoring, and customer-visible settings before any message is sent without operator approval.',
  ]
}
