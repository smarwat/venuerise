import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createServiceClient } from '@/lib/supabase/service'
import { requireAdmin } from '@/lib/auth/require-admin'
import { requireVenueRole, TenantAccessError } from '@/lib/auth/tenant-access'
import { ADMIN_ROLES } from '@/lib/auth/roles'
import { rateLimitUserAction, rateLimitedResponse } from '@/lib/rate-limit'
import { log } from '@/lib/log'
import { getOrCreateRequestId, withRequestIdHeader } from '@/lib/observability/request-id'
import { captureApiError } from '@/lib/observability/sentry'

/**
 * POST /api/admin/tours/bulk-cancel  (Phase 8F)
 *
 * Operator escape hatch — cancel every future scheduled/confirmed tour in a
 * date range for a single venue without hand-running SQL. Useful when a
 * venue closes for a holiday, fire damage, or any incident that forces a
 * mass reschedule.
 *
 * AUTHORIZATION
 *   1. `requireAdmin()` — caller is owner/admin of some venue.
 *   2. If body.venue_id is supplied and differs from the caller's primary
 *      venue, we re-verify ADMIN_ROLES on that target venue via
 *      `requireVenueRole`. Cross-tenant access (403 / not-a-member) collapses
 *      to 404 so an admin can't enumerate other venues by ID-guessing.
 *
 * RATE LIMITING
 *   - Per-user key `admin:tours-bulk-cancel:{userId}` — bulk cancels are
 *     destructive, so we don't want an accidental double-click to fire two
 *     overlapping cancellation sweeps.
 *
 * VALIDATION (defensive — bad input never reaches the UPDATE)
 *   - `from_date` and `to_date` are strict YYYY-MM-DD strings.
 *   - `from_date <= to_date`.
 *   - Range size <= 90 days (inclusive). Anything wider is almost certainly
 *     either a typo or a workflow problem the operator should handle via SQL.
 *   - Only `status ∈ {scheduled, confirmed}` get touched. Completed/cancelled/
 *     no_show rows are untouched even if they fall in the window.
 *   - Only `scheduled_at > now` rows are touched. We never retroactively
 *     "cancel" a past tour — that would corrupt completed-tour metrics.
 *
 * REASON COLUMN
 *   - The `tours` table has an `outcome text` column (migration 001). If a
 *     `reason` is supplied (max 240 chars), we write it there so the same
 *     EditTourDrawer that surfaces other outcomes will display the bulk-
 *     cancel context.
 *
 * RESPONSE SHAPE
 *   {
 *     success: true,
 *     venue_id: <uuid>,
 *     cancelled_count: <int>,
 *     from_date: 'YYYY-MM-DD',
 *     to_date: 'YYYY-MM-DD'
 *   }
 *
 * Logs never include any lead name/email — only counts + the date range.
 */

const DATE_RX = /^\d{4}-\d{2}-\d{2}$/

const BodySchema = z.object({
  venue_id: z.string().uuid().optional(),
  from_date: z.string().regex(DATE_RX, 'from_date must be YYYY-MM-DD'),
  to_date: z.string().regex(DATE_RX, 'to_date must be YYYY-MM-DD'),
  reason: z.string().trim().max(240).optional(),
})

const MS_DAY = 24 * 60 * 60 * 1000
const MAX_RANGE_DAYS = 90

function parseYmdUtc(ymd: string): Date {
  // Treat the YYYY-MM-DD as a UTC date so range math is timezone-invariant.
  return new Date(`${ymd}T00:00:00.000Z`)
}

