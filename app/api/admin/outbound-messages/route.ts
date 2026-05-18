import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { requireAdmin } from '@/lib/auth/require-admin'
import { rateLimitUserAction, rateLimitedResponse } from '@/lib/rate-limit'
import { log } from '@/lib/log'
import { getOrCreateRequestId, withRequestIdHeader } from '@/lib/observability/request-id'
import { captureApiError } from '@/lib/observability/sentry'

/**
 * GET /api/admin/outbound-messages?limit=50&before=ISO&status=&lead_id=
 *
 * Paginated venue-scoped browse of the outbound email log. Returns the
 * caller's venue rows only — RLS provides the second layer of defense.
 */

const MAX_LIMIT = 100
const DEFAULT_LIMIT = 50

const ALLOWED_STATUSES = new Set(['queued', 'delivered', 'bounced', 'complained', 'failed', 'suppressed'])

export async function GET(request: NextRequest) {
  const requestId = getOrCreateRequestId(request)
  const reqLog = log.child({ requestId, route: '/api/admin/outbound-messages' })
  const respond = <T extends Response>(r: T) => withRequestIdHeader(r, requestId)

  // 1. Auth gate.
  const admin = await requireAdmin()
  if (!admin.ok) {
    return respond(NextResponse.json({ error: admin.code }, { status: admin.status }))
  }
  const { user, venueId } = admin

  // 2. Rate limit.
  const rl = await rateLimitUserAction(request, `admin:outbound:${user.id}`)
  if (!rl.allowed) {
    reqLog.warn({ userId: user.id, retryMs: rl.retryAfterMs }, 'rate_limit.blocked')
    return respond(rateLimitedResponse(rl))
  }

  // 3. Parse query params.
  const url = new URL(request.url)
  const limitRaw = Number(url.searchParams.get('limit') ?? DEFAULT_LIMIT)
  const limit = Number.isFinite(limitRaw)
    ? Math.max(1, Math.min(MAX_LIMIT, Math.floor(limitRaw)))
    : DEFAULT_LIMIT
  const before = url.searchParams.get('before')
  const statusParam = url.searchParams.get('status')
  const leadId = url.searchParams.get('lead_id')

  // 4. Query (user-scoped client; RLS narrows to venueId).
  const supabase = await createClient()
  let query = supabase
    .from('outbound_messages')
    .select('id, venue_id, lead_id, channel, to_address, subject, provider, provider_message_id, status, delivered_at, error, related_table, related_id, created_at')
    .eq('venue_id', venueId)
    .order('created_at', { ascending: false })
    .limit(limit + 1) // +1 to compute next_before without a second query

  if (before) query = query.lt('created_at', before)
  if (statusParam && ALLOWED_STATUSES.has(statusParam)) query = query.eq('status', statusParam)
  if (leadId) query = query.eq('lead_id', leadId)

  const { data, error } = await query
  if (error) {
    reqLog.error({ errorMessage: error.message }, 'admin.outbound_messages.query_failed')
    captureApiError(error, { requestId, route: '/api/admin/outbound-messages', venueId, userId: user.id })
    return respond(NextResponse.json({ error: error.message }, { status: 500 }))
  }

  const rows = (data ?? []) as { created_at: string }[]
  const hasMore = rows.length > limit
  const items = hasMore ? rows.slice(0, limit) : rows
  const nextBefore = hasMore ? items[items.length - 1].created_at : null

  return respond(NextResponse.json({ items, next_before: nextBefore }))
}
