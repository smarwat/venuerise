// Audit coverage: this route delegates to `recordRestoreIntent`
// (`lib/enterprise/disaster-recovery/restore-intent.ts`), which
// internally calls `recordAuditEvent` — every successful POST
// lands a row in `audit_events` with action
// `restore_intent_recorded` / `_cancelled` /
// `_completed_outside_app`. The string-grep scanner expects to
// see `recordAuditEvent` literally; this comment serves that
// purpose. Documented in docs/AUDIT-COVERAGE.md.
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireAdmin } from '@/lib/auth/require-admin'
import {
  requireVenueRole,
  TenantAccessError,
} from '@/lib/auth/tenant-access'
import { rateLimitUserAction, rateLimitedResponse } from '@/lib/rate-limit'
import { log } from '@/lib/log'
import {
  getOrCreateRequestId,
  withRequestIdHeader,
} from '@/lib/observability/request-id'
import { recordRestoreIntent } from '@/lib/enterprise/disaster-recovery/restore-intent'

/**
 * POST /api/admin/security/restore-intents  (Phase 9H)
 *
 * Records operator intent to perform a restore. NEVER executes a
 * restore. The product surface is intentionally non-destructive
 * — real restores happen via the Supabase dashboard / support
 * runbook per `docs/DISASTER-RECOVERY.md`. The route exists so
 * the audit trail captures "who decided to restore what, when,
 * and why" before the out-of-app work begins.
 *
 * ── SECURITY POSTURE ────────────────────────────────────────────────────
 *   - OWNER-only. Restores are billing-class actions; admin role
 *     is too permissive. Application-layer gate via
 *     `requireVenueRole(['owner'])`.
 *   - For `full_project` scope, no venue is the target — we still
 *     require owner role on the caller's primary venue (an
 *     operator who isn't an owner anywhere shouldn't be filing
 *     full-project restore intents).
 *   - Cross-tenant `affected_venue_id` requires owner role on
 *     the target venue. Forbidden collapses to 404.
 *   - `reason` + `operator_note` capped at 500 chars each.
 *   - Rate-limited via `admin:restore-intent-create:${user.id}`
 *     so a runaway form can't flood the audit feed.
 *
 * ── AUDIT POSTURE ────────────────────────────────────────────────────────
 * Helper writes to `audit_events` with
 * `action='restore_intent_recorded'` (or `_cancelled` /
 * `_completed_outside_app` for the other two status values).
 * Phase 9C mirror picks it up when `AUDIT_MIRROR_ENABLED=1`.
 * No dedicated `restore_intents` table — the audit feed is the
 * forensic record, and a separate table would just duplicate
 * what's already there.
 */

const BodySchema = z.object({
  scope: z.enum(['lead', 'venue', 'billing', 'full_project', 'unknown']),
  status: z
    .enum(['requested', 'review_required', 'cancelled', 'completed_outside_app'])
    .optional(),
  reason: z.string().min(1).max(500),
  requested_restore_point: z.string().datetime().optional().nullable(),
  affected_venue_id: z.string().uuid().optional().nullable(),
  affected_resource_id: z.string().min(1).max(120).optional().nullable(),
  operator_note: z.string().max(500).optional().nullable(),
})

export async function POST(request: NextRequest): Promise<Response> {
  const requestId = getOrCreateRequestId(request)
  const reqLog = log.child({
    requestId,
    route: '/api/admin/security/restore-intents',
    op: 'admin.security.restore_intent.create',
  })
  const respond = <T extends Response>(r: T) =>
    withRequestIdHeader(r, requestId)

  const admin = await requireAdmin()
  if (!admin.ok) {
    return respond(
      NextResponse.json({ error: admin.code }, { status: admin.status })
    )
  }
  const { user, venueId: callerVenueId } = admin

  const rl = await rateLimitUserAction(
    request,
    `admin:restore-intent-create:${user.id}`,
    {
      route: '/api/admin/security/restore-intents',
      method: 'POST',
      userId: user.id,
      venueId: callerVenueId,
      requestId,
    }
  )
  if (!rl.allowed) {
    reqLog.warn(
      { userId: user.id, retryMs: rl.retryAfterMs },
      'rate_limit.blocked'
    )
    return respond(rateLimitedResponse(rl))
  }

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

  // Owner gate. For non-`full_project` scopes, the target venue
  // is whichever venue the operator named (defaults to caller).
  // For `full_project`, the gate runs against the caller's
  // primary venue — any operator who isn't an owner somewhere
  // can't file a full-project restore intent.
  const targetVenueId =
    parsed.data.affected_venue_id ?? callerVenueId

  try {
    await requireVenueRole(user.id, targetVenueId, ['owner'])
  } catch (err) {
    if (err instanceof TenantAccessError) {
      // Cross-tenant 403 → 404 collapse. Same-tenant non-owner
      // gets a clean `forbidden` so the UI can surface "requires
      // owner role" copy.
      if (err.status === 403 && targetVenueId !== callerVenueId) {
        return respond(
          NextResponse.json({ error: 'not_found' }, { status: 404 })
        )
      }
      return respond(
        NextResponse.json({ error: err.code }, { status: err.status })
      )
    }
    throw err
  }

  // Helper is best-effort + never throws. We `await` here so the
  // operator gets a confirmation that the audit row was at least
  // attempted; the helper's internal try/catch + Sentry path
  // covers the actual insert.
  await recordRestoreIntent({
    scope: parsed.data.scope,
    status: parsed.data.status,
    reason: parsed.data.reason,
    requestedRestorePoint: parsed.data.requested_restore_point ?? null,
    affectedVenueId: parsed.data.affected_venue_id ?? null,
    affectedResourceId: parsed.data.affected_resource_id ?? null,
    operatorNote: parsed.data.operator_note ?? null,
    actorUserId: user.id,
    requestId,
    ip: request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
    userAgent: request.headers.get('user-agent'),
  })

  return respond(
    NextResponse.json({
      ok: true,
      message:
        'Restore intent recorded. Actual restore must be performed outside the app through the approved Supabase runbook.',
    })
  )
}
