import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { processPendingFollowUp } from '@/lib/agents/orchestrator'
import { assertOwnsFollowUp, OwnershipError } from '@/lib/auth/assert-ownership'
import { z } from 'zod'

const Schema = z.object({
  follow_up_id: z.string().uuid(),
})

export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await request.json().catch(() => null)
  const parsed = Schema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 })

  try {
    await assertOwnsFollowUp(supabase, user.id, parsed.data.follow_up_id)
  } catch (err) {
    if (err instanceof OwnershipError) {
      return NextResponse.json({ error: 'Follow-up not found' }, { status: 404 })
    }
    throw err
  }

  try {
    const result = await processPendingFollowUp(parsed.data.follow_up_id)
    return NextResponse.json(result)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Follow-up processing failed'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
