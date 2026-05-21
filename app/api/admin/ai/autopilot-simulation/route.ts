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
  simulationModeFromAutopilotMode,
  type AutopilotSimulationMode,
  type OperatorAlignment,
  type SimulationRow,
} from '@/lib/revenue-os/autopilot-simulation'
import {
  computeReviewedDisagreementsPct,
  computeRuleSignals,
  isDisagreement,
  isReviewedState,
  type AutopilotReviewState,
  type AutopilotRuleSignal,
} from '@/lib/revenue-os/autopilot-review'

/**
 * GET /api/admin/ai/autopilot-simulation  (Phase 8AY)
 *
 * Dedicated roll-up for the AutopilotSimulationPanel on
 * /dashboard/settings/billing. The draft-audit route already
 * embeds a page-scoped simulation block via the same helper, but
 * that block is bounded to whatever page-of-25 the audit card is
 * showing. This endpoint widens the window so the panel reflects
 * a meaningful sample (default 30 days, max 90).
 *
 * Why a dedicated route rather than overloading draft-audit:
 *   - keeps draft-audit's CSV semantics + cursor pagination
 *     intact (they're row-list concerns, not summary concerns)
 *   - lets the panel pick its own window without forcing the
 *     card to fetch 100+ rows
 *   - the recent-mismatches list is panel-specific UX (top 5
 *     `!aligned` rows + lead names) and doesn't belong on the
 *     general audit feed
 *
 * Important: this is OBSERVATION only. The endpoint never sends a
 * message, never schedules anything, never flips any autonomy
 * toggle. The `autonomous_sending_still_disabled` health flag
 * remains 'mounted' until a later phase explicitly opens that
 * gate.
 *
 * Security:
 *   - requireAdmin() — owner/admin only
 *   - cross-tenant venue_id gated via requireVenueRole(ADMIN_ROLES);
 *     forbidden collapses to 404 (same posture as draft-audit)
 *   - rate-limit `admin:ai-autopilot-simulation:{userId}`
 *   - returns NO draft body text. Recent-mismatches rows expose
 *     ai_action_id + lead_id + lead_name + final_confidence +
 *     decision metadata only.
 */

const QuerySchema = z.object({
  venue_id: z.string().uuid().optional(),
  days: z.coerce.number().int().min(1).max(90).optional(),
})

const DEFAULT_WINDOW_DAYS = 30
const RECENT_MISMATCHES_LIMIT = 5
// Hard ceiling on rows loaded into the helper. The simulation
// summary is bounded — 1000 rows over 30 days is generous for a
// single venue's draft cadence. Prevents pathological venues
// (cron-driven regenerate spam) from blowing the route budget.
const MAX_ROWS_PER_WINDOW = 1000

type BucketCounts = {
  total: number
  sent_as_is: number
  sent_after_edit: number
  regenerated: number
  rejected: number
  unknown: number
}

interface RecentMismatch {
  ai_action_id: string
  lead_id: string | null
  lead_name: string | null
  created_at: string
  autopilot_mode: 'eligible' | 'review_required' | 'blocked' | null
  operator_outcome: string | null
  edit_distance_bucket: string | null
  final_confidence: number | null
  simulation_mode: AutopilotSimulationMode
  operator_alignment: OperatorAlignment
}

