import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireAdmin } from '@/lib/auth/require-admin'
import {
  requireVenueRole,
  TenantAccessError,
} from '@/lib/auth/tenant-access'
import { ADMIN_ROLES } from '@/lib/auth/roles'
import { createServiceClient } from '@/lib/supabase/service'
import { rateLimitUserAction, rateLimitedResponse } from '@/lib/rate-limit'
import { log } from '@/lib/log'
import {
  getOrCreateRequestId,
  withRequestIdHeader,
} from '@/lib/observability/request-id'
import { captureApiError } from '@/lib/observability/sentry'
import { recordAuditEvent } from '@/lib/enterprise/audit-events'
import {
  parseRevenueOsSettings,
  mergeRevenueOsSettings,
  isDefaultRevenueOsSettings,
  REVENUE_OS_CLAMP_BOUNDS,
  type RevenueOsSettings,
} from '@/lib/revenue-os/settings'

/**
 * /api/admin/revenue-os/settings  (Phase 8AQ)
 *
 * Per-venue Revenue OS thresholds backing the RevenueLeakageBrief +
 * Speed-to-Lead chip + leads-board leakage filter.
 *
 *   GET  → returns the current settings (or defaults) for a venue
 *   POST → merges a partial update into venues.metadata.revenue_os
 *
 * Storage: `venues.metadata.revenue_os` jsonb (migration 023). The
 * route preserves every other key in `venues.metadata` so a future
 * `branding` / `feature_flags` block can coexist without this route
 * stomping it.
 *
 * Security posture:
 *   - requireAdmin() — 401 unauthorized, 403 no_venue
 *   - Cross-tenant `venue_id` requires requireVenueRole(ADMIN_ROLES);
 *     403 collapses to 404 so non-admins can't probe existence
 *   - Per-method rate-limit:
 *       GET  → admin:revenue-os-settings:get:{userId}
 *       POST → admin:revenue-os-settings:update:{userId}
 *   - The helper's `mergeRevenueOsSettings` clamps every numeric field
 *     defensively; even a hand-crafted curl can't smuggle SLA=9999999
 *     past the read path.
 *   - We NEVER log raw venues.metadata — only the parsed/clamped
 *     `settings` keys + venue id.
 */

const SettingsSchema = z
  .object({
    firstReplySlaMinutes: z.number().int().min(1).max(10_000).optional(),
    highFitThreshold: z.number().int().min(0).max(100).optional(),
    staleHighFitHours: z.number().int().min(1).max(10_000).optional(),
    coldLeadDays: z.number().int().min(1).max(10_000).optional(),
    // Phase 8AV — Brand Voice confidence floor + escalation mode.
    // Floor is 0..100; mode is the discriminated union from
    // lib/revenue-os/settings.ts. Both are optional so a partial
    // POST can update just the SLA settings without disturbing
    // brand voice.
    brandVoiceConfidenceFloor: z.number().int().min(0).max(100).optional(),
    brandVoiceEscalationMode: z.enum(['off', 'warn', 'block']).optional(),
    // Phase 8BC — tour duration + buffer drive the slot-suggestion
    // helper. The route accepts the same camelCase the in-code
    // shape uses; storage flips to snake_case via the merge helper.
    tourDurationMinutes: z.number().int().min(15).max(240).optional(),
    tourBufferMinutes: z.number().int().min(0).max(120).optional(),
  })
  .strict()

const PostSchema = z
  .object({
    venue_id: z.string().uuid().optional(),
    settings: SettingsSchema,
  })
  .strict()

const GetSchema = z
  .object({
    venue_id: z.string().uuid().optional(),
  })
  .strict()

interface SettingsResponse {
  venue_id: string
  settings: RevenueOsSettings
  source: 'venue_metadata' | 'default'
}

async function resolveTargetVenue(
  userId: string,
  callerVenueId: string,
  requestedVenueId: string | undefined
): Promise<{ ok: true; venueId: string } | { ok: false; status: 404; code: string }> {
  const target = requestedVenueId ?? callerVenueId
  if (target === callerVenueId) return { ok: true, venueId: target }
  try {
    await requireVenueRole(userId, target, ADMIN_ROLES)
    return { ok: true, venueId: target }
  } catch (err) {
    if (err instanceof TenantAccessError) {
      // Collapse 403 → 404 so a non-admin can't probe other venues
      // for existence. Mirrors digest/sends + ai/draft-audit posture.
      return { ok: false, status: 404, code: 'not_found' }
    }
    throw err
  }
}

