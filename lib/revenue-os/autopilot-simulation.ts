/**
 * Phase 8AY — Autopilot Simulation.
 *
 * Pure module. No Supabase, no React, no env. The admin draft-
 * audit route + the dedicated `/api/admin/ai/autopilot-simulation`
 * endpoint + the AutopilotSimulationPanel all funnel through this
 * file so the simulation math stays in one place.
 *
 * This phase introduces ZERO autonomous sending. Every helper
 * here measures what the system WOULD HAVE DONE if autopilot were
 * on, then compares that to what the operator actually did. The
 * goal is to surface whether the Phase 8AX guardrails are
 * calibrated well enough that future autonomy would be safe —
 * NOT to authorize autonomy.
 *
 * Why pure:
 *   - rules can be unit-tested without spinning up Supabase
 *   - the per-row CSV projection on the audit route + the
 *     summary block on the dedicated simulation endpoint stay
 *     in lockstep (they both ask the same helper for the same
 *     answers)
 *   - swapping or tightening alignment rules later is a single
 *     PR diff against this file
 */

// ---------------------------------------------------------------------------
// Simulation mode (mirrors the 8AX autopilot mode, renamed for clarity)
// ---------------------------------------------------------------------------

/**
 * `AutopilotSimulationMode` is the simulation-layer projection of
 * the 8AX `AutopilotMode`. We keep it as a separate type instead
 * of reusing the 8AX literal so a future change to the 8AX
 * vocabulary (e.g. adding `eligible_with_caveat`) doesn't
 * silently rewrite simulation history.
 *
 * Mapping:
 *   eligible          → would_send
 *   review_required   → would_require_review
 *   blocked           → would_block
 *   anything else     → would_require_review (safe default; we
 *                       NEVER promote unknown to would_send)
 */
export type AutopilotSimulationMode =
  | 'would_send'
  | 'would_require_review'
  | 'would_block'

export function simulationModeFromAutopilotMode(
  mode: string | null
): AutopilotSimulationMode {
  if (mode === 'eligible') return 'would_send'
  if (mode === 'blocked') return 'would_block'
  // `review_required`, any other string, null, or undefined all
  // collapse to the safe middle. We never silently bridge missing
  // data to `would_send` — that would inflate the readiness
  // signal with rows we couldn't classify.
  return 'would_require_review'
}

// ---------------------------------------------------------------------------
// Operator alignment
// ---------------------------------------------------------------------------

/**
 * `OperatorAlignment` is the core safety question: did the human
 * agree with what autopilot would have done?
 *
 *   - `aligned`                       — the operator's behavior
 *                                       matches the autopilot
 *                                       recommendation (e.g.
 *                                       autopilot=eligible +
 *                                       operator sent as-is, OR
 *                                       autopilot=blocked +
 *                                       operator regenerated /
 *                                       edited heavily).
 *   - `operator_more_conservative`    — autopilot said
 *                                       eligible/would_send, but
 *                                       the human declined to
 *                                       send as-is (edited,
 *                                       regenerated, rejected).
 *                                       Safe direction; just
 *                                       means autopilot would
 *                                       have over-fired.
 *   - `operator_less_conservative`    — autopilot said blocked
 *                                       OR review_required, but
 *                                       the operator sent as-is.
 *                                       DANGEROUS direction;
 *                                       autopilot would have
 *                                       blocked a send the human
 *                                       was comfortable with —
 *                                       OR worse, blocked a send
 *                                       that turned out fine,
 *                                       making the guardrail too
 *                                       strict.
 *   - `unknown`                       — outcome not yet recorded
 *                                       (operator hasn't acted)
 *                                       OR autopilot mode is
 *                                       missing (pre-8AX row).
 */
export type OperatorAlignment =
  | 'aligned'
  | 'operator_more_conservative'
  | 'operator_less_conservative'
  | 'unknown'

export interface OperatorAlignmentInput {
  autopilotMode: string | null
  operatorOutcome: string | null
  editDistanceBucket?: string | null
  selectedVariantWasLowConfidence?: boolean | null
}

