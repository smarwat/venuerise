/**
 * Phase 8AW — Brand Voice calibration helpers.
 *
 * Pure module. No Supabase, no React, no env. The /api/ai/draft route
 * uses `computeFinalConfidence` to blend model + heuristic scores
 * conservatively; the /api/conversations/[id]/messages route uses
 * `editDistanceBucket` to classify whether the operator sent a draft
 * as-is or after material edits; the /api/admin/ai/draft-audit route
 * uses `computeCalibrationPageSummary` to produce the panel metrics
 * + signal heuristics the dashboard renders.
 *
 * Keeping the math here lets us:
 *   - unit-test the conservative cap independently
 *   - share the bucket definitions across the send route + audit
 *     surfaces so the dashboard never disagrees with the row data
 *   - swap the overconfidence heuristic later without grepping
 *     three route files
 */

// ---------------------------------------------------------------------------
// Final confidence — conservative blend of model self-rating + heuristic
// ---------------------------------------------------------------------------

/**
 * Compute the FINAL displayed/persisted confidence for a single
 * variant. Conservative posture:
 *
 *   - When the model emitted a confidence, take
 *     `min(model, heuristic + 10)` so the model can't claim it's
 *     dramatically more confident than the text actually reads.
 *   - When the model didn't emit a confidence, fall back to the
 *     heuristic verbatim.
 *
 * The `+10` allowance lets the model nudge confidence up when the
 * heuristic is being unfairly punitive (e.g. a short but perfectly
 * on-brand reply) without letting it inflate by 30 points.
 *
 * Always clamps 0..100. Always returns an integer.
 */
export function computeFinalConfidence(
  modelScore: number | null,
  heuristicScore: number
): number {
  const h = clampScore(heuristicScore)
  if (modelScore === null || !Number.isFinite(modelScore)) return h
  const m = clampScore(modelScore)
  // Conservative cap: model can be up to 10 points more optimistic
  // than the heuristic, no more.
  const capped = Math.min(m, h + 10)
  return clampScore(capped)
}

function clampScore(n: number): number {
  if (!Number.isFinite(n)) return 0
  return Math.max(0, Math.min(100, Math.round(n)))
}

// ---------------------------------------------------------------------------
// Edit-distance bucket
// ---------------------------------------------------------------------------

/**
 * Classify how much the operator changed a draft between regenerate
 * and send. We deliberately avoid Levenshtein on full prose (too
 * sensitive to harmless rewording); instead we compare normalized
 * length + token overlap to bucket into operator-meaningful tiers:
 *
 *   - `none`     — identical after collapsing whitespace
 *   - `minor`    — <= 10% length change AND >= 90% token overlap
 *   - `moderate` — <= 50% length change AND >= 60% token overlap
 *   - `major`    — anything else
 *   - `unknown`  — original draft text unavailable (e.g. legacy row)
 *
 * Returns `unknown` when either input is missing/empty. Token
 * comparison is case-insensitive + ignores punctuation.
 */
export type EditDistanceBucket =
  | 'none'
  | 'minor'
  | 'moderate'
  | 'major'
  | 'unknown'

export function editDistanceBucket(
  original: string | null | undefined,
  sent: string | null | undefined
): EditDistanceBucket {
  if (!original || !sent) return 'unknown'
  const a = normalizeForCompare(original)
  const b = normalizeForCompare(sent)
  if (a.length === 0 || b.length === 0) return 'unknown'
  if (a === b) return 'none'
  const lenRatio =
    Math.abs(a.length - b.length) / Math.max(a.length, b.length)
  const tokenOverlap = jaccardTokenOverlap(a, b)
  if (lenRatio <= 0.1 && tokenOverlap >= 0.9) return 'minor'
  if (lenRatio <= 0.5 && tokenOverlap >= 0.6) return 'moderate'
  return 'major'
}

function normalizeForCompare(s: string): string {
  return s.replace(/\s+/g, ' ').trim().toLowerCase()
}

function jaccardTokenOverlap(a: string, b: string): number {
  const tokenize = (s: string) =>
    new Set(
      s
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')
        .split(/\s+/)
        .filter((t) => t.length > 0)
    )
  const A = tokenize(a)
  const B = tokenize(b)
  if (A.size === 0 && B.size === 0) return 1
  let intersect = 0
  for (const t of A) if (B.has(t)) intersect += 1
  const union = A.size + B.size - intersect
  return union === 0 ? 1 : intersect / union
}

// ---------------------------------------------------------------------------
// Calibration page summary — operator-readable signals
// ---------------------------------------------------------------------------

/**
 * Operator outcome literals. Mirrors what `/api/conversations/[id]/
 * messages` writes onto the source draft action's metadata.
 */
export type OperatorOutcome =
  | 'sent_as_is'
  | 'sent_after_edit'
  | 'regenerated'
  | 'abandoned'
  | 'unknown'

/**
 * Minimal input shape the helper consumes. The admin draft-audit
 * route projects each row into this shape; tests can supply
 * fixtures directly.
 */
export interface CalibrationRow {
  success: boolean
  final_confidence: number | null
  model_confidence: number | null
  heuristic_confidence: number | null
  adjustment_delta: number | null
  low_confidence: boolean
  operator_outcome: OperatorOutcome | null
  edit_distance_bucket: EditDistanceBucket | null
  /** Free-text snippet of the instruction / output_summary that the
   *  helper scans for "missing context" phrases. Optional. */
  context_text: string | null
}

