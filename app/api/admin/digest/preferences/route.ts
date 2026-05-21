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
import { recordAuditEvent } from '@/lib/enterprise/audit-events'
import {
  DIGEST_CADENCES,
  DIGEST_WEEKLY_DAYS,
  resolveEffectiveDigestPreference,
  setMemberDigestPreference,
  type DigestCadence,
  type DigestWeeklyDay,
} from '@/lib/billing/operator-digest-preferences'

/**
 * /api/admin/digest/preferences  (Phase 8T → rewritten in 8U)
 *
 * Per-user digest preferences. Each admin/owner now controls their own
 * cadence + weekly-day. The route reads/writes
 * `venue_members.metadata` for the authenticated caller while still
 * surfacing the subscription-level fallback so the UI can render a
 * clear "source" badge.
 *
 * GET  → returns the caller's effective preference + the source it
 *        resolved from + the venue's subscription fallback (for the
 *        Phase 8U `DigestPreferencesCard` source-of-truth badge).
 * POST → writes the caller's preference into
 *        `venue_members.metadata`. Never touches subscription metadata.
 *
 * ── AUTH / TENANT ─────────────────────────────────────────────────────────
 *   - `requireAdmin()` first.
 *   - Optional `venue_id` for cross-tenant admins (`requireVenueRole`).
 *   - Per-caller rate limits (different keys for GET vs POST so a hot
 *     read loop doesn't starve writes).
 *
 * ── PII POSTURE ───────────────────────────────────────────────────────────
 *   - Returns only digest-relevant metadata fields. No subscription
 *     blob spread; no member-metadata blob spread.
 *   - `X-Request-Id` set on every response.
 */

const QuerySchema = z.object({
  venue_id: z.string().uuid().optional(),
})

const BodySchema = z.object({
  venue_id: z.string().uuid().optional(),
  cadence: z.enum(['daily', 'weekly', 'off']),
  weekly_day: z.enum(['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']).optional(),
})

interface MemberMetadataSlice {
  digest_cadence: DigestCadence | null
  digest_weekly_day: DigestWeeklyDay | null
  digest_disabled_at: string | null
}

interface SubscriptionFallbackSlice {
  digest_cadence: DigestCadence | null
  digest_weekly_day: DigestWeeklyDay | null
  digest_disabled: boolean
  digest_disabled_at: string | null
}

interface GetResponseBody {
  venue_id: string
  user_id: string
  subscription_id: string | null
  cadence: DigestCadence
  weekly_day: DigestWeeklyDay | null
  source: 'member' | 'subscription' | 'legacy_disabled' | 'default'
  member_metadata: MemberMetadataSlice
  subscription_fallback: SubscriptionFallbackSlice
}

async function resolveTargetVenue(
  requestedVenueId: string | undefined,
  callerVenueId: string,
  userId: string
): Promise<
  | { ok: true; venueId: string }
  | { ok: false; response: Response }
> {
  const target = requestedVenueId ?? callerVenueId
  if (target === callerVenueId) return { ok: true, venueId: target }
  try {
    await requireVenueRole(userId, target, ADMIN_ROLES)
    return { ok: true, venueId: target }
  } catch (err) {
    if (err instanceof TenantAccessError) {
      if (err.status === 403) {
        return {
          ok: false,
          response: NextResponse.json({ error: 'not_found' }, { status: 404 }),
        }
      }
      return {
        ok: false,
        response: NextResponse.json({ error: err.code }, { status: err.status }),
      }
    }
    throw err
  }
}

function sliceMemberMetadata(metadata: Record<string, unknown> | null): MemberMetadataSlice {
  if (!metadata) {
    return { digest_cadence: null, digest_weekly_day: null, digest_disabled_at: null }
  }
  const cadenceRaw = metadata.digest_cadence
  const dayRaw = metadata.digest_weekly_day
  const disabledAtRaw = metadata.digest_disabled_at
  return {
    digest_cadence:
      cadenceRaw === 'daily' || cadenceRaw === 'weekly' || cadenceRaw === 'off'
        ? cadenceRaw
        : null,
    digest_weekly_day:
      dayRaw === 'sun' || dayRaw === 'mon' || dayRaw === 'tue' ||
      dayRaw === 'wed' || dayRaw === 'thu' || dayRaw === 'fri' || dayRaw === 'sat'
        ? dayRaw
        : null,
    digest_disabled_at: typeof disabledAtRaw === 'string' ? disabledAtRaw : null,
  }
}

