import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createServiceClient } from '@/lib/supabase/service'
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
import { captureApiError } from '@/lib/observability/sentry'
import { recordAuditEvent } from '@/lib/enterprise/audit-events'
import { AUDIT_ACTIONS } from '@/lib/enterprise/audit-actions'

/**
 * /api/admin/security/demo-mode  (Phase 9J)
 *
 * GET   — read demo mode state for the caller's primary venue.
 *         Returns enabled / label / started_at / started_by.
 *
 * PATCH — OWNER-only. Toggle demo mode + optional operator label.
 *         Audited via `demo_mode_updated` action.
 *
 * Demo mode is a VISUAL marker — the dashboard shell renders a
 * "DEMO MODE" badge in the topbar when enabled. It does NOT
 * anonymize production data; operators should treat it as a
 * "we're presenting on screen right now" attention signal, not
 * a substitute for actual data scrubbing.
 *
 * Owner-only PATCH because flipping demo mode affects how every
 * operator at the venue sees the dashboard. Cross-tenant access
 * defaults to caller's primary venue (no body venue_id field).
 */

const PatchBodySchema = z.object({
  enabled: z.boolean(),
  label: z.string().trim().max(120).nullable().optional(),
})

interface VenueRow {
  id: string
  demo_mode_enabled: boolean
  demo_mode_label: string | null
  demo_mode_started_at: string | null
  demo_mode_started_by: string | null
}

const SELECT =
  'id, demo_mode_enabled, demo_mode_label, demo_mode_started_at, demo_mode_started_by'

export async function GET(request: NextRequest): Promise<Response> {
  const requestId = getOrCreateRequestId(request)
  const reqLog = log.child({
    requestId,
    route: '/api/admin/security/demo-mode',
    op: 'admin.security.demo_mode.read',
  })
  const respond = <T extends Response>(r: T) =>
    withRequestIdHeader(r, requestId)

  const admin = await requireAdmin()
  if (!admin.ok) {
    return respond(
      NextResponse.json({ error: admin.code }, { status: admin.status })
    )
  }
  const { user, venueId } = admin

  const rl = await rateLimitUserAction(
    request,
    `admin:demo-mode-read:${user.id}`,
    {
      route: '/api/admin/security/demo-mode',
      method: 'GET',
      userId: user.id,
      venueId,
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

  const svc = createServiceClient()
  const { data, error } = await svc
    .from('venues')
    .select(SELECT)
    .eq('id', venueId)
    .maybeSingle()
  if (error) {
    reqLog.error({ err: error, venueId }, 'admin.security.demo_mode.read_failed')
    captureApiError(error, {
      requestId,
      route: '/api/admin/security/demo-mode',
      userId: user.id,
      venueId,
    })
    return respond(
      NextResponse.json({ error: 'unexpected_error' }, { status: 500 })
    )
  }
  if (!data) {
    return respond(NextResponse.json({ error: 'not_found' }, { status: 404 }))
  }
  const row = data as VenueRow
  return respond(
    NextResponse.json({
      venue_id: row.id,
      enabled: row.demo_mode_enabled,
      label: row.demo_mode_label,
      started_at: row.demo_mode_started_at,
      started_by: row.demo_mode_started_by,
    })
  )
}

export async function PATCH(request: NextRequest): Promise<Response> {
  const requestId = getOrCreateRequestId(request)
  const reqLog = log.child({
    requestId,
    route: '/api/admin/security/demo-mode',
    op: 'admin.security.demo_mode.update',
  })
  const respond = <T extends Response>(r: T) =>
    withRequestIdHeader(r, requestId)

  const admin = await requireAdmin()
  if (!admin.ok) {
    return respond(
      NextResponse.json({ error: admin.code }, { status: admin.status })
    )
  }
  const { user, venueId } = admin

  const rl = await rateLimitUserAction(
    request,
    `admin:demo-mode-update:${user.id}`,
    {
      route: '/api/admin/security/demo-mode',
      method: 'PATCH',
      userId: user.id,
      venueId,
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

  // Owner-only — flipping demo mode affects every operator at
  // the venue.
  try {
    await requireVenueRole(user.id, venueId, ['owner'])
  } catch (err) {
    if (err instanceof TenantAccessError) {
      return respond(
        NextResponse.json({ error: err.code }, { status: err.status })
      )
    }
    throw err
  }

  const body = await request.json().catch(() => null)
  const parsed = PatchBodySchema.safeParse(body ?? {})
  if (!parsed.success) {
    return respond(
      NextResponse.json(
        { error: 'validation_failed', detail: parsed.error.flatten() },
        { status: 400 }
      )
    )
  }

  const svc = createServiceClient()

  // Read current state for the audit before-snapshot.
  const { data: beforeRaw } = await svc
    .from('venues')
    .select(SELECT)
    .eq('id', venueId)
    .maybeSingle()
  const before = (beforeRaw as VenueRow | null) ?? null

  const nowIso = new Date().toISOString()
  // Clearing a label or disabling demo mode resets the
  // started_at + started_by markers so the next enable cycle
  // stamps fresh provenance.
  const update = parsed.data.enabled
    ? {
        demo_mode_enabled: true,
        demo_mode_label:
          parsed.data.label === undefined
            ? before?.demo_mode_label ?? null
            : parsed.data.label,
        // Only stamp started_at + started_by on the OFF→ON edge.
        // Re-enabling while already enabled (label change) keeps
        // the original start time intact so the operator can
        // see how long demo mode has been live.
        demo_mode_started_at:
          before?.demo_mode_enabled === true
            ? before.demo_mode_started_at
            : nowIso,
        demo_mode_started_by:
          before?.demo_mode_enabled === true
            ? before.demo_mode_started_by
            : user.id,
      }
    : {
        demo_mode_enabled: false,
        demo_mode_label: null,
        demo_mode_started_at: null,
        demo_mode_started_by: null,
      }

  const { data: updated, error: updateErr } = await svc
    .from('venues')
    .update(update)
    .eq('id', venueId)
    .select(SELECT)
    .single()
  if (updateErr) {
    reqLog.error(
      { err: updateErr, venueId },
      'admin.security.demo_mode.update_failed'
    )
    captureApiError(updateErr, {
      requestId,
      route: '/api/admin/security/demo-mode',
      userId: user.id,
      venueId,
    })
    return respond(
      NextResponse.json({ error: 'unexpected_error' }, { status: 500 })
    )
  }

  const updatedRow = updated as VenueRow

  void recordAuditEvent({
    venueId,
    actorUserId: user.id,
    actorKind: 'operator',
    route: '/api/admin/security/demo-mode',
    action: AUDIT_ACTIONS.DEMO_MODE_UPDATED,
    targetTable: 'venues',
    targetId: venueId,
    requestId,
    ip: request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
    userAgent: request.headers.get('user-agent'),
    before: before
      ? {
          enabled: before.demo_mode_enabled,
          label: before.demo_mode_label,
          started_at: before.demo_mode_started_at,
          started_by: before.demo_mode_started_by,
        }
      : null,
    after: {
      enabled: updatedRow.demo_mode_enabled,
      label: updatedRow.demo_mode_label,
      started_at: updatedRow.demo_mode_started_at,
      started_by: updatedRow.demo_mode_started_by,
    },
  })

  return respond(
    NextResponse.json({
      venue_id: updatedRow.id,
      enabled: updatedRow.demo_mode_enabled,
      label: updatedRow.demo_mode_label,
      started_at: updatedRow.demo_mode_started_at,
      started_by: updatedRow.demo_mode_started_by,
    })
  )
}
