import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { rateLimitUserAction, rateLimitedResponse } from '@/lib/rate-limit'
import { log } from '@/lib/log'
import { getOrCreateRequestId, withRequestIdHeader } from '@/lib/observability/request-id'
import { captureApiError } from '@/lib/observability/sentry'
import {
  createWorkspaceForUser,
  OnboardingError,
} from '@/lib/onboarding/onboarding-service'
import { recordAuditEvent } from '@/lib/enterprise/audit-events'
import { AUDIT_ACTIONS } from '@/lib/enterprise/audit-actions'

/**
 * POST /api/onboarding/create-workspace
 *
 * Bootstrap a brand-new authenticated user into a usable VenueRise tenant:
 *   - venue row (owner_user_id = caller)
 *   - venue_members row with role='owner'
 *   - 5 starter knowledge_base rows
 *   - 5 starter tour_availability rows (Mon–Fri)
 *
 * STATUS CODES
 *   201  workspace created       — body: { venue_id, already_exists: false }
 *   200  workspace already there — body: { venue_id, already_exists: true }
 *   400  bad payload             — body: { error: 'validation_failed', detail }
 *   401  unauthenticated         — body: { error: 'unauthorized' }
 *   429  rate-limited            — body: standard rateLimitedResponse
 *   500  unexpected              — body: { error: <code-or-message> }
 *
 * Rate-limited per user (`onboarding:create:{userId}`) so a misbehaving
 * frontend can't hammer the service-role writes.
 */
export async function POST(request: NextRequest) {
  const requestId = getOrCreateRequestId(request)
  const reqLog = log.child({ requestId, route: '/api/onboarding/create-workspace' })
  const respond = <T extends Response>(r: T) => withRequestIdHeader(r, requestId)

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return respond(NextResponse.json({ error: 'unauthorized' }, { status: 401 }))
  }

  // Rate limit BEFORE doing any work — single key per user.
  const rl = await rateLimitUserAction(request, `onboarding:create:${user.id}`)
  if (!rl.allowed) {
    reqLog.warn({ userId: user.id, retryMs: rl.retryAfterMs }, 'rate_limit.blocked')
    return respond(rateLimitedResponse(rl))
  }

  // Tolerate empty body — every field has a default except venue_name, which
  // the schema will reject with a 400 if missing.
  let body: unknown
  try {
    body = await request.json()
  } catch {
    body = {}
  }

  try {
    const result = await createWorkspaceForUser({
      userId: user.id,
      email: user.email ?? null,
      payload: body,
      requestId,
    })
    // Phase 9B — enterprise audit. Workspace creation is the
    // moment a venue tenant first comes into being; the audit row
    // attributes the creating user. We skip the row when the
    // helper short-circuited on `already_exists` — the original
    // workspace_create row already exists from the first call.
    if (!result.already_exists) {
      void recordAuditEvent({
        venueId: result.venue_id,
        actorUserId: user.id,
        actorKind: 'operator',
        route: '/api/onboarding/create-workspace',
        action: AUDIT_ACTIONS.WORKSPACE_CREATE,
        targetTable: 'venues',
        targetId: result.venue_id,
        requestId,
        ip: request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
        userAgent: request.headers.get('user-agent'),
        metadata: {
          owner_user_id: user.id,
        },
      })
    }
    const status = result.already_exists ? 200 : 201
    return respond(NextResponse.json(result, { status }))
  } catch (err) {
    if (err instanceof OnboardingError) {
      const payload: { error: string; detail?: unknown } = { error: err.code }
      if (err.detail !== undefined) payload.detail = err.detail
      return respond(NextResponse.json(payload, { status: err.status }))
    }
    const message = err instanceof Error ? err.message : 'onboarding_failed'
    reqLog.error({ err, userId: user.id }, 'onboarding.unexpected_error')
    captureApiError(err, {
      requestId,
      route: '/api/onboarding/create-workspace',
      userId: user.id,
    })
    return respond(NextResponse.json({ error: message }, { status: 500 }))
  }
}
