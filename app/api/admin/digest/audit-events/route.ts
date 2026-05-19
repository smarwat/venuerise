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
 * GET /api/admin/digest/audit-events  (Phase 8AC)
 *
 * Surfaces `public.digest_audit_events` rows (migration 017) for the
 * billing-page `DigestAuditLogCard`. Mirrors the Phase 8Y digest
 * sends endpoint shape: cursor pagination, JSON + CSV branches,
 * cross-tenant guarded by requireVenueRole.
 *
 * ── ACTION FAMILIES ───────────────────────────────────────────────────────
 * Initial vocabulary (Phase 8AC):
 *   - 'suppression_remove'        per-row delete
 *   - 'suppression_remove_noop'   per-row idempotent no-op
 *   - 'suppression_remove_all'    bulk summary
 *   - 'digest_retention_archive'  weekly retention cron summary
 *
 * The `?action=<string>` filter does an EXACT match (no LIKE) so a
 * future caller can target a single action family. The card uses
 * filter chips with explicit families.
 *
 * ── PII POSTURE ───────────────────────────────────────────────────────────
 *   - `target_email_masked` is stored masked at write time; we
 *     return it as-is. The audit feed NEVER reads raw emails from
 *     auth.users for this surface.
 *   - `metadata_json` in the CSV emits a compact JSON serialization
 *     of the row's metadata. Helpers (suppression remove / retention)
 *     write only structural fields (route, counts, retention_days)
 *     so PII never lands there in the first place.
 */

const QuerySchema = z.object({
  venue_id: z.string().uuid().optional(),
  action: z.string().max(80).optional(),
  // Phase 8AD — `action_family` is a server-side fan-out so the
  // `DigestAuditLogCard` chip can drop its client-side multi-fetch.
  // `action` exact-match always wins when both are supplied.
  action_family: z
    .enum(['suppression', 'retention', 'cron', 'preview', 'all'])
    .optional(),
  actor_kind: z.enum(['operator', 'cron', 'system', 'all']).optional(),
  target_user_id: z.string().uuid().optional(),
  since: z.string().datetime().optional(),
  occurred_before: z.string().datetime().optional(),
  // Phase 8AD — free-text search. Capped 120 chars; trimmed; empty
  // after trim coerces to absent in the handler.
  q: z.string().max(120).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  format: z.enum(['json', 'csv']).optional(),
})

const DEFAULT_LIMIT = 50

// Phase 8AD — action_family → action list mapping. Kept as a literal
// table so the card and the route can stay in lockstep with a single
// source of truth (route exports the family vocabulary via the
// QuerySchema; the card hardcodes the chip strip and accepts that the
// two pair-bond manually).
const ACTION_FAMILIES: Record<
  Exclude<NonNullable<z.infer<typeof QuerySchema>['action_family']>, 'all'>,
  string[]
> = {
  suppression: [
    'suppression_remove',
    'suppression_remove_noop',
    'suppression_remove_all',
  ],
  retention: ['digest_retention_archive'],
  cron: ['digest_send_cron'],
  // Phase 8AE — preview audit family. Populated only when
  // DIGEST_AUDIT_LOG_CRON_SENDS=1 was set at the time the preview
  // fired (the preview route reuses the cron-send audit env gate so
  // operators don't have to flip a second flag).
  preview: ['digest_send_preview'],
}

// Phase 8AE — `q_mode` discriminator. Scalar-short for terms < 3
// chars (trigram indexes don't help below that length); metadata-
// indexed for terms ≥ 3 chars (the new gin_trgm_ops index on
// `metadata_text` makes that path planner-eligible).
const TRGM_MIN_LEN = 3
type QMode = 'none' | 'scalar_short' | 'metadata_indexed'

interface AuditRow {
  id: string
  venue_id: string
  actor_user_id: string | null
  actor_kind: 'operator' | 'cron' | 'system'
  action: string
  target_user_id: string | null
  target_email_masked: string | null
  reason: string | null
  metadata: Record<string, unknown> | null
  occurred_at: string
}

