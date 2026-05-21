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
  computeOperatorAlignment,
  simulationModeFromAutopilotMode,
  type OperatorAlignment,
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
 * GET /api/admin/ai/autopilot-reviews  (Phase 8AZ)
 *
 * Powers the AutopilotReviewQueue surface on
 * /dashboard/settings/billing. Returns the list of `ai_actions`
 * rows where the Phase 8AY simulation classified the operator
 * as either more or less conservative than autopilot
 * (`operator_more_conservative` / `operator_less_conservative`),
 * joined with any existing review row from `ai_action_reviews`.
 *
 * Why this route, not draft-audit:
 *   - the audit feed is the general-purpose row list with CSV +
 *     cursor + realtime concerns; bolting the disagreement
 *     filter on would muddy the contract.
 *   - this route can pull the wider review-aware window the
 *     queue UI needs without forcing every audit reader to
 *     pay for the join.
 *
 * Safety posture:
 *   - Read-only. No mutations happen here; the POST sibling
 *     handles label writes.
 *   - No draft body text is returned. Only metadata + lead name.
 *   - `autonomous_sending_still_disabled` flag from 8AX stays
 *     `mounted`; nothing here sends a message.
 *
 * Security:
 *   - requireAdmin() — owner/admin only (401/403).
 *   - Cross-tenant venue_id query gated via requireVenueRole(
 *     ADMIN_ROLES); forbidden collapses to 404.
 *   - Per-user rate limit: `admin:ai-autopilot-reviews:{userId}`.
 *
 * Query schema:
 *   venue_id?         uuid
 *   state?            'needs_review' | 'confirmed_*' |
 *                     'deferred' | 'all'                  default 'all'
 *   alignment?        'operator_more_conservative' |
 *                     'operator_less_conservative' | 'all' default 'all'
 *   limit?            1..100                              default 25
 *   occurred_before?  ISO timestamp                       strict <
 */

const DEFAULT_LIMIT = 25
const MAX_LIMIT = 100
// Hard ceiling on rows scanned per call. Same cap as the
// simulation endpoint; the helper math degrades gracefully when
// it's hit (rule signals are still correct over the sample).
const MAX_SCAN_ROWS = 1000

const QuerySchema = z.object({
  venue_id: z.string().uuid().optional(),
  state: z
    .enum([
      'needs_review',
      'confirmed_guardrail_too_strict',
      'confirmed_guardrail_correct',
      'confirmed_operator_error',
      'deferred',
      'all',
    ])
    .optional(),
  alignment: z
    .enum([
      'operator_more_conservative',
      'operator_less_conservative',
      'all',
    ])
    .optional(),
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).optional(),
  occurred_before: z.string().datetime({ offset: true }).optional(),
})

interface QueueItem {
  ai_action_id: string
  venue_id: string
  lead_id: string | null
  lead_name: string | null
  created_at: string
  autopilot_mode: 'eligible' | 'review_required' | 'blocked' | null
  operator_outcome: string | null
  edit_distance_bucket: string | null
  final_confidence: number | null
  operator_alignment: OperatorAlignment
  risk_flags: string[]
  review_state: AutopilotReviewState
  review_note: string | null
  reviewed_at: string | null
  reviewer_user_id: string | null
}

interface QueueSummary {
  total_disagreements: number
  reviewed_disagreements: number
  reviewed_disagreements_pct: number | null
  needs_review: number
  confirmed_guardrail_too_strict: number
  confirmed_guardrail_correct: number
  confirmed_operator_error: number
  deferred: number
  operator_more_conservative: number
  operator_less_conservative: number
  rule_signals: AutopilotRuleSignal[]
}

