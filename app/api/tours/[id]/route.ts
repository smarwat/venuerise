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
import { recordTourStatusEvent } from '@/lib/integrations/tour-status-events'
import { recordAuditEvent } from '@/lib/enterprise/audit-events'
import { rateLimitUserAction, rateLimitedResponse } from '@/lib/rate-limit'
import { log } from '@/lib/log'
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

/**
 * Phase 8M — derive the audit action verb from a before/after pair.
 * Returns null when nothing relevant changed (no audit row written).
 *
 * Status change always wins over scheduled_at change: a single PATCH
 * that flips status AND moves the slot writes one row with the status
 * verb, since the status flip is the operator-visible action.
 */
function deriveTourAuditAction(
  before: { status: string | null; scheduled_at: string | null },
  after: { status: string | null; scheduled_at: string | null }
): string | null {
  if (before.status !== after.status) {
    if (after.status === 'cancelled') return 'cancel'
    if (after.status === 'confirmed') return 'confirm'
    return 'status_change'
  }
  if (
    after.scheduled_at &&
    before.scheduled_at &&
    after.scheduled_at !== before.scheduled_at
  ) {
    return 'reschedule'
  }
  return null
}

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
  // Phase 8M widens the pre-fetch with `duration_minutes` so the unified
  // status-event audit can record the duration diff in metadata.
  const { data: tourRow } = await supabase
    .from('tours')
    .select('id, venue_id, lead_id, status, scheduled_at, duration_minutes')
    .eq('id', id)
    .maybeSingle()
  if (!tourRow) return respond(NextResponse.json({ error: 'Tour not found' }, { status: 404 }))
  const tourBefore = tourRow as {
    venue_id: string
    lead_id: string | null
    status: string | null
    scheduled_at: string | null
    duration_minutes: number | null
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

  // Phase 9F — per-user rate limit.
  const rl = await rateLimitUserAction(
    request,
    `tours:update:${user.id}`,
    {
      route: '/api/tours/[id]',
      method: 'PATCH',
      userId: user.id,
      venueId,
      requestId,
    }
  )
  if (!rl.allowed) {
    log.warn(
      { requestId, userId: user.id, retryMs: rl.retryAfterMs },
      'rate_limit.blocked'
    )
    return respond(rateLimitedResponse(rl))
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

  // Phase 8M — unified status-event audit. Operator-driven PATCH writes
  // here whenever status or scheduled_at actually changed. Derivation
  // matches what we already use for notification routing in the Phase 8G
  // helper below, but the audit covers a wider set of transitions:
  //   - status change to cancelled         → 'cancel'
  //   - status change to confirmed         → 'confirm'
  //   - any other status change            → 'status_change'
  //   - scheduled_at change with no status → 'reschedule'
  //   - nothing relevant changed           → no audit row written
  const afterForAudit = data as {
    id: string
    lead_id: string | null
    status: string | null
    scheduled_at: string | null
    duration_minutes: number | null
  }
  const auditAction = deriveTourAuditAction(
    { status: tourBefore.status, scheduled_at: tourBefore.scheduled_at },
    { status: afterForAudit.status, scheduled_at: afterForAudit.scheduled_at }
  )
  if (auditAction) {
    void recordTourStatusEvent({
      venueId,
      tourId: afterForAudit.id,
      leadId: afterForAudit.lead_id,
      actorKind: 'operator',
      actorId: user.id,
      action: auditAction,
      previousStatus: tourBefore.status,
      newStatus: afterForAudit.status ?? 'unknown',
      metadata: {
        route: '/api/tours/[id]',
        scheduled_at_before: tourBefore.scheduled_at,
        scheduled_at_after: afterForAudit.scheduled_at,
        duration_before: tourBefore.duration_minutes,
        duration_after: afterForAudit.duration_minutes,
      },
      requestId,
    }).catch(() => {
      /* swallowed — helper already logs + Sentry-captures */
    })
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

  // Phase 9A — best-effort audit row. Action discriminates so the
  // audit card can chip-filter by `tour_cancel` / `tour_confirm` /
  // `tour_reschedule` / `tour_update`. We re-derive the verb
  // here (the existing `auditAction` variable above is the
  // tour-status-events verb; this one is the enterprise audit
  // verb namespace — different sinks).
  const enterpriseAuditVerb = deriveTourAuditAction(
    { status: tourBefore.status, scheduled_at: tourBefore.scheduled_at },
    {
      status:
        ((data as { status?: string | null }).status ?? tourBefore.status) ?? null,
      scheduled_at:
        ((data as { scheduled_at?: string | null }).scheduled_at ??
          tourBefore.scheduled_at) ?? null,
    }
  )
  const enterpriseAuditAction =
    enterpriseAuditVerb === 'cancel'
      ? 'tour_cancel'
      : enterpriseAuditVerb === 'confirm'
        ? 'tour_confirm'
        : enterpriseAuditVerb === 'reschedule'
          ? 'tour_reschedule'
          : 'tour_update'
  void recordAuditEvent({
    venueId,
    actorUserId: user.id,
    actorKind: 'operator',
    route: '/api/tours/[id]',
    action: enterpriseAuditAction,
    targetTable: 'tours',
    targetId: id,
    requestId,
    ip: request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
    userAgent: request.headers.get('user-agent'),
    before: {
      status: tourBefore.status,
      scheduled_at: tourBefore.scheduled_at,
      duration_minutes: tourBefore.duration_minutes,
    },
    after: {
      status: (data as { status?: unknown }).status,
      scheduled_at: (data as { scheduled_at?: unknown }).scheduled_at,
      duration_minutes: (data as { duration_minutes?: unknown }).duration_minutes,
    },
    metadata: { fields: Object.keys(parsed.data) },
  })

  return respond(NextResponse.json(data))
}
