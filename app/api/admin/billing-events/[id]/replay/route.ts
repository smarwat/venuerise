import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { requireAdmin } from '@/lib/auth/require-admin'
import { requireVenueRole, TenantAccessError } from '@/lib/auth/tenant-access'
import { ADMIN_ROLES } from '@/lib/auth/roles'
import { rateLimitUserAction, rateLimitedResponse } from '@/lib/rate-limit'
import { log } from '@/lib/log'
import { getOrCreateRequestId, withRequestIdHeader } from '@/lib/observability/request-id'
import { captureApiError } from '@/lib/observability/sentry'
import { stripe, BillingNotConfiguredError } from '@/lib/billing/stripe'
import { dispatchStripeEvent } from '@/lib/billing/stripe-event-dispatcher'
import { markStripeEventHandled } from '@/lib/billing/billing-events-log'
import { recordAuditEvent } from '@/lib/enterprise/audit-events'
import { AUDIT_ACTIONS } from '@/lib/enterprise/audit-actions'
import { z } from 'zod'

/**
 * POST /api/admin/billing-events/[id]/replay
 *
 * Manually reprocess a Stripe event from the audit log. Owner/admin only.
 *
 * BEHAVIOR
 *   1. Auth + tenant binding (same shape as the Phase 7G detail endpoint).
 *   2. Look up the audit row by id, deny with 404 on missing / null venue
 *      / cross-tenant access (existence boundary preserved).
 *   3. Fetch the freshest event payload from Stripe via
 *      `stripe().events.retrieve(stripe_event_id)`. If anything changed
 *      server-side since the original delivery, we use the latest.
 *   4. Dispatch through the shared dispatcher with `source: 'admin_replay'`.
 *   5. Update the SAME audit row's handled/handler_error/venue_id —
 *      explicitly DO NOT insert a new audit row, DO NOT bump
 *      duplicate_count. This is a manual re-run, not a Stripe redelivery.
 *
 * WHY THIS EXISTS
 *   When a webhook handler failed transiently (Supabase blip, Anthropic
 *   timeout in a downstream side effect, etc.) the audit row is left with
 *   handled=false. Stripe's own "Resend" button in the dashboard re-fires
 *   the webhook, but that takes the dispatcher down its full path including
 *   the duplicate short-circuit (Stripe sends the same event id; our
 *   UNIQUE rejects the insert and we just bump duplicate_count). This
 *   endpoint sidesteps that by re-running the handler directly against
 *   the existing audit row.
 *
 * SAFETY
 *   - Idempotent on the subscription sync: `syncSubscriptionFromStripeSubscription`
 *     upserts on `stripe_subscription_id`, so re-running is safe.
 *   - Rate-limited per caller to prevent accidental click-loops.
 *   - The full payload is NEVER logged.
 */

