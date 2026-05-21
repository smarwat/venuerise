import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import {
  requireVenueRole,
  TenantAccessError,
} from '@/lib/auth/tenant-access'
import { SALES_ROLES } from '@/lib/auth/roles'
import {
  getOrCreateRequestId,
  withRequestIdHeader,
} from '@/lib/observability/request-id'
import { captureApiError } from '@/lib/observability/sentry'
import { log } from '@/lib/log'
import { recordAuditEvent } from '@/lib/enterprise/audit-events'
import { rateLimitUserAction, rateLimitedResponse } from '@/lib/rate-limit'

/**
 * /api/venues/[id]/availability/[slotId]  (Settings → Availability tab)
 *
 * Per-slot mutations:
 *   - PATCH  — update one or more of {start_time, end_time,
 *              is_active}; day_of_week is intentionally NOT
 *              editable here (deleting + re-adding under a
 *              different day is clearer than letting a slot
 *              hop weekdays)
 *   - DELETE — remove the slot
 *
 * Cross-tenant safety: we verify both that the caller has
 * SALES_ROLES on the URL venue AND that the slot itself belongs
 * to that venue. Mismatched slot → 404 (don't leak existence
 * across tenants).
 */

const TIME_REGEX = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/

const UpdateSlotSchema = z
  .object({
    start_time: z.string().regex(TIME_REGEX, 'Use HH:MM').optional(),
    end_time: z.string().regex(TIME_REGEX, 'Use HH:MM').optional(),
    is_active: z.boolean().optional(),
  })
  .refine((v) => {
    // Only validate ordering when BOTH times are supplied — a
    // PATCH that only flips `is_active` shouldn't require the
    // client to also resend the start/end pair.
    if (v.start_time && v.end_time) return v.start_time < v.end_time
    return true
  }, {
    message: 'start_time must be before end_time',
    path: ['end_time'],
  })

interface RouteContext {
  params: Promise<{ id: string; slotId: string }>
}

async function authorize(
  request: NextRequest,
  context: RouteContext
): Promise<
  | { ok: true; userId: string; venueId: string; slotId: string }
  | { ok: false; response: Response }
> {
  const requestId = getOrCreateRequestId(request)
  const respond = <T extends Response>(r: T) =>
    withRequestIdHeader(r, requestId)
  const { id: venueId, slotId } = await context.params
  if (
    !z.string().uuid().safeParse(venueId).success ||
    !z.string().uuid().safeParse(slotId).success
  ) {
    return {
      ok: false,
      response: respond(
        NextResponse.json({ error: 'validation_failed' }, { status: 400 })
      ),
    }
  }
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return {
      ok: false,
      response: respond(
        NextResponse.json({ error: 'unauthorized' }, { status: 401 })
      ),
    }
  }
  try {
    await requireVenueRole(user.id, venueId, SALES_ROLES)
  } catch (err) {
    if (err instanceof TenantAccessError) {
      const status = err.status === 403 ? 404 : err.status
      return {
        ok: false,
        response: respond(
          NextResponse.json({ error: err.code }, { status })
        ),
      }
    }
    throw err
  }
  // Cross-tenant slot guard. The URL says "this venue's slot
  // X", but a malicious caller could pass a slot that belongs
  // to a different venue they happen to admin. Require the
  // slot's venue to match the URL venue, collapsing mismatch
  // to 404.
  const { data: slotRow } = await supabase
    .from('tour_availability')
    .select('id, venue_id')
    .eq('id', slotId)
    .maybeSingle()
  if (!slotRow || (slotRow as { venue_id: string }).venue_id !== venueId) {
    return {
      ok: false,
      response: respond(
        NextResponse.json({ error: 'not_found' }, { status: 404 })
      ),
    }
  }
  return { ok: true, userId: user.id, venueId, slotId }
}