export async function POST(request: NextRequest) {
  const requestId = getOrCreateRequestId(request)
  const reqLog = log.child({
    requestId,
    route: '/api/admin/tours/bulk-cancel',
  })
  const respond = <T extends Response>(r: T) => withRequestIdHeader(r, requestId)

  // 1. Auth.
  const admin = await requireAdmin()
  if (!admin.ok) {
    return respond(NextResponse.json({ error: admin.code }, { status: admin.status }))
  }
  const { user, venueId: callerVenueId } = admin

  // 2. Rate limit per caller.
  const rl = await rateLimitUserAction(
    request,
    `admin:tours-bulk-cancel:${user.id}`
  )
  if (!rl.allowed) {
    reqLog.warn({ userId: user.id, retryMs: rl.retryAfterMs }, 'rate_limit.blocked')
    return respond(rateLimitedResponse(rl))
  }

  // 3. Validate body.
  const body = await request.json().catch(() => null)
  const parsed = BodySchema.safeParse(body)
  if (!parsed.success) {
    return respond(
      NextResponse.json(
        { error: 'validation_failed', detail: parsed.error.flatten() },
        { status: 400 }
      )
    )
  }
  const { venue_id: bodyVenueId, from_date, to_date, reason } = parsed.data

  // 4. Date range sanity.
  const fromDate = parseYmdUtc(from_date)
  const toDate = parseYmdUtc(to_date)
  if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime())) {
    return respond(
      NextResponse.json({ error: 'invalid_date' }, { status: 400 })
    )
  }
  if (fromDate.getTime() > toDate.getTime()) {
    return respond(
      NextResponse.json({ error: 'from_after_to' }, { status: 400 })
    )
  }
  const rangeDays = Math.floor((toDate.getTime() - fromDate.getTime()) / MS_DAY) + 1
  if (rangeDays > MAX_RANGE_DAYS) {
    return respond(
      NextResponse.json(
        {
          error: 'range_too_large',
          max_days: MAX_RANGE_DAYS,
          requested_days: rangeDays,
        },
        { status: 400 }
      )
    )
  }

  // 5. Resolve target venue + tenant bind.
  const targetVenueId = bodyVenueId ?? callerVenueId
  if (targetVenueId !== callerVenueId) {
    try {
      await requireVenueRole(user.id, targetVenueId, ADMIN_ROLES)
    } catch (err) {
      if (err instanceof TenantAccessError) {
        if (err.status === 403) {
          return respond(NextResponse.json({ error: 'not_found' }, { status: 404 }))
        }
        return respond(NextResponse.json({ error: err.code }, { status: err.status }))
      }
      throw err
    }
  }

  // 6. Build the window. We always cancel only FUTURE tours — past rows are
  // a historical record. The lower bound is max(from_date start, now); upper
  // bound is to_date end-of-day (UTC) — inclusive of the entire to_date.
  const now = new Date()
  const windowStart = fromDate.getTime() > now.getTime() ? fromDate : now
  const windowEnd = new Date(toDate.getTime() + MS_DAY - 1) // end-of-day UTC

  const svc = createServiceClient()

  // 7. Fetch matching ids first so we can return an accurate cancelled_count
  // even if a row flips status mid-update. PATCH .in('id', ids) ensures we
  // only touch the exact rows we screened.
  const { data: matchRaw, error: matchErr } = await svc
    .from('tours')
    .select('id')
    .eq('venue_id', targetVenueId)
    .in('status', ['scheduled', 'confirmed'])
    .gte('scheduled_at', windowStart.toISOString())
    .lte('scheduled_at', windowEnd.toISOString())

  if (matchErr) {
    reqLog.error(
      { err: matchErr, venueId: targetVenueId },
      'admin.tours_bulk_cancel.match_failed'
    )
    captureApiError(matchErr, {
      requestId,
      route: '/api/admin/tours/bulk-cancel',
      userId: user.id,
      venueId: targetVenueId,
    })
    return respond(NextResponse.json({ error: 'unexpected_error' }, { status: 500 }))
  }

  const ids = ((matchRaw ?? []) as Array<{ id: string }>).map((r) => r.id)
  if (ids.length === 0) {
    reqLog.info(
      {
        userId: user.id,
        venueId: targetVenueId,
        from_date,
        to_date,
        cancelled_count: 0,
      },
      'admin.tours_bulk_cancel.no_matches'
    )
    return respond(
      NextResponse.json({
        success: true,
        venue_id: targetVenueId,
        cancelled_count: 0,
        from_date,
        to_date,
      })
    )
  }

  // 8. Cancel. We re-assert status ∈ {scheduled, confirmed} on the UPDATE
  // so a row that completed between the fetch + update doesn't get clobbered.
  const updatePayload: Record<string, unknown> = { status: 'cancelled' }
  if (reason && reason.length > 0) updatePayload.outcome = reason

  const { data: updatedRaw, error: updateErr } = await svc
    .from('tours')
    .update(updatePayload)
    .in('id', ids)
    .in('status', ['scheduled', 'confirmed'])
    .select('id')

  if (updateErr) {
    reqLog.error(
      { err: updateErr, venueId: targetVenueId, candidateCount: ids.length },
      'admin.tours_bulk_cancel.update_failed'
    )
    captureApiError(updateErr, {
      requestId,
      route: '/api/admin/tours/bulk-cancel',
      userId: user.id,
      venueId: targetVenueId,
    })
    return respond(NextResponse.json({ error: 'unexpected_error' }, { status: 500 }))
  }

  const cancelledCount = (updatedRaw as Array<{ id: string }> | null)?.length ?? 0

  reqLog.info(
    {
      userId: user.id,
      venueId: targetVenueId,
      from_date,
      to_date,
      cancelled_count: cancelledCount,
      candidate_count: ids.length,
      hadReason: Boolean(reason),
    },
    'admin.tours_bulk_cancel.completed'
  )

  return respond(
    NextResponse.json({
      success: true,
      venue_id: targetVenueId,
      cancelled_count: cancelledCount,
      from_date,
      to_date,
    })
  )
}
