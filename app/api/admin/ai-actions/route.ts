import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { requireAdmin } from '@/lib/auth/require-admin'
import { rateLimitUserAction, rateLimitedResponse } from '@/lib/rate-limit'
import { log } from '@/lib/log'
import { getOrCreateRequestId, withRequestIdHeader } from '@/lib/observability/request-id'
import { captureApiError } from '@/lib/observability/sentry'

/**
 * GET /api/admin/ai-actions?limit=50&lead_id=&success=true|false&agent=
 *
 * Recent AI agent actions for the admin's venue — drawn from the
 * `ai_actions` audit table populated by the orchestrator + jobs.
 * RLS-scoped to the caller's venue (defense in depth on top of the
 * explicit `.eq('venue_id', venueId)` filter).
 */

const MAX_LIMIT = 100
const DEFAULT_LIMIT = 50

export async function GET(request: NextRequest) {
  const requestId = getOrCreateRequestId(request)
  const reqLog = log.child({ requestId, route: '/api/admin/ai-actions' })
  const respond = <T extends Response>(r: T) => withRequestIdHeader(r, requestId)

  const admin = await requireAdmin()
  if (!admin.ok) {
    return respond(NextResponse.json({ error: admin.code }, { status: admin.status }))
  }
  const { user, venueId } = admin

  const rl = await rateLimitUserAction(request, `admin:ai-actions:${user.id}`)
  if (!rl.allowed) {
    reqLog.warn({ userId: user.id, retryMs: rl.retryAfterMs }, 'rate_limit.blocked')
    return respond(rateLimitedResponse(rl))
  }

  const url = new URL(request.url)
  const limitRaw = Number(url.searchParams.get('limit') ?? DEFAULT_LIMIT)
  const limit = Number.isFinite(limitRaw)
    ? Math.max(1, Math.min(MAX_LIMIT, Math.floor(limitRaw)))
    : DEFAULT_LIMIT
  const leadId = url.searchParams.get('lead_id')
  const agent = url.searchParams.get('agent')
  const successParam = url.searchParams.get('success')

  const supabase = await createClient()
  let query = supabase
    .from('ai_actions')
    .select('id, agent, action, input_summary, output_summary, latency_ms, tokens_used, success, error_message, created_at, lead_id')
    .eq('venue_id', venueId)
    .order('created_at', { ascending: false })
    .limit(limit)

  if (leadId) query = query.eq('lead_id', leadId)
  if (agent) query = query.eq('agent', agent)
  if (successParam === 'true') query = query.eq('success', true)
  if (successParam === 'false') query = query.eq('success', false)

  const { data, error } = await query
  if (error) {
    reqLog.error({ errorMessage: error.message }, 'admin.ai_actions.query_failed')
    captureApiError(error, { requestId, route: '/api/admin/ai-actions', venueId, userId: user.id })
    return respond(NextResponse.json({ error: error.message }, { status: 500 }))
  }

  return respond(NextResponse.json({ items: data ?? [] }))
}
