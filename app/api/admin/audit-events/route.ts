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
 * GET /api/admin/audit-events  (Phase 9A)
 *
 * Surfaces `public.audit_events` rows (migration 027) for the
 * billing-page `EnterpriseAuditEventsCard`. The enterprise audit log
 * is intentionally distinct from the Phase 8AC digest-specific
 * `digest_audit_events` feed:
 *
 *   - digest_audit_events  → operator-facing digest forensics
 *                            (suppression removes, retention, sends)
 *   - audit_events         → cross-cutting security log
 *                            (lead/tour/settings writes, AI safety,
 *                            availability, venues, digest, pause).
 *
 * Both feeds are useful to operators. The enterprise feed is the one
 * a security reviewer would pull during an incident.
 *
 * ── PII POSTURE ───────────────────────────────────────────────────────────
 *   - `ip_hash` is the salted-SHA-256 fingerprint set at write time
 *     by `lib/enterprise/audit-events.ts#maskIpForAudit`. We return
 *     it as-is — operators get linkability without raw addresses.
 *   - `user_agent` is truncated to 240 chars at write time.
 *   - `before_snapshot` / `after_snapshot` go through the helper's
 *     sensitive-key drop pass before storage. The route does NOT
 *     re-sanitize on read.
 *   - The optional `?include_snapshots=1` flag returns the jsonb
 *     snapshots inline. Default behavior omits them from the row to
 *     keep the list view tight; the drawer fetches a single row with
 *     `?id=<uuid>` when the operator drills in.
 *
 * ── PAGINATION ────────────────────────────────────────────────────────────
 *   - `?occurred_before=<iso>` cursor — matches the Phase 8Y sends
 *     endpoint shape so the card's "Load older" wiring transfers.
 *   - `X-Has-More` + `X-Next-Cursor` headers on every response.
 *
 * ── CROSS-TENANT POSTURE ──────────────────────────────────────────────────
 *   - Defaults to the caller's primary venue. `?venue_id=<uuid>`
 *     overrides — requires admin role on the target. Forbidden
 *     collapses to 404 (same shape as every other admin surface).
 */

const QuerySchema = z.object({
  venue_id: z.string().uuid().optional(),
  // Exact-match filters keyed to (venue_id, action, created_at desc) /
  // (action, created_at desc) indexes on the table.
  action: z.string().max(80).optional(),
  target_table: z.string().max(80).optional(),
  target_id: z.string().max(80).optional(),
  actor_user_id: z.string().uuid().optional(),
  actor_kind: z.enum(['operator', 'cron', 'system', 'webhook', 'all']).optional(),
  since: z.string().datetime().optional(),
  occurred_before: z.string().datetime().optional(),
  // Single-row fetch for the drawer. When supplied, all other
  // filters are ignored (still tenant-guarded post-fetch).
  id: z.string().uuid().optional(),
  // Include before_snapshot / after_snapshot in the row payload.
  // Default omitted to keep the list-view bandwidth low.
  include_snapshots: z.coerce.boolean().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  format: z.enum(['json', 'csv']).optional(),
})

const DEFAULT_LIMIT = 50

interface AuditEventRow {
  id: string
  venue_id: string
  actor_user_id: string | null
  actor_kind: string
  route: string
  action: string
  target_table: string | null
  target_id: string | null
  request_id: string | null
  ip_hash: string | null
  user_agent: string | null
  before_snapshot: Record<string, unknown> | null
  after_snapshot: Record<string, unknown> | null
  metadata: Record<string, unknown> | null
  created_at: string
}

const BASE_SELECT =
  'id, venue_id, actor_user_id, actor_kind, route, action, target_table, target_id, request_id, ip_hash, user_agent, metadata, created_at'
const FULL_SELECT = `${BASE_SELECT}, before_snapshot, after_snapshot`

