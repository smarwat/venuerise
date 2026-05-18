import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getOrCreateRequestId, withRequestIdHeader } from '@/lib/observability/request-id'
import { captureApiError } from '@/lib/observability/sentry'
import { requireVenueRole, TenantAccessError } from '@/lib/auth/tenant-access'
import { SALES_ROLES } from '@/lib/auth/roles'
import { requireActiveSubscription, SubscriptionRequiredError } from '@/lib/billing/subscription-status'
import {
  sendTourNotificationEmail,
  type TourNotificationKind,
} from '@/lib/integrations/tour-notifications'
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
  // Phase 8G — also pull current `status` + `scheduled_at` so we can derive
  // the notification kind (rescheduled vs confirmed vs cancelled) after the
  // update lands.
  const { data: tourRow } = await supabase
    .from('tours')
    .select('id, venue_id, lead_id, status, scheduled_at')
    .eq('id', id)
    .maybeSingle()
  if (!tourRow) return respond(NextResponse.json({ error: 'Tour not found' }, { status: 404 }))
  const tourBefore = tourRow as {
    venue_id: string
    lead_id: string | null
    status: string | null
    scheduled_at: string | null
  }
  const venueId = tourBefore.venue_id

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

  // Phase 8G — derive notification kind from the transition + send to
  // the lead. We pick at most ONE kind per request, in priority order:
  //   cancelled   > confirmed > rescheduled
  // so a single PATCH that simultaneously sets status='confirmed' AND
  // updates scheduled_at sends a confirmation email (the more positive,
  // user-facing signal), not a reschedule email.
  //
  // The notification is a no-op when:
  //   - no relevant field changed
  //   - lead_id is null (orphaned tour — shouldn't happen, defense)
  //   - lead has no email on file
  // and is always best-effort (helper swallows internally).
  const tourAfter = data as {
    id: string
    lead_id: string | null
    scheduled_at: string
    duration_minutes: number | null
    location_notes: string | null
    status: string | null
  }
  let kind: TourNotificationKind | null = null
  if (
    parsed.data.status === 'cancelled' &&
    tourBefore.status !== 'cancelled'
  ) {
    kind = 'cancelled'
  } else if (
    parsed.data.status === 'confirmed' &&
    tourBefore.status !== 'confirmed'
  ) {
    kind = 'confirmed'
  } else if (
    parsed.data.scheduled_at &&
    tourBefore.scheduled_at &&
    parsed.data.scheduled_at !== tourBefore.scheduled_at
  ) {
    kind = 'rescheduled'
  }

  if (kind && tourAfter.lead_id) {
    const { data: leadRow } = await supabase
      .from('leads')
      .select('name, email')
      .eq('id', tourAfter.lead_id)
      .maybeSingle()
    const lead = (leadRow ?? null) as { name?: string | null; email?: string | null } | null
    void sendTourNotificationEmail({
      kind,
      tourId: tourAfter.id,
      venueId,
      leadId: tourAfter.lead_id,
      leadEmail: lead?.email ?? null,
      leadName: lead?.name ?? null,
      scheduledAt: tourAfter.scheduled_at,
      durationMinutes: tourAfter.duration_minutes ?? null,
      locationNotes: tourAfter.location_notes ?? null,
      requestId,
    }).catch(() => {
      /* swallowed — helper already logs + Sentry-captures */
    })
  }

  return respond(NextResponse.json(data))
}
