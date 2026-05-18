import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { z } from 'zod'

const UpdateVenueSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().optional().nullable(),
  capacity_min: z.number().int().min(1).optional().nullable(),
  capacity_max: z.number().int().min(1).optional().nullable(),
  base_price: z.number().min(0).optional().nullable(),
  price_per_guest: z.number().min(0).optional().nullable(),
  style_tags: z.array(z.string()).optional(),
  amenities: z.array(z.string()).optional(),
  timezone: z.string().optional(),
  ai_persona_name: z.string().min(1).max(50).optional(),
  ai_tone: z.string().optional(),
  response_time_target: z.number().int().min(1).optional(),
})

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data, error } = await supabase
    .from('venues')
    .select('*')
    .eq('id', id)
    .eq('owner_user_id', user.id)
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 404 })
  return NextResponse.json(data)
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await request.json()
  const parsed = UpdateVenueSchema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 })

  const { data, error } = await supabase
    .from('venues')
    .update(parsed.data)
    .eq('id', id)
    .eq('owner_user_id', user.id)
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(data)
}
