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
import { parseRevenueOsSettings } from '@/lib/revenue-os/settings'
import {
  computeCalibrationPageSummary,
  type CalibrationRow,
  type EditDistanceBucket,
  type OperatorOutcome,
} from '@/lib/revenue-os/brand-voice-calibration'
import {
  computeAutopilotSimulationSummary,
  computeOperatorAlignment,
  estimateTimeSavedMinutes,
  simulationModeFromAutopilotMode,
  type AutopilotSimulationMode,
  type OperatorAlignment,
  type SimulationRow,
} from '@/lib/revenue-os/autopilot-simulation'

/**
 * GET /api/admin/ai/draft-audit  (Phase 8AO)
 *
 * Operator audit feed over `ai_actions` rows produced by
 * /api/ai/draft (agent='venuerise', action='draft_regenerate').
 * Powers the AIDraftAuditCard on /dashboard/settings/billing:
 *   - JSON branch backs the card's row list + Load older pagination
 *   - CSV branch backs the card's Export button
 *
 * Why a dedicated admin route instead of an RLS-scoped browser
 * fetch (Phase 8AN's initial pattern):
 *   - CSV export has to mask emails before they leave the server.
 *     Browser-side masking would require sending raw emails over the
 *     wire — exactly the PII surface we want to avoid.
 *   - A single endpoint centralizes the lead-name join + the
 *     accepted-variant-index lookup so the card doesn't have to fan
 *     out three sequential queries.
 *
 * Security posture:
 *   - requireAdmin() — owner/admin only (401 unauthorized, 403 no_venue).
 *   - Cross-tenant `venue_id` query string is gated via
 *     requireVenueRole(ADMIN_ROLES) and collapses 403 → 404 so a
 *     non-admin can't probe other venues for existence.
 *   - rateLimitUserAction `admin:ai-draft-audit:{userId}`.
 *   - Emails are MASKED before they leave the route. The raw column
 *     never appears in the JSON response or CSV body.
 *
 * Query schema:
 *   venue_id?         uuid              defaults to caller's venue
 *   status?           all|success|failed default 'all'
 *   q?                string (<=80)     ILIKE over scalar fields
 *   occurred_before?  ISO timestamp     strict < cursor for pagination
 *   limit?            1..100            default 25
 *   format?           json|csv          default 'json'
 *
 * JSON response shape:
 *   { items: AuditItem[], next_cursor: string|null, has_more: boolean }
 *
 * CSV columns (allowlisted):
 *   id, venue_id, lead_id, lead_name, lead_email_masked, success,
 *   instruction, variant_count, accepted_variant_index, latency_ms,
 *   error, created_at
 */

const DEFAULT_LIMIT = 25
const MAX_LIMIT = 100

const QuerySchema = z.object({
  venue_id: z.string().uuid().optional(),
  status: z.enum(['all', 'success', 'failed']).optional(),
  q: z.string().max(80).optional(),
  occurred_before: z.string().datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).optional(),
  format: z.enum(['json', 'csv']).optional(),
  // Phase 8AV — filter to ai_actions whose lowest variant
  // confidence fell below the venue's `brandVoiceConfidenceFloor`.
  // Matches the AIDraftAuditCard "Low confidence" chip.
  low_confidence: z.coerce.boolean().optional(),
})

