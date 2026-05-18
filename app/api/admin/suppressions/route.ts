import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { requireAdmin } from '@/lib/auth/require-admin'
import { addSuppression } from '@/lib/integrations/suppression'
import { rateLimitUserAction, rateLimitedResponse } from '@/lib/rate-limit'
import { log } from '@/lib/log'
import { getOrCreateRequestId, withRequestIdHeader } from '@/lib/observability/request-id'
import { captureApiError } from '@/lib/observability/sentry'
import { z } from 'zod'

/**
 * /api/admin/suppressions
 *
 * GET  ?email=foo@bar.com    → single-row lookup OR list recent
 * POST { email, reason='manual', source='admin' } → add a manual suppression
 *
 * The suppression list is GLOBAL (not per-venue) — that's intentional for
 * Phase 5E operator tooling. Treat any UI built on this carefully.
 */

const MAX_LIMIT = 100
const DEFAULT_LIMIT = 50

const PostSchema = z.object({
  email: z.string().email(),
  /** Only `manual` is acceptable from this endpoint. Webhook adds others. */
  reason: z.literal('manual').optional().default('manual'),
  source: z.string().optional().default('admin'),
})

function normalize(email: string): string {
  return email.trim().toLowerCase()
}

export async function GET(request: NextRequest) {
  const requestId = getOrCreateRequestId(request)
  const reqLog = log.child({ requestId, route: '/api/admin/suppressions' })
  const respond = <T extends Response>(r: T) => withRequestIdHeader(r, requestId)

  const admin = await requireAdmin()
  if (!admin.ok) {
    return respond(NextResponse.json({ error: admin.code }, { status: admin.status }))
  }
  const { user } = admin

  const rl = await rateLimitUserAction(request, `admin:suppressions:${user.id}`)
  if (!rl.allowed) {
    reqLog.warn({ userId: user.id, retryMs: rl.retryAfterMs }, 'rate_limit.blocked')
    return respond(rateLimitedResponse(rl))
  }

  const url = new URL(request.url)
  const emailParam = url.searchParams.get('email')
  const supabase = await createClient()

  if (emailParam) {
    const normalized = normalize(emailParam)
    if (!normalized.includes('@')) {
      return respond(NextResponse.json({ error: 'email must be a valid address' }, { status: 400 }))
    }

    const { data, error } = await supabase
      .from('email_suppressions')
      .select('id, email, reason, source, created_at')
      .eq('email', normalized)
      .maybeSingle()

    if (error) {
      reqLog.error({ errorMessage: error.message }, 'admin.suppressions.lookup_failed')
      captureApiError(error, { requestId, route: '/api/admin/suppressions', userId: user.id })
      return respond(NextResponse.json({ error: error.message }, { status: 500 }))
    }
    if (!data) return respond(NextResponse.json({ found: false }))
    return respond(NextResponse.json({ found: true, item: data }))
  }

  // No email — list recent rows.
  const limitRaw = Number(url.searchParams.get('limit') ?? DEFAULT_LIMIT)
  const limit = Number.isFinite(limitRaw)
    ? Math.max(1, Math.min(MAX_LIMIT, Math.floor(limitRaw)))
    : DEFAULT_LIMIT

  const { data, error } = await supabase
    .from('email_suppressions')
    .select('id, email, reason, source, created_at')
    .order('created_at', { ascending: false })
    .limit(limit)

  if (error) {
    reqLog.error({ errorMessage: error.message }, 'admin.suppressions.list_failed')
    captureApiError(error, { requestId, route: '/api/admin/suppressions', userId: user.id })
    return respond(NextResponse.json({ error: error.message }, { status: 500 }))
  }
  return respond(NextResponse.json({ items: data ?? [] }))
}

export async function POST(request: NextRequest) {
  const requestId = getOrCreateRequestId(request)
  const reqLog = log.child({ requestId, route: '/api/admin/suppressions' })
  const respond = <T extends Response>(r: T) => withRequestIdHeader(r, requestId)

  const admin = await requireAdmin()
  if (!admin.ok) {
    return respond(NextResponse.json({ error: admin.code }, { status: admin.status }))
  }
  const { user } = admin

  const rl = await rateLimitUserAction(request, `admin:suppressions:${user.id}`)
  if (!rl.allowed) {
    reqLog.warn({ userId: user.id, retryMs: rl.retryAfterMs }, 'rate_limit.blocked')
    return respond(rateLimitedResponse(rl))
  }

  const body = await request.json().catch(() => null)
  const parsed = PostSchema.safeParse(body)
  if (!parsed.success) {
    return respond(NextResponse.json({ error: parsed.error.flatten() }, { status: 400 }))
  }

  // `addSuppression` is idempotent — first reason wins (Phase 4B).
  await addSuppression(parsed.data.email, 'manual', parsed.data.source)
  reqLog.info({ userId: user.id, source: parsed.data.source }, 'admin.suppressions.added')

  return respond(NextResponse.json({ success: true }))
}
