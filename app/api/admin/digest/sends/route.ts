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
 * GET /api/admin/digest/sends  (Phase 8Y)
 *
 * Operator audit feed over digest deliveries. Reads `outbound_messages`
 * filtered to rows tagged with a `tour_digest_send_kind` metadata key
 * (cron / preview / manual — see BILLING-QA §7ae for the send-kind
 * matrix).
 *
 * ── HOW IT DIFFERS FROM /api/admin/tours/status-events ────────────────────
 * `status-events` is the per-tour audit feed. This route is the
 * per-digest-delivery feed. Same admin auth model, same rate-limit
 * shape, same JSON/CSV branch, same masking discipline.
 *
 * ── QUERY PARAMS ──────────────────────────────────────────────────────────
 *   venue_id?            uuid       — cross-tenant guarded via requireVenueRole
 *   send_kind?           cron|preview|manual|all   default all
 *   recipient_user_id?   uuid
 *   since?               ISO8601 datetime
 *   limit?               1..200, default 50
 *   format?              json|csv,  default json
 *
 * ── PII POSTURE ───────────────────────────────────────────────────────────
 *   - `recipient_email` is MASKED (`y***@domain.com`) by default. Even
 *     though the admin caller could otherwise look the email up via
 *     /api/admin/digest/members, the audit feed exists to support
 *     forensic queries at scale and we don't want a CSV download
 *     scattering raw emails across an operator's hard drive.
 *   - We deliberately do NOT return subject, body (text/html),
 *     provider_message_id, or the full metadata jsonb. Only an
 *     allow-listed subset of metadata keys is surfaced.
 *   - error field exposed as-is so operators can triage suppressions
 *     and provider failures.
 *
 * ── CSV BRANCH ────────────────────────────────────────────────────────────
 * `format=csv` returns a UTF-8 CSV with a BOM for Excel compatibility,
 * `Content-Disposition: attachment; filename="digest-sends-YYYY-MM-DD.csv"`.
 * Columns: id, venue_id, send_kind, status, recipient_user_id,
 * recipient_email, provider, event_count, cadence, weekly_day,
 * manual_initiator_user_id, error, created_at, delivered_at.
 *
 * ── RATE LIMIT ────────────────────────────────────────────────────────────
 * `admin:digest-sends:{userId}` — distinct from preview / manual / members.
 */

const QuerySchema = z.object({
  venue_id: z.string().uuid().optional(),
  send_kind: z.enum(['cron', 'preview', 'manual', 'all']).optional(),
  recipient_user_id: z.string().uuid().optional(),
  since: z.string().datetime().optional(),
  // Phase 8Z — descending cursor. Mirrors the Phase 8P pattern on
  // /api/admin/tours/status-events. Strict `<` so chained pages never
  // duplicate the boundary row.
  occurred_before: z.string().datetime().optional(),
  // Phase 8AA — free-text search. Capped at 120 chars; trimmed; empty
  // after trim coerces to absent in the handler. Same shape as the
  // Phase 8Q `?q=` on status-events.
  q: z.string().max(120).optional(),
  // Phase 8AB — opt-in inclusion of soft-archived rows. Default
  // false: feed callers see only "live" history. Forensic queries
  // pass `?include_archived=true` to surface rows the Phase 8AB
  // retention job has tagged with `metadata.digest_archived='true'`.
  include_archived: z
    .union([z.literal('true'), z.literal('false'), z.boolean()])
    .optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  format: z.enum(['json', 'csv']).optional(),
})

// Phase 8AA — search-term length threshold. Below this the search
// runs against a narrow scalar/metadata-key allowlist; at-or-above
// the threshold the full allowlist applies. Mirrors the Phase 8T/8U
// short-circuit pattern on `/api/admin/tours/status-events`.
const FULL_SEARCH_MIN_LEN = 3

const DEFAULT_LIMIT = 50

interface OutboundRow {
  id: string
  venue_id: string
  to_address: string | null
  provider: string | null
  status: string
  delivered_at: string | null
  error: string | null
  metadata: Record<string, unknown> | null
  created_at: string
}

