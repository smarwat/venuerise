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
 * GET /api/admin/tours/status-events  (Phase 8M)
 *
 * Unified operator audit feed for every tour status change, regardless
 * of which write path produced it (lead token, operator PATCH, admin
 * bulk-cancel, billing auto-pause cron, future system paths).
 *
 * This is the successor to the Phase 8K/8L narrow endpoint
 * `/api/admin/tours/recent-token-actions`, which now carries a
 * `Deprecation: true` header pointing here. Both endpoints will remain
 * mounted for one release cycle to avoid breaking external dashboards.
 *
 * ── AUTH / TENANT ─────────────────────────────────────────────────────────
 *   - `requireAdmin()` first.
 *   - Optional `venue_id` overrides the caller's primary venue;
 *     cross-tenant access re-verified via `requireVenueRole(ADMIN_ROLES)`.
 *     Cross-tenant denial collapses to 404 (no UUID enumeration).
 *   - Per-caller rate limit `admin:tours-status-events:{userId}`.
 *
 * ── FILTERS (all optional) ────────────────────────────────────────────────
 *   - `venue_id`    — uuid, cross-tenant guarded
 *   - `tour_id`     — narrow to a single tour's full history
 *   - `lead_id`     — narrow to one lead's tour-related activity
 *   - `actor_kind`  — `lead_token | operator | cron | system | all`
 *   - `action`      — exact-match filter on the action verb
 *   - `limit`       — 1..200, default 50
 *
 * ── PII POSTURE ───────────────────────────────────────────────────────────
 *   - Does NOT join leads — `lead_name`/`lead_email` are deliberately
 *     absent. Operators who need lead context pivot through `lead_id`
 *     into `/dashboard/inbox/<lead_id>`.
 *   - `source_ip` is CIDR-masked at write time (Phase 8L `maskIp`).
 *   - `token_nonce` is exclusive to `tour_action_events`; never present
 *     in this table's columns.
 *   - `metadata` is spread as-is; the helper write paths are responsible
 *     for keeping PII out of it.
 *   - `X-Request-Id` set via the standard `respond()` wrapper.
 */

const ACTOR_KINDS = ['lead_token', 'operator', 'cron', 'system', 'all'] as const

const QuerySchema = z.object({
  venue_id: z.string().uuid().optional(),
  tour_id: z.string().uuid().optional(),
  lead_id: z.string().uuid().optional(),
  actor_kind: z.enum(ACTOR_KINDS).optional(),
  // Action verb whitelist would be brittle — new write paths add new
  // verbs. We accept any short string, max 64 chars.
  action: z.string().min(1).max(64).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  // Phase 8O — optional output format. Defaults to JSON for back compat;
  // `csv` returns a downloadable text/csv with the same column ordering
  // documented in BILLING-QA §7q.
  format: z.enum(['json', 'csv']).optional().default('json'),
  // Phase 8P — cursor for descending `occurred_at` pagination. When
  // present, we apply `occurred_at < occurred_before`, so the next page
  // of older rows comes back. Strict ISO-8601 string; anything else
  // fails Zod and surfaces as a 400.
  occurred_before: z.string().datetime().optional(),
  // Phase 8Q — free-text search over scalar columns. Trimmed + bounded.
  // Empty after trim coerces to undefined so the route treats it as
  // absent (matches the client-side "no input" UX).
  q: z
    .string()
    .max(120)
    .transform((s) => s.trim())
    .optional()
    .transform((s) => (s && s.length > 0 ? s : undefined)),
  // Phase 8Q — streamed CSV mode. Only meaningful with format=csv.
  // Internally pages through results with the existing occurred_at
  // cursor, emitting one continuous CSV stream up to STREAM_HARD_CAP.
  stream: z.enum(['0', '1']).optional(),
})

// Phase 8Q — guardrails for the streaming export. Operators chaining a
// page-loop today max out at limit=200 per request; the stream collapses
// that into one response but we still need a hard ceiling so a misuse
// (or a venue with months of inserts) can't blow the request budget.
const STREAM_HARD_CAP = 5000
const STREAM_DEFAULT_PAGE_SIZE = 200

