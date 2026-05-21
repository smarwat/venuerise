import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireAdmin } from '@/lib/auth/require-admin'
import {
  requireVenueRole,
  TenantAccessError,
} from '@/lib/auth/tenant-access'
import { ADMIN_ROLES } from '@/lib/auth/roles'
import { createServiceClient } from '@/lib/supabase/service'
import { rateLimitUserAction, rateLimitedResponse } from '@/lib/rate-limit'
import { log } from '@/lib/log'
import {
  getOrCreateRequestId,
  withRequestIdHeader,
} from '@/lib/observability/request-id'
import { captureApiError } from '@/lib/observability/sentry'
import {
  computeAutopilotSimulationSummary,
  computeOperatorAlignment,
  type SimulationRow,
} from '@/lib/revenue-os/autopilot-simulation'
import {
  computeReviewedDisagreementsPct,
  computeRuleSignals,
  isReviewedState,
  type AutopilotReviewState,
} from '@/lib/revenue-os/autopilot-review'
import {
  computeAutopilotReadiness,
} from '@/lib/revenue-os/autopilot-readiness'

/**
 * GET /api/admin/ai/autopilot-readiness  (Phase 8BA)
 *
 * Powers the AutopilotReadinessScorecard on
 * /dashboard/settings/billing. Returns a single read-only
 * verdict ("not_eligible" / "watch" / "eligible") + the
 * gate-by-gate breakdown + the raw inputs that drove the
 * verdict.
 *
 * Safety posture (this is the only place in the codebase that
 * derives the eligibility signal):
 *   - The route returns a SIGNAL, not a CONTROL. Returning
 *     `{verdict: 'eligible'}` does not enable any autonomy
 *     code path. There is no autonomy code path in 8BA.
 *   - `autonomous_sending_still_disabled` health flag (from
 *     8AX, carried through 8AY/8AZ) stays `mounted`.
 *   - No draft body, no variants, no lead emails, no message
 *     content are exposed by this route. Only the aggregate
 *     numbers the helper needs.
 *
 * Data sources (reused from 8AY + 8AZ — no new database surface):
 *   - `ai_actions` rows where agent='venuerise' AND
 *     action='draft_regenerate' AND success=true, scanned over
 *     the request's `days` window (default 30, max 90).
 *   - `ai_action_reviews` joined for the disagreement rows.
 *
 * Security:
 *   - requireAdmin() — owner/admin only
 *   - cross-tenant `venue_id` gated via requireVenueRole(
 *     ADMIN_ROLES); forbidden collapses to 404 (same posture as
 *     the rest of the admin AI surface)
 *   - per-user rate limit `admin:ai-autopilot-readiness:{userId}`
 *
 * Query:
 *   venue_id? uuid
 *   days?     1..90 (default 30)
 */

const QuerySchema = z.object({
  venue_id: z.string().uuid().optional(),
  days: z.coerce.number().int().min(1).max(90).optional(),
})

const DEFAULT_WINDOW_DAYS = 30
// Same hard scan cap the 8AY simulation endpoint uses. The
// helper math degrades gracefully when the cap is hit
// (windowDaysWithData is still correct over the sample).
const MAX_ROWS_PER_WINDOW = 1000