interface SendItem {
  id: string
  venue_id: string
  recipient_user_id: string | null
  recipient_email: string | null
  send_kind: string
  status: string
  provider: string | null
  event_count: number | null
  cadence: string | null
  weekly_day: string | null
  manual_initiator_user_id: string | null
  error: string | null
  created_at: string
  delivered_at: string | null
  /** Phase 8AB — true when the Phase 8AB retention cron has tagged
   *  this row with `metadata.digest_archived='true'`. Always present
   *  on the response shape so clients can render the archived state
   *  without a separate fetch. */
  archived: boolean
}

export async function GET(request: NextRequest): Promise<Response> {
  const requestId = getOrCreateRequestId(request)
  const reqLog = log.child({
    requestId,
    route: '/api/admin/digest/sends',
    op: 'admin.digest_sends',
  })
  const respond = <T extends Response>(r: T) => withRequestIdHeader(r, requestId)

  const admin = await requireAdmin()
  if (!admin.ok) {
    return respond(NextResponse.json({ error: admin.code }, { status: admin.status }))
  }
  const { user, venueId: callerVenueId } = admin

  const rl = await rateLimitUserAction(request, `admin:digest-sends:${user.id}`)
  if (!rl.allowed) {
    reqLog.warn({ userId: user.id, retryMs: rl.retryAfterMs }, 'rate_limit.blocked')
    return respond(rateLimitedResponse(rl))
  }

  const url = new URL(request.url)
  const parsed = QuerySchema.safeParse({
    venue_id: url.searchParams.get('venue_id') ?? undefined,
    send_kind: url.searchParams.get('send_kind') ?? undefined,
    recipient_user_id: url.searchParams.get('recipient_user_id') ?? undefined,
    since: url.searchParams.get('since') ?? undefined,
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
    send_kind: sendKindFilter = 'all',
    recipient_user_id: recipientFilter,
    since,
    occurred_before: occurredBefore,
    q: qRaw,
    include_archived: includeArchivedRaw,
    limit = DEFAULT_LIMIT,
    format = 'json',
  } = parsed.data
  // Phase 8AB — `include_archived` accepts true|false|'true'|'false'
  // for URL-vs-fetch convenience. Default false: callers see only
  // live history.
  const includeArchived =
    includeArchivedRaw === true || includeArchivedRaw === 'true'
  // Trim + collapse-empty for the search term. Done after Zod
  // parsing so the schema's max-length still applies.
  const q = (qRaw ?? '').trim()
  const qMode: 'none' | 'short' | 'full' =
    q.length === 0
      ? 'none'
      : q.length < FULL_SEARCH_MIN_LEN
        ? 'short'
        : 'full'

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

  // Build the base query. `related_table = 'tour_status_events'`
  // narrows to the digest surface (all three send kinds tag this
  // value). The `not.is` filter on `metadata->>tour_digest_send_kind`
  // excludes legacy pre-8W rows from this audit feed — those rows
  // pre-date the discriminator and can't be classified accurately.
  const svc = createServiceClient()
  let query = svc
    .from('outbound_messages')
    .select(
      'id, venue_id, to_address, provider, status, delivered_at, error, metadata, created_at'
    )
    .eq('venue_id', targetVenueId)
    .eq('related_table', 'tour_status_events')
    .not('metadata->>tour_digest_send_kind', 'is', null)
    .order('created_at', { ascending: false })
    .limit(limit)

  if (sendKindFilter !== 'all') {
    query = query.filter('metadata->>tour_digest_send_kind', 'eq', sendKindFilter)
  }
  // Phase 8AB — archive gating. Default path excludes any row the
  // weekly retention cron has tagged. The two-clause `.or()` covers
  // both "key absent" and "key present but not 'true'" so a future
  // alternate value (e.g. 'pending') isn't accidentally hidden.
  if (!includeArchived) {
    query = query.or(
      'metadata->>digest_archived.is.null,metadata->>digest_archived.neq.true'
    )
  }
  if (recipientFilter) {
    query = query.filter(
      'metadata->>tour_digest_recipient_user_id',
      'eq',
      recipientFilter
    )
  }
  if (since) {
    query = query.gte('created_at', since)
  }
  // Phase 8Z — descending cursor. Strict `<` so chaining
  // `?occurred_before=<next_cursor>` never re-emits the boundary row.
  if (occurredBefore) {
    query = query.lt('created_at', occurredBefore)
  }
  // Phase 8AA — free-text search. `qMode === 'short'` (1–2 chars)
  // matches a narrow allowlist of scalar columns + the `send_kind`
  // metadata key (the only metadata key small enough to make sense
  // for a short term). `qMode === 'full'` (3+ chars) widens to every
  // supported field.
  //
  // PostgREST's `.or()` accepts a comma-separated string of column
  // expressions. Each `ilike.*<term>*` wraps the user term in
  // wildcards. We escape commas + parentheses + backslashes in the
  // term to avoid breaking out of the `.or()` syntax. Backslash also
  // needs to escape `%` and `_` to defang ILIKE wildcards inside the
  // user-supplied term itself (search for `100%` should match the
  // literal string, not "anything").
  if (qMode !== 'none') {
    const escaped = q
      .replace(/\\/g, '\\\\')
      .replace(/%/g, '\\%')
      .replace(/_/g, '\\_')
      .replace(/,/g, '')
      .replace(/\(/g, '')
      .replace(/\)/g, '')
    const wrap = `*${escaped}*`
    const shortFields = [
      `status.ilike.${wrap}`,
      `provider.ilike.${wrap}`,
      `error.ilike.${wrap}`,
      // Searching `to_address` ILIKE preserves the email PII rule —
      // we never RETURN the raw address; matching on it server-side
      // is internal-only. An admin can find "all sends to o***@…" by
      // searching the local-part fragment they remember.
      `to_address.ilike.${wrap}`,
      `metadata->>tour_digest_send_kind.ilike.${wrap}`,
    ]
    const fullExtras = [
      `metadata->>tour_digest_cadence.ilike.${wrap}`,
      `metadata->>tour_digest_weekly_day.ilike.${wrap}`,
      `metadata->>tour_digest_recipient_user_id.ilike.${wrap}`,
      `metadata->>tour_digest_manual_initiator_user_id.ilike.${wrap}`,
    ]
    const orExpr =
      qMode === 'full'
        ? [...shortFields, ...fullExtras].join(',')
        : shortFields.join(',')
    query = query.or(orExpr)
  }

  const { data: rowsRaw, error: queryErr } = await query
  if (queryErr) {
    reqLog.error(
      { err: queryErr, venueId: targetVenueId },
      'admin.digest_sends.query_failed'
    )
    captureApiError(queryErr, {
      requestId,
      route: '/api/admin/digest/sends',
      userId: user.id,
      venueId: targetVenueId,
    })
    return respond(NextResponse.json({ error: 'unexpected_error' }, { status: 500 }))
  }

  const rows = (rowsRaw ?? []) as OutboundRow[]
  const items: SendItem[] = rows.map(toSendItem)

  // Phase 8Z — pagination metadata. `has_more` is set when the page
  // came back full; the next page's cursor is the last returned row's
  // created_at. A short page (rows.length < limit) implies the
  // operator reached the end and no further fetch is needed.
  const hasMore = items.length === limit
  const nextCursor = hasMore && items.length > 0
    ? items[items.length - 1].created_at
    : null

  reqLog.info(
    {
      venueId: targetVenueId,
      itemCount: items.length,
      sendKind: sendKindFilter,
      format,
      hasMore,
      hasCursor: Boolean(occurredBefore),
      qMode,
      qLen: q.length,
      includeArchived,
    },
    'admin.digest_sends.listed'
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
// Mapping + masking helpers
// ============================================================================

function toSendItem(row: OutboundRow): SendItem {
  const meta = (row.metadata ?? {}) as Record<string, unknown>
  return {
    id: row.id,
    venue_id: row.venue_id,
    recipient_user_id: readString(meta.tour_digest_recipient_user_id),
    recipient_email: maskEmail(row.to_address),
    send_kind: readString(meta.tour_digest_send_kind) ?? 'unknown',
    status: row.status,
    provider: row.provider,
    event_count: readNumber(meta.tour_digest_total),
    cadence: readString(meta.tour_digest_cadence),
    weekly_day: readString(meta.tour_digest_weekly_day) || null,
    manual_initiator_user_id: readString(meta.tour_digest_manual_initiator_user_id),
    error: row.error,
    created_at: row.created_at,
    delivered_at: row.delivered_at,
    // Phase 8AB — archived flag derived from the retention marker.
    // Lenient read: the cron writes the literal boolean `true` (jsonb)
    // but a future operator hand-patch could land the string 'true'
    // instead, so we accept either.
    archived:
      meta.digest_archived === true || meta.digest_archived === 'true',
  }
}

function readString(v: unknown): string | null {
  if (typeof v !== 'string' || v.length === 0) return null
  return v
}

function readNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.length > 0) {
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  return null
}

/**
 * Phase 8Y — email masking. A raw `operator@example.com` becomes
 * `o***@example.com`. Defends against an admin downloading the CSV
 * and accidentally scattering raw emails across screenshots / Slack
 * threads. The picker endpoint (`/api/admin/digest/members`) still
 * returns raw emails because the picker NEEDS a human-readable label
 * — the audit feed doesn't.
 */
function maskEmail(addr: string | null): string | null {
  if (!addr || typeof addr !== 'string') return null
  const at = addr.indexOf('@')
  if (at < 1) return null
  const local = addr.slice(0, at)
  const domain = addr.slice(at)
  // Always show ONE leading char then mask, regardless of local-part
  // length. For 1-char local parts this yields `y***@…` — minimal
  // info but consistent with the operator's mental model.
  const head = local.slice(0, 1)
  return `${head}***${domain}`
}

// ============================================================================
// CSV renderer
// ============================================================================

const CSV_COLUMNS: ReadonlyArray<{ key: keyof SendItem; header: string }> = [
  { key: 'id', header: 'id' },
  { key: 'venue_id', header: 'venue_id' },
  { key: 'send_kind', header: 'send_kind' },
  { key: 'status', header: 'status' },
  { key: 'recipient_user_id', header: 'recipient_user_id' },
  { key: 'recipient_email', header: 'recipient_email_masked' },
  { key: 'provider', header: 'provider' },
  { key: 'event_count', header: 'event_count' },
  { key: 'cadence', header: 'cadence' },
  { key: 'weekly_day', header: 'weekly_day' },
  { key: 'manual_initiator_user_id', header: 'manual_initiator_user_id' },
  { key: 'error', header: 'error' },
  { key: 'created_at', header: 'created_at' },
  { key: 'delivered_at', header: 'delivered_at' },
  // Phase 8AB — archived flag column. Operators reviewing a CSV
  // export that included `?include_archived=true` can sort/filter
  // archived vs live rows in their spreadsheet of choice.
  { key: 'archived', header: 'archived' },
]

function escapeCsv(value: unknown): string {
  if (value === null || value === undefined) return ''
  const s = String(value)
  // RFC 4180-ish quoting: wrap if it contains comma / quote / newline.
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`
  }
  return s
}

interface CsvPagination {
  hasMore: boolean
  nextCursor: string | null
}

function renderCsv(
  items: SendItem[],
  requestId: string,
  pagination: CsvPagination
): Response {
  const header = CSV_COLUMNS.map((c) => c.header).join(',')
  const rows = items.map((it) =>
    CSV_COLUMNS.map((c) => escapeCsv(it[c.key])).join(',')
  )
  // UTF-8 BOM so Excel auto-detects the encoding.
  const body = '﻿' + [header, ...rows].join('\r\n') + '\r\n'

  const date = new Date().toISOString().slice(0, 10)
  // Phase 8Z — pagination metadata via response headers (CSV body
  // intentionally doesn't carry control fields). `X-Next-Cursor` is
  // only set when `has_more` is true so a finished page doesn't
  // tempt a client into an unnecessary final fetch.
  const headers: Record<string, string> = {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="digest-sends-${date}.csv"`,
    'Cache-Control': 'no-store',
    'X-Request-Id': requestId,
    'X-Has-More': pagination.hasMore ? 'true' : 'false',
  }
  if (pagination.hasMore && pagination.nextCursor) {
    headers['X-Next-Cursor'] = pagination.nextCursor
  }
  return new NextResponse(body, { status: 200, headers })
}
