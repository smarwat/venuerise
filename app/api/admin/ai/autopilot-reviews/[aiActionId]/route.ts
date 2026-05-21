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
import { recordAuditEvent } from '@/lib/enterprise/audit-events'

/**
 * POST /api/admin/ai/autopilot-reviews/[aiActionId]  (Phase 8AZ)
 *
 * Records (or relabels) an operator's verdict on a single
 * `ai_actions` row where the Phase 8AX autopilot guardrail and
 * the Phase 8AW operator outcome disagreed. Upsert semantics
 * keyed on `ai_action_id` (enforced at the table level by the
 * unique constraint in migration 024): relabeling the same row
 * UPDATES the existing review, never piles up duplicates.
 *
 * Safety posture:
 *   - This route ONLY writes to `ai_action_reviews`. It never
 *     touches `ai_actions`, never modifies guardrail rules,
 *     never relaxes any threshold. The label is calibration
 *     evidence, not a control.
 *   - The `autonomous_sending_still_disabled` health flag from
 *     8AX stays `mounted`. Nothing here sends a message.
 *
 * Security:
 *   - requireAdmin() — owner/admin only (401 unauthorized, 403
 *     no_venue).
 *   - Fetched ai_action's venue is cross-checked via
 *     requireVenueRole(ADMIN_ROLES); forbidden collapses to 404
 *     so a non-admin can't probe foreign actions for existence.
 *   - The route refuses any action that isn't
 *     agent='venuerise' AND action='draft_regenerate' — labeling
 *     an unrelated action would silently poison the simulation
 *     summary.
 *   - Per-user rate limit: `admin:ai-autopilot-review:{userId}`.
 *   - Note is bounded at 500 chars by the Zod schema; no draft
 *     body content is read or written.
 */

const BodySchema = z.object({
  review_state: z.enum([
    'confirmed_guardrail_too_strict',
    'confirmed_guardrail_correct',
    'confirmed_operator_error',
    'deferred',
  ]),
  // Optional free-form note. We intentionally cap at 500 chars
  // and store via the table column (text, no length cap at the
  // DB layer) so the route's contract is the operative limit.
  // `needs_review` is NOT a writable state — see helper docs.
  note: z.string().max(500).optional(),
})

interface RouteContext {
  params: Promise<{ aiActionId: string }>
}