export async function GET(request: NextRequest): Promise<Response> {
  const requestId = getOrCreateRequestId(request)
  const reqLog = log.child({
    requestId,
    route: '/api/admin/ai/autopilot-readiness',
    op: 'admin.ai.autopilot_readiness',
  })
  const respond = <T extends Response>(r: T) =>
    withRequestIdHeader(r, requestId)

  // 1. Admin auth.
  const admin = await requireAdmin()
  if (!admin.ok) {
    return respond(
      NextResponse.json({ error: admin.code }, { status: admin.status })
    )
  }
  const { user, venueId: callerVenueId } = admin

  // 2. Rate limit.
  const rl = await rateLimitUserAction(
    request,
    `admin:ai-autopilot-readiness:${user.id}`
  )
  if (!rl.allowed) {
    reqLog.warn(
      { userId: user.id, retryMs: rl.retryAfterMs },
      'rate_limit.blocked'
    )
    return respond(rateLimitedResponse(rl))
  }

  // 3. Parse query.
  const url = new URL(request.url)
  const parsed = QuerySchema.safeParse({
    venue_id: url.searchParams.get('venue_id') ?? undefined,
    days: url.searchParams.get('days') ?? undefined,
  })
  if (!parsed.success) {
    return respond(
      NextResponse.json(
        { error: 'validation_failed', detail: parsed.error.flatten() },
        { status: 400 }
      )
    )
  }
  const { venue_id: bodyVenueId, days = DEFAULT_WINDOW_DAYS } = parsed.data

  // 4. Cross-tenant gate.
  const targetVenueId = bodyVenueId ?? callerVenueId
  if (targetVenueId !== callerVenueId) {
    try {
      await requireVenueRole(user.id, targetVenueId, ADMIN_ROLES)
    } catch (err) {
      if (err instanceof TenantAccessError) {
        if (err.status === 403) {
          return respond(
            NextResponse.json({ error: 'not_found' }, { status: 404 })
          )
        }
        return respond(
          NextResponse.json({ error: err.code }, { status: err.status })
        )
      }
      throw err
    }
  }

  const svc = createServiceClient()
  const windowStart = new Date(
    Date.now() - days * 24 * 60 * 60 * 1000
  ).toISOString()

  // 5. Fetch the window of draft_regenerate rows. We pull the
  // minimum metadata the simulation + review helpers need —
  // explicitly NOT `variants_offered` so a careless log line
  // can never leak draft text from this route.
  let actionRows: Array<{
    id: string
    lead_id: string | null
    created_at: string
    metadata: {
      variant_confidences?: number[]
      autopilot_decisions?: Array<{
        mode?: 'eligible' | 'review_required' | 'blocked'
      }>
      variant_risk_flags?: Array<{
        has_pricing_question?: boolean
        has_policy_question?: boolean
        has_availability_claim?: boolean
      }>
      operator_outcome?: string
      operator_outcome_at?: string
      edit_distance_bucket?: string
      selected_variant_index?: number
    } | null
  }> = []
  try {
    const { data, error } = await svc
      .from('ai_actions')
      .select('id, lead_id, created_at, metadata')
      .eq('venue_id', targetVenueId)
      .eq('agent', 'venuerise')
      .eq('action', 'draft_regenerate')
      .eq('success', true)
      .gte('created_at', windowStart)
      .order('created_at', { ascending: false })
      .limit(MAX_ROWS_PER_WINDOW)
    if (error) throw error
    actionRows = (data as typeof actionRows) ?? []
  } catch (err) {
    reqLog.error(
      { err, targetVenueId, days },
      'admin.ai.autopilot_readiness.query_failed'
    )
    captureApiError(err, {
      requestId,
      route: '/api/admin/ai/autopilot-readiness',
      userId: user.id,
      venueId: targetVenueId,
    })
    return respond(
      NextResponse.json({ error: 'unexpected_error' }, { status: 500 })
    )
  }

  // 6. Project per-row metadata into the shapes the helpers
  // need:
  //   - simulationRows feeds computeAutopilotSimulationSummary
  //     for the readiness signal
  //   - disagreementRiskById captures risk flags for every
  //     disagreement row so the rule-signal join below has
  //     the data it needs
  //   - scoredDateSet powers windowDaysWithData (distinct UTC
  //     dates among rows where BOTH autopilot mode AND
  //     operator outcome are known — i.e. rows that could
  //     legally contribute to readiness)
  const simulationRows: SimulationRow[] = []
  const disagreementRiskById = new Map<string, string[]>()
  const operatorAlignmentById = new Map<string, string>()
  const scoredDateSet = new Set<string>()

  for (const r of actionRows) {
    const md = r.metadata ?? {}
    const decisionsArr = Array.isArray(md.autopilot_decisions)
      ? md.autopilot_decisions
      : []
    const idx =
      typeof md.selected_variant_index === 'number'
        ? md.selected_variant_index
        : 0
    const dec = decisionsArr[idx]
    const autopilotMode =
      dec?.mode === 'eligible' ||
      dec?.mode === 'review_required' ||
      dec?.mode === 'blocked'
        ? dec.mode
        : null
    const operatorOutcome =
      typeof md.operator_outcome === 'string' ? md.operator_outcome : null
    const editDistanceBucket =
      typeof md.edit_distance_bucket === 'string'
        ? md.edit_distance_bucket
        : null

    simulationRows.push({
      autopilotMode,
      operatorOutcome,
      editDistanceBucket,
      createdAt: r.created_at,
      sentAt: md.operator_outcome_at ?? null,
    })

    // Distinct active days. Mirrors the 8AY summary's
    // `total_scored` rule: a row must have BOTH an autopilot
    // mode AND an operator outcome to count. Pre-8AX rows
    // (no autopilot decision) are excluded automatically.
    if (autopilotMode && operatorOutcome && operatorOutcome !== 'unknown') {
      // ISO date in UTC. `toISOString` is stable across
      // timezones so two servers in different regions agree.
      const dateKey = r.created_at.slice(0, 10)
      scoredDateSet.add(dateKey)
    }

    const alignment = computeOperatorAlignment({
      autopilotMode,
      operatorOutcome,
      editDistanceBucket,
    })
    operatorAlignmentById.set(r.id, alignment)
    if (
      alignment === 'operator_more_conservative' ||
      alignment === 'operator_less_conservative'
    ) {
      const riskArr = Array.isArray(md.variant_risk_flags)
        ? md.variant_risk_flags
        : []
      const risk = riskArr[idx] ?? null
      const riskFlags: string[] = []
      if (risk?.has_pricing_question) riskFlags.push('pricing')
      if (risk?.has_policy_question) riskFlags.push('policy')
      if (risk?.has_availability_claim) riskFlags.push('availability')
      disagreementRiskById.set(r.id, riskFlags)
    }
  }

  const simulationSummary = computeAutopilotSimulationSummary(simulationRows)

  // 7. Join with ai_action_reviews for the disagreement rows.
  // Best-effort: if this fails we still produce a readiness
  // verdict (the review gates collapse to "no data", which
  // means they fail — the right safe default).
  const disagreementIds = Array.from(disagreementRiskById.keys())
  const reviewStateByActionId = new Map<string, AutopilotReviewState>()
  if (disagreementIds.length > 0) {
    try {
      const { data: reviewRows } = await svc
        .from('ai_action_reviews')
        .select('ai_action_id, review_state')
        .in('ai_action_id', disagreementIds)
      for (const rr of (reviewRows as Array<{
        ai_action_id: string
        review_state: AutopilotReviewState
      }> | null) ?? []) {
        reviewStateByActionId.set(rr.ai_action_id, rr.review_state)
      }
    } catch (err) {
      reqLog.warn(
        { err, targetVenueId },
        'admin.ai.autopilot_readiness.review_lookup_failed'
      )
    }
  }

  // 8. Derive the readiness helper's inputs from the joined
  // data. The helper itself is pure; everything below is
  // straight projection.
  const reviewedDisagreements = disagreementIds.filter((id) =>
    isReviewedState(reviewStateByActionId.get(id) ?? null)
  ).length
  const reviewedDisagreementsPct = computeReviewedDisagreementsPct({
    totalDisagreements: disagreementIds.length,
    reviewedDisagreements,
  })
  const ruleSignals = computeRuleSignals(
    disagreementIds.map((id) => ({
      riskFlags: disagreementRiskById.get(id) ?? [],
      reviewState: reviewStateByActionId.get(id) ?? null,
    }))
  )
  // "Dangerous mismatches" = operator_less_conservative rows
  // that haven't been labeled yet (status === needs_review).
  // We refuse autonomy eligibility while any of these remain
  // unreviewed — the operator MUST look at them first.
  let operatorLessConservativeUnreviewed = 0
  for (const [actionId, alignment] of operatorAlignmentById) {
    if (alignment !== 'operator_less_conservative') continue
    const state = reviewStateByActionId.get(actionId) ?? null
    if (!isReviewedState(state)) operatorLessConservativeUnreviewed += 1
  }
  const windowDaysWithData = scoredDateSet.size
  const maxRuleFalsePositiveRate = ruleSignals.reduce<number | null>(
    (acc, r) => {
      if (typeof r.falsePositiveRate !== 'number') return acc
      if (!Number.isFinite(r.falsePositiveRate)) return acc
      if (r.reviewed <= 0) return acc
      if (acc === null || r.falsePositiveRate > acc) return r.falsePositiveRate
      return acc
    },
    null
  )

  const readiness = computeAutopilotReadiness({
    simulationReadiness: simulationSummary.readiness,
    totalScored: simulationSummary.total_scored,
    reviewedDisagreementsPct,
    ruleSignals,
    operatorLessConservativeUnreviewed,
    windowDaysWithData,
  })

  reqLog.info(
    {
      targetVenueId,
      days,
      rows: actionRows.length,
      total_scored: simulationSummary.total_scored,
      verdict: readiness.verdict,
      window_days_with_data: windowDaysWithData,
    },
    'admin.ai.autopilot_readiness.served'
  )

  return respond(
    NextResponse.json({
      venue_id: targetVenueId,
      window_days: days,
      readiness,
      inputs: {
        simulation_readiness: simulationSummary.readiness,
        total_scored: simulationSummary.total_scored,
        reviewed_disagreements_pct: reviewedDisagreementsPct,
        max_rule_false_positive_rate: maxRuleFalsePositiveRate,
        operator_less_conservative_unreviewed:
          operatorLessConservativeUnreviewed,
        window_days_with_data: windowDaysWithData,
      },
      generated_at: new Date().toISOString(),
    })
  )
}
