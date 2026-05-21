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
 * GET /api/admin/security/sso-login-events  (Phase 9G)
 *
 * Surfaces `public.sso_login_events` (migration 030) for the
 * SsoLoginEventsCard. Mirrors the Phase 9F
 * `/api/admin/security/abuse-events` shape so the card can reuse
 * the same cursor-pagination + CSV pattern.
 *
 * Query params:
 *   - venue_id          (optional; defaults to caller's primary)
 *   - domain            (exact match)
 *   - outcome           ('initiated' | 'success' | 'failed' | 'blocked')
 *   - provider          (vendor identifier)
 *   - since             (ISO timestamp lower bound)
 *   - occurred_before   (cursor for "load older")
 *   - limit             (1..200, default 50)
 *   - format            (json | csv, default json)
 *
 * Response (JSON):
 *   {
 *     items: SsoLoginEventRow[],
 *     next_cursor: string | null,
 *     has_more: boolean,
 *     summary: {
 *       total,
 *       by_outcome,
 *       by_domain,
 *       by_reason,
 *     }
 *   }
 *
 * The summary is derived from the SAME slice. Public-route style
 * `venue_id IS NULL` rows (rare — only when an SSO callback fires
 * before any connection is matched) are NOT surfaced through this
 * endpoint — the WHERE clause `eq('venue_id', targetVenueId)`
 * filters them out. Operators investigating those query directly
 * via Supabase SQL editor.
 */

const QuerySchema = z.object({
  venue_id: z.string().uuid().optional(),
  domain: z.string().max(253).optional(),
  outcome: z.enum(['initiated', 'success', 'failed', 'blocked']).optional(),
  provider: z
    .enum(['workos', 'clerk', 'stytch', 'supabase_sso', 'custom_oidc'])
    .optional(),
  since: z.string().datetime().optional(),
  occurred_before: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  format: z.enum(['json', 'csv']).optional(),
})

const DEFAULT_LIMIT = 50

interface SsoLoginEventRow {
  id: string
  venue_id: string | null
  connection_id: string | null
  user_id: string | null
  email: string | null
  domain: string | null
  provider: string | null
  protocol: string | null
  outcome: string
  reason: string | null
  ip_hash: string | null
  request_id: string | null
  metadata: Record<string, unknown> | null
  created_at: string
}

function bumpCounter(map: Record<string, number>, key: string | null): void {
  if (!key) return
  map[key] = (map[key] ?? 0) + 1
}

export async function GET(request: NextRequest): Promise<Response> {
  const requestId = getOrCreateRequestId(request)
  const reqLog = log.child({
    requestId,
    route: '/api/admin/security/sso-login-events',
    op: 'admin.sso.login_events.list',
  })
  const respond = <T extends Response>(r: T) =>
    withRequestIdHeader(r, requestId)

  const admin = await requireAdmin()
  if (!admin.ok) {
    return respond(
      NextResponse.json({ error: admin.code }, { status: admin.status })
    )
  }
  const { user, venueId: callerVenueId } = admin

  const rl = await rateLimitUserAction(
    request,
    `admin:sso-login-events:${user.id}`,
    {
      route: '/api/admin/security/sso-login-events',
      method: 'GET',
      userId: user.id,
      venueId: callerVenueId,
      requestId,
    }
  )
  if (!rl.allowed) {
    reqLog.warn({ userId: user.id, retryMs: rl.retryAfterMs }, 'rate_limit.blocked')
    return respond(rateLimitedResponse(rl))
  }

  const url = new URL(request.url)
  const parsed = QuerySchema.safeParse({
    venue_id: url.searchParams.get('venue_id') ?? undefined,
    domain: url.searchParams.get('domain') ?? undefined,
    outcome: url.searchParams.get('outcome') ?? undefined,
    provider: url.searchParams.get('provider') ?? undefined,
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
    domain: domainFilter,
    outcome: outcomeFilter,
    provider: providerFilter,
    since,
    occurred_before: occurredBefore,
    limit = DEFAULT_LIMIT,
    format = 'json',
  } = parsed.data

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

  const svc = createServiceClient()
  let query = svc
    .from('sso_login_events')
    .select(
      'id, venue_id, connection_id, user_id, email, domain, provider, protocol, outcome, reason, ip_hash, request_id, metadata, created_at'
    )
    .eq('venue_id', targetVenueId)
    .order('created_at', { ascending: false })
    .limit(limit)

  if (domainFilter) query = query.eq('domain', domainFilter)
  if (outcomeFilter) query = query.eq('outcome', outcomeFilter)
  if (providerFilter) query = query.eq('provider', providerFilter)
  if (since) query = query.gte('created_at', since)
  if (occurredBefore) query = query.lt('created_at', occurredBefore)

  const { data: rowsRaw, error: queryErr } = await query
  if (queryErr) {
    reqLog.error(
      { err: queryErr, venueId: targetVenueId },
      'admin.sso.login_events.query_failed'
    )
    captureApiError(queryErr, {
      requestId,
      route: '/api/admin/security/sso-login-events',
      userId: user.id,
      venueId: targetVenueId,
    })
    return respond(
      NextResponse.json({ error: 'unexpected_error' }, { status: 500 })
    )
  }

  const items = (rowsRaw ?? []) as SsoLoginEventRow[]
  const hasMore = items.length === limit
  const nextCursor =
    hasMore && items.length > 0 ? items[items.length - 1].created_at : null

  const byOutcome: Record<string, number> = {}
  const byDomain: Record<string, number> = {}
  const byReason: Record<string, number> = {}
  for (const row of items) {
    bumpCounter(byOutcome, row.outcome)
    bumpCounter(byDomain, row.domain)
    bumpCounter(byReason, row.reason)
  }

  reqLog.info(
    {
      venueId: targetVenueId,
      userId: user.id,
      itemCount: items.length,
      domainFilter: domainFilter ?? null,
      outcomeFilter: outcomeFilter ?? null,
      providerFilter: providerFilter ?? null,
      hasMore,
      hasCursor: Boolean(occurredBefore),
      format,
    },
    'admin.sso.login_events.listed'
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
        by_outcome: byOutcome,
        by_domain: byDomain,
        by_reason: byReason,
      },
    })
  )
}

// ── CSV renderer — matches Phase 9F abuse-events shape ─────────────────

const CSV_COLUMNS: ReadonlyArray<{
  key: keyof SsoLoginEventRow | 'metadata_json'
  header: string
}> = [
  { key: 'id', header: 'id' },
  { key: 'venue_id', header: 'venue_id' },
  { key: 'connection_id', header: 'connection_id' },
  { key: 'user_id', header: 'user_id' },
  { key: 'email', header: 'email' },
  { key: 'domain', header: 'domain' },
  { key: 'provider', header: 'provider' },
  { key: 'protocol', header: 'protocol' },
  { key: 'outcome', header: 'outcome' },
  { key: 'reason', header: 'reason' },
  { key: 'ip_hash', header: 'ip_hash' },
  { key: 'request_id', header: 'request_id' },
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
  items: SsoLoginEventRow[],
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
    'Content-Disposition': `attachment; filename="sso-login-events-${date}.csv"`,
    'Cache-Control': 'no-store',
    'X-Request-Id': requestId,
    'X-Has-More': pagination.hasMore ? 'true' : 'false',
  }
  if (pagination.hasMore && pagination.nextCursor) {
    headers['X-Next-Cursor'] = pagination.nextCursor
  }
  return new NextResponse(body, { status: 200, headers })
}
