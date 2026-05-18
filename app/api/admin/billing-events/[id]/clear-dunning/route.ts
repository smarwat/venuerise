import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { requireAdmin } from '@/lib/auth/require-admin'
import { requireVenueRole, TenantAccessError } from '@/lib/auth/tenant-access'
import { ADMIN_ROLES } from '@/lib/auth/roles'
import { rateLimitUserAction, rateLimitedResponse } from '@/lib/rate-limit'
import { log } from '@/lib/log'
import { getOrCreateRequestId, withRequestIdHeader } from '@/lib/observability/request-id'
import { captureApiError } from '@/lib/observability/sentry'
import { removeSubscriptionMetadataArrayEntries } from '@/lib/billing/subscription-metadata-remove'
import { z } from 'zod'

/**
 * POST /api/admin/billing-events/[id]/clear-dunning
 *
 * Operator escape hatch (Phase 7N). Removes dunning-attempt entries from
 * `subscriptions.metadata.dunning_sent` for a venue without hand-editing SQL.
 *
 * AUTHORIZATION
 *   1. requireAdmin() — caller is owner/admin of some venue.
 *   2. Audit row tenant binding — same shape as Phase 7G detail + 7I replay:
 *      missing row / null venue_id / cross-tenant access all collapse to 404
 *      so admins can't enumerate cross-tenant events.
 *   3. Subscription↔venue binding — the supplied subscription_id MUST
 *      belong to the audit row's venue. Refuses with 404 otherwise so an
 *      admin who has access to venue A can't clear dunning on venue B by
 *      threading the call through an event id that happens to belong to A.
 *
 * PREFIX TARGETING
 *   - With period_date  → `dunning:<venue_id>:<period_date>` (one period)
 *   - Without           → `dunning:<venue_id>:` (every period for the venue)
 *
 * SAFETY
 *   - Rate-limited per caller to prevent accidental click loops.
 *   - Sentry captures the underlying RPC error only for true failures
 *     (RPC threw / DB unavailable); expected 4xx outcomes are info logs.
 *   - Logs include `subscriptionId`, `periodDate`, and the operator-supplied
 *     `reason` but NEVER the full metadata array. Operators inspecting the
 *     before/after metadata snapshot should use the Phase 7G detail endpoint
 *     immediately before + after running clear-dunning.
 */

const BodySchema = z.object({
  subscription_id: z.string().uuid(),
  // YYYY-MM-DD (UTC). The full ISO timestamp would also accidentally match
  // a longer prefix, so we keep this date-only.
  period_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'period_date must be YYYY-MM-DD')
    .optional(),
  reason: z.string().max(240).optional(),
})

const ParamsSchema = z.object({ id: z.string().uuid() })

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const requestId = getOrCreateRequestId(request)
  const reqLog = log.child({
    requestId,
    route: '/api/admin/billing-events/[id]/clear-dunning',
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
    `admin:billing-events-clear-dunning:${user.id}`
  )
  if (!rl.allowed) {
    reqLog.warn({ userId: user.id, retryMs: rl.retryAfterMs }, 'rate_limit.blocked')
    return respond(rateLimitedResponse(rl))
  }

  // 3. Validate route param + body.
  const { id } = await params
  const paramsParsed = ParamsSchema.safeParse({ id })
  if (!paramsParsed.success) {
    return respond(NextResponse.json({ error: 'not_found' }, { status: 404 }))
  }

  const body = await request.json().catch(() => null)
  const bodyParsed = BodySchema.safeParse(body)
  if (!bodyParsed.success) {
    return respond(
      NextResponse.json(
        { error: 'validation_failed', detail: bodyParsed.error.flatten() },
        { status: 400 }
      )
    )
  }
  const { subscription_id: subscriptionId, period_date: periodDate, reason } = bodyParsed.data

  // 4. Look up the audit row.
  const svc = createServiceClient()
  const { data: eventRaw, error: eventErr } = await svc
    .from('billing_events_log')
    .select('id, venue_id')
    .eq('id', paramsParsed.data.id)
    .maybeSingle()

  if (eventErr) {
    reqLog.error(
      { err: eventErr, billingEventId: paramsParsed.data.id },
      'billing.clear_dunning.event_lookup_failed'
    )
    captureApiError(eventErr, {
      requestId,
      route: '/api/admin/billing-events/[id]/clear-dunning',
      userId: user.id,
    })
    return respond(NextResponse.json({ error: 'unexpected_error' }, { status: 500 }))
  }
  if (!eventRaw) {
    return respond(NextResponse.json({ error: 'not_found' }, { status: 404 }))
  }

  const eventRow = eventRaw as unknown as { id: string; venue_id: string | null }
  if (!eventRow.venue_id) {
    return respond(NextResponse.json({ error: 'not_found' }, { status: 404 }))
  }

  // 5. Tenant binding on the audit row's venue.
  if (eventRow.venue_id !== callerVenueId) {
    try {
      await requireVenueRole(user.id, eventRow.venue_id, ADMIN_ROLES)
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

  // 6. Verify the subscription belongs to the SAME venue as the audit row.
  // This stops an admin of venue A from threading a call through one of
  // A's audit rows to mutate a subscription that belongs to venue B.
  const { data: subRaw, error: subErr } = await svc
    .from('subscriptions')
    .select('id, venue_id')
    .eq('id', subscriptionId)
    .maybeSingle()

  if (subErr) {
    reqLog.error(
      { err: subErr, subscriptionId },
      'billing.clear_dunning.subscription_lookup_failed'
    )
    captureApiError(subErr, {
      requestId,
      route: '/api/admin/billing-events/[id]/clear-dunning',
      userId: user.id,
      venueId: eventRow.venue_id,
    })
    return respond(NextResponse.json({ error: 'unexpected_error' }, { status: 500 }))
  }
  if (!subRaw) {
    return respond(NextResponse.json({ error: 'not_found' }, { status: 404 }))
  }
  const subRow = subRaw as unknown as { id: string; venue_id: string | null }
  if (!subRow.venue_id || subRow.venue_id !== eventRow.venue_id) {
    return respond(NextResponse.json({ error: 'not_found' }, { status: 404 }))
  }

  // 7. Build the prefix. The dunning job (Phase 7K) keys entries with
  // `dunning:<venue>:<period>:attempt-N`, so a venue-only prefix wipes
  // every period; adding the period scopes to one period.
  const venuePrefix = `dunning:${eventRow.venue_id}:`
  const keyPrefix = periodDate ? `${venuePrefix}${periodDate}` : venuePrefix

  // 8. Call the RPC via the helper.
  const updatedMetadata = await removeSubscriptionMetadataArrayEntries({
    subscriptionId: subRow.id,
    arrayKey: 'dunning_sent',
    keyPrefix,
    requestId,
  })

  if (!updatedMetadata) {
    // Helper already logged + Sentry-captured the underlying error.
    return respond(
      NextResponse.json({ error: 'unexpected_error' }, { status: 500 })
    )
  }

  reqLog.info(
    {
      userId: user.id,
      venueId: eventRow.venue_id,
      billingEventId: eventRow.id,
      subscriptionId: subRow.id,
      periodDate: periodDate ?? null,
      reason: reason ?? null,
      clearedPrefix: keyPrefix,
    },
    'billing.clear_dunning.completed'
  )

  return respond(
    NextResponse.json({
      success: true,
      subscription_id: subRow.id,
      cleared_prefix: keyPrefix,
      metadata: updatedMetadata,
    })
  )
}