export function computeOperatorAlignment(
  input: OperatorAlignmentInput
): OperatorAlignment {
  const mode = input.autopilotMode
  const outcome = input.operatorOutcome
  // Pre-8AX rows (no autopilot mode) or untouched-by-operator
  // rows (no outcome) collapse to `unknown`. Caller can decide
  // whether to bucket those.
  if (
    mode === null ||
    mode === undefined ||
    outcome === null ||
    outcome === undefined ||
    outcome === 'unknown'
  ) {
    return 'unknown'
  }
  if (mode === 'eligible') {
    if (outcome === 'sent_as_is') return 'aligned'
    // Eligible + edit / regenerate / abandon = operator pulled
    // back. Safe direction.
    return 'operator_more_conservative'
  }
  if (mode === 'blocked') {
    if (outcome === 'sent_as_is') return 'operator_less_conservative'
    // Blocked + edit / regenerate / abandon = operator agreed
    // the draft wasn't ready. Aligned.
    return 'aligned'
  }
  if (mode === 'review_required') {
    if (outcome === 'sent_as_is') return 'operator_less_conservative'
    // Review + anything-but-as-is = operator did what we asked
    // (review before send). Aligned.
    return 'aligned'
  }
  // Unrecognized mode string — treat as unknown.
  return 'unknown'
}

// ---------------------------------------------------------------------------
// Time-saved estimate
// ---------------------------------------------------------------------------

/**
 * Estimate how many operator-minutes autopilot WOULD have saved
 * on this single row, IF autonomy had been enabled. The estimate
 * is intentionally simple and lossy:
 *
 *   - Only `eligible` drafts the operator ended up sending as-is
 *     count. Everything else is `null` (we can't claim time-saved
 *     credit for sends the operator wouldn't have approved).
 *   - When `createdAt` + `sentAt` are present, we use the elapsed
 *     wall time clamped to a sane band [0, 30].
 *   - When `sentAt` is missing we fall back to a flat 3-minute
 *     credit per eligible+sent_as_is row. That's the rough median
 *     of "operator opened the drawer, read the draft, clicked
 *     Approve" observed during Phase 8AW edit-bucket tuning.
 *
 * Returns `null` for rows that don't contribute to the estimate,
 * so the caller can sum non-null values cleanly.
 */
export interface TimeSavedInput {
  autopilotMode: string | null
  operatorOutcome: string | null
  createdAt: string | null
  sentAt?: string | null
}

const FLAT_TIME_SAVED_PER_AS_IS_MINUTES = 3
const TIME_SAVED_BAND_MIN_MINUTES = 0
const TIME_SAVED_BAND_MAX_MINUTES = 30

export function estimateTimeSavedMinutes(
  input: TimeSavedInput
): number | null {
  if (input.autopilotMode !== 'eligible') return null
  if (input.operatorOutcome !== 'sent_as_is') return null
  if (!input.createdAt) return FLAT_TIME_SAVED_PER_AS_IS_MINUTES
  if (!input.sentAt) return FLAT_TIME_SAVED_PER_AS_IS_MINUTES
  const created = Date.parse(input.createdAt)
  const sent = Date.parse(input.sentAt)
  if (!Number.isFinite(created) || !Number.isFinite(sent)) {
    return FLAT_TIME_SAVED_PER_AS_IS_MINUTES
  }
  const deltaMs = sent - created
  if (deltaMs <= 0) return FLAT_TIME_SAVED_PER_AS_IS_MINUTES
  const minutes = deltaMs / 60_000
  return Math.max(
    TIME_SAVED_BAND_MIN_MINUTES,
    Math.min(TIME_SAVED_BAND_MAX_MINUTES, Math.round(minutes))
  )
}

// ---------------------------------------------------------------------------
// Page / window summary
// ---------------------------------------------------------------------------

export interface SimulationRow {
  autopilotMode: string | null
  operatorOutcome: string | null
  editDistanceBucket?: string | null
  selectedVariantWasLowConfidence?: boolean | null
  createdAt: string | null
  sentAt?: string | null
}

export type SimulationReadiness = 'not_ready' | 'watch' | 'promising'

export interface AutopilotSimulationSummary {
  total_scored: number
  would_send: number
  would_require_review: number
  would_block: number
  eligible_sent_as_is: number
  blocked_sent_as_is: number
  review_required_edited_or_regenerated: number
  aligned: number
  operator_more_conservative: number
  operator_less_conservative: number
  unknown: number
  estimated_minutes_saved: number
  readiness: SimulationReadiness
}

