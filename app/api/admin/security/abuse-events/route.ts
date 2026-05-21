import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createServiceClient } from '@/lib/supabase/service'
import { requireAdmin } from '@/lib/auth/require-admin'
import {
  requireVenueRole,
  TenantAccessError,
} from '@/lib/auth/tenant-access'
import { ADMIN_ROLES } from '@/lib/auth/roles'
import { rateLimitUserAction, rateLimitedResponse } from '@/lib/rate-limit'
import { log } from '@/lib/log'
import {
  getOrCreateRequestId,
  withRequestIdHeader,
} from '@/lib/observability/request-id'
import { captureApiError } from '@/lib/observability/sentry'

/**
 * GET /api/admin/security/abuse-events  (Phase 9F)
 *
 * Surfaces `public.abuse_events` (migration 029) for the
 * `AbuseMonitorCard` on `/dashboard/settings/billing`. Mirrors the
 * Phase 9A `/api/admin/audit-events` shape so the card can reuse
 * the same cursor-pagination + CSV pattern.
 *
 * Query params:
 *   - venue_id          (optional; defaults to caller's primary)
 *   - route             (exact match)
 *   - reason            (exact match)
 *   - since             (ISO timestamp lower bound)
 *   - occurred_before   (cursor for "load older")
 *   - limit             (1..200, default 50)
 *   - format            (json | csv, default json)
 *
 * Response (JSON):
 *   {
 *     items: AbuseEventRow[],
 *     next_cursor: string | null,
 *     has_more: boolean,
 *     summary: {
 *       total,
 *       by_route: { [route]: count },
 *       by_reason: { [reason]: count },
 *       by_limiter_key: { [key]: count },
 *     }
 *   }
 *
 * The summary is derived from the SAME slice that comes back (not
 * a separate query) so the card's "top route" matches what the
 * operator can scroll. A future phase can add a wider summary
 * window (24h roll-up) if the slice proves too narrow.
 *
 * Cross-tenant venue_id requires `requireVenueRole(ADMIN_ROLES)`;
 * forbidden collapses to 404.
 *
 * Public-route rows (`venue_id IS NULL`) are NEVER returned via
 * this endpoint — the WHERE clause `eq('venue_id', targetVenueId)`
 * filters them out. Operators investigating widget/CSP abuse must
 * query the table directly via Supabase SQL editor (intentional:
 * cross-venue abuse review is an infra-team task).
 */

const QuerySchema = z.object({
  venue_id: z.string().uuid().optional(),
  route: z.string().max(120).optional(),
  reason: z.string().max(40).optional(),
  since: z.string().datetime().optional(),
  occurred_before: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  format: z.enum(['json', 'csv']).optional(),
})

const DEFAULT_LIMIT = 50

interface AbuseEventRow {
  id: string
  venue_id: string | null
  user_id: string | null
  route: string
  method: string
  limiter_key: string
  ip_hash: string | null
  reason: string
  metadata: Record<string, unknown> | null
  created_at: string
}

function bumpCounter(map: Record<string, number>, key: string): void {
  map[key] = (map[key] ?? 0) + 1
}

