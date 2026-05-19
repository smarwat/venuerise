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
import { sendEmail } from '@/lib/integrations/email'
import {
  aggregateEvents,
  buildOperatorDigestText,
  buildOperatorDigestHtml,
  tryBuildUnsubscribeUrl,
  tryBuildResubscribeUrl,
} from '@/lib/jobs/functions/operator-activity-digest'
import { resolveEffectiveDigestPreference } from '@/lib/billing/operator-digest-preferences'
import { recordDigestAuditEvent } from '@/lib/billing/digest-audit-events'

/**
 * Phase 8AE — preview audit env gate. Reuses
 * `DIGEST_AUDIT_LOG_CRON_SENDS` so operators only manage one flag for
 * "log every per-recipient digest send into digest_audit_events". The
 * preview branch deliberately rides the cron flag rather than
 * introducing a separate `DIGEST_AUDIT_LOG_PREVIEW_SENDS` so the
 * audit-row volume profile stays predictable: both paths log only
 * when the operator opts in.
 */
function cronAuditEnabled(): boolean {
  return process.env.DIGEST_AUDIT_LOG_CRON_SENDS === '1'
}

/** Local masker mirroring the Phase 8Y / 8AD shape — never throws. */
function maskEmail(addr: string | null | undefined): string | null {
  if (!addr || typeof addr !== 'string') return null
  const at = addr.indexOf('@')
  if (at < 1) return null
  return `${addr.slice(0, 1)}***${addr.slice(at)}`
}

/**
 * POST /api/admin/digest/preview  (Phase 8V)
 *
 * Operator escape hatch — sends the caller a sample digest email
 * RIGHT NOW so they can verify cadence / template / formatting without
 * waiting for the next 8am UTC cron tick.
 *
 * ── HOW IT DIFFERS FROM THE CRON ──────────────────────────────────────────
 *   - Fan-out to ONE recipient only (the calling user, via their auth
 *     email).
 *   - Bypasses the cadence check: even cadence='off' or weekly-on-non-
 *     Monday users get the preview.
 *   - Bypasses the per-recipient idempotency probe: an operator can hit
 *     this multiple times in one day without "already sent today"
 *     blocking the click.
 *   - Tags the outbound row with `metadata.tour_digest_preview = true`
 *     so the real cron's idempotency probe IGNORES it on the next
 *     scheduled run. The cron probes for
 *     `metadata->>tour_digest_recipient_user_id = <user>` AND
 *     `metadata->>tour_digest_date = <today>` — the preview shares
 *     those keys, so we explicitly add a separate `is_preview` marker
 *     the cron can filter out.
 *
 *     Actually a cleaner story: the cron's probe uses `=` on the marker
 *     fields it ALSO writes, but it does not check for absence of
 *     `tour_digest_preview`. So a preview WOULD trigger the dedup. We
 *     fix this by NOT writing `tour_digest_recipient_user_id` on the
 *     preview row — see metadata block below.
 *
 * ── PII POSTURE ───────────────────────────────────────────────────────────
 *   - Returns the caller's own email in `sent_to` so they can confirm
 *     delivery target. NOT cross-tenant — only the authenticated user's
 *     own email ever appears in the response.
 *   - `X-Request-Id` set on every response via the standard `respond()`
 *     wrapper.
 *
 * ── BILLING / RATE LIMIT ──────────────────────────────────────────────────
 *   - Hard-rate-limited per caller via `admin:digest-preview:{userId}`.
 *     A misclick or QA loop shouldn't blow past Resend's budget.
 *   - OPERATOR_DIGEST_ENABLED is NOT required — the preview is operator-
 *     initiated, not part of the cron's policy gate.
 *   - DIGEST_UNSUBSCRIBE_SECRET is optional; the email body links
 *     gracefully when present (preview shows the venue-level link the
 *     real digest would include) and omits otherwise.
 */

const BodySchema = z.object({
  venue_id: z.string().uuid().optional(),
})

const LOOKBACK_HOURS = 24

