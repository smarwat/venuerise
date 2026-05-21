import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import {
  requireVenueRole,
  TenantAccessError,
} from '@/lib/auth/tenant-access'
import { ADMIN_ROLES, SALES_ROLES } from '@/lib/auth/roles'
import {
  getOrCreateRequestId,
  withRequestIdHeader,
} from '@/lib/observability/request-id'
import { captureApiError } from '@/lib/observability/sentry'
import { log } from '@/lib/log'
import { recordAuditEvent } from '@/lib/enterprise/audit-events'
import { rateLimitUserAction, rateLimitedResponse } from '@/lib/rate-limit'

/**
 * /api/venues/[id]/tour-blackouts  (Phase 8BC — Settings → Availability)
 *
 * Operator-managed blackout dates per venue. Surfaces:
 *   - GET   — list rows (sales roles)
 *   - POST  — add a row (owner/admin only)
 *
 * Per-row DELETE lives on the sibling `[blackoutId]/route.ts`.
 *
 * Blackouts feed `suggestTourSlots` (Phase 8BB → 8BC) — candidates
 * whose local date matches a blackout row are dropped before being
 * surfaced as chips in the LeadDetailDrawer. They DO NOT cancel
 * existing tours and DO NOT prevent the operator from manually
 * scheduling a tour on a blackout date from the drawer's date
 * picker.
 *
 * Auth posture mirrors `/api/venues/[id]/availability` (Phase 8BB):
 * 401 unauth, 403→404 cross-tenant, Zod validation, snake_case
 * row shape returned so the UI can drop `item` straight into
 * state.
 */

// `YYYY-MM-DD` only. The table column is `date`; we keep the wire
// format intentionally simple so a future cron / digest surface
// can compose `blackout_date >= now()` without parsing timestamps.
const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/

const CreateBlackoutSchema = z.object({
  blackout_date: z.string().regex(DATE_REGEX, 'Use YYYY-MM-DD'),
  // Optional free-text label ("Memorial Day", "Private event").
  // Capped at 240 chars to match the rest of the operator-facing
  // free-text surfaces.
  reason: z.string().max(240).optional(),
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
    route: '/api/venues/[id]/tour-blackouts',
    op: 'venue.tour_blackouts.list',
  })

  const { id: venueId } = await params
  if (!z.string().uuid().safeParse(venueId).success) {
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

  // Read: any sales-role member can list blackouts (same posture as
  // the availability GET — the LeadDetailDrawer needs both).
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
    .from('tour_blackouts')
    .select('id, venue_id, blackout_date, reason, created_at')
    .eq('venue_id', venueId)
    .order('blackout_date', { ascending: true })
  if (error) {
    reqLog.error(
      { err: error, venueId },
      'venue.tour_blackouts.list_failed'
    )
    captureApiError(error, {
      requestId,
      route: '/api/venues/[id]/tour-blackouts',
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
    route: '/api/venues/[id]/tour-blackouts',
    op: 'venue.tour_blackouts.create',
  })

  const { id: venueId } = await params
  if (!z.string().uuid().safeParse(venueId).success) {
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

  // Write: ADMIN_ROLES only. Coordinators set their own tour
  // windows but blackouts are venue-wide policy + should require
  // an owner/admin hand. Matches migration 025's RLS write policy
  // so route + DB agree.
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
    `venues:blackouts:create:${user.id}`,
    {
      route: '/api/venues/[id]/tour-blackouts',
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
  const parsed = CreateBlackoutSchema.safeParse(body ?? {})
  if (!parsed.success) {
    return respond(
      NextResponse.json(
        { error: 'validation_failed', detail: parsed.error.flatten() },
        { status: 400 }
      )
    )
  }

  const { data, error } = await supabase
    .from('tour_blackouts')
    .insert({
      venue_id: venueId,
      blackout_date: parsed.data.blackout_date,
      reason: parsed.data.reason ?? null,
    })
    .select('id, venue_id, blackout_date, reason, created_at')
    .single()
  if (error) {
    // The unique constraint on (venue_id, blackout_date) surfaces
    // PostgREST code 23505. Translate to a friendlier `conflict`
    // so the UI can render "already blacked out" instead of a
    // generic 500.
    const code = (error as { code?: string }).code
    if (code === '23505') {
      return respond(
        NextResponse.json(
          { error: 'conflict', detail: 'date already blocked' },
          { status: 409 }
        )
      )
    }
    reqLog.error(
      { err: error, venueId },
      'venue.tour_blackouts.create_failed'
    )
    captureApiError(error, {
      requestId,
      route: '/api/venues/[id]/tour-blackouts',
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
    route: '/api/venues/[id]/tour-blackouts',
    action: 'tour_blackout_create',
    targetTable: 'tour_blackouts',
    targetId: (data as { id?: string } | null)?.id ?? null,
    requestId,
    ip: request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
    userAgent: request.headers.get('user-agent'),
    after: {
      blackout_date: parsed.data.blackout_date,
      reason: parsed.data.reason ?? null,
    },
  })
  return respond(NextResponse.json({ success: true, item: data }))
}
