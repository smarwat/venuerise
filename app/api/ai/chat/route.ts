// AUDIT_EXEMPT: AI chat is an agent invocation path that writes
// `messages` rows the inbox surfaces directly. Per the Phase 9A
// "don't touch agent prompts / decision logic" rule, this route
// stays out of `audit_events`; the operator-initiated
// counterpart (operator sends a message) goes through
// /api/conversations/[id]/messages and IS audited. Documented in
// docs/AUDIT-COVERAGE.md.
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { handleIncomingMessage } from '@/lib/agents/orchestrator'
import { assertOwnsConversation, OwnershipError } from '@/lib/auth/assert-ownership'
import { SALES_ROLES } from '@/lib/auth/roles'
import { requireActiveSubscription, SubscriptionRequiredError } from '@/lib/billing/subscription-status'
import { AnthropicNotConfiguredError } from '@/lib/anthropic'
import { rateLimitAi, rateLimitedResponse } from '@/lib/rate-limit'
import { log } from '@/lib/log'
import { getOrCreateRequestId, withRequestIdHeader } from '@/lib/observability/request-id'
import { captureApiError } from '@/lib/observability/sentry'
import { z } from 'zod'

const PostSchema = z.object({
  conversation_id: z.string().uuid(),
  message: z.string().min(1),
})

// POST — receive a NEW LEAD MESSAGE and run the AI orchestrator.
//
// This route is the INBOUND-LEAD path. The body's `message` field is
// inserted into `messages` as `role: 'lead'` by handleIncomingMessage,
// and the orchestrator generates an AI draft in response.
//
// ⚠️  Do NOT call this from the operator composer. Operator-typed
// replies are venue-side messages and must use
// /api/conversations/[id]/messages (inserts role:'human', no AI
// auto-response). The composer was historically pointing at this
// route, which caused two bugs: operator text saved as 'lead' AND
// the AI replied as if the lead had spoken. Fixed in the P0
// sender-role pass.
//
// Legitimate callers: widget inbound (when wired), channel webhooks
// that hand off inbound lead messages, future external integrations
// that need the AI to draft a reply to a real inbound lead message.
export async function POST(request: NextRequest) {
  const requestId = getOrCreateRequestId(request)
  const reqLog = log.child({ requestId, route: '/api/ai/chat' })
  const respond = <T extends Response>(r: T) => withRequestIdHeader(r, requestId)

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return respond(NextResponse.json({ error: 'Unauthorized' }, { status: 401 }))

  const body = await request.json().catch(() => null)
  const parsed = PostSchema.safeParse(body)
  if (!parsed.success) return respond(NextResponse.json({ error: parsed.error.flatten() }, { status: 400 }))

  // Ownership + role check — POSTing a reply is a write action, gate to SALES_ROLES.
  let conversationVenueId: string
  try {
    const own = await assertOwnsConversation(supabase, user.id, parsed.data.conversation_id, SALES_ROLES)
    conversationVenueId = own.venue_id
  } catch (err) {
    if (err instanceof OwnershipError) {
      return respond(NextResponse.json({ error: 'Conversation not found' }, { status: 404 }))
    }
    throw err
  }

  // Phase 7D — billing gate (no-op when BILLING_GATE_ENABLED !== '1').
  try {
    await requireActiveSubscription(conversationVenueId, { requestId, route: '/api/ai/chat' })
  } catch (err) {
    if (err instanceof SubscriptionRequiredError) {
      return respond(NextResponse.json(
        { error: err.code, subscription_status: err.subscriptionStatus.kind },
        { status: err.status }
      ))
    }
    throw err
  }

  // Rate limit POSTs per user + conversation (each AI reply burns tokens).
  const rl = await rateLimitAi(request, `chat:post:${user.id}:${parsed.data.conversation_id}`)
  if (!rl.allowed) {
    reqLog.warn(
      { userId: user.id, conversationId: parsed.data.conversation_id, retryMs: rl.retryAfterMs },
      'rate_limit.blocked'
    )
    return respond(rateLimitedResponse(rl))
  }

  try {
    const result = await handleIncomingMessage(parsed.data.conversation_id, parsed.data.message)
    return respond(NextResponse.json(result))
  } catch (err) {
    // Clean 503 when the Anthropic env var is missing — surfaces a stable
    // machine-readable code instead of leaking the SDK's raw
    // "Could not resolve authentication method" string. Logged at info
    // level (it's a configuration problem, not a fault) and NOT
    // Sentry-captured (would drown the operator in noise).
    if (err instanceof AnthropicNotConfiguredError) {
      reqLog.info(
        { conversationId: parsed.data.conversation_id },
        'ai.chat.anthropic_not_configured'
      )
      return respond(
        NextResponse.json({ error: 'anthropic_not_configured' }, { status: 503 })
      )
    }
    const message = err instanceof Error ? err.message : 'AI chat failed'
    reqLog.error({ err, conversationId: parsed.data.conversation_id }, 'ai.chat.failed')
    captureApiError(err, {
      requestId, route: '/api/ai/chat',
      conversationId: parsed.data.conversation_id, userId: user.id,
    })
    return respond(NextResponse.json({ error: message }, { status: 500 }))
  }
}

// GET — fetch messages for a conversation
export async function GET(request: NextRequest) {
  const requestId = getOrCreateRequestId(request)
  const reqLog = log.child({ requestId, route: '/api/ai/chat' })
  const respond = <T extends Response>(r: T) => withRequestIdHeader(r, requestId)

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return respond(NextResponse.json({ error: 'Unauthorized' }, { status: 401 }))

  const { searchParams } = new URL(request.url)
  const conversationId = searchParams.get('conversation_id')
  if (!conversationId) {
    return respond(NextResponse.json({ error: 'conversation_id required' }, { status: 400 }))
  }
  // Validate UUID shape early to avoid downstream Postgres errors.
  if (!z.string().uuid().safeParse(conversationId).success) {
    return respond(NextResponse.json({ error: 'conversation_id must be a UUID' }, { status: 400 }))
  }

  try {
    await assertOwnsConversation(supabase, user.id, conversationId)
  } catch (err) {
    if (err instanceof OwnershipError) {
      return respond(NextResponse.json({ error: 'Conversation not found' }, { status: 404 }))
    }
    throw err
  }

  // GET — looser limit than POST (no AI tokens spent here). Realtime drives
  // the inbox, so realistic GET traffic is low; 60/min/user is plenty.
  const rl = await rateLimitAi(request, `chat:get:${user.id}`)
  if (!rl.allowed) {
    reqLog.warn({ userId: user.id, retryMs: rl.retryAfterMs }, 'rate_limit.blocked')
    return respond(rateLimitedResponse(rl))
  }

  const { data, error } = await supabase
    .from('messages')
    .select('*')
    .eq('conversation_id', conversationId)
    .order('created_at')

  if (error) {
    reqLog.error({ errorMessage: error.message, conversationId }, 'ai.chat.fetch_failed')
    captureApiError(error, {
      requestId, route: '/api/ai/chat', conversationId, userId: user.id,
    })
    return respond(NextResponse.json({ error: error.message }, { status: 500 }))
  }
  return respond(NextResponse.json(data))
}
