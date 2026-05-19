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
 * GET /api/admin/tours/notification-stats  (Phase 8J)
 *
 * Aggregates `public.outbound_messages` rows where `related_table='tours'`
 * over a configurable window. Powers operator deliverability triage —
 * "are reminders actually landing?", "is the suppressed bucket growing?",
 * "how often is Resend bouncing us?".
 *
 * AUTH / TENANT
 *   - `requireAdmin()` first.
 *   - Optional `venue_id` query — cross-tenant access re-verified via
 *     `requireVenueRole(ADMIN_ROLES)`. Cross-tenant denial collapses to
 *     404 so admins can't enumerate venues.
 *   - Per-caller rate limit (`admin:tours-notification-stats:{userId}`).
 *
 * AGGREGATION
 *   - Groups by `(kind, provider, status)` where
 *       kind = metadata->>'tour_notification_kind'  (Phase 8G/8J tag)
 *       provider = outbound_messages.provider        (Phase 4B)
 *       status   = outbound_messages.status          (queued/delivered/
 *                  bounced/complained/failed/suppressed per migration 003)
 *   - Returns row-level counts as `items[]` for the operator to slice
 *     further client-side, plus pre-computed `totals` rolled up to the
 *     four buckets the prompt asks for: `attempted | sent | failed | suppressed`.
 *
 * ROLL-UP RULE (totals)
 *   - `attempted` = every row in the window (handed to provider OR not).
 *   - `sent`      = status ∈ {queued, delivered}. We treat `queued` as
 *                   "successfully handed off" because Resend bumps it to
 *                   `delivered` asynchronously via the webhook (Phase 4B+).
 *   - `failed`    = status ∈ {failed, bounced, complained}.
 *   - `suppressed`= status = 'suppressed'.
 *   - Rows with NULL `provider` or NULL `kind` are still counted in
 *     `attempted` + their status bucket, and surface as `null` keys in
 *     `items[]` so the operator sees how many lifecycle vs reminder
 *     emails are missing the tag (e.g. legacy Phase 4B rows from before
 *     Phase 8G).
 *
 * PII POSTURE
 *   - Never returns lead emails, message bodies, or subject lines.
 *   - Sentry-capture unexpected DB errors.
 *   - `X-Request-Id` set via the standard `respond()` wrapper.
 */

const QuerySchema = z.object({
  venue_id: z.string().uuid().optional(),
  days: z.coerce.number().int().min(1).max(90).default(30),
})

type OutboundStatus =
  | 'queued'
  | 'delivered'
  | 'bounced'
  | 'complained'
  | 'failed'
  | 'suppressed'

interface OutboundRow {
  status: OutboundStatus | string | null
  provider: string | null
  metadata: Record<string, unknown> | null
}

interface StatsItem {
  kind: string | null
  provider: string | null
  status: string | null
  count: number
}

interface StatsTotals {
  attempted: number
  sent: number
  failed: number
  suppressed: number
}

const SENT_STATUSES: ReadonlySet<string> = new Set(['queued', 'delivered'])
const FAILED_STATUSES: ReadonlySet<string> = new Set([
  'failed',
  'bounced',
  'complained',
])

function bucketize(status: string | null): keyof StatsTotals | 'unknown' {
  if (!status) return 'unknown'
  if (status === 'suppressed') return 'suppressed'
  if (SENT_STATUSES.has(status)) return 'sent'
  if (FAILED_STATUSES.has(status)) return 'failed'
  return 'unknown'
}

function readKind(metadata: Record<string, unknown> | null): string | null {
  if (!metadata) return null
  const v = (metadata as { tour_notification_kind?: unknown }).tour_notification_kind
  return typeof v === 'string' && v.length > 0 ? v : null
}

export async function GET(request: NextRequest) {
  const requestId = getOrCreateRequestId(request)
  const reqLog = log.child({
    requestId,
    route: '/api/admin/tours/notification-stats',
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
    `admin:tours-notification-stats:${user.id}`
  )
  if (!rl.allowed) {
    reqLog.warn({ userId: user.id, retryMs: rl.retryAfterMs }, 'rate_limit.blocked')
    return respond(rateLimitedResponse(rl))
  }

  // 3. Validate query.
  const url = new URL(request.url)
  const queryParsed = QuerySchema.safeParse({
    venue_id: url.searchParams.get('venue_id') ?? undefined,
    days: url.searchParams.get('days') ?? undefined,
  })
  if (!queryParsed.success) {
    return respond(
      NextResponse.json(
        { error: 'validation_failed', detail: queryParsed.error.flatten() },
        { status: 400 }
      )
    )
  }
  const { venue_id: bodyVenueId, days } = queryParsed.data

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

  // 5. Read the rows. Narrow SELECT — we don't fetch `to`, `subject`,
  // `body`, `provider_message_id`, etc. so there's zero PII leak risk.
  // Postgres doesn't expose a clean `group by jsonb_extract_path_text`
  // through PostgREST without an RPC, so we aggregate in JS — the per-
  // venue per-window row count is small (handful of rows/day at most).
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()
  const svc = createServiceClient()
  const { data, error } = await svc
    .from('outbound_messages')
    .select('status, provider, metadata')
    .eq('venue_id', targetVenueId)
    .eq('related_table', 'tours')
    .gte('created_at', since)
    .limit(10000)

  if (error) {
    reqLog.error({ err: error }, 'admin.tours_notification_stats.query_failed')
    captureApiError(error, {
      requestId,
      route: '/api/admin/tours/notification-stats',
      userId: user.id,
      venueId: targetVenueId,
    })
    return respond(NextResponse.json({ error: 'unexpected_error' }, { status: 500 }))
  }

  const rows = (data ?? []) as OutboundRow[]

  // 6. Aggregate. The grouping key is `kind|provider|status` joined with
  // a separator that can't appear in any of the three (null becomes the
  // string "null"). One pass through the rows; the per-venue cardinality
  // is tiny (a few kinds × 1-2 providers × ~6 statuses).
  const counts = new Map<string, StatsItem>()
  const totals: StatsTotals = { attempted: 0, sent: 0, failed: 0, suppressed: 0 }

  for (const row of rows) {
    const kind = readKind(row.metadata)
    const provider = row.provider ?? null
    const status =
      typeof row.status === 'string' && row.status.length > 0 ? row.status : null
    const key = `${kind ?? 'null'}|${provider ?? 'null'}|${status ?? 'null'}`
    const existing = counts.get(key)
    if (existing) {
      existing.count++
    } else {
      counts.set(key, { kind, provider, status, count: 1 })
    }

    totals.attempted++
    const bucket = bucketize(status)
    if (bucket !== 'unknown') {
      totals[bucket]++
    }
  }

  const items = [...counts.values()].sort((a, b) => {
    // Stable sort: kind asc, then provider asc, then status asc. Helps
    // the operator scan the table visually without re-sorting.
    const k = (a.kind ?? '').localeCompare(b.kind ?? '')
    if (k !== 0) return k
    const p = (a.provider ?? '').localeCompare(b.provider ?? '')
    if (p !== 0) return p
    return (a.status ?? '').localeCompare(b.status ?? '')
  })

  reqLog.info(
    {
      userId: user.id,
      venueId: targetVenueId,
      windowDays: days,
      rowCount: rows.length,
      itemCount: items.length,
      totals,
    },
    'admin.tours_notification_stats.completed'
  )

  return respond(
    NextResponse.json({
      venue_id: targetVenueId,
      window_days: days,
      items,
      totals,
    })
  )
}
