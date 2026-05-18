import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getOrCreateRequestId, withRequestIdHeader } from '@/lib/observability/request-id'
import { captureApiError } from '@/lib/observability/sentry'
import { requireVenueRole, TenantAccessError } from '@/lib/auth/tenant-access'
import { SALES_ROLES } from '@/lib/auth/roles'
import { requireActiveSubscription, SubscriptionRequiredError } from '@/lib/billing/subscription-status'
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
  const requestId = getOrCreateRequestId(request)
  const respond = <T extends Response>(r: T) => withRequestIdHeader(r, requestId)

  const { id } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return respond(NextResponse.json({ error: 'Unauthorized' }, { status: 401 }))

  // Resolve venue via RLS-aware read (post-migration-005, any member sees the tour).
  const { data: tourRow } = await supabase
    .from('tours')
    .select('id, venue_id, lead_id')
    .eq('id', id)
    .maybeSingle()
  if (!tourRow) return respond(NextResponse.json({ error: 'Tour not found' }, { status: 404 }))
  const venueId = (tourRow as { venue_id: string }).venue_id

  // Phase 6B: PATCH = SALES_ROLES only.
  try {
    await requireVenueRole(user.id, venueId, SALES_ROLES)
  } catch (err) {
    if (err instanceof TenantAccessError) {
      return respond(NextResponse.json({ error: err.code }, { status: err.status }))
    }
    throw err
  }

  // Phase 7D — billing gate (no-op when BILLING_GATE_ENABLED !== '1').
  try {
    await requireActiveSubscription(venueId, { requestId, route: '/api/tours/[id]' })
  } catch (err) {
    if (err instanceof SubscriptionRequiredError) {
      return respond(NextResponse.json(
        { error: err.code, subscription_status: err.subscriptionStatus.kind },
        { status: err.status }
      ))
    }
    throw err
  }

  const body = await request.json()
  const parsed = UpdateTourSchema.safeParse(body)
  if (!parsed.success) return respond(NextResponse.json({ error: parsed.error.flatten() }, { status: 400 }))

  const { data, error } = await supabase
    .from('tours')
    .update(parsed.data)
    .eq('id', id)
    .eq('venue_id', venueId)
    .select()
    .single()

  if (error) {
    captureApiError(error, { requestId, route: '/api/tours/[id]', tourId: id, userId: user.id, venueId })
    return respond(NextResponse.json({ error: error.message }, { status: 500 }))
  }

  // If completed, update lead stage
  if (parsed.data.status === 'completed') {
    const tour = data as { lead_id?: string }
    if (tour.lead_id) {
      await supabase.from('leads').update({ stage: 'tour_completed' }).eq('id', tour.lead_id)
    }
  }

  return respond(NextResponse.json(data))
}
