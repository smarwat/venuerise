import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getOrCreateRequestId, withRequestIdHeader } from '@/lib/observability/request-id'
import { captureApiError } from '@/lib/observability/sentry'
import { getCurrentVenueForUser } from '@/lib/auth/tenant-access'
import { SALES_ROLES } from '@/lib/auth/roles'
import { requireActiveSubscription, SubscriptionRequiredError } from '@/lib/billing/subscription-status'
import { sendTourNotificationEmail } from '@/lib/integrations/tour-notifications'
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

  // Phase 6B: any member (incl. viewer) can list tours.
  const venue = await getCurrentVenueForUser(user.id)
  if (!venue) return respond(NextResponse.json({ error: 'Venue not found' }, { status: 404 }))
  const venueId = venue.venueId

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
  if (error) {
    captureApiError(error, { requestId, route: '/api/tours', userId: user.id, venueId })
    return respond(NextResponse.json({ error: error.message }, { status: 500 }))
  }
  return respond(NextResponse.json(data))
}

export async function POST(request: NextRequest) {
  const requestId = getOrCreateRequestId(request)
  const respond = <T extends Response>(r: T) => withRequestIdHeader(r, requestId)

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return respond(NextResponse.json({ error: 'Unauthorized' }, { status: 401 }))

  // Phase 6B: SALES_ROLES only.
  const venue = await getCurrentVenueForUser(user.id)
  if (!venue) return respond(NextResponse.json({ error: 'Venue not found' }, { status: 404 }))
  if (!(SALES_ROLES as readonly string[]).includes(venue.role)) {
    return respond(NextResponse.json({ error: 'forbidden' }, { status: 403 }))
  }
  const venueId = venue.venueId

  // Phase 7D — billing gate (no-op when BILLING_GATE_ENABLED !== '1').
  try {
    await requireActiveSubscription(venueId, { requestId, route: '/api/tours' })
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
  const parsed = CreateTourSchema.safeParse(body)
  if (!parsed.success) return respond(NextResponse.json({ error: parsed.error.flatten() }, { status: 400 }))

  const { data, error } = await supabase
    .from('tours')
    .insert({ ...parsed.data, venue_id: venueId, status: 'scheduled' })
    .select()
    .single()

  if (error) {
    captureApiError(error, {
      requestId, route: '/api/tours', userId: user.id, venueId, leadId: parsed.data.lead_id,
    })
    return respond(NextResponse.json({ error: error.message }, { status: 500 }))
  }

  // Update lead stage
  await supabase.from('leads').update({ stage: 'tour_scheduled' }).eq('id', parsed.data.lead_id)

  // Phase 8G — fire-and-forget lead notification. We look up the lead
  // contact AFTER the insert so the email reflects what's actually in
  // the DB. The `.catch(() => {})` is belt-and-suspenders — the helper
  // already swallows internally, but if a future bug surfaces it, we'd
  // rather log it than crash the route.
  const tour = data as {
    id: string
    lead_id: string
    scheduled_at: string
    duration_minutes: number | null
    location_notes: string | null
  }
  const { data: leadRow } = await supabase
    .from('leads')
    .select('name, email')
    .eq('id', tour.lead_id)
    .maybeSingle()
  const lead = (leadRow ?? null) as { name?: string | null; email?: string | null } | null
  void sendTourNotificationEmail({
    kind: 'created',
    tourId: tour.id,
    venueId,
    leadId: tour.lead_id,
    leadEmail: lead?.email ?? null,
    leadName: lead?.name ?? null,
    scheduledAt: tour.scheduled_at,
    durationMinutes: tour.duration_minutes ?? null,
    locationNotes: tour.location_notes ?? null,
    requestId,
  }).catch(() => {
    /* swallowed — helper already logs + Sentry-captures */
  })

  return respond(NextResponse.json(data, { status: 201 }))
}