export async function PATCH(
  request: NextRequest,
  context: RouteContext
): Promise<Response> {
  const requestId = getOrCreateRequestId(request)
  const respond = <T extends Response>(r: T) =>
    withRequestIdHeader(r, requestId)
  const reqLog = log.child({
    requestId,
    route: '/api/venues/[id]/availability/[slotId]',
    op: 'venue.availability.update',
  })

  const auth = await authorize(request, context)
  if (!auth.ok) return auth.response
  const { userId, venueId, slotId } = auth

  // Phase 9F — per-user rate limit (post-auth so the limiter key
  // resolves to the authenticated user).
  const rlPatch = await rateLimitUserAction(
    request,
    `venues:availability:update:${userId}`,
    {
      route: '/api/venues/[id]/availability/[slotId]',
      method: 'PATCH',
      userId,
      venueId,
      requestId,
    }
  )
  if (!rlPatch.allowed) {
    reqLog.warn({ userId, retryMs: rlPatch.retryAfterMs }, 'rate_limit.blocked')
    return respond(rateLimitedResponse(rlPatch))
  }

  const body = await request.json().catch(() => null)
  const parsed = UpdateSlotSchema.safeParse(body ?? {})
  if (!parsed.success) {
    return respond(
      NextResponse.json(
        { error: 'validation_failed', detail: parsed.error.flatten() },
        { status: 400 }
      )
    )
  }

  // Reject empty updates so callers don't accidentally bump
  // `updated_at` with no change. (The table doesn't track
  // updated_at today; defensive anyway.)
  const patch: Record<string, unknown> = {}
  if (parsed.data.start_time !== undefined) patch.start_time = parsed.data.start_time
  if (parsed.data.end_time !== undefined) patch.end_time = parsed.data.end_time
  if (parsed.data.is_active !== undefined) patch.is_active = parsed.data.is_active
  if (Object.keys(patch).length === 0) {
    return respond(
      NextResponse.json(
        { error: 'validation_failed', detail: 'no fields to update' },
        { status: 400 }
      )
    )
  }

  // Cross-field ordering check: when only ONE time is sent in
  // a PATCH, we re-read the row's current value for the other
  // side so an "edit just the end time" can still validate.
  if (
    (parsed.data.start_time && !parsed.data.end_time) ||
    (!parsed.data.start_time && parsed.data.end_time)
  ) {
    const supabase = await createClient()
    const { data: current } = await supabase
      .from('tour_availability')
      .select('start_time, end_time')
      .eq('id', slotId)
      .single()
    const cur = current as { start_time: string; end_time: string } | null
    const nextStart = parsed.data.start_time ?? cur?.start_time
    const nextEnd = parsed.data.end_time ?? cur?.end_time
    if (!nextStart || !nextEnd || nextStart >= nextEnd) {
      return respond(
        NextResponse.json(
          { error: 'validation_failed', detail: 'start_time must be before end_time' },
          { status: 400 }
        )
      )
    }
  }

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('tour_availability')
    .update(patch)
    .eq('id', slotId)
    .eq('venue_id', venueId)
    .select('id, venue_id, day_of_week, start_time, end_time, is_active, created_at')
    .single()
  if (error) {
    reqLog.error(
      { err: error, venueId, slotId },
      'venue.availability.update_failed'
    )
    captureApiError(error, {
      requestId,
      route: '/api/venues/[id]/availability/[slotId]',
      userId,
      venueId,
    })
    return respond(
      NextResponse.json({ error: 'unexpected_error' }, { status: 500 })
    )
  }
  void recordAuditEvent({
    venueId,
    actorUserId: userId,
    actorKind: 'operator',
    route: '/api/venues/[id]/availability/[slotId]',
    action: 'availability_update',
    targetTable: 'tour_availability',
    targetId: slotId,
    requestId,
    ip: request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
    userAgent: request.headers.get('user-agent'),
    metadata: { fields: Object.keys(patch) },
  })
  return respond(NextResponse.json({ success: true, item: data }))
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
    route: '/api/venues/[id]/availability/[slotId]',
    op: 'venue.availability.delete',
  })

  const auth = await authorize(request, context)
  if (!auth.ok) return auth.response
  const { userId, venueId, slotId } = auth

  // Phase 9F — per-user rate limit.
  const rlDel = await rateLimitUserAction(
    request,
    `venues:availability:delete:${userId}`,
    {
      route: '/api/venues/[id]/availability/[slotId]',
      method: 'DELETE',
      userId,
      venueId,
      requestId,
    }
  )
  if (!rlDel.allowed) {
    reqLog.warn({ userId, retryMs: rlDel.retryAfterMs }, 'rate_limit.blocked')
    return respond(rateLimitedResponse(rlDel))
  }

  const supabase = await createClient()
  const { error } = await supabase
    .from('tour_availability')
    .delete()
    .eq('id', slotId)
    .eq('venue_id', venueId)
  if (error) {
    reqLog.error(
      { err: error, venueId, slotId },
      'venue.availability.delete_failed'
    )
    captureApiError(error, {
      requestId,
      route: '/api/venues/[id]/availability/[slotId]',
      userId,
      venueId,
    })
    return respond(
      NextResponse.json({ error: 'unexpected_error' }, { status: 500 })
    )
  }
  void recordAuditEvent({
    venueId,
    actorUserId: userId,
    actorKind: 'operator',
    route: '/api/venues/[id]/availability/[slotId]',
    action: 'availability_delete',
    targetTable: 'tour_availability',
    targetId: slotId,
    requestId,
    ip: request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
    userAgent: request.headers.get('user-agent'),
  })
  return respond(NextResponse.json({ success: true }))
}
