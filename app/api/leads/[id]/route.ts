import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getOrCreateRequestId, withRequestIdHeader } from '@/lib/observability/request-id'
import { captureApiError } from '@/lib/observability/sentry'
import { requireVenueRole, TenantAccessError } from '@/lib/auth/tenant-access'
import { SALES_ROLES, ADMIN_ROLES } from '@/lib/auth/roles'
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

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const requestId = getOrCreateRequestId(request)
  const respond = <T extends Response>(r: T) => withRequestIdHeader(r, requestId)

  const { id } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return respond(NextResponse.json({ error: 'Unauthorized' }, { status: 401 }))

  // Phase 6B: any member can read. RLS scopes the read to venues the user
  // belongs to, so we don't need to pre-resolve venue_id.
  const { data, error } = await supabase
    .from('leads')
    .select('*')
    .eq('id', id)
    .single()

  if (error) return respond(NextResponse.json({ error: error.message }, { status: 404 }))
  return respond(NextResponse.json(data))
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const requestId = getOrCreateRequestId(request)
  const respond = <T extends Response>(r: T) => withRequestIdHeader(r, requestId)

  const { id } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return respond(NextResponse.json({ error: 'Unauthorized' }, { status: 401 }))

  // Resolve the lead's venue via RLS-aware read (members see it).
  const { data: leadRow } = await supabase
    .from('leads')
    .select('id, venue_id')
    .eq('id', id)
    .maybeSingle()
  if (!leadRow) return respond(NextResponse.json({ error: 'Lead not found' }, { status: 404 }))
  const venueId = (leadRow as { venue_id: string }).venue_id

  // Phase 6B: PATCH = SALES_ROLES only.
  try {
    await requireVenueRole(user.id, venueId, SALES_ROLES)
  } catch (err) {
    if (err instanceof TenantAccessError) {
      return respond(NextResponse.json({ error: err.code }, { status: err.status }))
    }
    throw err
  }

  const body = await request.json()
  const parsed = UpdateLeadSchema.safeParse(body)
  if (!parsed.success) return respond(NextResponse.json({ error: parsed.error.flatten() }, { status: 400 }))

  const { data, error } = await supabase
    .from('leads')
    .update(parsed.data)
    .eq('id', id)
    .eq('venue_id', venueId)
    .select()
    .single()

  if (error) {
    captureApiError(error, { requestId, route: '/api/leads/[id]', leadId: id, userId: user.id, venueId })
    return respond(NextResponse.json({ error: error.message }, { status: 500 }))
  }
  return respond(NextResponse.json(data))
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const requestId = getOrCreateRequestId(request)
  const respond = <T extends Response>(r: T) => withRequestIdHeader(r, requestId)

  const { id } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return respond(NextResponse.json({ error: 'Unauthorized' }, { status: 401 }))

  const { data: leadRow } = await supabase
    .from('leads')
    .select('id, venue_id')
    .eq('id', id)
    .maybeSingle()
  if (!leadRow) return respond(NextResponse.json({ error: 'Lead not found' }, { status: 404 }))
  const venueId = (leadRow as { venue_id: string }).venue_id

  // Phase 6B: DELETE = ADMIN_ROLES only (destructive).
  try {
    await requireVenueRole(user.id, venueId, ADMIN_ROLES)
  } catch (err) {
    if (err instanceof TenantAccessError) {
      return respond(NextResponse.json({ error: err.code }, { status: err.status }))
    }
    throw err
  }

  const { error } = await supabase
    .from('leads')
    .delete()
    .eq('id', id)
    .eq('venue_id', venueId)

  if (error) {
    captureApiError(error, { requestId, route: '/api/leads/[id]', leadId: id, userId: user.id, venueId })
    return respond(NextResponse.json({ error: error.message }, { status: 500 }))
  }
  return respond(NextResponse.json({ success: true }))
}