// Phase 8Q — server-side `q` filter target columns. We deliberately do
// NOT include `metadata::text` here: PostgREST's `.or()` builder can't
// express a jsonb-cast `ilike` cleanly, and a Postgres function +
// SECURITY DEFINER would require a migration. Documented as a known
// limitation in BILLING-QA §7s; client-side search still matches the
// metadata JSON over the loaded slice.
const SEARCH_COLUMNS = [
  'reason',
  'actor_id',
  'action',
  'previous_status',
  'new_status',
] as const

/**
 * Escape a user-supplied search string for safe inclusion in a
 * PostgREST `.or()` clause. PostgREST splits the string on commas and
 * parentheses, so any of those in the search term must be quoted.
 * Wrapping the value in `"..."` and escaping internal backslashes +
 * double-quotes is sufficient — the underlying `.ilike` operator then
 * sees the literal as a pattern; we add `%` wildcards around the
 * trimmed term so substring matches work.
 */
function buildSearchOrClause(rawTerm: string): string {
  const escaped = rawTerm.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  const pattern = `%${escaped}%`
  return SEARCH_COLUMNS.map((col) => `${col}.ilike."${pattern}"`).join(',')
}

// Phase 8O — CSV escaper. Quotes any field that contains a comma, quote,
// CR, or LF; doubles internal quotes. Null/undefined → empty cell.
//
// We deliberately don't use a CSV library — the row count is bounded by
// the `limit` query (max 200) and the helper is a single function that
// every column flows through. A dependency would add weight for zero
// behavior gain.
function csvCell(value: unknown): string {
  if (value === null || value === undefined) return ''
  const str = typeof value === 'string' ? value : String(value)
  if (str.length === 0) return ''
  const needsQuote = /[",\r\n]/.test(str)
  if (!needsQuote) return str
  return `"${str.replace(/"/g, '""')}"`
}

const CSV_COLUMNS = [
  'id',
  'venue_id',
  'tour_id',
  'lead_id',
  'actor_kind',
  'actor_id',
  'action',
  'previous_status',
  'new_status',
  'source_ip',
  'user_agent',
  'reason',
  'occurred_at',
  'metadata_json',
] as const

interface EventRow {
  id: string
  venue_id: string
  tour_id: string
  lead_id: string | null
  actor_kind: string
  actor_id: string | null
  action: string
  previous_status: string | null
  new_status: string
  source_ip: string | null
  user_agent: string | null
  reason: string | null
  metadata: Record<string, unknown> | null
  occurred_at: string
}

export async function GET(request: NextRequest) {
  const requestId = getOrCreateRequestId(request)
  const reqLog = log.child({
    requestId,
    route: '/api/admin/tours/status-events',
  })
  const respond = <T extends Response>(r: T) => withRequestIdHeader(r, requestId)

  // 1. Auth.
  const admin = await requireAdmin()
  if (!admin.ok) {
    return respond(NextResponse.json({ error: admin.code }, { status: admin.status }))
  }
  const { user, venueId: callerVenueId } = admin

  // 2. Rate-limit per caller.
  const rl = await rateLimitUserAction(
    request,
    `admin:tours-status-events:${user.id}`
  )
  if (!rl.allowed) {
    reqLog.warn({ userId: user.id, retryMs: rl.retryAfterMs }, 'rate_limit.blocked')
    return respond(rateLimitedResponse(rl))
  }

  // 3. Validate query.
  const url = new URL(request.url)
  const queryParsed = QuerySchema.safeParse({
    venue_id: url.searchParams.get('venue_id') ?? undefined,
    tour_id: url.searchParams.get('tour_id') ?? undefined,
    lead_id: url.searchParams.get('lead_id') ?? undefined,
    actor_kind: url.searchParams.get('actor_kind') ?? undefined,
    action: url.searchParams.get('action') ?? undefined,
    limit: url.searchParams.get('limit') ?? undefined,
    format: url.searchParams.get('format') ?? undefined,
    occurred_before: url.searchParams.get('occurred_before') ?? undefined,
    q: url.searchParams.get('q') ?? undefined,
    stream: url.searchParams.get('stream') ?? undefined,
  })
  if (!queryParsed.success) {
    return respond(
      NextResponse.json(
        { error: 'validation_failed', detail: queryParsed.error.flatten() },
        { status: 400 }
      )
    )
  }
  const {
    venue_id: bodyVenueId,
    tour_id: tourId,
    lead_id: leadId,
    actor_kind: actorKind,
    action,
    limit,
    format,
    occurred_before: occurredBefore,
    q,
    stream: streamFlag,
  } = queryParsed.data
  const streamEnabled = streamFlag === '1' && format === 'csv'

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

  const svc = createServiceClient()

  // Phase 8Q — shared query builder for the NON-`q` path. The PostgREST
  // chain handles every filter except `q`; for `q`, we hand off to the
  // Phase 8R RPC which can search `metadata::text` server-side.
  //
  // Return type is left to inference because the PostgREST builder
  // chain re-narrows on every `.eq()` and pinning it explicitly would
  // lose the `.limit()` method downstream.
  function buildBaseQuery() {
    let q2 = svc
      .from('tour_status_events')
      .select(
        'id, venue_id, tour_id, lead_id, actor_kind, actor_id, action, previous_status, new_status, source_ip, user_agent, reason, metadata, occurred_at'
      )
      .eq('venue_id', targetVenueId)
      .order('occurred_at', { ascending: false })

    if (tourId) q2 = q2.eq('tour_id', tourId)
    if (leadId) q2 = q2.eq('lead_id', leadId)
    if (actorKind && actorKind !== 'all') q2 = q2.eq('actor_kind', actorKind)
    if (action) q2 = q2.eq('action', action)
    // NOTE: `q` is NOT applied here. When `q` is present, callers must
    // route through `fetchEventsPage()` below, which dispatches to the
    // search_tour_status_events RPC.
    return q2
  }

  // Phase 8R — `q_mode` discriminator for logging. 'rpc_metadata' means
  // we delegated to the SECURITY DEFINER RPC (and therefore searched
  // `metadata::text`); 'standard' means the PostgREST chain (which
  // doesn't search metadata).
  const qMode: 'rpc_metadata' | 'standard' = q ? 'rpc_metadata' : 'standard'

  /**
   * Phase 8R — unified per-page fetcher.
   *
   * Dispatches to either the RPC (when `q` is present) or the standard
   * PostgREST chain (otherwise). Both branches return the same EventRow
   * shape + optional error, so the caller can stay format-agnostic.
   *
   * `cursor` is the descending-pagination anchor; null on the first
   * page. The RPC accepts it via `p_occurred_before`; the standard
   * path applies it via `.lt('occurred_at', …)`.
   */
  async function fetchEventsPage(
    cursor: string | null,
    pageLimit: number
  ): Promise<{ data: EventRow[]; error: unknown }> {
    if (q) {
      // RPC path — metadata-aware search.
      const { data, error } = await svc.rpc('search_tour_status_events', {
        p_venue_id: targetVenueId,
        p_tour_id: tourId ?? null,
        p_lead_id: leadId ?? null,
        p_actor_kind: actorKind && actorKind !== 'all' ? actorKind : null,
        p_action: action ?? null,
        p_q: q,
        p_occurred_before: cursor,
        p_limit: pageLimit,
      })
      return {
        data: ((data ?? []) as EventRow[]),
        error,
      }
    }
    // Standard path — PostgREST chain, identical to Phase 8Q.
    let pageQuery = buildBaseQuery().limit(pageLimit)
    if (cursor) pageQuery = pageQuery.lt('occurred_at', cursor)
    const { data, error } = await pageQuery
    return {
      data: ((data ?? []) as EventRow[]),
      error,
    }
  }

  // -----------------------------------------------------------------
  // Phase 8Q — streamed CSV branch.
  //
  // Pages through `tour_status_events` server-side using the existing
  // `occurred_at` cursor, emitting one continuous CSV body via a
  // `ReadableStream`. Bounded by STREAM_HARD_CAP (5000 rows) so a
  // misconfigured filter can't produce a runaway export.
  //
  // Honors every filter the single-page path honors (venue, tour,
  // lead, actor_kind, action, q, plus `occurred_before` as the
  // STARTING cursor when the caller wants to resume mid-stream).
  // -----------------------------------------------------------------
  if (streamEnabled) {
    const pageSize = Math.max(1, Math.min(limit, STREAM_HARD_CAP))
    const dateSlug = new Date().toISOString().slice(0, 10)
    const filename = `tour-status-events-stream-${dateSlug}.csv`

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const encoder = new TextEncoder()
        try {
          // UTF-8 BOM + header row, emitted once.
          controller.enqueue(encoder.encode('﻿' + CSV_COLUMNS.join(',') + '\n'))

          let cursor = occurredBefore ?? null
          let emitted = 0
          let pageNumber = 0

          while (emitted < STREAM_HARD_CAP) {
            pageNumber++
            const remaining = STREAM_HARD_CAP - emitted
            const thisPageLimit = Math.min(pageSize, remaining)

            // Phase 8R — fetcher dispatches to the RPC when `q` is set,
            // the PostgREST chain otherwise. Single call site keeps
            // streaming + single-page behavior consistent.
            const { data, error } = await fetchEventsPage(cursor, thisPageLimit)
            if (error) {
              const errMsg =
                error instanceof Error
                  ? error.message
                  : typeof (error as { message?: unknown })?.message === 'string'
                    ? String((error as { message: string }).message)
                    : 'unknown'
              reqLog.error(
                { err: error, pageNumber, emitted, qMode },
                'admin.tours_status_events.stream_page_failed'
              )
              captureApiError(error, {
                requestId,
                route: '/api/admin/tours/status-events',
                userId: user.id,
                venueId: targetVenueId,
              })
              // Surface a trailing comment so a consumer parsing the
              // chunked response sees the truncation reason. Lines
              // starting with `#` are not valid CSV but most readers
              // skip them; we ALSO close the stream below so the
              // download finalizes.
              controller.enqueue(
                encoder.encode(`# stream aborted: ${errMsg}\n`)
              )
              break
            }

            const pageRows = data
            if (pageRows.length === 0) break

            const lines = pageRows.map((e) => {
              const metadataJson = JSON.stringify(e.metadata ?? {})
              return [
                csvCell(e.id),
                csvCell(e.venue_id),
                csvCell(e.tour_id),
                csvCell(e.lead_id),
                csvCell(e.actor_kind),
                csvCell(e.actor_id),
                csvCell(e.action),
                csvCell(e.previous_status),
                csvCell(e.new_status),
                csvCell(e.source_ip),
                csvCell(e.user_agent),
                csvCell(e.reason),
                csvCell(e.occurred_at),
                csvCell(metadataJson),
              ].join(',')
            })
            controller.enqueue(encoder.encode(lines.join('\n') + '\n'))

            emitted += pageRows.length
            cursor = pageRows[pageRows.length - 1].occurred_at

            // Page wasn't full → no more rows; clean exit.
            if (pageRows.length < thisPageLimit) break
          }

          reqLog.info(
            {
              userId: user.id,
              venueId: targetVenueId,
              pageNumber,
              emitted,
              hitCap: emitted >= STREAM_HARD_CAP,
            },
            'admin.tours_status_events.stream_complete'
          )
        } catch (err) {
          reqLog.error({ err }, 'admin.tours_status_events.stream_threw')
          captureApiError(err, {
            requestId,
            route: '/api/admin/tours/status-events',
            userId: user.id,
            venueId: targetVenueId,
          })
        } finally {
          controller.close()
        }
      },
    })

    const headers: Record<string, string> = {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
      'X-Streamed': 'true',
      'X-Row-Limit': String(STREAM_HARD_CAP),
    }
    return respond(new NextResponse(stream, { status: 200, headers }))
  }

  // 5. Single-page path (default for JSON + non-streamed CSV).
  //
  // Phase 8R — same `fetchEventsPage` helper as the streaming branch.
  // When `q` is present, the helper delegates to the
  // search_tour_status_events RPC (metadata-aware); otherwise it uses
  // the PostgREST chain. Cursor pagination via `occurred_before` is
  // honored on both paths.
  const { data, error } = await fetchEventsPage(occurredBefore ?? null, limit)

  if (error) {
    reqLog.error({ err: error, qMode }, 'admin.tours_status_events.query_failed')
    captureApiError(error, {
      requestId,
      route: '/api/admin/tours/status-events',
      userId: user.id,
      venueId: targetVenueId,
    })
    return respond(NextResponse.json({ error: 'unexpected_error' }, { status: 500 }))
  }

  const events = (data ?? []) as EventRow[]

  // Phase 8P — cursor pagination. We use a "limit equality = more pages"
  // heuristic: if the result set is full, assume another page exists and
  // hand back the last row's occurred_at as the next cursor. The next
  // request with `occurred_before=<cursor>` strictly excludes the anchor
  // row (we use `<`, not `<=`), so paginated chains never duplicate rows.
  //
  // Edge case: a venue whose row count is EXACTLY a multiple of `limit`
  // will return `has_more: true` on the final page and produce an empty
  // follow-up. Operators expect this; the explicit empty page is the
  // signal that pagination is done.
  const hasMore = events.length === limit
  const nextCursor = hasMore ? events[events.length - 1].occurred_at : null

  reqLog.info(
    {
      userId: user.id,
      venueId: targetVenueId,
      filters: {
        tour_id: tourId ?? null,
        lead_id: leadId ?? null,
        actor_kind: actorKind ?? null,
        action: action ?? null,
        format,
        occurred_before: occurredBefore ?? null,
        q: q ?? null,
        q_mode: qMode,
      },
      returned: events.length,
      has_more: hasMore,
    },
    'admin.tours_status_events.completed'
  )

  if (format === 'csv') {
    // Phase 8O — CSV export. Auth / tenant / rate-limit / Sentry posture
    // is identical to the JSON path above; we just serialize the SAME
    // rows differently. Auto-generated filename embeds today's date
    // (UTC) so an operator who exports the same filter twice in a row
    // doesn't have to rename the second download.
    //
    // Note: `metadata_json` is the compact JSON of the row's `metadata`
    // jsonb — not a separate column. Operators who want structured
    // metadata querying use the JSON endpoint; CSV consumers get the
    // raw blob so nothing is lost.
    const dateSlug = new Date().toISOString().slice(0, 10)
    const filename = `tour-status-events-${dateSlug}.csv`
    const header = CSV_COLUMNS.join(',')
    const lines = events.map((e) => {
      const metadataJson = JSON.stringify(e.metadata ?? {})
      return [
        csvCell(e.id),
        csvCell(e.venue_id),
        csvCell(e.tour_id),
        csvCell(e.lead_id),
        csvCell(e.actor_kind),
        csvCell(e.actor_id),
        csvCell(e.action),
        csvCell(e.previous_status),
        csvCell(e.new_status),
        csvCell(e.source_ip),
        csvCell(e.user_agent),
        csvCell(e.reason),
        csvCell(e.occurred_at),
        csvCell(metadataJson),
      ].join(',')
    })
    // Prepend a UTF-8 BOM so Excel opens the file as UTF-8 instead of
    // Windows-1252. Other consumers (Sheets, pandas, awk) ignore the BOM.
    const body = '﻿' + header + '\n' + lines.join('\n') + '\n'
    // Phase 8P — surface pagination state via response headers so CSV
    // consumers don't have to parse the body to chain pages. JSON
    // callers get the same info in the response object below.
    const csvHeaders: Record<string, string> = {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
      'X-Has-More': hasMore ? 'true' : 'false',
    }
    if (nextCursor) csvHeaders['X-Next-Cursor'] = nextCursor
    return respond(
      new NextResponse(body, {
        status: 200,
        headers: csvHeaders,
      })
    )
  }

  return respond(
    NextResponse.json({
      items: events,
      next_cursor: nextCursor,
      has_more: hasMore,
    })
  )
}
