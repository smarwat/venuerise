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
import { sendEmail } from '@/lib/integrations/email'
import {
  aggregateEvents,
  buildOperatorDigestText,
  buildOperatorDigestHtml,
  tryBuildUnsubscribeUrl,
  tryBuildResubscribeUrl,
  fetchRevenueOsDigestSummary,
} from '@/lib/jobs/functions/operator-activity-digest'
import { resolveEffectiveDigestPreference } from '@/lib/billing/operator-digest-preferences'

/**
 * POST /api/admin/digest/send  (Phase 8X)
 *
 * Operator-triggered manual digest send. Sister surface to the Phase
 * 8V `/api/admin/digest/preview`, but with two important differences:
 *
 *   1. Can target ANOTHER owner/admin member of the venue via the
 *      optional `user_id` body field. `preview` is hard-pinned to the
 *      calling user.
 *   2. Outbound row is tagged `metadata.tour_digest_send_kind = 'manual'`
 *      (Phase 8W discriminator). The cron's per-recipient idempotency
 *      probe filters on `send_kind = 'cron'` so a manual send NEVER
 *      blocks the day's scheduled digest, and the cron NEVER dedupes
 *      its send because of a prior manual one.
 *
 * The endpoint can either honor or bypass the recipient's effective
 * cadence preference via the `respect_cadence` flag (defaults to
 * `false` — operator-initiated sends are typically "send it NOW
 * regardless of preference"). Cron idempotency is always bypassed.
 *
 * ── PII POSTURE ───────────────────────────────────────────────────────────
 *   - Recipient email is resolved via service-role
 *     `auth.admin.getUserById` and only echoed back in `sent_to` when
 *     the caller IS the recipient (`target_user_id === caller.id`). For
 *     cross-user sends we return `sent_to: null` so an admin cannot
 *     enumerate other admins' email addresses through this surface.
 *   - `X-Request-Id` set on every response.
 *
 * ── BILLING / RATE LIMIT ──────────────────────────────────────────────────
 *   - Hard-rate-limited per caller via `admin:digest-send:{userId}`.
 *     Separate budget from `admin:digest-preview:{userId}` so a noisy
 *     manual loop doesn't push the preview limiter into deny-all.
 *   - OPERATOR_DIGEST_ENABLED is NOT required — manual sends are
 *     operator-initiated, not part of the cron's policy gate.
 *   - DIGEST_UNSUBSCRIBE_SECRET is optional; the body footer links
 *     omit when absent (the once-per-process warn fires inside the URL
 *     helpers).
 */

const BodySchema = z.object({
  venue_id: z.string().uuid().optional(),
  user_id: z.string().uuid().optional(),
  respect_cadence: z.boolean().optional(),
})

const LOOKBACK_HOURS = 24

