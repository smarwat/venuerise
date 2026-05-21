import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getOrCreateRequestId, withRequestIdHeader } from '@/lib/observability/request-id'
import { captureApiError } from '@/lib/observability/sentry'
import { requireVenueRole, TenantAccessError } from '@/lib/auth/tenant-access'
import { SALES_ROLES, ADMIN_ROLES } from '@/lib/auth/roles'
import { requireActiveSubscription, SubscriptionRequiredError } from '@/lib/billing/subscription-status'
import { z } from 'zod'
import { LOST_REASON_VALUES } from '@/lib/revenue-os/reactivation'
import { recordAuditEvent } from '@/lib/enterprise/audit-events'
import { getClientIpHash } from '@/lib/observability/request-context'
import { rateLimitUserAction, rateLimitedResponse } from '@/lib/rate-limit'
import { log } from '@/lib/log'

// Phase 8BD — lost reason sub-block. The PATCH body's
// `lost_reason` field is the ONLY metadata key the route accepts;
// arbitrary `metadata` writes are deliberately rejected so a
// client can't smuggle other namespaces past the allowlist. A
// `null` value clears the existing `metadata.lost_reason` block;
// any object passes through the enum + length check below before
// being merged.
const LostReasonInputSchema = z
  .union([
    z.null(),
    z.object({
      reason: z.enum(LOST_REASON_VALUES as unknown as [string, ...string[]]),
      note: z.string().max(500).optional(),
    }),
  ])

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
  // Phase 8BD — operator-supplied lost reason. Stamped under
  // `metadata.lost_reason` with the calling user's id +
  // recorded_at on the server. Pass `null` to clear.
  lost_reason: LostReasonInputSchema.optional(),
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

  // Phase 9F — per-user rate limit. Lead updates are operator-
  // initiated and should not loop. The abuse-context arg lets the
  // limiter populate the AbuseMonitorCard on block.
  const rlPatch = await rateLimitUserAction(
    request,
    `leads:update:${user.id}`,
    {
      route: '/api/leads/[id]',
      method: 'PATCH',
      userId: user.id,
      venueId,
      requestId,
    }
  )
  if (!rlPatch.allowed) {
    log.warn(
      { requestId, userId: user.id, retryMs: rlPatch.retryAfterMs },
      'rate_limit.blocked'
    )
    return respond(rateLimitedResponse(rlPatch))
  }

  // Phase 7D — billing gate (no-op when BILLING_GATE_ENABLED !== '1').
  try {
    await requireActiveSubscription(venueId, { requestId, route: '/api/leads/[id]' })
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
  const parsed = UpdateLeadSchema.safeParse(body)
  if (!parsed.success) return respond(NextResponse.json({ error: parsed.error.flatten() }, { status: 400 }))

  // Split out the metadata-bound `lost_reason` field from the
  // direct-column updates. The lost_reason write merges into the
  // existing `metadata` jsonb so any unrelated keys a future
  // phase adds under metadata stay intact.
  const { lost_reason: lostReasonInput, ...directUpdates } = parsed.data
  const update: Record<string, unknown> = { ...directUpdates }
  if (lostReasonInput !== undefined) {
    // Read the current metadata so we can merge instead of
    // clobber. RLS-aware read; we already know the caller has
    // venue access (requireVenueRole above).
    const { data: currentRow } = await supabase
      .from('leads')
      .select('metadata')
      .eq('id', id)
      .eq('venue_id', venueId)
      .maybeSingle()
    const currentMetadata: Record<string, unknown> =
      currentRow &&
      typeof (currentRow as { metadata?: unknown }).metadata === 'object' &&
      (currentRow as { metadata?: unknown }).metadata !== null
        ? { ...((currentRow as { metadata: Record<string, unknown> }).metadata) }
        : {}
    if (lostReasonInput === null) {
      // Operator chose to clear the reason. Drop the key
      // entirely rather than leaving a `null` behind so the
      // jsonb stays tidy + the reactivation helper's "is the
      // reason missing" check stays unambiguous.
      delete currentMetadata.lost_reason
    } else {
      currentMetadata.lost_reason = {
        reason: lostReasonInput.reason,
        note: lostReasonInput.note ?? null,
        recorded_at: new Date().toISOString(),
        recorded_by: user.id,
      }
    }
    update.metadata = currentMetadata
  }

  // Phase 9A — pre-update snapshot for the audit row. Allowlisted
  // columns only (we never want raw notes / metadata blobs in the
  // audit trail). Best-effort: probe failure does not block the
  // PATCH.
  let beforeRow: Record<string, unknown> | null = null
  try {
    const { data: snap } = await supabase
      .from('leads')
      .select('stage, lead_score, urgency, event_date, ai_active, metadata')
      .eq('id', id)
      .eq('venue_id', venueId)
      .maybeSingle()
    beforeRow = (snap as Record<string, unknown> | null) ?? null
  } catch {
    beforeRow = null
  }

  const { data, error } = await supabase
    .from('leads')
    .update(update)
    .eq('id', id)
    .eq('venue_id', venueId)
    .select()
    .single()

  if (error) {
    captureApiError(error, { requestId, route: '/api/leads/[id]', leadId: id, userId: user.id, venueId })
    return respond(NextResponse.json({ error: error.message }, { status: 500 }))
  }

  // Phase 9A — best-effort audit write. The action discriminates
  // a lost_reason write from a plain lead update so the audit
  // card's filter chip can show them separately. Snapshots are
  // allowlisted + sanitized by the helper.
  const action =
    lostReasonInput !== undefined ? 'lead_lost_reason_set' : 'lead_update'
  void recordAuditEvent({
    venueId,
    actorUserId: user.id,
    actorKind: 'operator',
    route: '/api/leads/[id]',
    action,
    targetTable: 'leads',
    targetId: id,
    requestId,
    ip: request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
    userAgent: request.headers.get('user-agent'),
    before: beforeRow,
    after: {
      stage: (data as { stage?: unknown }).stage,
      lead_score: (data as { lead_score?: unknown }).lead_score,
      urgency: (data as { urgency?: unknown }).urgency,
      event_date: (data as { event_date?: unknown }).event_date,
      ai_active: (data as { ai_active?: unknown }).ai_active,
      // For metadata, only echo the `lost_reason` sub-block —
      // the rest of metadata may grow over time and we don't
      // want the audit row to balloon.
      lost_reason:
        ((data as { metadata?: Record<string, unknown> | null }).metadata
          ?.lost_reason as unknown) ?? null,
    },
    metadata: {
      fields: Object.keys(update),
    },
  })
  void getClientIpHash // keep the import live for future routes
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

  // Phase 9F — per-user rate limit.
  const rlDel = await rateLimitUserAction(
    request,
    `leads:delete:${user.id}`,
    {
      route: '/api/leads/[id]',
      method: 'DELETE',
      userId: user.id,
      venueId,
      requestId,
    }
  )
  if (!rlDel.allowed) {
    log.warn(
      { requestId, userId: user.id, retryMs: rlDel.retryAfterMs },
      'rate_limit.blocked'
    )
    return respond(rateLimitedResponse(rlDel))
  }

  // Phase 7D — billing gate (no-op when BILLING_GATE_ENABLED !== '1').
  try {
    await requireActiveSubscription(venueId, { requestId, route: '/api/leads/[id]' })
  } catch (err) {
    if (err instanceof SubscriptionRequiredError) {
      return respond(NextResponse.json(
        { error: err.code, subscription_status: err.subscriptionStatus.kind },
        { status: err.status }
      ))
    }
    throw err
  }

  // Phase 9A — capture the slim pre-delete snapshot so the audit
  // row has the lead's "name + stage at time of delete" instead
  // of just an opaque uuid. Best-effort: failure does not block.
  let beforeDeleteRow: Record<string, unknown> | null = null
  try {
    const { data: snap } = await supabase
      .from('leads')
      .select('name, stage, lead_score, urgency, event_date')
      .eq('id', id)
      .eq('venue_id', venueId)
      .maybeSingle()
    beforeDeleteRow = (snap as Record<string, unknown> | null) ?? null
  } catch {
    beforeDeleteRow = null
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
  void recordAuditEvent({
    venueId,
    actorUserId: user.id,
    actorKind: 'operator',
    route: '/api/leads/[id]',
    action: 'lead_delete',
    targetTable: 'leads',
    targetId: id,
    requestId,
    ip: request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
    userAgent: request.headers.get('user-agent'),
    before: beforeDeleteRow,
    after: null,
  })
  return respond(NextResponse.json({ success: true }))
}