interface AuditItem {
  id: string
  venue_id: string
  lead_id: string | null
  lead_name: string | null
  lead_email_masked: string | null
  success: boolean
  instruction: string | null
  variant_count: number | null
  accepted_variant_index: number | null
  latency_ms: number | null
  error: string | null
  created_at: string
  // Phase 8AV — confidence audit fields.
  min_confidence: number | null
  low_confidence: boolean
  // Phase 8AW — per-row calibration detail. `*_confidence` mirror the
  // selected variant when an accepted_variant_index exists, falling
  // back to the variant min otherwise so the row line always has a
  // value to render. `confidence_source` exposes whether the model
  // emitted CONFIDENCE: or the heuristic carried the row.
  model_confidence: number | null
  heuristic_confidence: number | null
  final_confidence: number | null
  adjustment_delta: number | null
  confidence_source: 'model_and_heuristic' | 'heuristic_fallback' | null
  operator_outcome: OperatorOutcome | null
  edit_distance_bucket: EditDistanceBucket | null
  // Phase 8AX — autopilot guardrail detail for the row's selected
  // variant. `risk_flags` summarizes which hard-risk categories
  // fired (pricing / policy / availability), comma-joined for CSV
  // friendliness; the JSON array is also returned alongside.
  // Pre-8AX rows surface as null/empty so the card hides the line.
  autopilot_mode: 'eligible' | 'review_required' | 'blocked' | null
  autopilot_reasons: string[]
  risk_flags: string[]
  // Phase 8AY — simulation projections of the 8AX autopilot
  // decision. `simulation_mode` always renders (defaults to
  // `would_require_review` when the row pre-dates 8AX);
  // `operator_alignment` returns `unknown` for rows without an
  // outcome yet. `estimated_time_saved_minutes` is null when
  // the row didn't earn time-saved credit (only eligible+sent_as_is).
  simulation_mode: AutopilotSimulationMode
  operator_alignment: OperatorAlignment
  estimated_time_saved_minutes: number | null
}

/**
 * Mask an email to `local***@domain.com` form. The local part keeps
 * the first character + `***`; the domain stays intact so an admin
 * can disambiguate two same-local addresses across different domains.
 * Empty / unparseable values collapse to null.
 */
function maskEmail(raw: string | null | undefined): string | null {
  if (!raw) return null
  const at = raw.indexOf('@')
  if (at < 1) return null
  const local = raw.slice(0, at)
  const domain = raw.slice(at + 1)
  const head = local.charAt(0)
  return `${head}***@${domain}`
}

