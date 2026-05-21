import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireAdmin } from '@/lib/auth/require-admin'
import {
  requireVenueRole,
  TenantAccessError,
} from '@/lib/auth/tenant-access'
import { ADMIN_ROLES } from '@/lib/auth/roles'
import { rateLimitUserAction, rateLimitedResponse } from '@/lib/rate-limit'
import { log } from '@/lib/log'
import {
  getOrCreateRequestId,
  withRequestIdHeader,
} from '@/lib/observability/request-id'
import { captureApiError } from '@/lib/observability/sentry'
import { seedRevenueRecoveryDemo } from '@/lib/demo/revenue-recovery-seed'
import { recordAuditEvent } from '@/lib/enterprise/audit-events'
import { AUDIT_ACTIONS } from '@/lib/enterprise/audit-actions'

/**
 * POST /api/admin/demo/revenue-recovery-seed  (GTM-0A)
 *
 * Seeds the rich Revenue Recovery demo dataset for the caller's
 * venue. Separate from the legacy `/api/admin/demo/seed` route
 * (Phase 8A fixture set) — this one is GTM-shaped: each lead is
 * tagged with attribution + designed to trigger a specific Revenue
 * OS leakage signal so the operator sees the pain in 30 seconds.
 *
 * Body (all optional):
 *   - `venue_id`                  Override the caller's default venue.
 *                                 Requires ADMIN_ROLES on the target
 *                                 venue; cross-tenant 403 collapses to 404.
 *   - `reset_existing_demo_data`  When true, delete prior gtm_0a rows
 *                                 first. Tables without a metadata
 *                                 column are NOT touched — the result
 *                                 `warnings` field documents skips.
 *
 * Honesty / safety:
 *   - Never deletes non-demo rows (matches `metadata->>demo_seed = 'true'`).
 *   - No external API calls (no Stripe, no Anthropic, no platform sends).
 *   - No autonomous behavior — operator-initiated only.
 *   - Audit row `revenue_recovery_demo_seeded` includes counts +
 *     reset flag + warnings count. Full content not mirrored.
 */

const BodySchema = z.object({
  venue_id: z.string().uuid().optional(),
  reset_existing_demo_data: z.boolean().optional(),
})

export async function POST(request: NextRequest) {
  const requestId = getOrCreateRequestId(request)
  const reqLog = log.child({
    requestId,
    route: '/api/admin/demo/revenue-recovery-seed',
  })
  const respond = <T extends Response>(r: T) =>
    withRequestIdHeader(r, requestId)

  const admin = await requireAdmin()
  if (!admin.ok) {
    return respond(
      NextResponse.json({ error: admin.code }, { status: admin.status })
    )
  }
  const { user, venueId: defaultVenueId } = admin

  const rl = await rateLimitUserAction(
    request,
    `admin:demo:revenue-recovery-seed:${user.id}`
  )
  if (!rl.allowed) {
    reqLog.warn({ userId: user.id, retryMs: rl.retryAfterMs }, 'rate_limit.blocked')
    return respond(rateLimitedResponse(rl))
  }

  const body = await request.json().catch(() => ({}))
  const parsed = BodySchema.safeParse(body ?? {})
  if (!parsed.success) {
    return respond(
      NextResponse.json(
        { error: 'validation_failed', detail: parsed.error.flatten() },
        { status: 400 }
      )
    )
  }

  // Resolve the target venue. When a caller overrides `venue_id` we
  // must re-validate role on that specific venue; the `requireAdmin`
  // call above only verifies role on the caller's *default* venue.
  // Cross-tenant forbidden collapses to 404 per the API posture.
  const targetVenueId = parsed.data.venue_id ?? defaultVenueId
  if (parsed.data.venue_id && parsed.data.venue_id !== defaultVenueId) {
    try {
      await requireVenueRole(user.id, targetVenueId, ADMIN_ROLES)
    } catch (err) {
      if (err instanceof TenantAccessError) {
        const status = err.status === 403 ? 404 : err.status
        return respond(
          NextResponse.json({ error: err.code }, { status })
        )
      }
      throw err
    }
  }

  try {
    const result = await seedRevenueRecoveryDemo({
      venueId: targetVenueId,
      actorUserId: user.id,
      resetExistingDemoData:
        parsed.data.reset_existing_demo_data ?? false,
      requestId,
    })

    // Enterprise audit. Counts + warnings shape captures magnitude
    // and any partial failures without echoing the seeded content.
    void recordAuditEvent({
      venueId: targetVenueId,
      actorUserId: user.id,
      actorKind: 'operator',
      route: '/api/admin/demo/revenue-recovery-seed',
      action: AUDIT_ACTIONS.REVENUE_RECOVERY_DEMO_SEEDED,
      targetTable: null,
      targetId: null,
      requestId,
      ip: request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
      userAgent: request.headers.get('user-agent'),
      metadata: {
        reset_existing_demo_data:
          parsed.data.reset_existing_demo_data ?? false,
        created: result.created,
        skipped: result.skipped,
        reset: result.reset,
        warnings_count: result.warnings.length,
      },
    })

    return respond(NextResponse.json(result))
  } catch (err) {
    reqLog.error(
      { err, venueId: targetVenueId },
      'admin.demo.revenue_recovery.unexpected'
    )
    captureApiError(err, {
      requestId,
      route: '/api/admin/demo/revenue-recovery-seed',
      userId: user.id,
      venueId: targetVenueId,
    })
    return respond(
      NextResponse.json({ error: 'unexpected_error' }, { status: 500 })
    )
  }
}
