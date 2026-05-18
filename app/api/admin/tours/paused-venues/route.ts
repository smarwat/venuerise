import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { requireAdmin } from '@/lib/auth/require-admin'
import { rateLimitUserAction, rateLimitedResponse } from '@/lib/rate-limit'
import { log } from '@/lib/log'
import { getOrCreateRequestId, withRequestIdHeader } from '@/lib/observability/request-id'
import { captureApiError } from '@/lib/observability/sentry'

/**
 * GET /api/admin/tours/paused-venues  (Phase 8G)
 *
 * Operator dashboard helper — lists every subscription that is currently
 * "tour-paused": `metadata.tours_paused_at IS NOT NULL` AND
 * `metadata.tours_resumed_at IS NULL`. Useful for triaging which venues
 * need a manual tour-restore conversation after recovery, OR for sanity-
 * checking that the Phase 8F auto-pause cron is firing on the venues it
 * should and skipping ones it shouldn't.
 *
 * AUTHORIZATION
 *   - `requireAdmin()` only. The endpoint returns a CROSS-tenant view (every
 *     paused venue across the platform), so we don't bind to a single
 *     caller venue. ADMIN_ROLES is enforced inside `requireAdmin()` itself
 *     (it returns `ok: false` unless the caller has owner/admin somewhere).
 *   - Rate-limited per caller (`admin:tours-paused-venues:{userId}`) to
 *     prevent scraping loops.
 *
 * RESPONSE SHAPE
 *   {
 *     items: [
 *       { venue_id, subscription_id, status, tours_paused_at, tours_paused_count }
 *     ]
 *   }
 *
 * PII POSTURE
 *   - venue_id + subscription_id are UUIDs, not PII.
 *   - No venue name, no owner email, no Stripe customer id. Operators
 *     who need those can pivot through the Phase 7G billing-events list
 *     using the subscription_id.
 */

const MAX_ROWS = 500

export async function GET(request: NextRequest) {
  const requestId = getOrCreateRequestId(request)
  const reqLog = log.child({
    requestId,
    route: '/api/admin/tours/paused-venues',
  })
  const respond = <T extends Response>(r: T) => withRequestIdHeader(r, requestId)

  // 1. Auth.
  const admin = await requireAdmin()
  if (!admin.ok) {
    return respond(NextResponse.json({ error: admin.code }, { status: admin.status }))
  }
  const { user } = admin

  // 2. Rate limit per caller.
  const rl = await rateLimitUserAction(
    request,
    `admin:tours-paused-venues:${user.id}`
  )
  if (!rl.allowed) {
    reqLog.warn({ userId: user.id, retryMs: rl.retryAfterMs }, 'rate_limit.blocked')
    return respond(rateLimitedResponse(rl))
  }

  // 3. Read candidates. PostgREST's jsonb operators are limited — we use
  // the documented `not(...)`-style chain to filter `tours_paused_at IS
  // NOT NULL` AND `tours_resumed_at IS NULL`. The `metadata->>...` text
  // accessor works with `.not('column', 'is', null)` and `.is('column',
  // null)` style filters via raw URL params. We use `.not()` for "paused
  // exists" and JS filter for the harder "resumed missing" check to keep
  // the query readable.
  //
  // Performance: paused venues are rare (only past_due > 7d), so even an
  // unfiltered read of the subscriptions table on a small SaaS is bounded.
  // We cap at MAX_ROWS as defense in depth.
  const svc = createServiceClient()
  const { data, error } = await svc
    .from('subscriptions')
    .select('id, venue_id, status, metadata')
    .not('metadata->>tours_paused_at', 'is', null)
    .order('created_at', { ascending: false })
    .limit(MAX_ROWS)

  if (error) {
    reqLog.error(
      { err: error },
      'admin.tours_paused_venues.query_failed'
    )
    captureApiError(error, {
      requestId,
      route: '/api/admin/tours/paused-venues',
      userId: user.id,
    })
    return respond(NextResponse.json({ error: 'unexpected_error' }, { status: 500 }))
  }

  type Row = {
    id: string
    venue_id: string | null
    status: string | null
    metadata: Record<string, unknown> | null
  }
  const rows = (data ?? []) as Row[]

  const items = rows
    .filter((r) => {
      const md = r.metadata ?? {}
      const pausedAt = (md as { tours_paused_at?: unknown }).tours_paused_at
      const resumedAt = (md as { tours_resumed_at?: unknown }).tours_resumed_at
      // Belt-and-suspenders: the `.not('metadata->>tours_paused_at', 'is', null)`
      // filter already excludes rows without a paused stamp; we re-check
      // here AND drop any row that has a resumed stamp.
      if (typeof pausedAt !== 'string' || pausedAt.length === 0) return false
      if (typeof resumedAt === 'string' && resumedAt.length > 0) return false
      return true
    })
    .map((r) => {
      const md = r.metadata ?? {}
      const pausedAt = (md as { tours_paused_at?: unknown }).tours_paused_at as string
      const pausedCountRaw = (md as { tours_paused_count?: unknown }).tours_paused_count
      const pausedCount =
        typeof pausedCountRaw === 'number' ? pausedCountRaw : null
      return {
        venue_id: r.venue_id,
        subscription_id: r.id,
        status: r.status,
        tours_paused_at: pausedAt,
        tours_paused_count: pausedCount,
      }
    })

  reqLog.info(
    { userId: user.id, candidates: rows.length, returned: items.length },
    'admin.tours_paused_venues.completed'
  )

  return respond(NextResponse.json({ items }))
}
