import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getOrCreateRequestId, withRequestIdHeader } from '@/lib/observability/request-id'
import { captureApiError } from '@/lib/observability/sentry'
import { log } from '@/lib/log'
import { rateLimitUserAction, rateLimitedResponse } from '@/lib/rate-limit'
import { acceptInvitation, TeamError } from '@/lib/team/team-service'
import { AcceptInvitationSchema } from '@/lib/team/team-schema'

/**
 * POST /api/team/invitations/accept — any authed user trades a token for
 * a venue_members row. Rate-limited per user so a leaked token can't be
 * brute-forced against this endpoint by the would-be accepter.
 */
export async function POST(request: NextRequest) {
  const requestId = getOrCreateRequestId(request)
  const reqLog = log.child({ requestId, route: '/api/team/invitations/accept' })
  const respond = <T extends Response>(r: T) => withRequestIdHeader(r, requestId)

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return respond(NextResponse.json({ error: 'unauthorized' }, { status: 401 }))

  const rl = await rateLimitUserAction(request, `team:accept:${user.id}`)
  if (!rl.allowed) {
    reqLog.warn({ userId: user.id, retryMs: rl.retryAfterMs }, 'rate_limit.blocked')
    return respond(rateLimitedResponse(rl))
  }

  const body = await request.json().catch(() => null)
  const parsed = AcceptInvitationSchema.safeParse(body)
  if (!parsed.success) {
    return respond(
      NextResponse.json(
        { error: 'validation_failed', detail: parsed.error.flatten() },
        { status: 400 }
      )
    )
  }

  try {
    const result = await acceptInvitation({
      userId: user.id,
      token: parsed.data.token,
      requestId,
    })
    return respond(
      NextResponse.json({
        success: true,
        venue_id: result.venue_id,
        already_member: result.already_member,
      })
    )
  } catch (err) {
    if (err instanceof TeamError) {
      return respond(
        NextResponse.json({ error: err.code, detail: err.detail }, { status: err.status })
      )
    }
    reqLog.error({ err }, 'team.accept.unexpected')
    captureApiError(err, {
      requestId,
      route: '/api/team/invitations/accept',
      userId: user.id,
    })
    return respond(NextResponse.json({ error: 'unexpected_error' }, { status: 500 }))
  }
}