export async function GET(request: NextRequest): Promise<Response> {
  const requestId = getOrCreateRequestId(request)
  const reqLog = log.child({
    requestId,
    route: '/api/admin/ai/autopilot-simulation',
    op: 'admin.ai.autopilot_simulation',
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
    `admin:ai-autopilot-simulation:${user.id}`
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

  // 4. Cross-tenant gate. Forbidden collapses to 404 so a
  // non-admin can't probe other venues for existence (same
  // posture as draft-audit / digest/sends).
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

  // 5. Fetch the window of draft_regenerate rows. We DON'T pull
  // variants_offered — only the audit + outcome metadata the
  // simulation actually needs. Keeps the payload small + means
  // a careless logger never leaks draft text.
  let actionRows: Array<{
    id: string
    lead_id: string | null
    created_at: string
    success: boolean
    metadata: {
      variant_count?: number
      variant_confidences?: number[]
      min_confidence?: number | null
      autopilot_decisions?: Array<{
        mode?: 'eligible' | 'review_required' | 'blocked'
      }>
      // Phase 8AZ — per-variant risk flags surface as rule
      // names in the rule_signals summary so the simulation
      // panel can show which guardrail rules drive false
      // positives.
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
      .select(
        'id, lead_id, created_at, success, metadata'
      )
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
      'admin.ai.autopilot_simulation.query_failed'
    )
    captureApiError(err, {
      requestId,
      route: '/api/admin/ai/autopilot-simulation',
      userId: user.id,
      venueId: targetVenueId,
    })
    return respond(
      NextResponse.json({ error: 'unexpected_error' }, { status: 500 })
    )
  }

  // 6. Project per-row metadata into the simulation shape +
  // bucket counts the panel renders. We pick the selected variant
  // (by `selected_variant_index` when set; otherwise variant 0)
  // so the autopilot mode + final confidence reflect the
  // variant the operator actually evaluated.
  const buckets: Record<
    'eligible' | 'review_required' | 'blocked',
    BucketCounts
  > = {
    eligible: emptyBucket(),
    review_required: emptyBucket(),
    blocked: emptyBucket(),
  }
  const simulationInput: SimulationRow[] = []
  // We build the mismatch candidate list as we go (per-row info
  // we already have to compute alignment). Then sort + slice
  // after the loop so the top-N selection sees every candidate.
  const mismatchCandidates: Array<RecentMismatch & { _ts: number }> = []
  const leadIdsToFetch = new Set<string>()
  // Phase 8AZ — collect risk-flag arrays + ai_action_ids for
  // every DISAGREEMENT row in the window so we can join with
  // ai_action_reviews after the loop and feed the review
  // helper. Aligned/unknown rows don't contribute to the queue
  // or to rule signals.
  const disagreementRiskByActionId = new Map<string, string[]>()

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

    simulationInput.push({
      autopilotMode,
      operatorOutcome,
      editDistanceBucket,
      createdAt: r.created_at,
      sentAt: md.operator_outcome_at ?? null,
    })

    // Bucket counts. Pre-8AX rows (autopilot_mode null) are NOT
    // bucketed — they didn't have a decision to compare against.
    if (autopilotMode) {
      const b = buckets[autopilotMode]
      b.total += 1
      if (operatorOutcome === 'sent_as_is') b.sent_as_is += 1
      else if (operatorOutcome === 'sent_after_edit') b.sent_after_edit += 1
      else if (operatorOutcome === 'regenerated') b.regenerated += 1
      else if (operatorOutcome === 'abandoned') b.rejected += 1
      else b.unknown += 1
    }

    const alignment = computeOperatorAlignment({
      autopilotMode,
      operatorOutcome,
      editDistanceBucket,
    })
    if (
      alignment === 'operator_more_conservative' ||
      alignment === 'operator_less_conservative'
    ) {
      // Phase 8AZ — capture risk flags for this disagreement
      // row so the review join below can feed `computeRuleSignals`.
      const riskArr = Array.isArray(md.variant_risk_flags)
        ? md.variant_risk_flags
        : []
      const risk = riskArr[idx] ?? null
      const riskFlags: string[] = []
      if (risk?.has_pricing_question) riskFlags.push('pricing')
      if (risk?.has_policy_question) riskFlags.push('policy')
      if (risk?.has_availability_claim) riskFlags.push('availability')
      disagreementRiskByActionId.set(r.id, riskFlags)
      const finalConfidences = Array.isArray(md.variant_confidences)
        ? md.variant_confidences
        : []
      const final =
        idx >= 0 &&
        typeof finalConfidences[idx] === 'number' &&
        Number.isFinite(finalConfidences[idx])
          ? Math.max(0, Math.min(100, Math.round(finalConfidences[idx])))
          : null
      mismatchCandidates.push({
        _ts: Date.parse(r.created_at) || 0,
        ai_action_id: r.id,
        lead_id: r.lead_id,
        lead_name: null, // filled below after the leads lookup
        created_at: r.created_at,
        autopilot_mode: autopilotMode,
        operator_outcome: operatorOutcome,
        edit_distance_bucket: editDistanceBucket,
        final_confidence: final,
        simulation_mode: simulationModeFromAutopilotMode(autopilotMode),
        operator_alignment: alignment,
      })
      if (r.lead_id) leadIdsToFetch.add(r.lead_id)
    }
  }

  // 7. Lead name lookup for the recent-mismatches slice. We
  // intentionally do NOT include lead email — the panel only
  // needs the name + the deep-link. Bounded by the candidate
  // list size; never grows beyond ~RECENT_MISMATCHES_LIMIT after
  // sort (we resolve a few extras to be safe but cap the final
  // mismatch list).
  const leadsById = new Map<string, string | null>()
  if (leadIdsToFetch.size > 0) {
    const { data: leadRows } = await svc
      .from('leads')
      .select('id, name')
      .in('id', Array.from(leadIdsToFetch))
    for (const lr of (leadRows as Array<{
      id: string
      name: string | null
    }> | null) ?? []) {
      leadsById.set(lr.id, lr.name)
    }
  }
  const recent_rows = mismatchCandidates
    .sort((a, b) => b._ts - a._ts)
    .slice(0, RECENT_MISMATCHES_LIMIT)
    .map((m) => {
      const { _ts: _ignored, ...rest } = m
      void _ignored
      return {
        ...rest,
        lead_name: rest.lead_id ? leadsById.get(rest.lead_id) ?? null : null,
      }
    })

  const baseSummary = computeAutopilotSimulationSummary(simulationInput)

  // Phase 8AZ — review-aware extension. Join the disagreement
  // rows we collected above with `ai_action_reviews` (one
  // round-trip, bounded by the window scan size), then compute
  // per-rule signals + state counts. If the table is empty for
  // this venue, every count comes out 0 and rule_signals stays
  // empty — the panel's empty-state copy handles that.
  const disagreementIds = Array.from(disagreementRiskByActionId.keys())
  const reviewStateByActionId = new Map<string, AutopilotReviewState>()
  const reviewNoteByActionId = new Map<string, string | null>()
  if (disagreementIds.length > 0) {
    try {
      const { data: reviewRows } = await svc
        .from('ai_action_reviews')
        .select('ai_action_id, review_state, note')
        .in('ai_action_id', disagreementIds)
      for (const rr of (reviewRows as Array<{
        ai_action_id: string
        review_state: AutopilotReviewState
        note: string | null
      }> | null) ?? []) {
        reviewStateByActionId.set(rr.ai_action_id, rr.review_state)
        reviewNoteByActionId.set(rr.ai_action_id, rr.note)
      }
    } catch (err) {
      // Best-effort — if the reviews lookup fails the simulation
      // summary still ships with zeros for the new fields and
      // an empty rule_signals array. The panel renders fine.
      reqLog.warn(
        { err, targetVenueId },
        'admin.ai.autopilot_simulation.review_lookup_failed'
      )
    }
  }
  // `reviewNoteByActionId` is collected for parity with the queue
  // endpoint; the simulation summary doesn't expose notes (those
  // belong to the queue surface), but having it on hand means a
  // future "include notes" toggle is a one-line change.
  void reviewNoteByActionId

  let needs_review_count = 0
  let confirmed_guardrail_too_strict = 0
  let confirmed_guardrail_correct = 0
  let confirmed_operator_error = 0
  let deferred_count = 0
  for (const id of disagreementIds) {
    const s = reviewStateByActionId.get(id) ?? 'needs_review'
    if (s === 'needs_review') needs_review_count += 1
    else if (s === 'confirmed_guardrail_too_strict')
      confirmed_guardrail_too_strict += 1
    else if (s === 'confirmed_guardrail_correct')
      confirmed_guardrail_correct += 1
    else if (s === 'confirmed_operator_error')
      confirmed_operator_error += 1
    else if (s === 'deferred') deferred_count += 1
  }
  const reviewedDisagreements =
    confirmed_guardrail_too_strict +
    confirmed_guardrail_correct +
    confirmed_operator_error +
    deferred_count
  const reviewed_disagreements_pct = computeReviewedDisagreementsPct({
    totalDisagreements: disagreementIds.length,
    reviewedDisagreements,
  })
  const rule_signals: AutopilotRuleSignal[] = computeRuleSignals(
    disagreementIds.map((id) => ({
      riskFlags: disagreementRiskByActionId.get(id) ?? [],
      reviewState: reviewStateByActionId.get(id) ?? null,
    }))
  )
  // Sanity: every counter sums to disagreementIds.length (no
  // double-counting; states are mutually exclusive).
  void isDisagreement
  void isReviewedState

  // Merge into the existing summary shape. Existing 8AY fields
  // are preserved verbatim so older readers don't break.
  const summary = {
    ...baseSummary,
    reviewed_disagreements_pct,
    needs_review_count,
    confirmed_guardrail_too_strict,
    confirmed_guardrail_correct,
    confirmed_operator_error,
    deferred: deferred_count,
    rule_signals,
  }

  reqLog.info(
    {
      targetVenueId,
      days,
      rows: actionRows.length,
      total_scored: summary.total_scored,
      readiness: summary.readiness,
      mismatches: recent_rows.length,
    },
    'admin.ai.autopilot_simulation.served'
  )

  return respond(
    NextResponse.json({
      venue_id: targetVenueId,
      window_days: days,
      summary,
      buckets,
      recent_rows,
    })
  )
}

function emptyBucket(): BucketCounts {
  return {
    total: 0,
    sent_as_is: 0,
    sent_after_edit: 0,
    regenerated: 0,
    rejected: 0,
    unknown: 0,
  }
}