function sliceSubscriptionFallback(
  metadata: Record<string, unknown> | null
): SubscriptionFallbackSlice {
  if (!metadata) {
    return {
      digest_cadence: null,
      digest_weekly_day: null,
      digest_disabled: false,
      digest_disabled_at: null,
    }
  }
  const cadenceRaw = metadata.digest_cadence
  const dayRaw = metadata.digest_weekly_day
  const disabledRaw = metadata.digest_disabled
  const disabledAtRaw = metadata.digest_disabled_at
  return {
    digest_cadence:
      cadenceRaw === 'daily' || cadenceRaw === 'weekly' || cadenceRaw === 'off'
        ? cadenceRaw
        : null,
    digest_weekly_day:
      dayRaw === 'sun' || dayRaw === 'mon' || dayRaw === 'tue' ||
      dayRaw === 'wed' || dayRaw === 'thu' || dayRaw === 'fri' || dayRaw === 'sat'
        ? dayRaw
        : null,
    digest_disabled: disabledRaw === true,
    digest_disabled_at: typeof disabledAtRaw === 'string' ? disabledAtRaw : null,
  }
}

// ============================================================================
// GET
// ============================================================================

export async function GET(request: NextRequest): Promise<Response> {
  const requestId = getOrCreateRequestId(request)
  const reqLog = log.child({
    requestId,
    route: '/api/admin/digest/preferences',
    method: 'GET',
  })
  const respond = <T extends Response>(r: T) => withRequestIdHeader(r, requestId)

  const admin = await requireAdmin()
  if (!admin.ok) {
    return respond(NextResponse.json({ error: admin.code }, { status: admin.status }))
  }
  const { user, venueId: callerVenueId } = admin

  const rl = await rateLimitUserAction(
    request,
    `admin:digest-preferences:${user.id}`
  )
  if (!rl.allowed) {
    reqLog.warn({ userId: user.id, retryMs: rl.retryAfterMs }, 'rate_limit.blocked')
    return respond(rateLimitedResponse(rl))
  }

  const url = new URL(request.url)
  const parsed = QuerySchema.safeParse({
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

  const tenant = await resolveTargetVenue(parsed.data.venue_id, callerVenueId, user.id)
  if (!tenant.ok) return respond(tenant.response)
  const targetVenueId = tenant.venueId

  // Phase 8U — two parallel reads: member metadata + subscription
  // fallback. Both via service-role; the route's admin gate is the
  // primary access boundary.
  const svc = createServiceClient()
  const [memberRes, subRes] = await Promise.all([
    svc
      .from('venue_members')
      .select('metadata')
      .eq('venue_id', targetVenueId)
      .eq('user_id', user.id)
      .maybeSingle(),
    svc
      .from('subscriptions')
      .select('id, metadata')
      .eq('venue_id', targetVenueId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
  ])

  if (memberRes.error) {
    reqLog.error(
      { err: memberRes.error, venueId: targetVenueId },
      'admin.digest_preferences.member_lookup_failed'
    )
    captureApiError(memberRes.error, {
      requestId,
      route: '/api/admin/digest/preferences',
      userId: user.id,
      venueId: targetVenueId,
    })
    return respond(NextResponse.json({ error: 'unexpected_error' }, { status: 500 }))
  }
  if (subRes.error) {
    // Non-fatal — fallback fields just go null + the resolver falls
    // through to default 'daily'.
    reqLog.warn(
      { err: subRes.error, venueId: targetVenueId },
      'admin.digest_preferences.subscription_lookup_failed'
    )
  }

  const memberMetadata =
    (memberRes.data as { metadata?: Record<string, unknown> | null } | null)?.metadata ?? null
  const subRow = subRes.data as { id: string; metadata: Record<string, unknown> | null } | null
  const subscriptionMetadata = subRow?.metadata ?? null

  const effective = resolveEffectiveDigestPreference({
    memberMetadata,
    subscriptionMetadata,
  })

  const body: GetResponseBody = {
    venue_id: targetVenueId,
    user_id: user.id,
    subscription_id: subRow?.id ?? null,
    cadence: effective.cadence,
    weekly_day: effective.weeklyDay,
    source: effective.source,
    member_metadata: sliceMemberMetadata(memberMetadata),
    subscription_fallback: sliceSubscriptionFallback(subscriptionMetadata),
  }

  reqLog.info(
    {
      userId: user.id,
      venueId: targetVenueId,
      cadence: effective.cadence,
      weeklyDay: effective.weeklyDay,
      source: effective.source,
    },
    'admin.digest_preferences.get_completed'
  )

  return respond(NextResponse.json(body))
}

// ============================================================================
// POST
// ============================================================================

export async function POST(request: NextRequest): Promise<Response> {
  const requestId = getOrCreateRequestId(request)
  const reqLog = log.child({
    requestId,
    route: '/api/admin/digest/preferences',
    method: 'POST',
  })
  const respond = <T extends Response>(r: T) => withRequestIdHeader(r, requestId)

  const admin = await requireAdmin()
  if (!admin.ok) {
    return respond(NextResponse.json({ error: admin.code }, { status: admin.status }))
  }
  const { user, venueId: callerVenueId } = admin

  const rl = await rateLimitUserAction(
    request,
    `admin:digest-preferences-update:${user.id}`
  )
  if (!rl.allowed) {
    reqLog.warn({ userId: user.id, retryMs: rl.retryAfterMs }, 'rate_limit.blocked')
    return respond(rateLimitedResponse(rl))
  }

  const body = await request.json().catch(() => null)
  const parsed = BodySchema.safeParse(body)
  if (!parsed.success) {
    return respond(
      NextResponse.json(
        { error: 'validation_failed', detail: parsed.error.flatten() },
        { status: 400 }
      )
    )
  }

  const tenant = await resolveTargetVenue(parsed.data.venue_id, callerVenueId, user.id)
  if (!tenant.ok) return respond(tenant.response)
  const targetVenueId = tenant.venueId

  const { cadence, weekly_day } = parsed.data
  if (!DIGEST_CADENCES.includes(cadence)) {
    return respond(
      NextResponse.json({ error: 'validation_failed' }, { status: 400 })
    )
  }
  // Defensive — Zod allows DIGEST_WEEKLY_DAYS via the enum, but
  // mirror the helper's defaulting logic here so the response is
  // predictable.
  let effectiveWeeklyDay: DigestWeeklyDay | null = null
  if (cadence === 'weekly') {
    if (weekly_day && DIGEST_WEEKLY_DAYS.includes(weekly_day)) {
      effectiveWeeklyDay = weekly_day
    } else {
      effectiveWeeklyDay = 'mon'
    }
  }

  const result = await setMemberDigestPreference({
    venueId: targetVenueId,
    userId: user.id,
    cadence,
    weeklyDay: effectiveWeeklyDay,
    requestId,
  })

  if (!result.ok) {
    if (result.error === 'member_not_found') {
      // Caller passed `requireAdmin()` but doesn't have a venue_members
      // row for this venue — shouldn't happen for the primary venue;
      // most likely a cross-tenant venue_id that the operator has
      // legacy `owner_user_id`-only access to. Surface as 404 to match
      // the rest of the operator surface posture.
      reqLog.info(
        { userId: user.id, venueId: targetVenueId },
        'admin.digest_preferences.member_not_found'
      )
      return respond(
        NextResponse.json({ error: 'member_not_found' }, { status: 404 })
      )
    }
    return respond(NextResponse.json({ error: 'unexpected_error' }, { status: 500 }))
  }

  reqLog.info(
    {
      userId: user.id,
      venueId: targetVenueId,
      cadence,
      weeklyDay: effectiveWeeklyDay,
    },
    'admin.digest_preferences.post_completed'
  )

  void recordAuditEvent({
    venueId: targetVenueId,
    actorUserId: user.id,
    actorKind: 'operator',
    route: '/api/admin/digest/preferences',
    action: 'digest_preferences_update',
    targetTable: 'venue_member_digest_preferences',
    targetId: user.id,
    requestId,
    ip: request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
    userAgent: request.headers.get('user-agent'),
    after: { cadence, weekly_day: effectiveWeeklyDay },
  })

  return respond(
    NextResponse.json({
      success: true,
      venue_id: targetVenueId,
      user_id: user.id,
      cadence,
      weekly_day: effectiveWeeklyDay,
    })
  )
}