/**
 * Roll up a slice of rows into the summary the admin endpoint +
 * panel render.
 *
 * `total_scored` counts rows where we knew BOTH the autopilot
 * mode AND the operator outcome — i.e. rows that could legally
 * contribute to readiness. `unknown` counts rows with either
 * missing piece, so the operator can see how much of the window
 * the score is built on vs how much is pending.
 *
 * Readiness rules (mirror the spec):
 *
 *   - `promising` requires:
 *       - >= 20 scored rows
 *       - eligible_sent_as_is / would_send  >= 0.8
 *       - blocked_sent_as_is  / would_block <= 0.1
 *   - `watch` requires:
 *       - >= 10 scored rows
 *       - data is "mixed but not obviously dangerous" — we
 *         operationalize that as
 *         `operator_less_conservative / total_scored < 0.2`.
 *   - otherwise `not_ready`.
 *
 * When the denominator on a ratio is 0 (e.g. zero would_block
 * rows), we treat that ratio as 0 — i.e. nothing to disprove the
 * upper bound. The MIN row-count gate is what prevents a
 * 1-of-1 win from flipping the readiness to promising.
 */
export function computeAutopilotSimulationSummary(
  rows: ReadonlyArray<SimulationRow>
): AutopilotSimulationSummary {
  let would_send = 0
  let would_require_review = 0
  let would_block = 0
  let eligible_sent_as_is = 0
  let blocked_sent_as_is = 0
  let review_required_edited_or_regenerated = 0
  let aligned = 0
  let operator_more_conservative = 0
  let operator_less_conservative = 0
  let unknown = 0
  let estimated_minutes_saved = 0

  for (const r of rows) {
    const sim = simulationModeFromAutopilotMode(r.autopilotMode)
    if (sim === 'would_send') would_send += 1
    else if (sim === 'would_block') would_block += 1
    else would_require_review += 1

    const alignment = computeOperatorAlignment({
      autopilotMode: r.autopilotMode,
      operatorOutcome: r.operatorOutcome,
      editDistanceBucket: r.editDistanceBucket,
      selectedVariantWasLowConfidence: r.selectedVariantWasLowConfidence,
    })
    if (alignment === 'aligned') aligned += 1
    else if (alignment === 'operator_more_conservative')
      operator_more_conservative += 1
    else if (alignment === 'operator_less_conservative')
      operator_less_conservative += 1
    else unknown += 1

    // Side-counters the spec calls out by name.
    if (r.autopilotMode === 'eligible' && r.operatorOutcome === 'sent_as_is') {
      eligible_sent_as_is += 1
    }
    if (r.autopilotMode === 'blocked' && r.operatorOutcome === 'sent_as_is') {
      blocked_sent_as_is += 1
    }
    if (
      r.autopilotMode === 'review_required' &&
      (r.operatorOutcome === 'sent_after_edit' ||
        r.operatorOutcome === 'regenerated')
    ) {
      review_required_edited_or_regenerated += 1
    }

    const minutes = estimateTimeSavedMinutes({
      autopilotMode: r.autopilotMode,
      operatorOutcome: r.operatorOutcome,
      createdAt: r.createdAt,
      sentAt: r.sentAt,
    })
    if (typeof minutes === 'number' && Number.isFinite(minutes)) {
      estimated_minutes_saved += minutes
    }
  }

  const total_scored = rows.length - unknown
  const readiness = computeReadiness({
    total_scored,
    would_send,
    would_block,
    eligible_sent_as_is,
    blocked_sent_as_is,
    operator_less_conservative,
  })

  return {
    total_scored,
    would_send,
    would_require_review,
    would_block,
    eligible_sent_as_is,
    blocked_sent_as_is,
    review_required_edited_or_regenerated,
    aligned,
    operator_more_conservative,
    operator_less_conservative,
    unknown,
    estimated_minutes_saved,
    readiness,
  }
}

function computeReadiness(input: {
  total_scored: number
  would_send: number
  would_block: number
  eligible_sent_as_is: number
  blocked_sent_as_is: number
  operator_less_conservative: number
}): SimulationReadiness {
  const {
    total_scored,
    would_send,
    would_block,
    eligible_sent_as_is,
    blocked_sent_as_is,
    operator_less_conservative,
  } = input
  // Hard floor: nothing scored, nothing to say.
  if (total_scored < 10) return 'not_ready'
  const eligibleAsIsRate =
    would_send === 0 ? 0 : eligible_sent_as_is / would_send
  const blockedAsIsRate =
    would_block === 0 ? 0 : blocked_sent_as_is / would_block
  const dangerousMismatchRate =
    total_scored === 0 ? 0 : operator_less_conservative / total_scored

  if (
    total_scored >= 20 &&
    eligibleAsIsRate >= 0.8 &&
    blockedAsIsRate <= 0.1
  ) {
    return 'promising'
  }
  if (total_scored >= 10 && dangerousMismatchRate < 0.2) {
    return 'watch'
  }
  return 'not_ready'
}
