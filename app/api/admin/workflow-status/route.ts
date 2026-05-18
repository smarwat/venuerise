import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { requireAdmin } from '@/lib/auth/require-admin'
import { rateLimitUserAction, rateLimitedResponse } from '@/lib/rate-limit'
import { log } from '@/lib/log'
import { getOrCreateRequestId, withRequestIdHeader } from '@/lib/observability/request-id'
import { captureApiError } from '@/lib/observability/sentry'

/**
 * GET /api/admin/workflow-status
 *
 * Single-shot operational snapshot for the admin's venue. Eight cheap count
 * queries fanned out in parallel. Built for "is anything stuck?" triage,
 * not end-user analytics.
 *
 * Response:
 *   leads_last_24h         — newly-created leads (any source)
 *   ai_actions_last_24h    — total agent action audit rows
 *   ai_failures_last_24h   — subset where success=false
 *   pending_followups      — scheduled rows still waiting
 *   failed_followups       — terminal failures (status='failed')
 *   outbound_queued        — Resend-accepted, awaiting webhook confirmation
 *   outbound_failed        — provider rejected OR console-fallback marked failed
 *   suppression_count      — GLOBAL count (suppression list is not venue-scoped)
 */

export async function GET(request: NextRequest) {
  const requestId = getOrCreateRequestId(request)
  const reqLog = log.child({ requestId, route: '/api/admin/workflow-status' })
  const respond = <T extends Response>(r: T) => withRequestIdHeader(r, requestId)

  const admin = await requireAdmin()
  if (!admin.ok) {
    return respond(NextResponse.json({ error: admin.code }, { status: admin.status }))
  }
  const { user, venueId } = admin

  const rl = await rateLimitUserAction(request, `admin:workflow-status:${user.id}`)
  if (!rl.allowed) {
    reqLog.warn({ userId: user.id, retryMs: rl.retryAfterMs }, 'rate_limit.blocked')
    return respond(rateLimitedResponse(rl))
  }

  const supabase = await createClient()
  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
  const countOpts = { count: 'exact' as const, head: true }

  // 8 parallel count queries. Each returns `{ count, error }` only.
  const [
    leads24h,
    aiActions24h,
    aiFailures24h,
    pendingFollowups,
    failedFollowups,
    outboundQueued,
    outboundFailed,
    suppressionCount,
  ] = await Promise.all([
    supabase.from('leads').select('id', countOpts).eq('venue_id', venueId).gte('created_at', since24h),
    supabase.from('ai_actions').select('id', countOpts).eq('venue_id', venueId).gte('created_at', since24h),
    supabase.from('ai_actions').select('id', countOpts).eq('venue_id', venueId).eq('success', false).gte('created_at', since24h),
    supabase.from('follow_up_schedules').select('id', countOpts).eq('venue_id', venueId).eq('status', 'pending'),
    supabase.from('follow_up_schedules').select('id', countOpts).eq('venue_id', venueId).eq('status', 'failed'),
    supabase.from('outbound_messages').select('id', countOpts).eq('venue_id', venueId).eq('status', 'queued'),
    supabase.from('outbound_messages').select('id', countOpts).eq('venue_id', venueId).eq('status', 'failed'),
    // Suppression list is global — no venue filter.
    supabase.from('email_suppressions').select('id', countOpts),
  ])

  // If any of them failed, log + capture but still respond with partial data
  // (counts default to 0 on failure). Operator UX favors a partial answer
  // over a 500.
  const checks = [
    { name: 'leads_last_24h', res: leads24h },
    { name: 'ai_actions_last_24h', res: aiActions24h },
    { name: 'ai_failures_last_24h', res: aiFailures24h },
    { name: 'pending_followups', res: pendingFollowups },
    { name: 'failed_followups', res: failedFollowups },
    { name: 'outbound_queued', res: outboundQueued },
    { name: 'outbound_failed', res: outboundFailed },
    { name: 'suppression_count', res: suppressionCount },
  ]
  for (const { name, res } of checks) {
    if (res.error) {
      reqLog.error({ counter: name, errorMessage: res.error.message }, 'admin.workflow_status.count_failed')
      captureApiError(res.error, {
        requestId, route: '/api/admin/workflow-status', venueId, userId: user.id,
      })
    }
  }

  return respond(NextResponse.json({
    leads_last_24h:       leads24h.count ?? 0,
    ai_actions_last_24h:  aiActions24h.count ?? 0,
    ai_failures_last_24h: aiFailures24h.count ?? 0,
    pending_followups:    pendingFollowups.count ?? 0,
    failed_followups:     failedFollowups.count ?? 0,
    outbound_queued:      outboundQueued.count ?? 0,
    outbound_failed:      outboundFailed.count ?? 0,
    suppression_count:    suppressionCount.count ?? 0,
  }))
}
