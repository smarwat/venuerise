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
 * /api/venues/[id]/availability  (Settings → Availability tab)
 *
 * Tour availability windows per venue. Surfaces:
 *   - GET    — list active+inactive slots for the venue
 *   - POST   — create a new slot
 *
 * Per-slot PATCH/DELETE live on the sibling
 * `/[slotId]/route.ts`.
 *
 * Why route-side instead of direct browser writes:
 *   - centralizes Zod validation (`start_time < end_time`,
 *     `day_of_week ∈ [0,6]`)
 *   - gives us a single place to enforce the SALES_ROLES gate
 *     even if a future RLS change widens the table
 *   - returns the canonical row shape so the UI can drop
 *     `data` straight into state on POST
 *
 * Revenue OS: these windows are the source for future tour-slot suggestions.
 */

const TIME_REGEX = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/

const CreateSlotSchema = z
  .object({
    day_of_week: z.number().int().min(0).max(6),
    start_time: z.string().regex(TIME_REGEX, 'Use HH:MM'),
    end_time: z.string().regex(TIME_REGEX, 'Use HH:MM'),
    is_active: z.boolean().optional().default(true),
  })
  .refine((v) => v.start_time < v.end_time, {
    message: 'start_time must be before end_time',
    path: ['end_time'],
  })

interface RouteContext {
  params: Promise<{ id: string }>
}

export async function GET(
  request: NextRequest,
  { params }: RouteContext
): Promise<Response> {
  const requestId = getOrCreateRequestId(request)
  const respond = <T extends Response>(r: T) =>
    withRequestIdHeader(r, requestId)
  const reqLog = log.child({
    requestId,
    route: '/api/venues/[id]/availability',
    op: 'venue.availability.list',
  })

  const { id: venueId } = await params
  if (!z.string().uuid().safeParse(venueId).success) {
    return respond(
      NextResponse.json(
        { error: 'validation_failed' },
        { status: 400 }
      )
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

  // Any member can READ tour availability — these are the same
  // windows the Tour Booking surfaces will read for suggestions.
  // Membership is enforced by RLS on the table; we also do an
  // explicit cross-tenant check to collapse forbidden → 404 in
  // line with the rest of the admin surface.
  try {
    await requireVenueRole(user.id, venueId, SALES_ROLES)
  } catch (err) {
    if (err instanceof TenantAccessError) {
      const status = err.status === 403 ? 404 : err.status
      return respond(NextResponse.json({ error: err.code }, { status }))
    }
    throw err
  }

  const { data, error } = await supabase
    .from('tour_availability')
    .select('id, venue_id, day_of_week, start_time, end_time, is_active, created_at')
    .eq('venue_id', venueId)
    .order('day_of_week', { ascending: true })
    .order('start_time', { ascending: true })
  if (error) {
    reqLog.error({ err: error, venueId }, 'venue.availability.list_failed')
    captureApiError(error, {
      requestId,
      route: '/api/venues/[id]/availability',
      userId: user.id,
      venueId,
    })
    return respond(
      NextResponse.json({ error: 'unexpected_error' }, { status: 500 })
    )
  }

  return respond(NextResponse.json({ items: data ?? [] }))
}

export async function POST(
  request: NextRequest,
  { params }: RouteContext
): Promise<Response> {
  const requestId = getOrCreateRequestId(request)
  const respond = <T extends Response>(r: T) =>
    withRequestIdHeader(r, requestId)
  const reqLog = log.child({
    requestId,
    route: '/api/venues/[id]/availability',
    op: 'venue.availability.create',
  })

  const { id: venueId } = await params
  if (!z.string().uuid().safeParse(venueId).success) {
    return respond(
      NextResponse.json(
        { error: 'validation_failed' },
        { status: 400 }
      )
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

  // SALES_ROLES matches migration 005's RLS write policy on
  // `tour_availability`. Coordinators + sales managers manage
  // tour windows; we don't gate this on full admin role.
  try {
    await requireVenueRole(user.id, venueId, SALES_ROLES)
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
    `venues:availability:create:${user.id}`,
    {
      route: '/api/venues/[id]/availability',
      method: 'POST',
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

  const body = await request.json().catch(() => null)
  const parsed = CreateSlotSchema.safeParse(body ?? {})
  if (!parsed.success) {
    return respond(
      NextResponse.json(
        { error: 'validation_failed', detail: parsed.error.flatten() },
        { status: 400 }
      )
    )
  }

  const { data, error } = await supabase
    .from('tour_availability')
    .insert({
      venue_id: venueId,
      day_of_week: parsed.data.day_of_week,
      start_time: parsed.data.start_time,
      end_time: parsed.data.end_time,
      is_active: parsed.data.is_active,
    })
    .select('id, venue_id, day_of_week, start_time, end_time, is_active, created_at')
    .single()
  if (error) {
    reqLog.error(
      { err: error, venueId },
      'venue.availability.create_failed'
    )
    captureApiError(error, {
      requestId,
      route: '/api/venues/[id]/availability',
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
    route: '/api/venues/[id]/availability',
    action: 'availability_create',
    targetTable: 'tour_availability',
    targetId: (data as { id?: string } | null)?.id ?? null,
    requestId,
    ip: request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
    userAgent: request.headers.get('user-agent'),
    after: {
      day_of_week: parsed.data.day_of_week,
      start_time: parsed.data.start_time,
      end_time: parsed.data.end_time,
      is_active: parsed.data.is_active,
    },
  })
  return respond(NextResponse.json({ success: true, item: data }))
}
