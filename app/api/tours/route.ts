import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getOrCreateRequestId, withRequestIdHeader } from '@/lib/observability/request-id'
import { z } from 'zod'

const CreateTourSchema = z.object({
  lead_id: z.string().uuid(),
  scheduled_at: z.string().datetime(),
  duration_minutes: z.number().int().min(15).max(480).default(60),
  location_notes: z.string().optional().nullable(),
})

export async function GET(request: NextRequest) {
  const requestId = getOrCreateRequestId(request)
  const respond = <T extends Response>(r: T) => withRequestIdHeader(r, requestId)

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return respond(NextResponse.json({ error: 'Unauthorized' }, { status: 401 }))

  const { data: venueRaw } = await supabase.from('venues').select('id').eq('owner_user_id', user.id).order('created_at').limit(1).maybeSingle()
  const venueId = (venueRaw as { id?: string } | null)?.id
  if (!venueId) return respond(NextResponse.json({ error: 'Venue not found' }, { status: 404 }))

  const { searchParams } = new URL(request.url)
  const from = searchParams.get('from')
  const to = searchParams.get('to')

  let query = supabase
    .from('tours')
    .select('*, leads(name, email)')
    .eq('venue_id', venueId)
    .order('scheduled_at')

  if (from) query = query.gte('scheduled_at', from)
  if (to) query = query.lte('scheduled_at', to)

  const { data, error } = await query
  if (error) return respond(NextResponse.json({ error: error.message }, { status: 500 }))
  return respond(NextResponse.json(data))
}

export async function POST(request: NextRequest) {
  const requestId = getOrCreateRequestId(request)
  const respond = <T extends Response>(r: T) => withRequestIdHeader(r, requestId)

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return respond(NextResponse.json({ error: 'Unauthorized' }, { status: 401 }))

  const { data: venueRaw } = await supabase.from('venues').select('id').eq('owner_user_id', user.id).order('created_at').limit(1).maybeSingle()
  const venueId = (venueRaw as { id?: string } | null)?.id
  if (!venueId) return respond(NextResponse.json({ error: 'Venue not found' }, { status: 404 }))

  const body = await request.json()
  const parsed = CreateTourSchema.safeParse(body)
  if (!parsed.success) return respond(NextResponse.json({ error: parsed.error.flatten() }, { status: 400 }))

  const { data, error } = await supabase
    .from('tours')
    .insert({ ...parsed.data, venue_id: venueId, status: 'scheduled' })
    .select()
    .single()

  if (error) return respond(NextResponse.json({ error: error.message }, { status: 500 }))

  // Update lead stage
  await supabase.from('leads').update({ stage: 'tour_scheduled' }).eq('id', parsed.data.lead_id)

  return respond(NextResponse.json(data, { status: 201 }))
}
