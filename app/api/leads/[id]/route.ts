import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { z } from 'zod'

const UpdateLeadSchema = z.object({
  name: z.string().min(1).optional(),
  email: z.string().email().optional(),
  phone: z.string().optional().nullable(),
  stage: z.enum(['new_inquiry', 'qualified', 'tour_scheduled', 'tour_completed', 'negotiation', 'booked', 'lost']).optional(),
  lead_score: z.number().int().min(0).max(100).optional(),
  urgency: z.enum(['low', 'medium', 'high', 'critical']).optional(),
  event_date: z.string().optional().nullable(),
  guest_count: z.number().int().optional().nullable(),
  budget: z.number().optional().nullable(),
  ai_active: z.boolean().optional(),
  notes: z.string().optional().nullable(),
})

async function getVenueId(supabase: Awaited<ReturnType<typeof createClient>>, userId: string) {
  const { data } = await supabase.from('venues').select('id').eq('owner_user_id', userId).order('created_at').limit(1).maybeSingle()
  return (data as { id: string } | null)?.id ?? null
}

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const venueId = await getVenueId(supabase, user.id)
  if (!venueId) return NextResponse.json({ error: 'Venue not found' }, { status: 404 })

  const { data, error } = await supabase
    .from('leads')
    .select('*')
    .eq('id', id)
    .eq('venue_id', venueId)
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 404 })
  return NextResponse.json(data)
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const venueId = await getVenueId(supabase, user.id)
  if (!venueId) return NextResponse.json({ error: 'Venue not found' }, { status: 404 })

  const body = await request.json()
  const parsed = UpdateLeadSchema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 })

  const { data, error } = await supabase
    .from('leads')
    .update(parsed.data)
    .eq('id', id)
    .eq('venue_id', venueId)
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(data)
}

export async function DELETE(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const venueId = await getVenueId(supabase, user.id)
  if (!venueId) return NextResponse.json({ error: 'Venue not found' }, { status: 404 })

  const { error } = await supabase
    .from('leads')
    .delete()
    .eq('id', id)
    .eq('venue_id', venueId)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ success: true })
}