export async function GET(request: NextRequest): Promise<Response> {
  const requestId = getOrCreateRequestId(request)
  const reqLog = log.child({
    requestId,
    route: '/api/admin/audit-events',
    op: 'admin.audit_events.list',
  })
  const respond = <T extends Response>(r: T) => withRequestIdHeader(r, requestId)

  // 1. Auth.
  const admin = await requireAdmin()
  if (!admin.ok) {
    return respond(NextResponse.json({ error: admin.code }, { status: admin.status }))
  }
  const { user, venueId: callerVenueId } = admin

  // 2. Rate limit per caller. Distinct prefix from the digest audit
  // endpoint so the two surfaces have independent budgets.
  const rl = await rateLimitUserAction(request, `admin:audit-events:${user.id}`)
  if (!rl.allowed) {
    reqLog.warn({ userId: user.id, retryMs: rl.retryAfterMs }, 'rate_limit.blocked')
    return respond(rateLimitedResponse(rl))
  }

  // 3. Parse query.
  const url = new URL(request.url)
  const parsed = QuerySchema.safeParse({
    venue_id: url.searchParams.get('venue_id') ?? undefined,
    action: url.searchParams.get('action') ?? undefined,
    target_table: url.searchParams.get('target_table') ?? undefined,
    target_id: url.searchParams.get('target_id') ?? undefined,
    actor_user_id: url.searchParams.get('actor_user_id') ?? undefined,
    actor_kind: url.searchParams.get('actor_kind') ?? undefined,
    since: url.searchParams.get('since') ?? undefined,
    occurred_before: url.searchParams.get('occurred_before') ?? undefined,
    id: url.searchParams.get('id') ?? undefined,
    include_snapshots: url.searchParams.get('include_snapshots') ?? undefined,
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
    action: actionFilter,
    target_table: targetTableFilter,
    target_id: targetIdFilter,
    actor_user_id: actorUserFilter,
    actor_kind: actorKindFilter = 'all',
    since,
    occurred_before: occurredBefore,
    id: rowIdFilter,
    include_snapshots: includeSnapshots = false,
    limit = DEFAULT_LIMIT,
    format = 'json',
  } = parsed.data

  // 4. Resolve target venue + tenant bind. Mirror the rest of the
  // admin surface — cross-tenant requires ADMIN_ROLES; forbidden
  // collapses to 404.
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

  const svc = createServiceClient()

  // 5. Single-row drawer fetch. We still bind the row to the resolved
  // venue (eq venue_id) so a tampered id can never read another
  // tenant's row — the cross-tenant 404 collapse applies.
  if (rowIdFilter) {
    const { data: rowRaw, error: rowErr } = await svc
      .from('audit_events')
      .select(FULL_SELECT)
      .eq('id', rowIdFilter)
      .eq('venue_id', targetVenueId)
      .maybeSingle()
    if (rowErr) {
      reqLog.error({ err: rowErr, id: rowIdFilter }, 'admin.audit_events.row_fetch_failed')
      captureApiError(rowErr, {
        requestId,
        route: '/api/admin/audit-events',
        userId: user.id,
        venueId: targetVenueId,
      })
      return respond(NextResponse.json({ error: 'unexpected_error' }, { status: 500 }))
    }
    if (!rowRaw) {
      return respond(NextResponse.json({ error: 'not_found' }, { status: 404 }))
    }
    return respond(NextResponse.json({ item: rowRaw as AuditEventRow }))
  }

  // 6. List query.
  let query = svc
    .from('audit_events')
    .select(includeSnapshots ? FULL_SELECT : BASE_SELECT)
    .eq('venue_id', targetVenueId)
    .order('created_at', { ascending: false })
    .limit(limit)

  if (actionFilter) query = query.eq('action', actionFilter)
  if (targetTableFilter) query = query.eq('target_table', targetTableFilter)
  if (targetIdFilter) query = query.eq('target_id', targetIdFilter)
  if (actorUserFilter) query = query.eq('actor_user_id', actorUserFilter)
  if (actorKindFilter !== 'all') query = query.eq('actor_kind', actorKindFilter)
  if (since) query = query.gte('created_at', since)
  if (occurredBefore) query = query.lt('created_at', occurredBefore)

  const { data: rowsRaw, error: queryErr } = await query
  if (queryErr) {
    reqLog.error(
      { err: queryErr, venueId: targetVenueId },
      'admin.audit_events.query_failed'
    )
    captureApiError(queryErr, {
      requestId,
      route: '/api/admin/audit-events',
      userId: user.id,
      venueId: targetVenueId,
    })
    return respond(NextResponse.json({ error: 'unexpected_error' }, { status: 500 }))
  }

  // The dynamic select string (BASE_SELECT vs FULL_SELECT) defeats
  // PostgREST's type inference, so we round-trip through `unknown`.
  const items = (rowsRaw ?? []) as unknown as AuditEventRow[]
  const hasMore = items.length === limit
  const nextCursor =
    hasMore && items.length > 0 ? items[items.length - 1].created_at : null

  reqLog.info(
    {
      venueId: targetVenueId,
      itemCount: items.length,
      actorKind: actorKindFilter,
      actionFilter: actionFilter ?? null,
      targetTableFilter: targetTableFilter ?? null,
      hasMore,
      hasCursor: Boolean(occurredBefore),
      format,
      includeSnapshots,
    },
    'admin.audit_events.listed'
  )

  if (format === 'csv') {
    return respond(renderCsv(items, requestId, { hasMore, nextCursor }))
  }
  return respond(
    NextResponse.json({
      items,
      next_cursor: nextCursor,
      has_more: hasMore,
    })
  )
}

// ============================================================================
// CSV renderer — matches the Phase 8Y digest-sends + Phase 8AC
// digest-audit-events shape: UTF-8 BOM, RFC-4180-quoted cells, X-Has-More +
// X-Next-Cursor pagination headers. Snapshots are emitted as compact JSON
// strings so a CSV consumer can re-parse them downstream.
// ============================================================================

const CSV_COLUMNS: ReadonlyArray<{
  key: keyof AuditEventRow | 'before_json' | 'after_json' | 'metadata_json'
  header: string
}> = [
  { key: 'id', header: 'id' },
  { key: 'venue_id', header: 'venue_id' },
  { key: 'actor_kind', header: 'actor_kind' },
  { key: 'actor_user_id', header: 'actor_user_id' },
  { key: 'route', header: 'route' },
  { key: 'action', header: 'action' },
  { key: 'target_table', header: 'target_table' },
  { key: 'target_id', header: 'target_id' },
  { key: 'request_id', header: 'request_id' },
  { key: 'ip_hash', header: 'ip_hash' },
  { key: 'user_agent', header: 'user_agent' },
  { key: 'created_at', header: 'created_at' },
  { key: 'before_json', header: 'before_json' },
  { key: 'after_json', header: 'after_json' },
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
  items: AuditEventRow[],
  requestId: string,
  pagination: { hasMore: boolean; nextCursor: string | null }
): Response {
  const header = CSV_COLUMNS.map((c) => c.header).join(',')
  const rows = items.map((row) =>
    CSV_COLUMNS.map((col) => {
      if (col.key === 'before_json') return escapeCsv(row.before_snapshot ?? null)
      if (col.key === 'after_json') return escapeCsv(row.after_snapshot ?? null)
      if (col.key === 'metadata_json') return escapeCsv(row.metadata ?? null)
      return escapeCsv(row[col.key as keyof AuditEventRow])
    }).join(',')
  )
  const body = '﻿' + [header, ...rows].join('\r\n') + '\r\n'

  const date = new Date().toISOString().slice(0, 10)
  const headers: Record<string, string> = {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="audit-events-${date}.csv"`,
    'Cache-Control': 'no-store',
    'X-Request-Id': requestId,
    'X-Has-More': pagination.hasMore ? 'true' : 'false',
  }
  if (pagination.hasMore && pagination.nextCursor) {
    headers['X-Next-Cursor'] = pagination.nextCursor
  }
  return new NextResponse(body, { status: 200, headers })
}