export async function GET(request: NextRequest): Promise<Response> {
  const requestId = getOrCreateRequestId(request)
  const reqLog = log.child({
    requestId,
    route: '/api/admin/ai/autopilot-reviews',
    op: 'admin.ai.autopilot_review.queue',
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
    `admin:ai-autopilot-reviews:${user.id}`
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
    state: url.searchParams.get('state') ?? undefined,
    alignment: url.searchParams.get('alignment') ?? undefined,
    limit: url.searchParams.get('limit') ?? undefined,
    occurred_before: url.searchParams.get('occurred_before') ?? undefined,
  })
  if (!parsed.success) {
    return respond(
      NextResponse.json(
        { error: 'validation_failed', detail: parsed.error.flatten() },
        { status: 400 }
      )
    )
  }
  const {
    venue_id: bodyVenueId,
    state = 'all',
    alignment = 'all',
    limit = DEFAULT_LIMIT,
    occurred_before: occurredBefore,
  } = parsed.data

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

  // 5. Fetch the scan window of `draft_regenerate` rows. We
  // intentionally over-fetch (MAX_SCAN_ROWS) for the summary
  // pass — the simulation summary needs to see EVERY
  // disagreement in the window, not just the page slice. The
  // visible page is sliced after the in-memory filter so paginated
  // calls still respect `limit + 1`.
  let actionRows: Array<{
    id: string
    venue_id: string
    lead_id: string | null
    created_at: string
    metadata: {
      variant_count?: number
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
    let q = svc
      .from('ai_actions')
      .select('id, venue_id, lead_id, created_at, metadata')
      .eq('venue_id', targetVenueId)
      .eq('agent', 'venuerise')
      .eq('action', 'draft_regenerate')
      .eq('success', true)
      .order('created_at', { ascending: false })
      .limit(MAX_SCAN_ROWS)
    if (occurredBefore) q = q.lt('created_at', occurredBefore)
    const { data, error } = await q
    if (error) throw error
    actionRows = (data as typeof actionRows) ?? []
  } catch (err) {
    reqLog.error(
      { err, targetVenueId },
      'admin.ai.autopilot_review.query_failed'
    )
    captureApiError(err, {
      requestId,
      route: '/api/admin/ai/autopilot-reviews',
      userId: user.id,
      venueId: targetVenueId,
    })
    return respond(
      NextResponse.json({ error: 'unexpected_error' }, { status: 500 })
    )
  }

  // 6. Pull every review row keyed off ai_actions in the window.
  // One round-trip; bounded by the scan size.
  const actionIds = actionRows.map((r) => r.id)
  const reviewsByActionId = new Map<
    string,
    {
      review_state: AutopilotReviewState
      note: string | null
      reviewed_at: string
      reviewer_user_id: string | null
    }
  >()
  if (actionIds.length > 0) {
    const { data: reviewRows } = await svc
      .from('ai_action_reviews')
      .select('ai_action_id, review_state, note, reviewed_at, reviewer_user_id')
      .in('ai_action_id', actionIds)
    for (const rr of (reviewRows as Array<{
      ai_action_id: string
      review_state: AutopilotReviewState
      note: string | null
      reviewed_at: string
      reviewer_user_id: string | null
    }> | null) ?? []) {
      reviewsByActionId.set(rr.ai_action_id, {
        review_state: rr.review_state,
        note: rr.note,
        reviewed_at: rr.reviewed_at,
        reviewer_user_id: rr.reviewer_user_id,
      })
    }
  }

  // 7. Project each ai_action into a queue-shape row. Filter to
  // disagreements only. Aligned + unknown rows are dropped here
  // so the queue contract stays clean — the simulation panel is
  // the place to see EVERY simulation row.
  type ProjectedRow = QueueItem & { _ts: number }
  const projected: ProjectedRow[] = []
  for (const r of actionRows) {
    const md = r.metadata ?? {}
    const decisionsArr = Array.isArray(md.autopilot_decisions)
      ? md.autopilot_decisions
      : []
    const riskArr = Array.isArray(md.variant_risk_flags)
      ? md.variant_risk_flags
      : []
    const finalArr = Array.isArray(md.variant_confidences)
      ? md.variant_confidences
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
    const opAlignment = computeOperatorAlignment({
      autopilotMode,
      operatorOutcome,
      editDistanceBucket,
    })
    if (!isDisagreement({ operatorAlignment: opAlignment })) continue
    // Alignment filter.
    if (alignment !== 'all' && opAlignment !== alignment) continue

    const risk = riskArr[idx] ?? null
    const riskFlags: string[] = []
    if (risk?.has_pricing_question) riskFlags.push('pricing')
    if (risk?.has_policy_question) riskFlags.push('policy')
    if (risk?.has_availability_claim) riskFlags.push('availability')

    const reviewRow = reviewsByActionId.get(r.id) ?? null
    const reviewState: AutopilotReviewState =
      reviewRow?.review_state ?? 'needs_review'
    // State filter.
    if (state !== 'all' && reviewState !== state) continue

    const finalRaw = finalArr[idx]
    const final =
      typeof finalRaw === 'number' && Number.isFinite(finalRaw)
        ? Math.max(0, Math.min(100, Math.round(finalRaw)))
        : null

    projected.push({
      _ts: Date.parse(r.created_at) || 0,
      ai_action_id: r.id,
      venue_id: r.venue_id,
      lead_id: r.lead_id,
      lead_name: null, // filled below
      created_at: r.created_at,
      autopilot_mode: autopilotMode,
      operator_outcome: operatorOutcome,
      edit_distance_bucket: editDistanceBucket,
      final_confidence: final,
      operator_alignment: opAlignment,
      risk_flags: riskFlags,
      review_state: reviewState,
      review_note: reviewRow?.note ?? null,
      reviewed_at: reviewRow?.reviewed_at ?? null,
      reviewer_user_id: reviewRow?.reviewer_user_id ?? null,
    })
  }

  // 8. Summary is computed over EVERY disagreement in the window
  // (not the visible page) so the counts + rule signals reflect
  // the venue's actual posture, not just what fits on screen.
  // simulation_mode mapping reused only for `would_send`-style
  // rule-signal consistency.
  void simulationModeFromAutopilotMode // keep import explicit for future widening
  const ruleSignals = computeRuleSignals(
    projected.map((p) => ({
      riskFlags: p.risk_flags,
      reviewState: p.review_state,
    }))
  )
  const summary: QueueSummary = {
    total_disagreements: projected.length,
    reviewed_disagreements: projected.filter((p) =>
      isReviewedState(p.review_state)
    ).length,
    reviewed_disagreements_pct: null, // set below
    needs_review: projected.filter((p) => p.review_state === 'needs_review')
      .length,
    confirmed_guardrail_too_strict: projected.filter(
      (p) => p.review_state === 'confirmed_guardrail_too_strict'
    ).length,
    confirmed_guardrail_correct: projected.filter(
      (p) => p.review_state === 'confirmed_guardrail_correct'
    ).length,
    confirmed_operator_error: projected.filter(
      (p) => p.review_state === 'confirmed_operator_error'
    ).length,
    deferred: projected.filter((p) => p.review_state === 'deferred').length,
    operator_more_conservative: projected.filter(
      (p) => p.operator_alignment === 'operator_more_conservative'
    ).length,
    operator_less_conservative: projected.filter(
      (p) => p.operator_alignment === 'operator_less_conservative'
    ).length,
    rule_signals: ruleSignals,
  }
  summary.reviewed_disagreements_pct = computeReviewedDisagreementsPct({
    totalDisagreements: summary.total_disagreements,
    reviewedDisagreements: summary.reviewed_disagreements,
  })

  // 9. Sort by created_at desc, slice to `limit + 1` for the
  // has_more probe, and resolve lead names for the visible page
  // only. We don't fetch lead names for every disagreement in
  // the window — that would explode the payload + leak names
  // for rows the operator can't actually see.
  projected.sort((a, b) => b._ts - a._ts)
  const overFetched = projected.slice(0, limit + 1)
  const hasMore = overFetched.length > limit
  const page = hasMore ? overFetched.slice(0, limit) : overFetched
  const nextCursor =
    hasMore && page.length > 0 ? page[page.length - 1].created_at : null

  const leadIds = Array.from(
    new Set(
      page
        .map((p) => p.lead_id)
        .filter((x): x is string => typeof x === 'string')
    )
  )
  const leadNameById = new Map<string, string | null>()
  if (leadIds.length > 0) {
    const { data: leadRows } = await svc
      .from('leads')
      .select('id, name')
      .in('id', leadIds)
    for (const lr of (leadRows as Array<{
      id: string
      name: string | null
    }> | null) ?? []) {
      leadNameById.set(lr.id, lr.name)
    }
  }
  const items: QueueItem[] = page.map((p) => {
    const { _ts: _ignored, ...rest } = p
    void _ignored
    return {
      ...rest,
      lead_name: rest.lead_id ? leadNameById.get(rest.lead_id) ?? null : null,
    }
  })

  reqLog.info(
    {
      targetVenueId,
      state,
      alignment,
      limit,
      total: summary.total_disagreements,
      reviewed: summary.reviewed_disagreements,
      pageCount: items.length,
      hasMore,
    },
    'admin.ai.autopilot_review.queue.served'
  )

  return respond(
    NextResponse.json({
      items,
      next_cursor: nextCursor,
      has_more: hasMore,
      summary,
    })
  )
}