export async function GET(request: NextRequest): Promise<Response> {
  const requestId = getOrCreateRequestId(request)
  const reqLog = log.child({
    requestId,
    route: '/api/admin/security/abuse-events',
    op: 'admin.security.abuse_events.list',
  })
  const respond = <T extends Response>(r: T) =>
    withRequestIdHeader(r, requestId)

  // 1. Auth.
  const admin = await requireAdmin()
  if (!admin.ok) {
    return respond(
      NextResponse.json({ error: admin.code }, { status: admin.status })
    )
  }
  const { user, venueId: callerVenueId } = admin

  // 2. Rate limit.
  const rl = await rateLimitUserAction(
    request,
    `admin:security-abuse-events:${user.id}`,
    {
      route: '/api/admin/security/abuse-events',
      method: 'GET',
      userId: user.id,
      venueId: callerVenueId,
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

  // 3. Parse query.
  const url = new URL(request.url)
  const parsed = QuerySchema.safeParse({
    venue_id: url.searchParams.get('venue_id') ?? undefined,
    route: url.searchParams.get('route') ?? undefined,
    reason: url.searchParams.get('reason') ?? undefined,
    since: url.searchParams.get('since') ?? undefined,
    occurred_before: url.searchParams.get('occurred_before') ?? undefined,
    limit: url.searchParams.get('limit') ?? undefined,
    format: url.searchParams.get('format') ?? undefined,
  })
  if (!parsed.success) {
    return respond(
      NextResponse.json(
        { error: 'validation_failed', detail: parsed.error.flatten() },
        { status: 400 }
      )
    )
  }
  const {
    venue_id: bodyVenueId,
    route: routeFilter,
    reason: reasonFilter,
    since,
    occurred_before: occurredBefore,
    limit = DEFAULT_LIMIT,
    format = 'json',
  } = parsed.data

  // 4. Resolve target venue + tenant bind.
  const targetVenueId = bodyVenueId ?? callerVenueId
  if (targetVenueId !== callerVenueId) {
    try {
      await requireVenueRole(user.id, targetVenueId, ADMIN_ROLES)
    } catch (err) {
      if (err instanceof TenantAccessError) {
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
  }

  // 5. List query.
  const svc = createServiceClient()
  let query = svc
    .from('abuse_events')
    .select(
      'id, venue_id, user_id, route, method, limiter_key, ip_hash, reason, metadata, created_at'
    )
    .eq('venue_id', targetVenueId)
    .order('created_at', { ascending: false })
    .limit(limit)

  if (routeFilter) query = query.eq('route', routeFilter)
  if (reasonFilter) query = query.eq('reason', reasonFilter)
  if (since) query = query.gte('created_at', since)
  if (occurredBefore) query = query.lt('created_at', occurredBefore)

  const { data: rowsRaw, error: queryErr } = await query
  if (queryErr) {
    reqLog.error(
      { err: queryErr, venueId: targetVenueId },
      'admin.security.abuse_events.query_failed'
    )
    captureApiError(queryErr, {
      requestId,
      route: '/api/admin/security/abuse-events',
      userId: user.id,
      venueId: targetVenueId,
    })
    return respond(
      NextResponse.json({ error: 'unexpected_error' }, { status: 500 })
    )
  }

  const items = (rowsRaw ?? []) as AbuseEventRow[]
  const hasMore = items.length === limit
  const nextCursor =
    hasMore && items.length > 0 ? items[items.length - 1].created_at : null

  // 6. In-slice summary. Card uses this for "top route / top
  // reason / top limiter" chips so the operator gets the answer
  // without a second query.
  const byRoute: Record<string, number> = {}
  const byReason: Record<string, number> = {}
  const byLimiterKey: Record<string, number> = {}
  for (const row of items) {
    bumpCounter(byRoute, row.route)
    bumpCounter(byReason, row.reason)
    bumpCounter(byLimiterKey, row.limiter_key)
  }

  reqLog.info(
    {
      venueId: targetVenueId,
      userId: user.id,
      itemCount: items.length,
      routeFilter: routeFilter ?? null,
      reasonFilter: reasonFilter ?? null,
      hasMore,
      hasCursor: Boolean(occurredBefore),
      format,
    },
    'admin.security.abuse_events.listed'
  )

  if (format === 'csv') {
    return respond(renderCsv(items, requestId, { hasMore, nextCursor }))
  }

  return respond(
    NextResponse.json({
      items,
      next_cursor: nextCursor,
      has_more: hasMore,
      summary: {
        total: items.length,
        by_route: byRoute,
        by_reason: byReason,
        by_limiter_key: byLimiterKey,
      },
    })
  )
}

// ── CSV renderer — same shape as Phase 9A audit-events for muscle memory.

const CSV_COLUMNS: ReadonlyArray<{
  key: keyof AbuseEventRow | 'metadata_json'
  header: string
}> = [
  { key: 'id', header: 'id' },
  { key: 'venue_id', header: 'venue_id' },
  { key: 'user_id', header: 'user_id' },
  { key: 'route', header: 'route' },
  { key: 'method', header: 'method' },
  { key: 'limiter_key', header: 'limiter_key' },
  { key: 'ip_hash', header: 'ip_hash' },
  { key: 'reason', header: 'reason' },
  { key: 'created_at', header: 'created_at' },
  { key: 'metadata_json', header: 'metadata_json' },
]

function escapeCsv(value: unknown): string {
  if (value === null || value === undefined) return ''
  const s = typeof value === 'object' ? JSON.stringify(value) : String(value)
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`
  }
  return s
}

function renderCsv(
  items: AbuseEventRow[],
  requestId: string,
  pagination: { hasMore: boolean; nextCursor: string | null }
): Response {
  const header = CSV_COLUMNS.map((c) => c.header).join(',')
  const rows = items.map((row) =>
    CSV_COLUMNS.map((col) => {
      if (col.key === 'metadata_json') return escapeCsv(row.metadata ?? {})
      return escapeCsv(row[col.key])
    }).join(',')
  )
  const body = '﻿' + [header, ...rows].join('\r\n') + '\r\n'

  const date = new Date().toISOString().slice(0, 10)
  const headers: Record<string, string> = {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="abuse-events-${date}.csv"`,
    'Cache-Control': 'no-store',
    'X-Request-Id': requestId,
    'X-Has-More': pagination.hasMore ? 'true' : 'false',
  }
  if (pagination.hasMore && pagination.nextCursor) {
    headers['X-Next-Cursor'] = pagination.nextCursor
  }
  return new NextResponse(body, { status: 200, headers })
}
