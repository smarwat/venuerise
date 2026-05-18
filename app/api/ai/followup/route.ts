import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { processPendingFollowUp } from '@/lib/agents/orchestrator'
import { assertOwnsFollowUp, OwnershipError } from '@/lib/auth/assert-ownership'
import { rateLimitAi, rateLimitedResponse } from '@/lib/rate-limit'
import { log } from '@/lib/log'
import { getOrCreateRequestId, withRequestIdHeader } from '@/lib/observability/request-id'
import { z } from 'zod'

const Schema = z.object({
  follow_up_id: z.string().uuid(),
})

export async function POST(request: NextRequest) {
  const requestId = getOrCreateRequestId(request)
  const reqLog = log.child({ requestId, route: '/api/ai/followup' })
  const respond = <T extends Response>(r: T) => withRequestIdHeader(r, requestId)

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return respond(NextResponse.json({ error: 'Unauthorized' }, { status: 401 }))

  const body = await request.json().catch(() => null)
  const parsed = Schema.safeParse(body)
  if (!parsed.success) return respond(NextResponse.json({ error: parsed.error.flatten() }, { status: 400 }))

  try {
    await assertOwnsFollowUp(supabase, user.id, parsed.data.follow_up_id)
  } catch (err) {
    if (err instanceof OwnershipError) {
      return respond(NextResponse.json({ error: 'Follow-up not found' }, { status: 404 }))
    }
    throw err
  }

  // Rate limit per user + follow_up — guards against accidental "Send now"
  // button hammering. Internal job-runtime follow-ups go through the queue,
  // not this endpoint.
  const rl = await rateLimitAi(request, `followup:${user.id}:${parsed.data.follow_up_id}`)
  if (!rl.allowed) {
    reqLog.warn(
      { userId: user.id, followUpId: parsed.data.follow_up_id, retryMs: rl.retryAfterMs },
      'rate_limit.blocked'
    )
    return respond(rateLimitedResponse(rl))
  }

  try {
    const result = await processPendingFollowUp(parsed.data.follow_up_id)
    return respond(NextResponse.json(result))
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Follow-up processing failed'
    reqLog.error({ err, followUpId: parsed.data.follow_up_id }, 'ai.followup.failed')
    return respond(NextResponse.json({ error: message }, { status: 500 }))
  }
}
