import 'server-only'
import { createServiceClient } from '@/lib/supabase/service'
import { log } from '@/lib/log'
import { captureApiError } from '@/lib/observability/sentry'

/**
 * Phase 8M — unified tour-status audit writer.
 *
 * Every code path that changes a tour's `status` (or, in the operator
 * PATCH case, the `scheduled_at` slot) calls this helper to append a
 * single row to `public.tour_status_events`. The table is the SOURCE OF
 * TRUTH for the question "who changed this tour, when, from what to
 * what, and through which path?".
 *
 * ── COEXISTS WITH `tour_action_events` ────────────────────────────────────
 * Phase 8L's `tour_action_events` table (migration 012) keeps the
 * single-use claim for the public confirm/cancel handler — the unique
 * (tour_id, token_nonce) constraint is the atomic replay defeat. This
 * table (`tour_status_events`, migration 013) is the wider audit feed.
 * Lead-token actions write to BOTH tables for one release cycle to give
 * operators time to migrate dashboards off the old admin endpoint.
 *
 * ── CONTRACT ──────────────────────────────────────────────────────────────
 *   - Never throws. Always resolves with `{ ok: true | false, ... }`.
 *   - Service-role write so it works equally from public routes (no
 *     session) and cron jobs (no session).
 *   - Unexpected DB failures Sentry-captured and structured-logged.
 *   - `metadata` is inserted as-is (defaults to `{}`); callers should
 *     keep PII out of it (the admin endpoint spreads it directly into
 *     the response).
 *   - `user_agent` is truncated to 120 chars in LOG lines (the column
 *     itself accepts whatever the caller passes — usually already capped
 *     at 500 by the route handler boundary).
 *   - Never logs the full `metadata` blob — only its key list.
 *
 * ── CALLER RESPONSIBILITIES ───────────────────────────────────────────────
 *   - Mask `sourceIp` BEFORE calling. We assume the caller already used
 *     `maskIp()` from `tour-action-token.ts` or equivalent. The DB never
 *     sees the raw IP.
 *   - Cap `userAgent` at the route boundary. We don't re-truncate on
 *     write, only on log emission.
 *   - Wrap calls in `.catch(() => {})` if they're fire-and-forget — the
 *     helper already swallows internally, but defensive belt-and-suspenders
 *     prevents an unhandled rejection if a future refactor adds an
 *     uncaught throw.
 */

export type TourStatusActorKind = 'lead_token' | 'operator' | 'cron' | 'system'

export interface RecordTourStatusEventArgs {
  venueId: string
  tourId: string
  leadId?: string | null
  actorKind: TourStatusActorKind
  actorId?: string | null
  action: string
  previousStatus?: string | null
  newStatus: string
  sourceIp?: string | null
  userAgent?: string | null
  reason?: string | null
  metadata?: Record<string, unknown>
  requestId?: string
}

export type RecordTourStatusEventResult =
  | { ok: true; id: string | null }
  | { ok: false; error: string }

function truncateForLog(s: string | null | undefined, max: number): string | null {
  if (s == null) return null
  if (s.length <= max) return s
  return `${s.slice(0, max)}…`
}

export async function recordTourStatusEvent(
  args: RecordTourStatusEventArgs
): Promise<RecordTourStatusEventResult> {
  const reqLog = log.child({
    requestId: args.requestId,
    venueId: args.venueId,
    tourId: args.tourId,
    leadId: args.leadId ?? null,
    actorKind: args.actorKind,
    actorId: args.actorId ?? null,
    action: args.action,
    op: 'tour.status_event',
  })

  // We deliberately don't log the full metadata blob — only its keys.
  // The admin endpoint surfaces metadata to callers; we don't want a
  // leaked log to also leak the same data.
  const metadataKeys = args.metadata ? Object.keys(args.metadata) : []
  const uaForLog = truncateForLog(args.userAgent, 120)

  try {
    const svc = createServiceClient()
    const { data, error } = await svc
      .from('tour_status_events')
      .insert({
        venue_id: args.venueId,
        tour_id: args.tourId,
        lead_id: args.leadId ?? null,
        actor_kind: args.actorKind,
        actor_id: args.actorId ?? null,
        action: args.action,
        previous_status: args.previousStatus ?? null,
        new_status: args.newStatus,
        source_ip: args.sourceIp ?? null,
        user_agent: args.userAgent ?? null,
        reason: args.reason ?? null,
        metadata: args.metadata ?? {},
      })
      .select('id')
      .maybeSingle()

    if (error) {
      reqLog.error(
        {
          err: error,
          previousStatus: args.previousStatus ?? null,
          newStatus: args.newStatus,
          metadataKeys,
          userAgent: uaForLog,
        },
        'tour.status_event.insert_failed'
      )
      captureApiError(error, {
        requestId: args.requestId,
        route: 'lib.recordTourStatusEvent',
        venueId: args.venueId,
        leadId: args.leadId ?? undefined,
      })
      return { ok: false, error: error.message }
    }

    const id = (data as { id?: string } | null)?.id ?? null
    reqLog.info(
      {
        statusEventId: id,
        previousStatus: args.previousStatus ?? null,
        newStatus: args.newStatus,
        metadataKeys,
        userAgent: uaForLog,
      },
      'tour.status_event.recorded'
    )
    return { ok: true, id }
  } catch (err) {
    // Catastrophic path (createServiceClient threw, network blew up, etc).
    // Never bubble out of this helper — the caller is always writing to
    // an audit feed, never to a user-visible action surface.
    reqLog.error({ err, metadataKeys, userAgent: uaForLog }, 'tour.status_event.threw')
    captureApiError(err, {
      requestId: args.requestId,
      route: 'lib.recordTourStatusEvent',
      venueId: args.venueId,
      leadId: args.leadId ?? undefined,
    })
    return { ok: false, error: err instanceof Error ? err.message : 'unknown' }
  }
}