const ParamsSchema = z.object({ id: z.string().uuid() })

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const requestId = getOrCreateRequestId(request)
  const reqLog = log.child({
    requestId,
    route: '/api/admin/billing-events/[id]/replay',
  })
  const respond = <T extends Response>(r: T) => withRequestIdHeader(r, requestId)

  // 1. Auth.
  const admin = await requireAdmin()
  if (!admin.ok) {
    return respond(NextResponse.json({ error: admin.code }, { status: admin.status }))
  }
  const { user, venueId: callerVenueId } = admin

  // 2. Rate limit per caller.
  const rl = await rateLimitUserAction(
    request,
    `admin:billing-event-replay:${user.id}`
  )
  if (!rl.allowed) {
    reqLog.warn({ userId: user.id, retryMs: rl.retryAfterMs }, 'rate_limit.blocked')
    return respond(rateLimitedResponse(rl))
  }

  // 3. Validate route param.
  const { id } = await params
  const parsed = ParamsSchema.safeParse({ id })
  if (!parsed.success) {
    return respond(NextResponse.json({ error: 'not_found' }, { status: 404 }))
  }

  // 4. Look up audit row.
  const svc = createServiceClient()
  const { data: rowRaw, error: lookupErr } = await svc
    .from('billing_events_log')
    .select('id, stripe_event_id, event_type, venue_id, handled, handler_error')
    .eq('id', parsed.data.id)
    .maybeSingle()

  if (lookupErr) {
    reqLog.error(
      { err: lookupErr, billingEventId: parsed.data.id },
      'admin.billing_events.replay_lookup_failed'
    )
    captureApiError(lookupErr, {
      requestId,
      route: '/api/admin/billing-events/[id]/replay',
      userId: user.id,
    })
    return respond(NextResponse.json({ error: 'unexpected_error' }, { status: 500 }))
  }
  if (!rowRaw) {
    return respond(NextResponse.json({ error: 'not_found' }, { status: 404 }))
  }

  const row = rowRaw as unknown as {
    id: string
    stripe_event_id: string
    event_type: string
    venue_id: string | null
    handled: boolean
    handler_error: string | null
  }

  // 5. Tenant binding — collapse all denials to 404 (existence boundary).
  if (!row.venue_id) {
    return respond(NextResponse.json({ error: 'not_found' }, { status: 404 }))
  }
  if (row.venue_id !== callerVenueId) {
    try {
      await requireVenueRole(user.id, row.venue_id, ADMIN_ROLES)
    } catch (err) {
      if (err instanceof TenantAccessError) {
        if (err.status === 403) {
          return respond(NextResponse.json({ error: 'not_found' }, { status: 404 }))
        }
        return respond(NextResponse.json({ error: err.code }, { status: err.status }))
      }
      throw err
    }
  }

  // 6. Fetch the latest event payload from Stripe.
  let event
  try {
    event = await stripe().events.retrieve(row.stripe_event_id)
  } catch (err) {
    if (err instanceof BillingNotConfiguredError) {
      reqLog.warn({}, 'billing.replay.not_configured')
      return respond(
        NextResponse.json({ error: 'billing_not_configured' }, { status: 503 })
      )
    }
    reqLog.error(
      { err, stripeEventId: row.stripe_event_id },
      'billing.replay.stripe_retrieve_failed'
    )
    captureApiError(err, {
      requestId,
      route: '/api/admin/billing-events/[id]/replay',
      userId: user.id,
      venueId: row.venue_id,
    })
    return respond(
      NextResponse.json(
        { error: 'stripe_retrieve_failed' },
        { status: 502 }
      )
    )
  }

  // 7. Dispatch through the shared handler.
  const result = await dispatchStripeEvent(event, {
    requestId,
    source: 'admin_replay',
  })

  // 8. Update the SAME audit row's handled state. Preserve the existing
  // venue_id when dispatch couldn't resolve a fresh one (avoid stomping
  // good data).
  await markStripeEventHandled({
    stripeEventId: event.id,
    handled: result.handled,
    error: result.handlerError ?? null,
    venueId: result.venueId ?? row.venue_id,
    requestId,
  })

  // 9. Phase 7J — record the replay attempt atomically. The RPC bumps
  // replay_count, stamps replayed_at + replayed_by, and returns the new
  // count in one round-trip so we can surface it in the response.
  //
  // We only reach this point if Stripe retrieval succeeded AND dispatch
  // finished (success OR handler failure). A 502 from `stripe.events.retrieve`
  // above short-circuits the route before this counter increments — that
  // matches the spec: "If Stripe retrieval fails before dispatch, do not
  // increment replay_count."
  let newReplayCount: number | null = null
  try {
    const { data: countData, error: rpcErr } = await svc.rpc(
      'record_billing_event_replay',
      { p_event_id: row.id, p_user_id: user.id }
    )
    if (rpcErr) {
      reqLog.error(
        { err: rpcErr, billingEventId: row.id },
        'billing.replay.audit_rpc_failed'
      )
      captureApiError(rpcErr, {
        requestId,
        route: '/api/admin/billing-events/[id]/replay',
        userId: user.id,
        venueId: row.venue_id,
      })
    } else if (typeof countData === 'number') {
      newReplayCount = countData
    }
  } catch (err) {
    // Audit update failure must not unwind the replay — the dispatcher
    // already ran and `markStripeEventHandled` already wrote handled state.
    reqLog.error({ err, billingEventId: row.id }, 'billing.replay.audit_threw')
    captureApiError(err, {
      requestId,
      route: '/api/admin/billing-events/[id]/replay',
      userId: user.id,
      venueId: row.venue_id,
    })
  }

  reqLog.info(
    {
      stripeEventId: event.id,
      eventType: event.type,
      handled: result.handled,
      ignored: result.ignored,
      hadPreviousError: row.handler_error !== null,
      replayCount: newReplayCount,
    },
    'billing.replay.completed'
  )

  // Phase 9B — enterprise audit. The Stripe event payload is NOT
  // included in the snapshot — payloads can carry customer email +
  // raw line items + idempotency keys we don't want in a generic
  // audit feed. The dedicated `billing_events_log` row is the
  // forensic source of truth for payload contents; this audit row
  // captures operator intent.
  void recordAuditEvent({
    venueId: row.venue_id,
    actorUserId: user.id,
    actorKind: 'operator',
    route: '/api/admin/billing-events/[id]/replay',
    action: AUDIT_ACTIONS.BILLING_EVENT_REPLAY,
    targetTable: 'billing_events_log',
    targetId: row.id,
    requestId,
    ip: request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
    userAgent: request.headers.get('user-agent'),
    metadata: {
      stripe_event_id: event.id,
      stripe_event_type: event.type,
      dispatched: result.handled,
      dispatch_ignored: result.ignored,
      handler_error: result.handlerError ?? null,
      had_previous_error: row.handler_error !== null,
      replay_count: newReplayCount,
    },
  })

  return respond(
    NextResponse.json({
      replayed: true,
      handled: result.handled,
      ignored: result.ignored,
      handler_error: result.handlerError ?? null,
      replay_count: newReplayCount,
    })
  )
}