export async function GET(request: NextRequest): Promise<Response> {
  const requestId = getOrCreateRequestId(request)
  const reqLog = log.child({
    requestId,
    route: '/api/admin/revenue-os/settings',
    op: 'admin.revenue_os.settings.get',
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
    `admin:revenue-os-settings:get:${user.id}`
  )
  if (!rl.allowed) {
    reqLog.warn(
      { userId: user.id, retryMs: rl.retryAfterMs },
      'rate_limit.blocked'
    )
    return respond(rateLimitedResponse(rl))
  }

  const url = new URL(request.url)
  const parsed = GetSchema.safeParse({
    venue_id: url.searchParams.get('venue_id') ?? undefined,
  })
  if (!parsed.success) {
    return respond(
      NextResponse.json(
        { error: 'validation_failed', detail: parsed.error.flatten() },
        { status: 400 }
      )
    )
  }

  const venueResult = await resolveTargetVenue(
    user.id,
    callerVenueId,
    parsed.data.venue_id
  )
  if (!venueResult.ok) {
    return respond(
      NextResponse.json({ error: venueResult.code }, { status: venueResult.status })
    )
  }
  const venueId = venueResult.venueId

  const svc = createServiceClient()
  const { data: venueRow, error: queryErr } = await svc
    .from('venues')
    .select('metadata')
    .eq('id', venueId)
    .maybeSingle()
  if (queryErr) {
    reqLog.error({ err: queryErr, venueId }, 'admin.revenue_os.settings.read_failed')
    captureApiError(queryErr, {
      requestId,
      route: '/api/admin/revenue-os/settings',
      userId: user.id,
      venueId,
    })
    return respond(
      NextResponse.json({ error: 'unexpected_error' }, { status: 500 })
    )
  }
  const raw = (venueRow as { metadata?: unknown } | null)?.metadata
  const settings = parseRevenueOsSettings(raw)
  const body: SettingsResponse = {
    venue_id: venueId,
    settings,
    source: isDefaultRevenueOsSettings(settings) ? 'default' : 'venue_metadata',
  }
  reqLog.info(
    { venueId, source: body.source },
    'admin.revenue_os.settings.served'
  )
  return respond(NextResponse.json(body))
}

export async function POST(request: NextRequest): Promise<Response> {
  const requestId = getOrCreateRequestId(request)
  const reqLog = log.child({
    requestId,
    route: '/api/admin/revenue-os/settings',
    op: 'admin.revenue_os.settings.update',
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
    `admin:revenue-os-settings:update:${user.id}`
  )
  if (!rl.allowed) {
    reqLog.warn(
      { userId: user.id, retryMs: rl.retryAfterMs },
      'rate_limit.blocked'
    )
    return respond(rateLimitedResponse(rl))
  }

  const body = await request.json().catch(() => null)
  const parsed = PostSchema.safeParse(body)
  if (!parsed.success) {
    return respond(
      NextResponse.json(
        { error: 'validation_failed', detail: parsed.error.flatten() },
        { status: 400 }
      )
    )
  }

  const venueResult = await resolveTargetVenue(
    user.id,
    callerVenueId,
    parsed.data.venue_id
  )
  if (!venueResult.ok) {
    return respond(
      NextResponse.json({ error: venueResult.code }, { status: venueResult.status })
    )
  }
  const venueId = venueResult.venueId

  const svc = createServiceClient()
  // Read existing metadata FIRST so the merge doesn't wipe unrelated
  // keys (`branding`, `feature_flags`, future blocks).
  const { data: venueRow, error: readErr } = await svc
    .from('venues')
    .select('metadata')
    .eq('id', venueId)
    .maybeSingle()
  if (readErr) {
    reqLog.error(
      { err: readErr, venueId },
      'admin.revenue_os.settings.read_for_update_failed'
    )
    captureApiError(readErr, {
      requestId,
      route: '/api/admin/revenue-os/settings',
      userId: user.id,
      venueId,
    })
    return respond(
      NextResponse.json({ error: 'unexpected_error' }, { status: 500 })
    )
  }
  const currentMetadata = (venueRow as { metadata?: unknown } | null)?.metadata
  // Phase 9A — capture the pre-write parsed settings so the
  // audit row records the before/after pair (clamped values, not
  // raw client payload).
  const currentSettings = parseRevenueOsSettings(currentMetadata)
  // mergeRevenueOsSettings clamps each numeric field defensively + preserves
  // every unrelated jsonb key.
  const nextMetadata = mergeRevenueOsSettings(currentMetadata, parsed.data.settings)

  const { error: updateErr } = await svc
    .from('venues')
    .update({ metadata: nextMetadata })
    .eq('id', venueId)
  if (updateErr) {
    reqLog.error(
      { err: updateErr, venueId },
      'admin.revenue_os.settings.update_failed'
    )
    captureApiError(updateErr, {
      requestId,
      route: '/api/admin/revenue-os/settings',
      userId: user.id,
      venueId,
    })
    return respond(
      NextResponse.json({ error: 'unexpected_error' }, { status: 500 })
    )
  }

  // Reparse the persisted block so we return clamped values that
  // match what the read path would see.
  const persistedSettings = parseRevenueOsSettings(nextMetadata)
  reqLog.info(
    { venueId, settings: persistedSettings },
    'admin.revenue_os.settings.updated'
  )

  // Phase 9A — best-effort audit row. Snapshots are the parsed
  // settings (clamped to the spec) so the audit trail records
  // exactly what the system reads, not what the client tried to
  // send.
  void recordAuditEvent({
    venueId,
    actorUserId: user.id,
    actorKind: 'operator',
    route: '/api/admin/revenue-os/settings',
    action: 'revenue_os_settings_update',
    targetTable: 'venues',
    targetId: venueId,
    requestId,
    ip: request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
    userAgent: request.headers.get('user-agent'),
    before: currentSettings,
    after: persistedSettings,
    metadata: { fields: Object.keys(parsed.data.settings) },
  })

  return respond(
    NextResponse.json({
      success: true,
      venue_id: venueId,
      settings: persistedSettings,
      bounds: REVENUE_OS_CLAMP_BOUNDS,
    })
  )
}