function escapeCsv(v: string | number | boolean | null | undefined): string {
  if (v === null || v === undefined) return ''
  const s = String(v)
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`
  return s
}

const CSV_COLUMNS: ReadonlyArray<{
  header: string
  key: keyof AuditItem
}> = [
  { header: 'id', key: 'id' },
  { header: 'venue_id', key: 'venue_id' },
  { header: 'lead_id', key: 'lead_id' },
  { header: 'lead_name', key: 'lead_name' },
  { header: 'lead_email_masked', key: 'lead_email_masked' },
  { header: 'success', key: 'success' },
  { header: 'instruction', key: 'instruction' },
  { header: 'variant_count', key: 'variant_count' },
  { header: 'accepted_variant_index', key: 'accepted_variant_index' },
  { header: 'latency_ms', key: 'latency_ms' },
  { header: 'error', key: 'error' },
  { header: 'created_at', key: 'created_at' },
  // Phase 8AV — confidence audit columns.
  { header: 'min_confidence', key: 'min_confidence' },
  { header: 'low_confidence', key: 'low_confidence' },
  // Phase 8AW — calibration detail.
  { header: 'model_confidence', key: 'model_confidence' },
  { header: 'heuristic_confidence', key: 'heuristic_confidence' },
  { header: 'final_confidence', key: 'final_confidence' },
  { header: 'adjustment_delta', key: 'adjustment_delta' },
  { header: 'confidence_source', key: 'confidence_source' },
  { header: 'operator_outcome', key: 'operator_outcome' },
  { header: 'edit_distance_bucket', key: 'edit_distance_bucket' },
  // Phase 8AX — autopilot detail.
  { header: 'autopilot_mode', key: 'autopilot_mode' },
  { header: 'risk_flags', key: 'risk_flags' },
  // Phase 8AY — simulation projections.
  { header: 'simulation_mode', key: 'simulation_mode' },
  { header: 'operator_alignment', key: 'operator_alignment' },
  {
    header: 'estimated_time_saved_minutes',
    key: 'estimated_time_saved_minutes',
  },
]

export async function GET(request: NextRequest): Promise<Response> {
  const requestId = getOrCreateRequestId(request)
  const reqLog = log.child({
    requestId,
    route: '/api/admin/ai/draft-audit',
    op: 'admin.ai.draft_audit',
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

  // 2. Rate limit — one budget per admin user, not per venue.
  const rl = await rateLimitUserAction(
    request,
    `admin:ai-draft-audit:${user.id}`
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
    status: url.searchParams.get('status') ?? undefined,
    q: url.searchParams.get('q') ?? undefined,
    occurred_before: url.searchParams.get('occurred_before') ?? undefined,
    limit: url.searchParams.get('limit') ?? undefined,
    format: url.searchParams.get('format') ?? undefined,
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
    status = 'all',
    q: qRaw,
    occurred_before: occurredBefore,
    limit = DEFAULT_LIMIT,
    format = 'json',
    low_confidence: lowConfidenceFilter = false,
  } = parsed.data

  // 4. Cross-tenant gate. Mirror the digest/sends posture: a non-admin
  // probing another venue collapses to 404 rather than 403.
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

  const q = (qRaw ?? '').trim()
  const svc = createServiceClient()

  // 5. Fetch the ai_actions slice. We over-fetch by 1 to compute
  // `has_more` without a separate count query.
  let aiQuery = svc
    .from('ai_actions')
    .select(
      'id, venue_id, lead_id, success, latency_ms, error_message, created_at, output_summary, metadata'
    )
    .eq('venue_id', targetVenueId)
    .eq('agent', 'venuerise')
    .eq('action', 'draft_regenerate')
    .order('created_at', { ascending: false })
    .limit(limit + 1)

  if (status === 'success') aiQuery = aiQuery.eq('success', true)
  else if (status === 'failed') aiQuery = aiQuery.eq('success', false)

  if (occurredBefore) aiQuery = aiQuery.lt('created_at', occurredBefore)

  if (q.length > 0) {
    // Escape ILIKE wildcards + PostgREST .or() syntax characters in
    // the operator-supplied term. Same posture as
    // /api/admin/digest/sends and /api/dashboard/search.
    const esc = q
      .replace(/\\/g, '\\\\')
      .replace(/%/g, '\\%')
      .replace(/_/g, '\\_')
      .replace(/,/g, '')
      .replace(/\(/g, '')
      .replace(/\)/g, '')
    const wrap = `*${esc}*`
    // Search the scalar columns we actually return. `id` ILIKE
    // supports the spec's "ai_actions.id prefix" use case (operator
    // copy-pastes the audit id from logs). Instruction is on the
    // metadata jsonb; we read it via `->>` ILIKE.
    aiQuery = aiQuery.or(
      [
        `id.ilike.${wrap}`,
        `error_message.ilike.${wrap}`,
        `metadata->>instruction.ilike.${wrap}`,
      ].join(',')
    )
  }

  let actionRows: Array<{
    id: string
    venue_id: string
    lead_id: string | null
    success: boolean
    latency_ms: number | null
    error_message: string | null
    created_at: string
    output_summary: string | null
    metadata: {
      variant_count?: number
      instruction?: string | null
      // Phase 8AV — confidence audit fields persisted on success.
      variant_confidences?: number[]
      min_confidence?: number | null
      // Phase 8AW — calibration audit fields.
      model_variant_confidences?: Array<number | null>
      heuristic_variant_confidences?: number[]
      confidence_adjustment_deltas?: Array<number | null>
      confidence_source?: 'model_and_heuristic' | 'heuristic_fallback'
      operator_outcome?: OperatorOutcome
      operator_outcome_at?: string
      edit_distance_bucket?: EditDistanceBucket
      selected_variant_index?: number
      // Phase 8AX — autopilot decisions + risk flags persisted in
      // /api/ai/draft. Optional + parallel to `variants_offered`.
      variant_risk_flags?: Array<{
        has_pricing_question?: boolean
        has_policy_question?: boolean
        has_availability_claim?: boolean
      }>
      autopilot_decisions?: Array<{
        mode?: 'eligible' | 'review_required' | 'blocked'
        label?: string
        helper?: string
        reasons?: string[]
        confidence?: number | null
      }>
    } | null
  }> = []
  try {
    const { data, error } = await aiQuery
    if (error) throw error
    actionRows = (data as typeof actionRows) ?? []
  } catch (err) {
    reqLog.error({ err, targetVenueId }, 'admin.ai.draft_audit.query_failed')
    captureApiError(err, {
      requestId,
      route: '/api/admin/ai/draft-audit',
      userId: user.id,
      venueId: targetVenueId,
    })
    return respond(
      NextResponse.json({ error: 'unexpected_error' }, { status: 500 })
    )
  }

  // 6. Pagination probe — we fetched `limit + 1`. If the extra row is
  // present, there's more; the cursor is the last row's created_at.
  const hasMore = actionRows.length > limit
  const page = hasMore ? actionRows.slice(0, limit) : actionRows
  const nextCursor =
    hasMore && page.length > 0 ? page[page.length - 1].created_at : null

  // 7. Lead names + emails for the slice (one `in()` call). The lead
  // join is done server-side so the masking happens BEFORE the email
  // leaves the route.
  const leadIds = Array.from(
    new Set(
      page
        .map((r) => r.lead_id)
        .filter((x): x is string => typeof x === 'string')
    )
  )
  const leadsById = new Map<
    string,
    { id: string; name: string | null; email: string | null }
  >()
  if (leadIds.length > 0) {
    const { data: leadRows } = await svc
      .from('leads')
      .select('id, name, email')
      .in('id', leadIds)
    for (const lead of (leadRows as Array<{
      id: string
      name: string | null
      email: string | null
    }> | null) ?? []) {
      leadsById.set(lead.id, lead)
    }
  }

  // 8. Accepted-variant index lookup. PostgREST `.or()` with multiple
  // `metadata->>ai_action_id.eq.<id>` clauses scoops up every accepted
  // sibling message in one round-trip. Bounded by limit so we never
  // pull more rows than ai_actions in scope.
  const acceptedIndexByAction = new Map<string, number>()
  if (page.length > 0) {
    const orExpr = page
      .map((a) => `metadata->>ai_action_id.eq.${a.id}`)
      .join(',')
    const { data: msgRows } = await svc
      .from('messages')
      .select('metadata')
      .eq('venue_id', targetVenueId)
      .eq('role', 'human')
      .or(orExpr)
      .limit(page.length * 2)
    for (const m of (msgRows as Array<{
      metadata: {
        ai_action_id?: string
        selected_variant_index?: number
      } | null
    }> | null) ?? []) {
      const aid = m.metadata?.ai_action_id
      const idx = m.metadata?.selected_variant_index
      if (typeof aid === 'string' && typeof idx === 'number') {
        if (!acceptedIndexByAction.has(aid)) {
          acceptedIndexByAction.set(aid, idx)
        }
      }
    }
  }

  // 9. Phase 8AV — fetch venue brand voice floor so we can compute
  // `low_confidence` per row + filter the page when
  // `?low_confidence=true`. One round-trip; cheap.
  const { data: venueRow } = await svc
    .from('venues')
    .select('metadata')
    .eq('id', targetVenueId)
    .maybeSingle()
  const venueSettings = parseRevenueOsSettings(
    (venueRow as { metadata?: unknown } | null)?.metadata
  )
  const brandVoiceFloor = venueSettings.brandVoiceConfidenceFloor

  // Local clamp shared by the per-row picks below — keeps the
  // "round + bound to 0..100, null otherwise" rule in one place.
  const pickConfidence = (raw: unknown): number | null => {
    if (typeof raw !== 'number' || !Number.isFinite(raw)) return null
    return Math.max(0, Math.min(100, Math.round(raw)))
  }

  // 10. Stitch the response items + mask emails.
  let items: AuditItem[] = page.map((r) => {
    const lead = r.lead_id ? leadsById.get(r.lead_id) : null
    const accepted = acceptedIndexByAction.get(r.id)
    // Phase 8AV — pick the precomputed `min_confidence` when present
    // (written by `buildAuditMetadata` in /api/ai/draft); fall back
    // to computing from the array for older rows that pre-date that
    // denorm. Rows from before Phase 8AV have neither field — those
    // surface as `min_confidence: null` + `low_confidence: false`
    // (we deliberately don't treat "no signal" as low confidence).
    const minConfRaw =
      r.metadata?.min_confidence ??
      (Array.isArray(r.metadata?.variant_confidences) &&
      r.metadata!.variant_confidences!.length > 0
        ? Math.min(...r.metadata!.variant_confidences!)
        : null)
    const minConfidence =
      typeof minConfRaw === 'number' && Number.isFinite(minConfRaw)
        ? Math.max(0, Math.min(100, Math.round(minConfRaw)))
        : null
    const lowConfidence =
      minConfidence !== null && minConfidence < brandVoiceFloor
    // Phase 8AW — calibration detail. Prefer the selected variant's
    // numbers (operator actually evaluated those) when an accepted
    // index is known; otherwise fall back to the array min so the
    // row still has a per-row context for the detail line.
    const finalArr = Array.isArray(r.metadata?.variant_confidences)
      ? (r.metadata!.variant_confidences as number[])
      : []
    const modelArr = Array.isArray(r.metadata?.model_variant_confidences)
      ? (r.metadata!.model_variant_confidences as Array<number | null>)
      : []
    const heurArr = Array.isArray(r.metadata?.heuristic_variant_confidences)
      ? (r.metadata!.heuristic_variant_confidences as number[])
      : []
    const deltaArr = Array.isArray(r.metadata?.confidence_adjustment_deltas)
      ? (r.metadata!.confidence_adjustment_deltas as Array<number | null>)
      : []
    const idxForPick =
      typeof accepted === 'number'
        ? accepted
        : finalArr.length > 0
          ? finalArr.indexOf(Math.min(...finalArr))
          : -1
    const finalForRow =
      idxForPick >= 0 ? pickConfidence(finalArr[idxForPick]) : minConfidence
    const modelForRow =
      idxForPick >= 0 ? pickConfidence(modelArr[idxForPick]) : null
    const heurForRow =
      idxForPick >= 0 ? pickConfidence(heurArr[idxForPick]) : null
    const deltaForRow =
      idxForPick >= 0 &&
      typeof deltaArr[idxForPick] === 'number' &&
      Number.isFinite(deltaArr[idxForPick] as number)
        ? Math.round(deltaArr[idxForPick] as number)
        : null
    const confidenceSource = r.metadata?.confidence_source ?? null
    const operatorOutcome = r.metadata?.operator_outcome ?? null
    const editDistanceBucket = r.metadata?.edit_distance_bucket ?? null
    // Phase 8AX — pick the autopilot decision + risk flags for the
    // same variant `idxForPick` we used for the calibration line
    // above. Keeps the row consistent: the operator sees the
    // numbers and the decision for the SAME variant.
    const decisionsArr = Array.isArray(r.metadata?.autopilot_decisions)
      ? (r.metadata!.autopilot_decisions as Array<{
          mode?: 'eligible' | 'review_required' | 'blocked'
          reasons?: string[]
        }>)
      : []
    const riskArr = Array.isArray(r.metadata?.variant_risk_flags)
      ? (r.metadata!.variant_risk_flags as Array<{
          has_pricing_question?: boolean
          has_policy_question?: boolean
          has_availability_claim?: boolean
        }>)
      : []
    const decisionForRow =
      idxForPick >= 0 ? decisionsArr[idxForPick] ?? null : null
    const riskForRow =
      idxForPick >= 0 ? riskArr[idxForPick] ?? null : null
    const autopilotMode: 'eligible' | 'review_required' | 'blocked' | null =
      decisionForRow?.mode === 'eligible' ||
      decisionForRow?.mode === 'review_required' ||
      decisionForRow?.mode === 'blocked'
        ? decisionForRow.mode
        : null
    const autopilotReasons = Array.isArray(decisionForRow?.reasons)
      ? (decisionForRow!.reasons as string[])
      : []
    const riskFlagList: string[] = []
    if (riskForRow?.has_pricing_question) riskFlagList.push('pricing')
    if (riskForRow?.has_policy_question) riskFlagList.push('policy')
    if (riskForRow?.has_availability_claim) riskFlagList.push('availability')
    // Phase 8AY — simulation projections. Driven by the SAME
    // autopilot_mode + operator_outcome already exposed on the
    // row so the panel + per-row badge + summary block can never
    // disagree. `operator_outcome_at` (written by /api/conversations/
    // [id]/messages in 8AW) is the operator-send timestamp; we
    // pass it as `sentAt` so the time-saved estimate can use real
    // elapsed wall time when available, falling back to the flat
    // 3-minute credit defined in the helper.
    const simulationMode = simulationModeFromAutopilotMode(autopilotMode)
    const operatorAlignment = computeOperatorAlignment({
      autopilotMode,
      operatorOutcome,
      editDistanceBucket,
    })
    const estimatedTimeSavedMinutes = estimateTimeSavedMinutes({
      autopilotMode,
      operatorOutcome,
      createdAt: r.created_at,
      sentAt: r.metadata?.operator_outcome_at ?? null,
    })
    return {
      id: r.id,
      venue_id: r.venue_id,
      lead_id: r.lead_id,
      lead_name: lead?.name ?? null,
      lead_email_masked: maskEmail(lead?.email ?? null),
      success: r.success,
      instruction: r.metadata?.instruction ?? null,
      variant_count: r.metadata?.variant_count ?? null,
      accepted_variant_index: typeof accepted === 'number' ? accepted : null,
      latency_ms: r.latency_ms,
      error: r.error_message,
      created_at: r.created_at,
      min_confidence: minConfidence,
      low_confidence: lowConfidence,
      model_confidence: modelForRow,
      heuristic_confidence: heurForRow,
      final_confidence: finalForRow,
      adjustment_delta: deltaForRow,
      confidence_source: confidenceSource,
      operator_outcome: operatorOutcome,
      edit_distance_bucket: editDistanceBucket,
      autopilot_mode: autopilotMode,
      autopilot_reasons: autopilotReasons,
      risk_flags: riskFlagList,
      simulation_mode: simulationMode,
      operator_alignment: operatorAlignment,
      estimated_time_saved_minutes: estimatedTimeSavedMinutes,
    }
  })

  // Post-hoc filter for `?low_confidence=true`. PostgREST can't
  // easily filter on a jsonb-array min, so we filter the loaded
  // slice in memory. The slice is bounded by `limit + 1`; in
  // practice this only ever shrinks results.
  if (lowConfidenceFilter) {
    items = items.filter((it) => it.low_confidence)
  }

  // Phase 8AW — calibration page summary. Computed against the
  // SLICE we're about to return (operator-meaningful: "what does
  // this page of audit say about my brand voice today"). The
  // BrandVoiceCalibrationPanel renders the tiles + signal cards.
  // We project each item onto the CalibrationRow shape rather than
  // re-walking the raw metadata so the helper sees the same numbers
  // the operator does in the row list (consistency > completeness).
  const calibrationRows: CalibrationRow[] = page.map((r) => {
    const item = items.find((it) => it.id === r.id)
    return {
      success: r.success,
      final_confidence: item?.final_confidence ?? null,
      model_confidence: item?.model_confidence ?? null,
      heuristic_confidence: item?.heuristic_confidence ?? null,
      adjustment_delta: item?.adjustment_delta ?? null,
      low_confidence: item?.low_confidence ?? false,
      operator_outcome: item?.operator_outcome ?? null,
      edit_distance_bucket: item?.edit_distance_bucket ?? null,
      // Concatenate instruction + output_summary as the scan corpus
      // for the "needs more venue context" heuristic. Both fields
      // are already capped server-side so this stays bounded.
      context_text: [r.metadata?.instruction ?? '', r.output_summary ?? '']
        .filter((s) => typeof s === 'string' && s.length > 0)
        .join(' ')
        .trim() || null,
    }
  })
  const pageSummary = computeCalibrationPageSummary(calibrationRows)

  // Phase 8AX — autopilot readiness breakdown. Computed off the
  // already-loaded `items` slice; same posture as the calibration
  // summary (no extra DB hit). Rows that pre-date 8AX (autopilot_
  // mode === null) fall into `unknown` so the operator sees how
  // much of the page is older data they shouldn't read into.
  const autopilotBreakdown = {
    eligible: 0,
    review_required: 0,
    blocked: 0,
    unknown: 0,
  }
  for (const it of items) {
    if (it.autopilot_mode === 'eligible') autopilotBreakdown.eligible += 1
    else if (it.autopilot_mode === 'review_required')
      autopilotBreakdown.review_required += 1
    else if (it.autopilot_mode === 'blocked') autopilotBreakdown.blocked += 1
    else autopilotBreakdown.unknown += 1
  }

  // Phase 8AY — page-scoped autopilot simulation summary. Same
  // shape the dedicated /api/admin/ai/autopilot-simulation
  // endpoint returns, but bounded to the loaded slice so the
  // AIDraftAuditCard / inline panel can render without a second
  // fetch. The dedicated endpoint widens the window to 30 days
  // by default for the AutopilotSimulationPanel.
  const simulationRows: SimulationRow[] = page.map((r) => {
    const item = items.find((it) => it.id === r.id)
    return {
      autopilotMode: item?.autopilot_mode ?? null,
      operatorOutcome: item?.operator_outcome ?? null,
      editDistanceBucket: item?.edit_distance_bucket ?? null,
      createdAt: r.created_at,
      sentAt: r.metadata?.operator_outcome_at ?? null,
    }
  })
  const autopilotSimulationSummary =
    computeAutopilotSimulationSummary(simulationRows)

  reqLog.info(
    {
      targetVenueId,
      status,
      qLen: q.length,
      limit,
      format,
      count: items.length,
      hasMore,
    },
    'admin.ai.draft_audit.served'
  )

  // 10. CSV branch.
  if (format === 'csv') {
    const header = CSV_COLUMNS.map((c) => c.header).join(',')
    const rows = items.map((it) =>
      CSV_COLUMNS.map((c) => {
        const v = it[c.key]
        // Phase 8AX — `autopilot_reasons` + `risk_flags` are
        // string[]; join with `|` so each row stays one CSV cell.
        // `|` over `,` keeps Excel's split-on-comma intact.
        if (Array.isArray(v)) return escapeCsv(v.join('|'))
        return escapeCsv(
          v as string | number | boolean | null | undefined
        )
      }).join(',')
    )
    // UTF-8 BOM so Excel auto-detects the encoding.
    const body = '﻿' + [header, ...rows].join('\r\n') + '\r\n'
    const date = new Date().toISOString().slice(0, 10)
    const headers: Record<string, string> = {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="ai-draft-audit-${date}.csv"`,
      'Cache-Control': 'no-store',
      'X-Request-Id': requestId,
      'X-Has-More': hasMore ? 'true' : 'false',
    }
    if (hasMore && nextCursor) headers['X-Next-Cursor'] = nextCursor
    return respond(new NextResponse(body, { status: 200, headers }))
  }

  // 11. JSON branch.
  return respond(
    NextResponse.json({
      items,
      next_cursor: nextCursor,
      has_more: hasMore,
      // Phase 8AW — slice-scoped calibration summary. Named
      // `page_summary` to be explicit that it reflects the loaded
      // page, not a full historical aggregate.
      page_summary: pageSummary,
      // Phase 8AX — autopilot readiness breakdown over the same
      // slice. Sibling to `page_summary` (not nested inside it)
      // so a future surface can render either independently
      // without re-parsing the calibration block.
      autopilot_breakdown: autopilotBreakdown,
      // Phase 8AY — page-scoped simulation summary. Mirrors the
      // dedicated /api/admin/ai/autopilot-simulation endpoint
      // (which uses a wider window). Embedded here so the page
      // CSV export carries the simulation columns + an admin
      // can sanity-check the panel against the row data without
      // a second fetch.
      autopilot_simulation_summary: autopilotSimulationSummary,
    })
  )
}
