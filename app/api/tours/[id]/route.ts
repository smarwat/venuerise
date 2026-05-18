import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { z } from 'zod'

const UpdateTourSchema = z.object({
  status: z.enum(['scheduled', 'confirmed', 'completed', 'cancelled', 'no_show']).optional(),
  scheduled_at: z.string().datetime().optional(),
  duration_minutes: z.number().int().min(15).max(480).optional(),
  location_notes: z.string().optional().nullable(),
  reminder_24h_sent: z.boolean().optional(),
  reminder_2h_sent: z.boolean().optional(),
  outcome: z.string().optional().nullable(),
})

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: venueRaw } = await supabase.from('venues').select('id').eq('owner_user_id', user.id).order('created_at').limit(1).maybeSingle()
  const venueId = (venueRaw as { id?: string } | null)?.id
  if (!venueId) return NextResponse.json({ error: 'Venue not found' }, { status: 404 })

  const body = await request.json()
  const parsed = UpdateTourSchema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 })

  const { data, error } = await supabase
    .from('tours')
    .update(parsed.data)
    .eq('id', id)
    .eq('venue_id', venueId)
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // If completed, update lead stage
  if (parsed.data.status === 'completed') {
    const tour = data as { lead_id?: string }
    if (tour.lead_id) {
      await supabase.from('leads').update({ stage: 'tour_completed' }).eq('id', tour.lead_id)
    }
  }

  return NextResponse.json(data)
}
