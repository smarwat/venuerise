import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createServiceClient } from '@/lib/supabase/service'
import { requireAdmin } from '@/lib/auth/require-admin'
import { requireVenueRole, TenantAccessError } from '@/lib/auth/tenant-access'
import { ADMIN_ROLES } from '@/lib/auth/roles'
import { rateLimitUserAction, rateLimitedResponse } from '@/lib/rate-limit'
import { log } from '@/lib/log'
import { getOrCreateRequestId, withRequestIdHeader } from '@/lib/observability/request-id'
import { captureApiError } from '@/lib/observability/sentry'

/**
 * POST /api/admin/tours/clear-pause  (Phase 8I)
 *
 * Operator escape hatch for the auto-pause flow. Removes the active
 * pause scalars (`tours_paused_at`, `tours_paused_reason`,
 * `tours_paused_count`) AND the resume scalars (`tours_resumed_at`,
 * `tours_resumed_reason`) from a single venue's subscription metadata,
 * while preserving the full `tour_pause_history` audit array.
 *
 * Adds three forensic keys so we always know who pressed the button:
 *   tours_pause_cleared_at
 *   tours_pause_cleared_by      (operator user id)
 *   tours_pause_cleared_reason  (optional free text, 240 chars max)
 *
 * ── WHEN TO USE THIS vs LET STRIPE HANDLE IT ──────────────────────────────
 * Stripe webhook → dispatcher → Phase 8G `markTourSchedulingResumed`
 * already stamps `tours_resumed_at` on `past_due → active|trialing`
 * transitions. The /dashboard/tours banner reads
 * `tours_paused_at IS NOT NULL AND tours_resumed_at IS NULL`, so after
 * Stripe recovery the banner WILL flip off on its own.
 *
 * Use clear-pause ONLY when:
 *   1. Stripe recovery happened but the webhook never landed (rare),
 *      OR
 *   2. The operator manually fixed billing out-of-band (e.g. wrote off
 *      the invoice, comped the customer) and there's no webhook coming,
 *      OR
 *   3. A test/synthetic past_due was used to QA the pause flow and
 *      now needs to be reset.
 *
 * ── RESPONSE SHAPES ───────────────────────────────────────────────────────
 *   200 — pause existed, cleared:
 *     { success: true, changed: true, venue_id, subscription_id }
 *
 *   200 — no pause to clear (idempotent):
 *     { success: true, changed: false, reason: 'not_paused' }
 *
 *   200 — no subscription row at all (shouldn't happen post-onboarding):
 *     { success: true, changed: false, reason: 'no_subscription' }
 *
 *   Standard 401/403/404/429/500 for auth/tenant/rate-limit/db errors.
 *
 * `X-Request-Id` set on every response via the standard `respond()` wrapper.
 */

const BodySchema = z.object({
  venue_id: z.string().uuid().optional(),
  reason: z.string().trim().max(240).optional(),
})