export async function GET(request: NextRequest): Promise<Response> {
  const requestId = getOrCreateRequestId(request)
  const reqLog = log.child({
    requestId,
    route: '/api/admin/digest/audit-events',
    op: 'admin.digest_audit_events',
  })
  const respond = <T extends Response>(r: T) => withRequestIdHeader(r, requestId)

  const admin = await requireAdmin()
  if (!admin.ok) {
    return respond(NextResponse.json({ error: admin.code }, { status: admin.status }))
  }
  const { user, venueId: callerVenueId } = admin

  const rl = await rateLimitUserAction(request, `admin:digest-audit-events:${user.id}`)
  if (!rl.allowed) {
    reqLog.warn({ userId: user.id, retryMs: rl.retryAfterMs }, 'rate_limit.blocked')
    return respond(rateLimitedResponse(rl))
  }

  const url = new URL(request.url)
  const parsed = QuerySchema.safeParse({
    venue_id: url.searchParams.get('venue_id') ?? undefined,
    action: url.searchParams.get('action') ?? undefined,
    actor_kind: url.searchParams.get('actor_kind') ?? undefined,
    target_user_id: url.searchParams.get('target_user_id') ?? undefined,
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
    action: actionFilter,
    action_family: actionFamilyFilter = 'all',
    actor_kind: actorKindFilter = 'all',
    target_user_id: targetFilter,
    since,
    occurred_before: occurredBefore,
    q: qRaw,
    limit = DEFAULT_LIMIT,
    format = 'json',
  } = parsed.data
  const q = (qRaw ?? '').trim()
  // Phase 8AE — pick the search mode UP FRONT so the log line can
  // emit a stable discriminator regardless of which clauses end up
  // in the final query. Mirrors the Phase 8T short-query pattern on
  // /api/admin/tours/status-events.
  const qMode: QMode =
    q.length === 0
      ? 'none'
      : q.length < TRGM_MIN_LEN
        ? 'scalar_short'
        : 'metadata_indexed'

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
  let query = svc
    .from('digest_audit_events')
    .select(
      'id, venue_id, actor_user_id, actor_kind, action, target_user_id, target_email_masked, reason, metadata, occurred_at'
    )
    .eq('venue_id', targetVenueId)
    .order('occurred_at', { ascending: false })
    .limit(limit)

  if (actionFilter) {
    // Exact action wins over family — single canonical match.
    query = query.eq('action', actionFilter)
  } else if (actionFamilyFilter !== 'all') {
    // Phase 8AD — server-side fan-out. Same set the card's chip
    // would have requested per-action; now one round-trip instead of
    // N. PostgREST `.in()` is a single SQL `IN` clause, which the
    // (action, occurred_at desc) index handles natively.
    const actions = ACTION_FAMILIES[actionFamilyFilter]
    query = query.in('action', actions)
  }
  if (actorKindFilter !== 'all') {
    query = query.eq('actor_kind', actorKindFilter)
  }
  if (targetFilter) {
    query = query.eq('target_user_id', targetFilter)
  }
  if (since) {
    query = query.gte('occurred_at', since)
  }
  if (occurredBefore) {
    query = query.lt('occurred_at', occurredBefore)
  }
  // Phase 8AD — free-text search across scalar columns. We DO NOT
  // search `metadata::text` here: no trigram index on
  // digest_audit_events.metadata (the Phase 8R/8S pg_trgm index is
  // tour_status_events only), so a `metadata::text ilike` would
  // sequentially scan every row. Operators who need deep metadata
  // search should hit the SQL editor directly.
  //
  // Escape `,` `(` `)` `\` `%` `_` for PostgREST `.or()` syntax +
  // ILIKE wildcard defang — mirrors the Phase 8AA pattern on
  // /api/admin/digest/sends.
  if (q.length > 0) {
    const escaped = q
      .replace(/\\/g, '\\\\')
      .replace(/%/g, '\\%')
      .replace(/_/g, '\\_')
      .replace(/,/g, '')
      .replace(/\(/g, '')
      .replace(/\)/g, '')
    const wrap = `*${escaped}*`
    // Allowlist: only text columns. UUID columns (actor_user_id,
    // target_user_id) need an explicit `::text` cast for ILIKE, and
    // PostgREST's `.or()` parser doesn't accept casted expressions
    // — searches on those columns would 400. Operators looking up a
    // specific user should use the `?target_user_id=` exact filter
    // (indexed) instead. Documented in BILLING-QA §7ak.
    const scalarFields = [
      `action.ilike.${wrap}`,
      `reason.ilike.${wrap}`,
      `target_email_masked.ilike.${wrap}`,
    ]
    // Phase 8AE — metadata_text is a generated stored column
    // (migration 018) with a GIN trigram index. Below 3 chars the
    // index can't win, so we skip the clause and stay scalar-only.
    // At ≥ 3 chars the OR widens to include it.
    const indexedFields =
      qMode === 'metadata_indexed' ? [`metadata_text.ilike.${wrap}`] : []
    const orExpr = [...scalarFields, ...indexedFields].join(',')
    query = query.or(orExpr)
  }

  const { data: rowsRaw, error: queryErr } = await query
  if (queryErr) {
    reqLog.error(
      { err: queryErr, venueId: targetVenueId },
      'admin.digest_audit_events.query_failed'
    )
    captureApiError(queryErr, {
      requestId,
      route: '/api/admin/digest/audit-events',
      userId: user.id,
      venueId: targetVenueId,
    })
    return respond(NextResponse.json({ error: 'unexpected_error' }, { status: 500 }))
  }

  const items = (rowsRaw ?? []) as AuditRow[]
  const hasMore = items.length === limit
  const nextCursor = hasMore && items.length > 0
    ? items[items.length - 1].occurred_at
    : null

  reqLog.info(
    {
      venueId: targetVenueId,
      itemCount: items.length,
      actorKind: actorKindFilter,
      actionFilter: actionFilter ?? null,
      actionFamilyFilter,
      qLen: q.length,
      qMode,
      format,
      hasMore,
      hasCursor: Boolean(occurredBefore),
    },
    'admin.digest_audit_events.listed'
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
// CSV renderer — matches the Phase 8Y digest-sends shape: UTF-8 BOM,
// RFC-4180-quoted cells, X-Has-More + X-Next-Cursor pagination headers.
// ============================================================================

const CSV_COLUMNS: ReadonlyArray<{
  key: keyof AuditRow | 'metadata_json'
  header: string
}> = [
  { key: 'id', header: 'id' },
  { key: 'venue_id', header: 'venue_id' },
  { key: 'actor_kind', header: 'actor_kind' },
  { key: 'actor_user_id', header: 'actor_user_id' },
  { key: 'action', header: 'action' },
  { key: 'target_user_id', header: 'target_user_id' },
  { key: 'target_email_masked', header: 'target_email_masked' },
  { key: 'reason', header: 'reason' },
  { key: 'occurred_at', header: 'occurred_at' },
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
  items: AuditRow[],
  requestId: string,
  pagination: { hasMore: boolean; nextCursor: string | null }
): Response {
  const header = CSV_COLUMNS.map((c) => c.header).join(',')
  const rows = items.map((row) =>
    CSV_COLUMNS.map((col) => {
      if (col.key === 'metadata_json') {
        return escapeCsv(row.metadata ?? {})
      }
      return escapeCsv(row[col.key])
    }).join(',')
  )
  const body = '﻿' + [header, ...rows].join('\r\n') + '\r\n'

  const date = new Date().toISOString().slice(0, 10)
  const headers: Record<string, string> = {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="digest-audit-events-${date}.csv"`,
    'Cache-Control': 'no-store',
    'X-Request-Id': requestId,
    'X-Has-More': pagination.hasMore ? 'true' : 'false',
  }
  if (pagination.hasMore && pagination.nextCursor) {
    headers['X-Next-Cursor'] = pagination.nextCursor
  }
  return new NextResponse(body, { status: 200, headers })
}