export async function POST(request: NextRequest): Promise<Response> {
  const requestId = getOrCreateRequestId(request)
  const reqLog = log.child({
    requestId,
    route: '/api/admin/digest/send',
    op: 'admin.digest_send',
  })
  const respond = <T extends Response>(r: T) => withRequestIdHeader(r, requestId)

  // 1. Auth.
  const admin = await requireAdmin()
  if (!admin.ok) {
    return respond(NextResponse.json({ error: admin.code }, { status: admin.status }))
  }
  const { user, venueId: callerVenueId } = admin

  // 2. Rate limit per caller. Distinct key prefix from preview so the
  // two surfaces have independent budgets.
  const rl = await rateLimitUserAction(request, `admin:digest-send:${user.id}`)
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
  const {
    venue_id: bodyVenueId,
    user_id: bodyUserId,
    respect_cadence: respectCadence = false,
  } = parsed.data

  // 4. Resolve target venue + tenant bind. Mirrors preview / rest of
  // the admin surface: cross-tenant requires ADMIN_ROLES on the
  // target; forbidden collapses to 404 so admins can't enumerate
  // venues.
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

  // Target user defaults to caller. When the caller specifies a
  // different user_id, that user MUST be an owner/admin member of the
  // resolved venue — a viewer / coordinator membership returns 404
  // (same shape as "no membership") so the route can't enumerate per-
  // role distribution.
  const targetUserId = bodyUserId ?? user.id

  const svc = createServiceClient()
  const { data: memberRow, error: memberErr } = await svc
    .from('venue_members')
    .select('id, role, metadata')
    .eq('venue_id', targetVenueId)
    .eq('user_id', targetUserId)
    .maybeSingle()

  if (memberErr) {
    reqLog.error(
      { err: memberErr, venueId: targetVenueId, targetUserId },
      'admin.digest_send.member_lookup_failed'
    )
    captureApiError(memberErr, {
      requestId,
      route: '/api/admin/digest/send',
      userId: user.id,
      venueId: targetVenueId,
    })
    return respond(NextResponse.json({ error: 'unexpected_error' }, { status: 500 }))
  }

  if (!memberRow) {
    reqLog.info(
      { venueId: targetVenueId, targetUserId },
      'admin.digest_send.target_no_membership'
    )
    return respond(NextResponse.json({ error: 'not_found' }, { status: 404 }))
  }

  const member = memberRow as {
    id: string
    role: string
    metadata: Record<string, unknown> | null
  }

  if (!(ADMIN_ROLES as ReadonlyArray<string>).includes(member.role)) {
    // Same collapse-to-404 posture as the public resubscribe route —
    // doesn't leak per-role distribution.
    reqLog.info(
      { venueId: targetVenueId, targetUserId, role: member.role },
      'admin.digest_send.target_not_admin'
    )
    return respond(NextResponse.json({ error: 'not_found' }, { status: 404 }))
  }

  // 5. Resolve the target's email via service-role Auth admin. Mirrors
  // the cron's per-recipient lookup; failures collapse to a typed 400
  // so the operator sees a clear actionable error.
  let targetEmail: string | null = null
  try {
    const { data: userRes } = await svc.auth.admin.getUserById(targetUserId)
    targetEmail = userRes.user?.email ?? null
  } catch (err) {
    reqLog.error(
      { err, venueId: targetVenueId, targetUserId },
      'admin.digest_send.target_email_lookup_failed'
    )
    captureApiError(err, {
      requestId,
      route: '/api/admin/digest/send',
      userId: user.id,
      venueId: targetVenueId,
    })
    return respond(NextResponse.json({ error: 'unexpected_error' }, { status: 500 }))
  }
  if (!targetEmail) {
    reqLog.info(
      { venueId: targetVenueId, targetUserId },
      'admin.digest_send.target_no_email'
    )
    return respond(
      NextResponse.json({ error: 'recipient_email_missing' }, { status: 400 })
    )
  }

  // 6. Aggregate the last 24h of events for the venue. Single-venue
  // narrow read — same shape as preview, NOT the cron's batch read.
  const sinceIso = new Date(
    Date.now() - LOOKBACK_HOURS * 60 * 60 * 1000
  ).toISOString()
  const { data: eventsRaw, error: eventsErr } = await svc
    .from('tour_status_events')
    .select('venue_id, action, actor_kind')
    .eq('venue_id', targetVenueId)
    .gte('occurred_at', sinceIso)

  if (eventsErr) {
    reqLog.error(
      { err: eventsErr, venueId: targetVenueId },
      'admin.digest_send.events_query_failed'
    )
    captureApiError(eventsErr, {
      requestId,
      route: '/api/admin/digest/send',
      userId: user.id,
      venueId: targetVenueId,
    })
    return respond(NextResponse.json({ error: 'unexpected_error' }, { status: 500 }))
  }
  const events = (eventsRaw ?? []) as Array<{
    venue_id: string
    action: string
    actor_kind: string
  }>
  const byVenue = aggregateEvents(events)
  const agg =
    byVenue.get(targetVenueId) ?? { total: 0, byAction: {}, byActor: {} }

  // 7. Resolve effective preference for the TARGET user (not caller).
  // Reads the target's member metadata + the venue subscription
  // metadata; same priority order as the cron's per-recipient loop.
  const [subRes, venueRes] = await Promise.all([
    svc
      .from('subscriptions')
      .select('metadata')
      .eq('venue_id', targetVenueId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    svc
      .from('venues')
      .select('name')
      .eq('id', targetVenueId)
      .maybeSingle(),
  ])
  const subscriptionMetadata =
    (subRes.data as { metadata?: Record<string, unknown> | null } | null)?.metadata ?? null
  const venueName = (venueRes.data as { name?: string | null } | null)?.name ?? null

  const pref = resolveEffectiveDigestPreference({
    memberMetadata: member.metadata,
    subscriptionMetadata,
  })

  // 8. Cadence honor / bypass. The default is bypass — operators
  // typically want "send it now regardless of preference"; the flag is
  // an opt-in for the rare case where the operator wants to dry-run
  // "would today's cron actually send to this person?" without
  // dropping the row.
  if (respectCadence && !pref.shouldSend) {
    // Phase 8Y — `pref.reason` is typed as
    // 'send' | 'off' | 'weekly_wrong_day'. We narrow to the skip
    // branch so the response body carries one of the two operator-
    // facing codes the card switches on. 'send' is unreachable here
    // because shouldSend === false.
    const reason: 'off' | 'weekly_wrong_day' =
      pref.reason === 'off' ? 'off' : 'weekly_wrong_day'
    reqLog.info(
      {
        venueId: targetVenueId,
        targetUserId,
        cadence: pref.cadence,
        weeklyDay: pref.weeklyDay,
        reason,
      },
      'admin.digest_send.respect_cadence_skipped'
    )
    return respond(
      NextResponse.json({
        success: true,
        sent: false,
        skipped: true,
        reason,
        venue_id: targetVenueId,
        recipient_user_id: targetUserId,
        event_count: agg.total,
        cadence: pref.cadence,
        weekly_day: pref.weeklyDay,
        send_kind: 'manual' as const,
      })
    )
  }

  // 9. Build the email. Manual sends include BOTH unsubscribe and
  // resubscribe footer links (Phase 8X) — the recipient may need
  // either, and an operator-initiated message should surface the full
  // preference loop.
  const appUrl = (process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000').replace(
    /\/$/,
    ''
  )
  const unsubscribeUrl = tryBuildUnsubscribeUrl(targetVenueId)
  const resubscribeUrl = tryBuildResubscribeUrl(targetVenueId, targetUserId)
  // Phase 8AU — manual send shares the Revenue OS body with cron +
  // preview. Helper resolves to null on probe failure; in that case
  // the legacy tour-activity body still renders.
  const revenueOsSummary = await fetchRevenueOsDigestSummary(
    svc,
    targetVenueId
  )
  const bodyArgs = {
    venueName,
    venueId: targetVenueId,
    agg,
    appUrl,
    unsubscribeUrl,
    resubscribeUrl,
    cadence: pref.cadence,
    weeklyDay: pref.weeklyDay,
    sendKind: 'manual' as const,
    revenueOs: revenueOsSummary,
  }
  const text = buildOperatorDigestText(bodyArgs)
  const html = buildOperatorDigestHtml(bodyArgs)

  // 10. Send. Outbound row tagged with `send_kind='manual'` so:
  //   - the cron's per-recipient idempotency probe (which filters on
  //     `send_kind='cron'`) ignores this row entirely
  //   - audit queries can distinguish operator-initiated sends from
  //     scheduled / preview sends
  let result
  try {
    result = await sendEmail({
      to: targetEmail,
      subject: 'VenueRise activity summary',
      text,
      html,
      venueId: targetVenueId,
      relatedTable: 'tour_status_events',
      metadata: {
        // Phase 8W → 8X — explicit send-kind discriminator. The cron
        // probe filters on 'cron'; previews use 'preview'; manual
        // sends use 'manual'. No back-compat marker is written here
        // (manual is a Phase 8X addition; no prior audit shape exists).
        tour_digest_send_kind: 'manual',
        tour_digest_recipient_user_id: targetUserId,
        tour_digest_cadence: pref.cadence,
        tour_digest_weekly_day: pref.weeklyDay ?? '',
        tour_digest_total: String(agg.total),
        tour_digest_manual_initiator_user_id: user.id,
      },
    })
  } catch (err) {
    reqLog.error(
      { err, venueId: targetVenueId, targetUserId },
      'admin.digest_send.send_threw'
    )
    captureApiError(err, {
      requestId,
      route: '/api/admin/digest/send',
      userId: user.id,
      venueId: targetVenueId,
    })
    return respond(NextResponse.json({ error: 'email_failed' }, { status: 500 }))
  }

  if (!result.delivered) {
    if (result.error?.startsWith('suppressed:')) {
      reqLog.warn(
        { reason: result.error, venueId: targetVenueId, targetUserId },
        'admin.digest_send.suppressed'
      )
      return respond(
        NextResponse.json({ error: 'suppressed' }, { status: 409 })
      )
    }
    if (!result.error) {
      // console fallback — dev environment with no Resend config.
      reqLog.warn(
        { provider: result.provider, venueId: targetVenueId, targetUserId },
        'admin.digest_send.console_fallback'
      )
      return respond(
        NextResponse.json({
          success: false,
          sent: false,
          reason: 'console_fallback',
          venue_id: targetVenueId,
          recipient_user_id: targetUserId,
          event_count: agg.total,
          cadence: pref.cadence,
          weekly_day: pref.weeklyDay,
          send_kind: 'manual' as const,
        })
      )
    }
    reqLog.error(
      {
        provider: result.provider,
        errorMessage: result.error,
        venueId: targetVenueId,
        targetUserId,
      },
      'admin.digest_send.send_failed'
    )
    captureApiError(new Error(result.error), {
      requestId,
      route: '/api/admin/digest/send',
      userId: user.id,
      venueId: targetVenueId,
    })
    return respond(NextResponse.json({ error: 'email_failed' }, { status: 500 }))
  }

  reqLog.info(
    {
      initiatorUserId: user.id,
      targetUserId,
      venueId: targetVenueId,
      provider: result.provider,
      messageId: result.messageId,
      eventCount: agg.total,
      cadence: pref.cadence,
      weeklyDay: pref.weeklyDay,
      respectCadence,
    },
    'admin.digest_send.sent'
  )

  // PII posture: only echo target email back when the caller IS the
  // target. Cross-user manual sends return `sent_to: null` so an admin
  // can't enumerate other admins' email addresses through this surface.
  const sentToEcho = targetUserId === user.id ? targetEmail : null

  void recordAuditEvent({
    venueId: targetVenueId,
    actorUserId: user.id,
    actorKind: 'operator',
    route: '/api/admin/digest/send',
    action: 'digest_manual_send',
    targetTable: 'venue_member_digest_preferences',
    targetId: targetUserId,
    requestId,
    ip: request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
    userAgent: request.headers.get('user-agent'),
    metadata: {
      cadence: pref.cadence,
      weekly_day: pref.weeklyDay,
      event_count: agg.total,
      send_kind: 'manual',
      respect_cadence: respectCadence,
      cross_user: targetUserId !== user.id,
    },
  })

  return respond(
    NextResponse.json({
      success: true,
      sent: true,
      venue_id: targetVenueId,
      recipient_user_id: targetUserId,
      sent_to: sentToEcho,
      event_count: agg.total,
      cadence: pref.cadence,
      weekly_day: pref.weeklyDay,
      send_kind: 'manual' as const,
    })
  )
}
