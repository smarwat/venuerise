import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireAdmin } from '@/lib/auth/require-admin'
import {
  requireVenueRole,
  TenantAccessError,
} from '@/lib/auth/tenant-access'
import { ADMIN_ROLES } from '@/lib/auth/roles'
import { rateLimitUserAction, rateLimitedResponse } from '@/lib/rate-limit'
import { RATE_LIMIT_DOMAINS } from '@/lib/rate-limit-catalog'
import { log } from '@/lib/log'
import {
  getOrCreateRequestId,
  withRequestIdHeader,
} from '@/lib/observability/request-id'
import { captureApiError } from '@/lib/observability/sentry'
import {
  seedRevenueRecoveryLoadDemo,
  LOAD_SEED_PROFILES,
  MIN_LEAD_COUNT,
  MAX_LEAD_COUNT,
} from '@/lib/demo/revenue-recovery-load-seed'
import { recordAuditEvent } from '@/lib/enterprise/audit-events'
import { AUDIT_ACTIONS } from '@/lib/enterprise/audit-actions'

/**
 * POST /api/admin/demo/revenue-recovery-load-seed  (GTM-0A.2)
 *
 * Generates a realistic 25–1000 lead pipeline tagged with
 * `demo_seed_type = 'load'` + `demo_seed_version = 'gtm_0a_2'` so
 * the dashboard, charts, and Revenue OS surfaces can be tested
 * under load. Sister of `/api/admin/demo/revenue-recovery-seed`
 * (24-lead hand-crafted demo); the two never delete each other.
 *
 * Body (all optional):
 *   - `venue_id`                    Override caller's default venue.
 *                                   Requires ADMIN_ROLES on the
 *                                   target venue; cross-tenant 403
 *                                   collapses to 404.
 *   - `lead_count`                  Defaults to 250. Clamped to
 *                                   [25, 1000] with a warning.
 *   - `profile`                     'balanced' | 'high_volume' |
 *                                   'messy_channels' | 'sales_demo'.
 *                                   Defaults to 'balanced'.
 *   - `reset_existing_demo_data`    When true, delete prior gtm_0a_2
 *                                   LOAD rows first. NEVER touches
 *                                   GTM-0A hand-crafted rows.
 *
 * Honesty / safety:
 *   - Never deletes non-load-seed rows.
 *   - No external API calls (no Stripe, no Anthropic, no platform sends).
 *   - No autonomous behavior — operator-initiated only.
 *   - Audit row `revenue_recovery_load_demo_seeded` captures profile,
 *     lead count, distribution shape (stages/sources/signals), and
 *     reset counts. Generated message content is NOT mirrored.
 */

const BodySchema = z.object({
  venue_id: z.string().uuid().optional(),
  lead_count: z.number().int().optional(),
  profile: z.enum(LOAD_SEED_PROFILES).optional(),
  reset_existing_demo_data: z.boolean().optional(),
})

export async function POST(request: NextRequest) {
  const requestId = getOrCreateRequestId(request)
  const reqLog = log.child({
    requestId,
    route: '/api/admin/demo/revenue-recovery-load-seed',
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
    `${RATE_LIMIT_DOMAINS.adminDemo.revenueRecoveryLoadSeed}:${user.id}`
  )
  if (!rl.allowed) {
    reqLog.warn(
      { userId: user.id, retryMs: rl.retryAfterMs },
      'rate_limit.blocked'
    )
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

  // Bound check is enforced inside the seeder (with clamping warning),
  // but reject obviously hostile values up front.
  if (
    parsed.data.lead_count !== undefined &&
    (parsed.data.lead_count < 0 || parsed.data.lead_count > MAX_LEAD_COUNT * 10)
  ) {
    return respond(
      NextResponse.json(
        {
          error: 'lead_count_out_of_range',
          detail: { min: MIN_LEAD_COUNT, max: MAX_LEAD_COUNT },
        },
        { status: 400 }
      )
    )
  }

  try {
    const result = await seedRevenueRecoveryLoadDemo({
      venueId: targetVenueId,
      actorUserId: user.id,
      leadCount: parsed.data.lead_count,
      profile: parsed.data.profile,
      resetExistingDemoData:
        parsed.data.reset_existing_demo_data ?? false,
      requestId,
    })

    void recordAuditEvent({
      venueId: targetVenueId,
      actorUserId: user.id,
      actorKind: 'operator',
      route: '/api/admin/demo/revenue-recovery-load-seed',
      action: AUDIT_ACTIONS.REVENUE_RECOVERY_LOAD_DEMO_SEEDED,
      targetTable: null,
      targetId: null,
      requestId,
      ip:
        request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
        null,
      userAgent: request.headers.get('user-agent'),
      metadata: {
        profile: result.profile,
        lead_count_requested: result.leadCountRequested,
        lead_count_clamped: result.leadCountClamped,
        reset_existing_demo_data:
          parsed.data.reset_existing_demo_data ?? false,
        created: result.created,
        distribution: result.distribution,
        reset: result.reset,
        warnings_count: result.warnings.length,
        duration_ms: result.durationMs,
      },
    })

    return respond(NextResponse.json(result))
  } catch (err) {
    reqLog.error(
      { err, venueId: targetVenueId },
      'admin.demo.revenue_recovery_load.unexpected'
    )
    captureApiError(err, {
      requestId,
      route: '/api/admin/demo/revenue-recovery-load-seed',
      userId: user.id,
      venueId: targetVenueId,
    })
    return respond(
      NextResponse.json({ error: 'unexpected_error' }, { status: 500 })
    )
  }
}