export async function POST(request: NextRequest): Promise<Response> {
  const requestId = getOrCreateRequestId(request)
  const reqLog = log.child({
    requestId,
    route: '/api/admin/digest/preview',
    op: 'admin.digest_preview',
  })
  const respond = <T extends Response>(r: T) => withRequestIdHeader(r, requestId)

  // 1. Auth.
  const admin = await requireAdmin()
  if (!admin.ok) {
    return respond(NextResponse.json({ error: admin.code }, { status: admin.status }))
  }
  const { user, venueId: callerVenueId } = admin

  if (!user.email || user.email.length === 0) {
    // requireAdmin already enforces a real session, but auth.users.email
    // is nullable in Supabase. A user without a verified email can't
    // receive a preview — return a friendly 422 so the UI can surface
    // the actionable fix rather than a generic 500.
    reqLog.info({ userId: user.id }, 'admin.digest_preview.no_caller_email')
    return respond(
      NextResponse.json({ error: 'no_email_on_account' }, { status: 422 })
    )
  }

  // 2. Rate limit per caller.
  const rl = await rateLimitUserAction(request, `admin:digest-preview:${user.id}`)
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
  const { venue_id: bodyVenueId } = parsed.data

  // 4. Resolve target venue + tenant bind. Mirror the rest of the
  // admin surface: cross-tenant requires ADMIN_ROLES on the target;
  // forbidden collapses to 404 so admins can't enumerate venues.
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

  // 5. Aggregate the last 24h of events. Same shape as the cron;
  // single-venue narrow read so a tiny demo venue isn't slow.
  const svc = createServiceClient()
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
      'admin.digest_preview.events_query_failed'
    )
    captureApiError(eventsErr, {
      requestId,
      route: '/api/admin/digest/preview',
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
  // Even with zero events, we still send the preview — it lets
  // operators confirm template + cadence rendering on quiet days.
  // `aggregateEvents` returns an empty map on zero events; we fall
  // through to the empty-state aggregate.
  const agg =
    byVenue.get(targetVenueId) ?? { total: 0, byAction: {}, byActor: {} }

  // 6. Resolve effective preference for THIS user so the preview
  // matches what they'd actually receive on schedule. Parallel reads
  // mirror the GET preferences route — keeps per-page latency low.
  const [memberRes, subRes, venueRes] = await Promise.all([
    svc
      .from('venue_members')
      .select('metadata')
      .eq('venue_id', targetVenueId)
      .eq('user_id', user.id)
      .maybeSingle(),
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

  const memberMetadata =
    (memberRes.data as { metadata?: Record<string, unknown> | null } | null)?.metadata ?? null
  const subscriptionMetadata =
    (subRes.data as { metadata?: Record<string, unknown> | null } | null)?.metadata ?? null
  const venueName = (venueRes.data as { name?: string | null } | null)?.name ?? null

  const pref = resolveEffectiveDigestPreference({
    memberMetadata,
    subscriptionMetadata,
  })

  // 7. Build the email.
  //
  // Phase 8V → 8X — the body builder renders the same template the
  // cron would, including the cadence footer. As of Phase 8X the
  // preview INCLUDES both unsubscribe + resubscribe footer links so
  // the operator can QA the full preference loop in one click. The
  // links are omitted automatically when DIGEST_UNSUBSCRIBE_SECRET is
  // missing (the once-per-process warn fires inside the URL helpers).
  const appUrl = (process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000').replace(
    /\/$/,
    ''
  )
  const unsubscribeUrl = tryBuildUnsubscribeUrl(targetVenueId)
  const resubscribeUrl = tryBuildResubscribeUrl(targetVenueId, user.id)
  const bodyArgs = {
    venueName,
    venueId: targetVenueId,
    agg,
    appUrl,
    unsubscribeUrl,
    resubscribeUrl,
    cadence: pref.cadence,
    weeklyDay: pref.weeklyDay,
    sendKind: 'preview' as const,
  }
  const text = buildOperatorDigestText(bodyArgs)
  const html = buildOperatorDigestHtml(bodyArgs)

  // 8. Send. We deliberately do NOT include
  // `tour_digest_recipient_user_id` in the outbound metadata — that
  // marker is the cron's per-recipient idempotency key, and including
  // it would make tomorrow's cron think the user already received
  // today's digest.
  //
  // Phase 8W — the canonical "this was a preview" signal is now
  // `tour_digest_send_kind = 'preview'`. The legacy
  // `tour_digest_preview = 'true'` marker stays for one release cycle
  // so any audit query built between Phase 8V and 8W continues to find
  // preview rows.
  let result
  try {
    result = await sendEmail({
      to: user.email,
      subject: 'VenueRise daily activity summary (preview)',
      text,
      html,
      venueId: targetVenueId,
      relatedTable: 'tour_status_events',
      metadata: {
        tour_digest_preview: 'true',
        tour_digest_preview_user_id: user.id,
        tour_digest_cadence: pref.cadence,
        tour_digest_weekly_day: pref.weeklyDay ?? '',
        tour_digest_total: String(agg.total),
        // Phase 8W — explicit discriminator. The cron's per-recipient
        // idempotency probe filters on `send_kind = 'cron'`, so a
        // preview row tagged 'preview' here can NEVER block the next
        // 8am UTC scheduled digest. Future-proofs against a 'manual'
        // operator-send kind.
        tour_digest_send_kind: 'preview',
      },
    })
  } catch (err) {
    reqLog.error({ err, venueId: targetVenueId }, 'admin.digest_preview.send_threw')
    captureApiError(err, {
      requestId,
      route: '/api/admin/digest/preview',
      userId: user.id,
      venueId: targetVenueId,
    })
    return respond(NextResponse.json({ error: 'email_failed' }, { status: 500 }))
  }

  if (!result.delivered) {
    // Suppression / console-fallback / provider error. Console
    // fallback is a dev-only "Resend isn't configured" state; we
    // surface it cleanly so the operator knows the preview was
    // logged but not delivered.
    if (result.error?.startsWith('suppressed:')) {
      reqLog.warn(
        { reason: result.error, venueId: targetVenueId },
        'admin.digest_preview.suppressed'
      )
      return respond(
        NextResponse.json({ error: 'suppressed' }, { status: 409 })
      )
    }
    if (!result.error) {
      // console fallback in dev — return 200 with a clear preview flag.
      reqLog.warn(
        { provider: result.provider, venueId: targetVenueId },
        'admin.digest_preview.console_fallback'
      )
      return respond(
        NextResponse.json({
          success: false,
          reason: 'console_fallback',
          venue_id: targetVenueId,
          sent_to: user.email,
          event_count: agg.total,
          cadence: pref.cadence,
          weekly_day: pref.weeklyDay,
        })
      )
    }
    // Real provider error.
    reqLog.error(
      { provider: result.provider, errorMessage: result.error, venueId: targetVenueId },
      'admin.digest_preview.send_failed'
    )
    captureApiError(new Error(result.error), {
      requestId,
      route: '/api/admin/digest/preview',
      userId: user.id,
      venueId: targetVenueId,
    })
    return respond(NextResponse.json({ error: 'email_failed' }, { status: 500 }))
  }

  reqLog.info(
    {
      userId: user.id,
      venueId: targetVenueId,
      provider: result.provider,
      messageId: result.messageId,
      eventCount: agg.total,
      cadence: pref.cadence,
      weeklyDay: pref.weeklyDay,
    },
    'admin.digest_preview.sent'
  )

  // Phase 8AE — optional preview audit row. Gated by the same
  // DIGEST_AUDIT_LOG_CRON_SENDS env flag as per-recipient cron sends
  // (Phase 8AD) so operators flip one knob to get "every per-
  // recipient digest send is auditable". Best-effort write:
  // recordDigestAuditEvent never throws, so a failure here cannot
  // turn a successful preview into a 5xx.
  //
  // Only fires after the email was accepted/queued — failure /
  // suppression / console-fallback branches above return without
  // reaching this code path.
  if (cronAuditEnabled()) {
    await recordDigestAuditEvent({
      venueId: targetVenueId,
      actorKind: 'operator',
      actorUserId: user.id,
      action: 'digest_send_preview',
      targetUserId: user.id,
      targetEmailMasked: maskEmail(user.email),
      metadata: {
        venue_id: targetVenueId,
        event_count: agg.total,
        cadence: pref.cadence,
        weekly_day: pref.weeklyDay ?? null,
        outbound_message_id: result.outboundMessageId ?? null,
        send_kind: 'preview',
      },
      requestId,
    })
  }

  return respond(
    NextResponse.json({
      success: true,
      venue_id: targetVenueId,
      sent_to: user.email,
      event_count: agg.total,
      cadence: pref.cadence,
      weekly_day: pref.weeklyDay,
    })
  )
}