export async function POST(
  request: NextRequest,
  { params }: RouteContext
): Promise<Response> {
  const requestId = getOrCreateRequestId(request)
  const reqLog = log.child({
    requestId,
    route: '/api/admin/ai/autopilot-reviews/[aiActionId]',
    op: 'admin.ai.autopilot_review.write',
  })
  const respond = <T extends Response>(r: T) =>
    withRequestIdHeader(r, requestId)

  const { aiActionId } = await params

  if (!z.string().uuid().safeParse(aiActionId).success) {
    return respond(
      NextResponse.json(
        { error: 'ai_action_id must be a UUID' },
        { status: 400 }
      )
    )
  }

  // 1. Admin auth.
  const admin = await requireAdmin()
  if (!admin.ok) {
    return respond(
      NextResponse.json({ error: admin.code }, { status: admin.status })
    )
  }
  const { user } = admin

  // 2. Rate limit.
  const rl = await rateLimitUserAction(
    request,
    `admin:ai-autopilot-review:${user.id}`
  )
  if (!rl.allowed) {
    reqLog.warn(
      { userId: user.id, retryMs: rl.retryAfterMs },
      'rate_limit.blocked'
    )
    return respond(rateLimitedResponse(rl))
  }

  // 3. Parse body.
  const raw = await request.json().catch(() => null)
  const parsed = BodySchema.safeParse(raw ?? {})
  if (!parsed.success) {
    return respond(
      NextResponse.json(
        { error: 'validation_failed', detail: parsed.error.flatten() },
        { status: 400 }
      )
    )
  }
  const { review_state, note } = parsed.data

  const svc = createServiceClient()

  // 4. Lookup the ai_action. Must exist, must be the right
  // agent+action pair, and must belong to a venue the caller has
  // admin/owner role on. Any mismatch collapses to 404 — the
  // route never reveals cross-tenant existence.
  type ActionRow = {
    id: string
    venue_id: string
    agent: string
    action: string
  }
  let actionRow: ActionRow | null = null
  try {
    const { data } = await svc
      .from('ai_actions')
      .select('id, venue_id, agent, action')
      .eq('id', aiActionId)
      .maybeSingle()
    actionRow = data as ActionRow | null
  } catch (err) {
    reqLog.error(
      { err, aiActionId },
      'admin.ai.autopilot_review.action_lookup_failed'
    )
    captureApiError(err, {
      requestId,
      route: '/api/admin/ai/autopilot-reviews/[aiActionId]',
      userId: user.id,
    })
    return respond(
      NextResponse.json({ error: 'unexpected_error' }, { status: 500 })
    )
  }
  if (
    !actionRow ||
    actionRow.agent !== 'venuerise' ||
    actionRow.action !== 'draft_regenerate'
  ) {
    return respond(NextResponse.json({ error: 'not_found' }, { status: 404 }))
  }

  // 5. Cross-tenant role check. The caller's `venueId` is the
  // primary tenant; the ai_action's venue might be a different
  // one they happen to admin. Either way, require admin role on
  // the row's venue specifically.
  try {
    await requireVenueRole(user.id, actionRow.venue_id, ADMIN_ROLES)
  } catch (err) {
    if (err instanceof TenantAccessError) {
      // 403 → 404 collapse; same posture as draft-audit + sim.
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

  // 6. Upsert. Unique constraint on `ai_action_id` (migration 024)
  // makes the conflict target unambiguous. We deliberately
  // overwrite `reviewer_user_id` + `reviewed_at` on every write
  // so the audit reflects the LATEST labeler, not the first one.
  // The `metadata` jsonb carries a phase tag so future review
  // sources (e.g. an in-line drawer relabel) can be distinguished
  // from the queue path that produced this write.
  const reviewedAtIso = new Date().toISOString()
  const reviewRow = {
    venue_id: actionRow.venue_id,
    ai_action_id: actionRow.id,
    reviewer_user_id: user.id,
    review_state,
    note: note ?? null,
    metadata: { source: 'phase_8az_review_queue' },
    reviewed_at: reviewedAtIso,
  }
  try {
    const { error } = await svc
      .from('ai_action_reviews')
      .upsert(reviewRow, { onConflict: 'ai_action_id' })
    if (error) throw error
  } catch (err) {
    reqLog.error(
      { err, aiActionId, venueId: actionRow.venue_id, reviewState: review_state },
      'admin.ai.autopilot_review.upsert_failed'
    )
    captureApiError(err, {
      requestId,
      route: '/api/admin/ai/autopilot-reviews/[aiActionId]',
      userId: user.id,
      venueId: actionRow.venue_id,
    })
    return respond(
      NextResponse.json({ error: 'unexpected_error' }, { status: 500 })
    )
  }

  reqLog.info(
    {
      aiActionId,
      venueId: actionRow.venue_id,
      userId: user.id,
      reviewState: review_state,
      hasNote: Boolean(note),
    },
    'admin.ai.autopilot_review.upserted'
  )

  void recordAuditEvent({
    venueId: actionRow.venue_id,
    actorUserId: user.id,
    actorKind: 'operator',
    route: '/api/admin/ai/autopilot-reviews/[aiActionId]',
    action: 'autopilot_review_label',
    targetTable: 'ai_action_reviews',
    targetId: actionRow.id,
    requestId,
    ip: request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
    userAgent: request.headers.get('user-agent'),
    after: { review_state, reviewed_at: reviewedAtIso },
    metadata: { has_note: Boolean(note) },
  })

  return respond(
    NextResponse.json({
      success: true,
      ai_action_id: actionRow.id,
      review_state,
      reviewed_at: reviewedAtIso,
    })
  )
}
