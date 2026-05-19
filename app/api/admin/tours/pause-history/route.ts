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
 * GET /api/admin/tours/pause-history  (Phase 8I)
 *
 * Operator-facing read of the tour pause/resume state for a single venue.
 * Powers the new PauseHistoryTable on `/dashboard/settings/billing` and
 * is also useful for direct curl-style triage during incidents.
 *
 * RESPONSE SHAPE (mirrors the prompt exactly — keep stable)
 *   {
 *     items: [
 *       { paused_at, resumed_at, paused_reason, resumed_reason,
 *         paused_count, archived_at }
 *     ],
 *     current: {
 *       paused_at,        // null when no active pause
 *       paused_reason,
 *       paused_count,
 *       resumed_at,
 *       resumed_reason
 *     }
 *   }
 *
 * `items` mirrors `metadata.tour_pause_history` (Phase 8H), newest last
 * (we preserve insertion order — that's the cron's append order). The
 * caller is free to reverse for display.
 *
 * `current` is built from the four-key tuple Phase 8F/8G/8H maintains on
 * the subscription row. When the venue has never been paused, every field
 * is `null` and `items` is an empty array.
 *
 * AUTH / TENANT
 *   - `requireAdmin()` first.
 *   - If `venue_id` query param is supplied AND differs from caller's
 *     primary venue, re-verify ADMIN_ROLES on that target. Cross-tenant
 *     access (403) collapses to 404 so admins can't enumerate by guessing
 *     venue UUIDs.
 *   - Rate-limited per caller — read endpoints are cheap but a UI bug
 *     that hot-loops shouldn't melt our DB.
 *
 * PII POSTURE
 *   - Returns ONLY the six pause/resume keys + the four "current" scalars.
 *     We never spread the rest of `subscriptions.metadata` (which might
 *     contain Stripe-side fields, dunning audit, etc.).
 *
 * `X-Request-Id` is set by the standard `respond()` wrapper.
 */

const QuerySchema = z.object({
  venue_id: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
})

interface HistoryEntry {
  paused_at: string
  resumed_at: string
  paused_reason: string | null
  resumed_reason: string | null
  paused_count: number | null
  archived_at: string
}

interface CurrentState {
  paused_at: string | null
  paused_reason: string | null
  paused_count: number | null
  resumed_at: string | null
  resumed_reason: string | null
}

const EMPTY_CURRENT: CurrentState = {
  paused_at: null,
  paused_reason: null,
  paused_count: null,
  resumed_at: null,
  resumed_reason: null,
}

function readString(md: Record<string, unknown>, key: string): string | null {
  const v = md[key]
  return typeof v === 'string' && v.length > 0 ? v : null
}

function readNumber(md: Record<string, unknown>, key: string): number | null {
  const v = md[key]
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

function buildCurrent(md: Record<string, unknown> | null): CurrentState {
  if (!md) return EMPTY_CURRENT
  return {
    paused_at: readString(md, 'tours_paused_at'),
    paused_reason: readString(md, 'tours_paused_reason'),
    paused_count: readNumber(md, 'tours_paused_count'),
    resumed_at: readString(md, 'tours_resumed_at'),
    resumed_reason: readString(md, 'tours_resumed_reason'),
  }
}

function buildItems(md: Record<string, unknown> | null, limit: number): HistoryEntry[] {
  if (!md) return []
  const raw = (md as { tour_pause_history?: unknown }).tour_pause_history
  if (!Array.isArray(raw)) return []
  const filtered: HistoryEntry[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const e = entry as Record<string, unknown>
    const paused_at = typeof e.paused_at === 'string' ? e.paused_at : null
    const resumed_at = typeof e.resumed_at === 'string' ? e.resumed_at : null
    const archived_at = typeof e.archived_at === 'string' ? e.archived_at : null
    // Drop malformed entries silently — we never want a single corrupt
    // history row to break the whole audit surface.
    if (!paused_at || !resumed_at || !archived_at) continue
    filtered.push({
      paused_at,
      resumed_at,
      archived_at,
      paused_reason: typeof e.paused_reason === 'string' ? e.paused_reason : null,
      resumed_reason: typeof e.resumed_reason === 'string' ? e.resumed_reason : null,
      paused_count: typeof e.paused_count === 'number' ? e.paused_count : null,
    })
  }
  // Newest-first for display. Slice AFTER reverse so the cap applies to
  // the most recent N, not the oldest N.
  filtered.reverse()
  return filtered.slice(0, limit)
}

export async function GET(request: NextRequest) {
  const requestId = getOrCreateRequestId(request)
  const reqLog = log.child({
    requestId,
    route: '/api/admin/tours/pause-history',
  })
  const respond = <T extends Response>(r: T) => withRequestIdHeader(r, requestId)

  // 1. Auth.
  const admin = await requireAdmin()
  if (!admin.ok) {
    return respond(NextResponse.json({ error: admin.code }, { status: admin.status }))
  }
  const { user, venueId: callerVenueId } = admin

  // 2. Rate limit per caller.
  const rl = await rateLimitUserAction(request, `admin:tours-pause-history:${user.id}`)
  if (!rl.allowed) {
    reqLog.warn({ userId: user.id, retryMs: rl.retryAfterMs }, 'rate_limit.blocked')
    return respond(rateLimitedResponse(rl))
  }

  // 3. Validate query.
  const url = new URL(request.url)
  const queryParsed = QuerySchema.safeParse({
    venue_id: url.searchParams.get('venue_id') ?? undefined,
    limit: url.searchParams.get('limit') ?? undefined,
  })
  if (!queryParsed.success) {
    return respond(
      NextResponse.json(
        { error: 'validation_failed', detail: queryParsed.error.flatten() },
        { status: 400 }
      )
    )
  }
  const { venue_id: bodyVenueId, limit } = queryParsed.data

  // 4. Resolve target venue + tenant bind.
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

  // 5. Read the latest subscription row for the venue. There can be
  // multiple rows (canceled + new), so we pick the most-recently-created
  // — same priority Phase 7D uses for the gate / banner. We narrow the
  // SELECT to `metadata` only so we never accidentally leak unrelated
  // subscription fields back to the client.
  const svc = createServiceClient()
  const { data: subRaw, error: subErr } = await svc
    .from('subscriptions')
    .select('metadata')
    .eq('venue_id', targetVenueId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (subErr) {
    reqLog.error({ err: subErr }, 'admin.tours_pause_history.lookup_failed')
    captureApiError(subErr, {
      requestId,
      route: '/api/admin/tours/pause-history',
      userId: user.id,
      venueId: targetVenueId,
    })
    return respond(NextResponse.json({ error: 'unexpected_error' }, { status: 500 }))
  }

  const metadata =
    (subRaw as { metadata?: Record<string, unknown> | null } | null)?.metadata ?? null

  const current = buildCurrent(metadata)
  const items = buildItems(metadata, limit)

  reqLog.info(
    {
      userId: user.id,
      venueId: targetVenueId,
      historyLen: items.length,
      hasCurrentPause: Boolean(current.paused_at),
    },
    'admin.tours_pause_history.completed'
  )

  return respond(NextResponse.json({ items, current }))
}
