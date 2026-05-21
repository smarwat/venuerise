import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import {
  requireVenueRole,
  TenantAccessError,
} from '@/lib/auth/tenant-access'
import { ADMIN_ROLES } from '@/lib/auth/roles'
import {
  getOrCreateRequestId,
  withRequestIdHeader,
} from '@/lib/observability/request-id'
import { captureApiError } from '@/lib/observability/sentry'
import { log } from '@/lib/log'
import { recordAuditEvent } from '@/lib/enterprise/audit-events'
import { rateLimitUserAction, rateLimitedResponse } from '@/lib/rate-limit'

/**
 * DELETE /api/venues/[id]/tour-blackouts/[blackoutId]  (Phase 8BC)
 *
 * Remove a single blackout date. Cross-tenant guard: the URL says
 * "this venue's blackout X", but a misguided caller could pass a
 * blackout that belongs to a different venue they happen to admin.
 * We require both that the caller has ADMIN_ROLES on the URL venue
 * AND that the blackout row's venue matches the URL venue;
 * mismatch collapses to 404.
 *
 * No PATCH today — blackouts are tiny tuples (date + optional
 * reason). The UX is "delete + re-add" which is clearer than
 * "edit" for this shape. Trivial to add later if a venue complains
 * about losing the row's id on a reason-only edit.
 */

interface RouteContext {
  params: Promise<{ id: string; blackoutId: string }>
}

export async function DELETE(
  request: NextRequest,
  context: RouteContext
): Promise<Response> {
  const requestId = getOrCreateRequestId(request)
  const respond = <T extends Response>(r: T) =>
    withRequestIdHeader(r, requestId)
  const reqLog = log.child({
    requestId,
    route: '/api/venues/[id]/tour-blackouts/[blackoutId]',
    op: 'venue.tour_blackouts.delete',
  })

  const { id: venueId, blackoutId } = await context.params
  if (
    !z.string().uuid().safeParse(venueId).success ||
    !z.string().uuid().safeParse(blackoutId).success
  ) {
    return respond(
      NextResponse.json({ error: 'validation_failed' }, { status: 400 })
    )
  }

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return respond(
      NextResponse.json({ error: 'unauthorized' }, { status: 401 })
    )
  }

  try {
    await requireVenueRole(user.id, venueId, ADMIN_ROLES)
  } catch (err) {
    if (err instanceof TenantAccessError) {
      const status = err.status === 403 ? 404 : err.status
      return respond(NextResponse.json({ error: err.code }, { status }))
    }
    throw err
  }

  // Phase 9F — per-user rate limit.
  const rl = await rateLimitUserAction(
    request,
    `venues:blackouts:delete:${user.id}`,
    {
      route: '/api/venues/[id]/tour-blackouts/[blackoutId]',
      method: 'DELETE',
      userId: user.id,
      venueId,
      requestId,
    }
  )
  if (!rl.allowed) {
    reqLog.warn(
      { userId: user.id, retryMs: rl.retryAfterMs },
      'rate_limit.blocked'
    )
    return respond(rateLimitedResponse(rl))
  }

  // Cross-tenant blackout guard. Same posture as the availability
  // PATCH/DELETE sibling.
  const { data: blackoutRow } = await supabase
    .from('tour_blackouts')
    .select('id, venue_id')
    .eq('id', blackoutId)
    .maybeSingle()
  if (
    !blackoutRow ||
    (blackoutRow as { venue_id: string }).venue_id !== venueId
  ) {
    return respond(NextResponse.json({ error: 'not_found' }, { status: 404 }))
  }

  const { error } = await supabase
    .from('tour_blackouts')
    .delete()
    .eq('id', blackoutId)
    .eq('venue_id', venueId)
  if (error) {
    reqLog.error(
      { err: error, venueId, blackoutId },
      'venue.tour_blackouts.delete_failed'
    )
    captureApiError(error, {
      requestId,
      route: '/api/venues/[id]/tour-blackouts/[blackoutId]',
      userId: user.id,
      venueId,
    })
    return respond(
      NextResponse.json({ error: 'unexpected_error' }, { status: 500 })
    )
  }
  void recordAuditEvent({
    venueId,
    actorUserId: user.id,
    actorKind: 'operator',
    route: '/api/venues/[id]/tour-blackouts/[blackoutId]',
    action: 'tour_blackout_delete',
    targetTable: 'tour_blackouts',
    targetId: blackoutId,
    requestId,
    ip: request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
    userAgent: request.headers.get('user-agent'),
  })
  return respond(NextResponse.json({ success: true }))
}
