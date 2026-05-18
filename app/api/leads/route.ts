import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { rateLimitUserAction, rateLimitedResponse } from '@/lib/rate-limit'
import { log } from '@/lib/log'
import { getOrCreateRequestId, withRequestIdHeader } from '@/lib/observability/request-id'
import { z } from 'zod'

const CreateLeadSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  phone: z.string().optional().nullable(),
  stage: z.enum(['new_inquiry', 'qualified', 'tour_scheduled', 'tour_completed', 'negotiation', 'booked', 'lost']).default('new_inquiry'),
  urgency: z.enum(['low', 'medium', 'high', 'critical']).default('medium'),
  event_date: z.string().optional().nullable(),
  guest_count: z.number().int().optional().nullable(),
  budget: z.number().optional().nullable(),
  source: z.string().default('dashboard'),
  notes: z.string().optional().nullable(),
})

export async function GET(request: NextRequest) {
  const requestId = getOrCreateRequestId(request)
  const respond = <T extends Response>(r: T) => withRequestIdHeader(r, requestId)

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return respond(NextResponse.json({ error: 'Unauthorized' }, { status: 401 }))

  const { data: venue } = await supabase
    .from('venues').select('id').eq('owner_user_id', user.id).order('created_at').limit(1).maybeSingle()
  if (!venue) return respond(NextResponse.json({ error: 'Venue not found' }, { status: 404 }))

  const { searchParams } = new URL(request.url)
  const stage = searchParams.get('stage')

  let query = supabase
    .from('leads')
    .select('*')
    .eq('venue_id', venue.id)
    .order('created_at', { ascending: false })

  if (stage) query = query.eq('stage', stage)

  const { data, error } = await query
  if (error) return respond(NextResponse.json({ error: error.message }, { status: 500 }))

  return respond(NextResponse.json(data))
}

export async function POST(request: NextRequest) {
  const requestId = getOrCreateRequestId(request)
  const reqLog = log.child({ requestId, route: '/api/leads' })
  const respond = <T extends Response>(r: T) => withRequestIdHeader(r, requestId)

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return respond(NextResponse.json({ error: 'Unauthorized' }, { status: 401 }))

  // Rate limit manual lead creation per user (dashboard-facing). 30/min.
  // GET is intentionally not rate-limited — it's a read-heavy list view.
  const rl = await rateLimitUserAction(request, `leads:create:${user.id}`)
  if (!rl.allowed) {
    reqLog.warn({ userId: user.id, retryMs: rl.retryAfterMs }, 'rate_limit.blocked')
    return respond(rateLimitedResponse(rl))
  }

  const { data: venue } = await supabase
    .from('venues').select('id').eq('owner_user_id', user.id).order('created_at').limit(1).maybeSingle()
  if (!venue) return respond(NextResponse.json({ error: 'Venue not found' }, { status: 404 }))

  const body = await request.json()
  const parsed = CreateLeadSchema.safeParse(body)
  if (!parsed.success) return respond(NextResponse.json({ error: parsed.error.flatten() }, { status: 400 }))

  const { data, error } = await supabase
    .from('leads')
    .insert({ ...parsed.data, venue_id: venue.id, lead_score: 0 })
    .select()
    .single()

  if (error) return respond(NextResponse.json({ error: error.message }, { status: 500 }))

  return respond(NextResponse.json(data, { status: 201 }))
}
