import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { requireVenueRole, TenantAccessError } from '@/lib/auth/tenant-access'
import { SALES_ROLES } from '@/lib/auth/roles'
import { rateLimitUserAction, rateLimitedResponse } from '@/lib/rate-limit'
import { log } from '@/lib/log'
import {
  getOrCreateRequestId,
  withRequestIdHeader,
} from '@/lib/observability/request-id'
import { captureApiError } from '@/lib/observability/sentry'
import { recordAuditEvent } from '@/lib/enterprise/audit-events'

/**
 * PATCH /api/ai/actions/[id]/reject  (Phase 8AJ)
 *
 * Marks an `ai_actions` row as operator-rejected. Surfaced by the
 * LeadDetailDrawer Reject button so an operator can dismiss a stale
 * AI draft without deleting the audit row.
 *
 * Idempotent: re-rejecting an already-rejected row updates the
 * `rejected_at` timestamp and overrides `rejected_by` to the latest
 * caller. The original draft text + agent metadata stay intact for
 * forensic queries.
 *
 * Auth: requires SALES_ROLES on the venue that owns the action row.
 * Cross-tenant denial collapses to 404 so admins can't enumerate
 * AI actions across venues.
 *
 * No external side-effects (no email, no webhook). The cron and
 * orchestrator paths continue to write ai_actions normally; this
 * route ONLY toggles the rejection marker.
 */

interface RouteContext {
  params: Promise<{ id: string }>
}

const BodySchema = z.object({
  // Optional free-text breadcrumb. Capped at 240; logged but not
  // surfaced back to the client.
  reason: z.string().max(240).optional(),
})

export async function PATCH(
  request: NextRequest,
  { params }: RouteContext
): Promise<Response> {
  const requestId = getOrCreateRequestId(request)
  const reqLog = log.child({
    requestId,
    route: '/api/ai/actions/[id]/reject',
    op: 'ai.actions.reject',
  })
  const respond = <T extends Response>(r: T) => withRequestIdHeader(r, requestId)

  const { id } = await params
  if (!z.string().uuid().safeParse(id).success) {
    return respond(NextResponse.json({ error: 'id must be a UUID' }, { status: 400 }))
  }

  const supabase = await createClient()
  const {
    data: { user },
    error: userErr,
  } = await supabase.auth.getUser()
  if (userErr || !user) {
    return respond(NextResponse.json({ error: 'unauthorized' }, { status: 401 }))
  }

  // Rate limit per user — a runaway reject loop shouldn't churn the
  // table.
  const rl = await rateLimitUserAction(request, `ai-actions-reject:${user.id}`)
  if (!rl.allowed) {
    reqLog.warn({ userId: user.id, retryMs: rl.retryAfterMs }, 'rate_limit.blocked')
    return respond(rateLimitedResponse(rl))
  }

  const body = await request.json().catch(() => null)
  const parsed = BodySchema.safeParse(body ?? {})
  if (!parsed.success) {
    return respond(
      NextResponse.json(
        { error: 'validation_failed', detail: parsed.error.flatten() },
        { status: 400 }
      )
    )
  }

  // Look up the action's venue + role-gate via the same helper used
  // across the admin surface. We deliberately use the service client
  // for the lookup because the action row may have been written by
  // a cron in a different tenancy; the role check below is the auth
  // ground truth.
  const svc = createServiceClient()
  const { data: row, error: lookupErr } = await svc
    .from('ai_actions')
    .select('id, venue_id, rejected_at')
    .eq('id', id)
    .maybeSingle()
  if (lookupErr) {
    reqLog.error(
      { err: lookupErr, id },
      'ai.actions.reject.lookup_failed'
    )
    captureApiError(lookupErr, {
      requestId,
      route: '/api/ai/actions/[id]/reject',
      userId: user.id,
    })
    return respond(NextResponse.json({ error: 'unexpected_error' }, { status: 500 }))
  }
  if (!row) {
    // Collapse to 404 so the route can't be used to enumerate
    // existence of action ids across tenants.
    return respond(NextResponse.json({ error: 'not_found' }, { status: 404 }))
  }
  const actionRow = row as { id: string; venue_id: string; rejected_at: string | null }

  try {
    await requireVenueRole(user.id, actionRow.venue_id, SALES_ROLES)
  } catch (err) {
    if (err instanceof TenantAccessError) {
      // 403 collapses to 404 to match the rest of the cross-tenant
      // posture.
      const status = err.status === 403 ? 404 : err.status
      const code = err.status === 403 ? 'not_found' : err.code
      return respond(NextResponse.json({ error: code }, { status }))
    }
    throw err
  }

  const nowIso = new Date().toISOString()
  const { data: updated, error: updateErr } = await svc
    .from('ai_actions')
    .update({
      rejected_at: nowIso,
      rejected_by: user.id,
    })
    .eq('id', id)
    .select('id, rejected_at, rejected_by')
    .single()
  if (updateErr) {
    reqLog.error(
      { err: updateErr, id, venueId: actionRow.venue_id },
      'ai.actions.reject.update_failed'
    )
    captureApiError(updateErr, {
      requestId,
      route: '/api/ai/actions/[id]/reject',
      userId: user.id,
      venueId: actionRow.venue_id,
    })
    return respond(NextResponse.json({ error: 'unexpected_error' }, { status: 500 }))
  }

  reqLog.info(
    {
      id,
      venueId: actionRow.venue_id,
      userId: user.id,
      operatorReason: parsed.data.reason ?? null,
      previouslyRejected: actionRow.rejected_at !== null,
    },
    'ai.actions.reject.completed'
  )

  void recordAuditEvent({
    venueId: actionRow.venue_id,
    actorUserId: user.id,
    actorKind: 'operator',
    route: '/api/ai/actions/[id]/reject',
    action: 'ai_action_reject',
    targetTable: 'ai_actions',
    targetId: id,
    requestId,
    ip: request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
    userAgent: request.headers.get('user-agent'),
    after: {
      rejected_at: nowIso,
      previously_rejected: actionRow.rejected_at !== null,
    },
    metadata: { reason: parsed.data.reason ?? null },
  })

  return respond(NextResponse.json({ success: true, action: updated }))
}