export async function POST(request: NextRequest) {
  const requestId = getOrCreateRequestId(request)
  const reqLog = log.child({
    requestId,
    route: '/api/admin/tours/clear-pause',
  })
  const respond = <T extends Response>(r: T) => withRequestIdHeader(r, requestId)

  // 1. Auth.
  const admin = await requireAdmin()
  if (!admin.ok) {
    return respond(NextResponse.json({ error: admin.code }, { status: admin.status }))
  }
  const { user, venueId: callerVenueId } = admin

  // 2. Rate limit per caller.
  const rl = await rateLimitUserAction(request, `admin:tours-clear-pause:${user.id}`)
  if (!rl.allowed) {
    reqLog.warn({ userId: user.id, retryMs: rl.retryAfterMs }, 'rate_limit.blocked')
    return respond(rateLimitedResponse(rl))
  }

  // 3. Body.
  const body = await request.json().catch(() => null)
  const parsed = BodySchema.safeParse(body ?? {})
  if (!parsed.success) {
    return respond(
      NextResponse.json(
        { error: 'validation_failed', detail: parsed.error.flatten() },
        { status: 400 }
      )
    )
  }
  const { venue_id: bodyVenueId, reason } = parsed.data

  // 4. Resolve target venue + tenant bind.
  const targetVenueId = bodyVenueId ?? callerVenueId
  if (targetVenueId !== callerVenueId) {
    try {
      await requireVenueRole(user.id, targetVenueId, ADMIN_ROLES)
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

  // 5. Look up the most-recent subscription row for the venue. Same
  // priority order as the Phase 7D billing helper + the pause-history
  // endpoint — keeps the operator surface internally consistent.
  const svc = createServiceClient()
  const { data: subRaw, error: subErr } = await svc
    .from('subscriptions')
    .select('id, metadata')
    .eq('venue_id', targetVenueId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (subErr) {
    reqLog.error({ err: subErr }, 'admin.tours_clear_pause.lookup_failed')
    captureApiError(subErr, {
      requestId,
      route: '/api/admin/tours/clear-pause',
      userId: user.id,
      venueId: targetVenueId,
    })
    return respond(NextResponse.json({ error: 'unexpected_error' }, { status: 500 }))
  }
  if (!subRaw) {
    reqLog.info(
      { userId: user.id, venueId: targetVenueId },
      'admin.tours_clear_pause.no_subscription'
    )
    return respond(
      NextResponse.json({ success: true, changed: false, reason: 'no_subscription' })
    )
  }

  const sub = subRaw as { id: string; metadata: Record<string, unknown> | null }
  const metadata = (sub.metadata ?? {}) as Record<string, unknown>

  const isPaused =
    typeof metadata.tours_paused_at === 'string' && metadata.tours_paused_at.length > 0

  if (!isPaused) {
    reqLog.info(
      { userId: user.id, venueId: targetVenueId, subscriptionId: sub.id },
      'admin.tours_clear_pause.not_paused'
    )
    return respond(
      NextResponse.json({ success: true, changed: false, reason: 'not_paused' })
    )
  }

  // 6. Build the new metadata. We strip the five scalar pause/resume
  // keys, preserve `tour_pause_history` + every other unrelated key,
  // and stamp three forensic keys recording who cleared it.
  //
  // Spread → delete → assign keeps the mutation explicit and avoids
  // accidentally re-writing other Stripe-sourced metadata (e.g.
  // dunning_sent, recovery_sent, source flags).
  const next: Record<string, unknown> = { ...metadata }
  delete next.tours_paused_at
  delete next.tours_paused_reason
  delete next.tours_paused_count
  delete next.tours_resumed_at
  delete next.tours_resumed_reason

  next.tours_pause_cleared_at = new Date().toISOString()
  next.tours_pause_cleared_by = user.id
  if (reason && reason.length > 0) {
    next.tours_pause_cleared_reason = reason
  } else {
    // Explicitly null out any prior reason so a re-clear without a
    // reason doesn't inherit the previous one. Important when an
    // operator clears, the venue re-paused, then they clear again.
    delete next.tours_pause_cleared_reason
  }

  const { error: updateErr } = await svc
    .from('subscriptions')
    .update({ metadata: next })
    .eq('id', sub.id)

  if (updateErr) {
    reqLog.error(
      { err: updateErr, subscriptionId: sub.id },
      'admin.tours_clear_pause.update_failed'
    )
    captureApiError(updateErr, {
      requestId,
      route: '/api/admin/tours/clear-pause',
      userId: user.id,
      venueId: targetVenueId,
    })
    return respond(NextResponse.json({ error: 'unexpected_error' }, { status: 500 }))
  }

  reqLog.info(
    {
      userId: user.id,
      venueId: targetVenueId,
      subscriptionId: sub.id,
      hadReason: Boolean(reason),
    },
    'admin.tours_clear_pause.completed'
  )

  return respond(
    NextResponse.json({
      success: true,
      changed: true,
      venue_id: targetVenueId,
      subscription_id: sub.id,
    })
  )
}