export interface CalibrationPageSummary {
  total: number
  withConfidence: number
  lowConfidence: number
  lowConfidenceRate: number
  avgFinalConfidence: number | null
  avgModelConfidence: number | null
  avgHeuristicConfidence: number | null
  avgAdjustmentDelta: number | null
  sentAsIs: number
  sentAfterEdit: number
  regenerated: number
  unknownOutcome: number
  lowConfidenceSentRate: number | null
  overconfidenceSignal: 'low' | 'medium' | 'high'
  knowledgeContextSignal: 'healthy' | 'needs_more_context'
}

/**
 * Phrases that suggest the model couldn't ground its reply in venue
 * data. When several rows mention any of these, we surface the
 * "Needs more venue context" signal so the operator knows their
 * knowledge base is probably under-stocked.
 */
const MISSING_CONTEXT_PHRASES = [
  /pricing/i,
  /price list/i,
  /availability/i,
  /available date/i,
  /policy/i,
  /policies/i,
  /knowledge\s+base/i,
  /venue\s+context/i,
  /capacity/i,
]

function average(values: ReadonlyArray<number | null>): number | null {
  const nums = values.filter(
    (v): v is number => typeof v === 'number' && Number.isFinite(v)
  )
  if (nums.length === 0) return null
  const sum = nums.reduce((acc, n) => acc + n, 0)
  return Math.round((sum / nums.length) * 10) / 10
}

/**
 * Compute the summary block surfaced by the calibration panel.
 *
 * Operates on the PAGE slice the audit route already loaded — we
 * don't fire extra DB queries. Caller can rename the field on the
 * response (`pageSummary` vs `summary`) depending on whether the
 * slice represents a single page or a full window.
 */
export function computeCalibrationPageSummary(
  rows: ReadonlyArray<CalibrationRow>
): CalibrationPageSummary {
  const total = rows.length
  const withConfidence = rows.filter((r) => r.final_confidence !== null).length
  const lowConfidence = rows.filter((r) => r.low_confidence).length
  const lowConfidenceRate =
    withConfidence === 0 ? 0 : lowConfidence / withConfidence

  const finalScores = rows.map((r) => r.final_confidence)
  const modelScores = rows.map((r) => r.model_confidence)
  const heuristicScores = rows.map((r) => r.heuristic_confidence)
  const deltas = rows.map((r) => r.adjustment_delta)

  let sentAsIs = 0
  let sentAfterEdit = 0
  let regenerated = 0
  let unknownOutcome = 0
  let lowConfidenceSent = 0
  let lowConfidenceWithOutcome = 0
  for (const r of rows) {
    if (r.operator_outcome === 'sent_as_is') sentAsIs += 1
    else if (r.operator_outcome === 'sent_after_edit') sentAfterEdit += 1
    else if (r.operator_outcome === 'regenerated') regenerated += 1
    else if (r.operator_outcome === null || r.operator_outcome === 'unknown')
      unknownOutcome += 1
    if (r.low_confidence) {
      const isSend =
        r.operator_outcome === 'sent_as_is' ||
        r.operator_outcome === 'sent_after_edit'
      if (r.operator_outcome !== null) lowConfidenceWithOutcome += 1
      if (isSend) lowConfidenceSent += 1
    }
  }
  const lowConfidenceSentRate =
    lowConfidenceWithOutcome === 0
      ? null
      : lowConfidenceSent / lowConfidenceWithOutcome

  // Overconfidence heuristic. Two signals:
  //   1. Average adjustment delta is very negative (model rated
  //      meaningfully higher than the heuristic could justify).
  //   2. Operators are regenerating or sending-after-edit at a high
  //      rate — suggests drafts didn't match what they wanted.
  const avgDelta = average(deltas)
  const decided = sentAsIs + sentAfterEdit + regenerated
  const regenerateRate =
    decided === 0 ? 0 : (regenerated + sentAfterEdit) / decided
  let overconfidenceSignal: 'low' | 'medium' | 'high' = 'low'
  // Negative delta = model scored higher than final. Big negative
  // delta = model is consistently inflating.
  if (avgDelta !== null && avgDelta <= -10) overconfidenceSignal = 'high'
  else if (avgDelta !== null && avgDelta <= -5) overconfidenceSignal = 'medium'
  if (regenerateRate >= 0.5)
    overconfidenceSignal =
      overconfidenceSignal === 'high' ? 'high' : 'medium'
  if (regenerateRate >= 0.7) overconfidenceSignal = 'high'

  // Knowledge-context signal. Count rows whose context_text mentions
  // any of the "missing X" phrases. >= 25% of decided rows triggers
  // the prompt to add more venue context.
  let needsContextHits = 0
  for (const r of rows) {
    if (!r.context_text) continue
    for (const rx of MISSING_CONTEXT_PHRASES) {
      if (rx.test(r.context_text)) {
        needsContextHits += 1
        break
      }
    }
  }
  const knowledgeContextSignal: 'healthy' | 'needs_more_context' =
    total > 0 && needsContextHits / total >= 0.25
      ? 'needs_more_context'
      : 'healthy'

  return {
    total,
    withConfidence,
    lowConfidence,
    lowConfidenceRate,
    avgFinalConfidence: average(finalScores),
    avgModelConfidence: average(modelScores),
    avgHeuristicConfidence: average(heuristicScores),
    avgAdjustmentDelta: avgDelta,
    sentAsIs,
    sentAfterEdit,
    regenerated,
    unknownOutcome,
    lowConfidenceSentRate,
    overconfidenceSignal,
    knowledgeContextSignal,
  }
}
