import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { handleIncomingMessage } from '@/lib/agents/orchestrator'
import { assertOwnsConversation, OwnershipError } from '@/lib/auth/assert-ownership'
import { rateLimitAi, rateLimitedResponse } from '@/lib/rate-limit'
import { z } from 'zod'

const PostSchema = z.object({
  conversation_id: z.string().uuid(),
  message: z.string().min(1),
})

// POST — send a lead message and get AI reply
export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await request.json().catch(() => null)
  const parsed = PostSchema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 })

  // Ownership check — fail closed before any service-role work happens.
  try {
    await assertOwnsConversation(supabase, user.id, parsed.data.conversation_id)
  } catch (err) {
    if (err instanceof OwnershipError) {
      return NextResponse.json({ error: 'Conversation not found' }, { status: 404 })
    }
    throw err
  }

  // Rate limit POSTs per user + conversation (each AI reply burns tokens).
  const rl = await rateLimitAi(request, `chat:post:${user.id}:${parsed.data.conversation_id}`)
  if (!rl.allowed) return rateLimitedResponse(rl)

  try {
    const result = await handleIncomingMessage(parsed.data.conversation_id, parsed.data.message)
    return NextResponse.json(result)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'AI chat failed'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

// GET — fetch messages for a conversation
export async function GET(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(request.url)
  const conversationId = searchParams.get('conversation_id')
  if (!conversationId) {
    return NextResponse.json({ error: 'conversation_id required' }, { status: 400 })
  }
  // Validate UUID shape early to avoid downstream Postgres errors.
  if (!z.string().uuid().safeParse(conversationId).success) {
    return NextResponse.json({ error: 'conversation_id must be a UUID' }, { status: 400 })
  }

  try {
    await assertOwnsConversation(supabase, user.id, conversationId)
  } catch (err) {
    if (err instanceof OwnershipError) {
      return NextResponse.json({ error: 'Conversation not found' }, { status: 404 })
    }
    throw err
  }

  // GET — looser limit than POST (no AI tokens spent here). Realtime drives
  // the inbox, so realistic GET traffic is low; 60/min/user is plenty.
  const rl = await rateLimitAi(request, `chat:get:${user.id}`)
  if (!rl.allowed) return rateLimitedResponse(rl)

  const { data, error } = await supabase
    .from('messages')
    .select('*')
    .eq('conversation_id', conversationId)
    .order('created_at')

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(data)
}
