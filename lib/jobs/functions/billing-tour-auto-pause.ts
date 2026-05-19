import 'server-only'
import { inngest } from '../client'
import { createServiceClient } from '@/lib/supabase/service'
import { recordTourStatusEvent } from '@/lib/integrations/tour-status-events'
import { log } from '@/lib/log'
import { captureJobError } from '@/lib/observability/sentry'

/**
 * Phase 8F — past-due tour auto-pause cron.
 * Phase 8H — re-arm after recovery + history archive.
 *
 * Daily at 6pm UTC. For every venue whose subscription has been `past_due`
 * for more than 7 days AND is not already paused for the CURRENT past-due
 * window, we:
 *   1. Cancel every future `scheduled|confirmed` tour for that venue
 *      (we never touch completed / cancelled / no_show / past rows).
 *   2. If the subscription metadata has a stale pause/resume pair from a
 *      PRIOR past-due window, archive it into `metadata.tour_pause_history`
 *      so the timeline of "paused on X, recovered on Y, paused again on Z"
 *      stays readable forever (Phase 8H).
 *   3. Stamp `subscriptions.metadata` with `tours_paused_at`,
 *      `tours_paused_reason='past_due_7_days'`, and `tours_paused_count`.
 *      Clears any stale `tours_resumed_at` / `tours_resumed_reason` so
 *      the dashboard banner accurately reflects the new pause.
 *
 * ── PAUSE/RESUME LIFECYCLE ────────────────────────────────────────────────
 * After Phase 8G, the Stripe dispatcher stamps `tours_resumed_at` on
 * past_due → active/trialing. After Phase 8H, the cron uses that signal
 * to decide whether a venue's existing `tours_paused_at` belongs to the
 * CURRENT past-due window (skip — already handled) or a PRIOR one
 * (re-arm — recovered, then lapsed again).
 *
 * Decision rule (`isPausedForCurrentWindow`):
 *   - No `tours_paused_at`         → not paused. Eligible for first pause.
 *   - `tours_paused_at`, no resume → currently paused. Skip.
 *   - Both stamped, resume <  current_period_end → stale pair. Re-arm.
 *   - Both stamped, resume >= current_period_end → still paused. Skip.
 *
 * `current_period_end` is the anchor for the current past-due window —
 * when an invoice for the period ending at that timestamp went unpaid,
 * Stripe flipped status to `past_due`. A resume timestamp BEFORE that
 * point belongs to a prior cycle; a resume AT OR AFTER belongs to (or
 * post-dates) the current one.
 *
 * ── METADATA SHAPE (post-Phase 8H) ────────────────────────────────────────
 *   {
 *     tours_paused_at:       string  (ISO timestamp, current pause)
 *     tours_paused_reason:   string  (always 'past_due_7_days')
 *     tours_paused_count:    number  (cancelled this round)
 *     tours_resumed_at?:     string  (cleared on re-arm; re-stamped on recovery)
 *     tours_resumed_reason?: string  (cleared on re-arm)
 *     tour_pause_history?:   Array<{
 *       paused_at, resumed_at, paused_reason, resumed_reason,
 *       paused_count, archived_at
 *     }>
 *   }
 *
 * History is append-only. We never trim it — past_due cycles are rare
 * (handful per year per venue at the extreme), so unbounded growth is
 * a non-issue for the foreseeable future.
 *
 * ── IDEMPOTENCY ────────────────────────────────────────────────────────────
 * Running the cron twice in the same past-due window is a no-op:
 *   - first run stamps `tours_paused_at` (no resume yet)
 *   - second run sees `isPausedForCurrentWindow` → true → skip
 * Running after a recovery and later lapse archives the prior pair
 * EXACTLY once because once we stamp the new pause, the new
 * `tours_paused_at` overwrites the old AND `tours_resumed_at` is
 * cleared — the next run finds "paused, no resume" and skips.
 *
 * ── METADATA WRITE STRATEGY ───────────────────────────────────────────────
 * Direct service-role `UPDATE` (no Phase 7L array RPC). Scalar fields
 * + a single jsonb array append; we re-read metadata at the top of each
 * per-venue iteration so two crons running back-to-back can't double-
 * archive. The webhook-vs-cron race window is narrow and self-heals on
 * the next nightly run.
 *
 * ── LOGGING POSTURE ───────────────────────────────────────────────────────
 *   - No raw emails / lead names / tour notes in log lines.
 *   - venueId, subscriptionId, periodEnd, cancelled count — no PII.
 *   - Per-venue failures don't abort the batch; Sentry-captured + the
 *     loop continues so one bad venue can't block the rest.
 */

const SCHEDULE = '0 18 * * *' // daily 6pm UTC
const BATCH_LIMIT = 200
const GRACE_DAYS = 7
const PAUSED_REASON = 'past_due_7_days' as const

const MS_DAY = 24 * 60 * 60 * 1000

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SubscriptionRow {
  id: string
  venue_id: string
  status: string
  current_period_end: string | null
  metadata: Record<string, unknown> | null
}

interface RunSummary {
  scanned: number
  paused: number
  rearmed: number
  cancelled_tours: number
  skipped: number
  failed: number
  // Phase 8M — non-fatal counter for unified status-event audit misses.
  // Incremented when an audit insert fails for a tour we already cancelled.
  // Does NOT count toward `failed` (the cron's primary action still
  // succeeded); operators monitor it separately.
  audit_failed: number
}

interface TourPauseHistoryEntry {
  paused_at: string
  resumed_at: string
  paused_reason: string | null
  resumed_reason: string | null
  paused_count: number | null
  archived_at: string
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Phase 8H — replaces the old `alreadyPaused()` check with a window-aware
 * version. See the header comment for the decision rule.
 *
 * Exported for unit tests + RUNBOOK §7 SQL companion examples.
 */
function isPausedForCurrentWindow(
  metadata: Record<string, unknown> | null,
  currentPeriodEnd: string | null
): boolean {
  if (!metadata) return false
  const pausedAt =
    typeof metadata.tours_paused_at === 'string' ? metadata.tours_paused_at : null
  if (!pausedAt) return false
  const resumedAt =
    typeof metadata.tours_resumed_at === 'string' ? metadata.tours_resumed_at : null
  if (!resumedAt) return true

  // We have both pause + resume. Was the resume during/after this period?
  // If we can't parse either timestamp, fall back to "still paused" — the
  // cost of skipping a re-pause is one extra day of cancelled tours; the
  // cost of double-archiving is a corrupt history. We bias toward skip.
  if (!currentPeriodEnd) return true
  const resumedTime = new Date(resumedAt).getTime()
  const periodEndTime = new Date(currentPeriodEnd).getTime()
  if (!Number.isFinite(resumedTime) || !Number.isFinite(periodEndTime)) return true

  return resumedTime >= periodEndTime
}

/**
 * Phase 8F — kept for backward compatibility (was exported in Phase 8F).
 * Anyone calling this externally gets the pre-8H "any pause => paused"
 * semantics; Phase 8H code uses isPausedForCurrentWindow() instead.
 */
function alreadyPaused(metadata: Record<string, unknown> | null): boolean {
  if (!metadata) return false
  const v = (metadata as { tours_paused_at?: unknown }).tours_paused_at
  return typeof v === 'string' && v.length > 0
}

/**
 * Phase 8H — extract a complete prior pause/resume pair from metadata
 * so the cron can archive it into `tour_pause_history` before stamping
 * a fresh pause. Returns null if either timestamp is missing (no prior
 * cycle to archive — first ever pause).
 */
function extractPriorPausePair(
  metadata: Record<string, unknown> | null
): TourPauseHistoryEntry | null {
  if (!metadata) return null
  const pausedAt =
    typeof metadata.tours_paused_at === 'string' ? metadata.tours_paused_at : null
  const resumedAt =
    typeof metadata.tours_resumed_at === 'string' ? metadata.tours_resumed_at : null
  if (!pausedAt || !resumedAt) return null
  const pausedReason =
    typeof metadata.tours_paused_reason === 'string'
      ? metadata.tours_paused_reason
      : null
  const resumedReason =
    typeof metadata.tours_resumed_reason === 'string'
      ? metadata.tours_resumed_reason
      : null
  const pausedCount =
    typeof metadata.tours_paused_count === 'number'
      ? metadata.tours_paused_count
      : null
  return {
    paused_at: pausedAt,
    resumed_at: resumedAt,
    paused_reason: pausedReason,
    resumed_reason: resumedReason,
    paused_count: pausedCount,
    archived_at: new Date().toISOString(),
  }
}

/**
 * Phase 8H — compute the next metadata object given the prior metadata,
 * the (optional) archive entry, and the fresh pause stamp. Clears the
 * resume keys so the dashboard banner accurately reflects the new
 * pause. Appends archive entry to `tour_pause_history` if provided.
 *
 * Pure function — no I/O — so it's easy to unit test the metadata
 * transition logic independently of Supabase.
 */
function buildPausedMetadata(
  existing: Record<string, unknown> | null,
  cancelledCount: number,
  pausedAtIso: string,
  archive: TourPauseHistoryEntry | null
): Record<string, unknown> {
  const base = { ...((existing ?? {}) as Record<string, unknown>) }

  // Archive the prior cycle BEFORE clearing the resume keys so the new
  // pause metadata is internally consistent (no orphaned resume marker).
  if (archive) {
    const priorHistory = Array.isArray(base.tour_pause_history)
      ? (base.tour_pause_history as unknown[])
      : []
    base.tour_pause_history = [...priorHistory, archive]
  }

  // Clear stale resume markers so isPausedForCurrentWindow on the NEXT
  // run sees "paused with no resume" → still paused → skip (no double-
  // archive).
  delete base.tours_resumed_at
  delete base.tours_resumed_reason

  return {
    ...base,
    tours_paused_at: pausedAtIso,
    tours_paused_reason: PAUSED_REASON,
    tours_paused_count: cancelledCount,
  }
}

// ---------------------------------------------------------------------------
// Core run
// ---------------------------------------------------------------------------

async function runAutoPauseScan(): Promise<RunSummary> {
  const summary: RunSummary = {
    scanned: 0,
    paused: 0,
    rearmed: 0,
    cancelled_tours: 0,
    skipped: 0,
    failed: 0,
    audit_failed: 0,
  }
  const supabase = createServiceClient()
  const now = new Date()
  const cutoff = new Date(now.getTime() - GRACE_DAYS * MS_DAY)

  log.info(
    { schedule: SCHEDULE, graceDays: GRACE_DAYS, cutoff: cutoff.toISOString() },
    'jobs.billing_tour_auto_pause.scan_start'
  )

  const { data, error } = await supabase
    .from('subscriptions')
    .select('id, venue_id, status, current_period_end, metadata')
    .eq('status', 'past_due')
    .not('current_period_end', 'is', null)
    .lt('current_period_end', cutoff.toISOString())
    .order('current_period_end', { ascending: true })
    .limit(BATCH_LIMIT)

  if (error) {
    log.error(
      { errorMessage: error.message },
      'jobs.billing_tour_auto_pause.candidate_query_failed'
    )
    captureJobError('billing-tour-auto-pause', error, {})
    throw new Error(`tour auto-pause candidate query failed: ${error.message}`)
  }

  const rows = (data ?? []) as SubscriptionRow[]
  summary.scanned = rows.length

  for (const sub of rows) {
    if (sub.status !== 'past_due') {
      // Defense in depth — guard against mid-batch flips.
      summary.skipped++
      continue
    }

    const subLog = log.child({
      venueId: sub.venue_id,
      subscriptionId: sub.id,
      periodEnd: sub.current_period_end,
      op: 'jobs.billing_tour_auto_pause.process',
    })

    // Phase 8H — window-aware pause check. If the existing pause belongs
    // to the CURRENT past-due window, skip. If it belongs to a PRIOR
    // window (venue recovered then lapsed again), fall through to the
    // pause flow which will archive the prior pair.
    if (isPausedForCurrentWindow(sub.metadata, sub.current_period_end)) {
      subLog.info({}, 'jobs.billing_tour_auto_pause.already_paused_current_window')
      summary.skipped++
      continue
    }

    // Identify whether this is a fresh pause or a re-arm (for telemetry +
    // logging — the actual metadata write handles both via the archive arg).
    const archive = extractPriorPausePair(sub.metadata)
    const isRearm = archive !== null

    // Cancel future scheduled/confirmed tours. Phase 8M: we pre-fetch
    // the candidate rows (id + lead_id + status) BEFORE the UPDATE so
    // we can record `previous_status` + `lead_id` in the audit feed
    // per cancelled tour. The UPDATE re-asserts the eligible status set
    // to avoid clobbering rows that flipped between SELECT + UPDATE.
    let cancelledCount = 0
    let auditRows: Array<{ id: string; lead_id: string | null; status: string }> = []
    try {
      const { data: candidatesRaw, error: candErr } = await supabase
        .from('tours')
        .select('id, lead_id, status')
        .eq('venue_id', sub.venue_id)
        .in('status', ['scheduled', 'confirmed'])
        .gt('scheduled_at', now.toISOString())

      if (candErr) {
        subLog.error({ err: candErr }, 'jobs.billing_tour_auto_pause.candidate_query_failed_per_venue')
        captureJobError('billing-tour-auto-pause', candErr, { venueId: sub.venue_id })
        summary.failed++
        continue
      }

      const candidates =
        ((candidatesRaw ?? []) as Array<{
          id: string
          lead_id: string | null
          status: string
        }>)

      if (candidates.length === 0) {
        // No future tours to cancel. We still want the pause stamp to
        // land (count = 0) so the banner reflects "billing paused" even
        // when no actual cancellations were needed.
        cancelledCount = 0
        auditRows = []
      } else {
        const ids = candidates.map((c) => c.id)
        const { data: cancelledRaw, error: cancelErr } = await supabase
          .from('tours')
          .update({ status: 'cancelled' })
          .in('id', ids)
          .in('status', ['scheduled', 'confirmed'])
          .gt('scheduled_at', now.toISOString())
          .select('id')

        if (cancelErr) {
          subLog.error({ err: cancelErr }, 'jobs.billing_tour_auto_pause.cancel_failed')
          captureJobError('billing-tour-auto-pause', cancelErr, { venueId: sub.venue_id })
          summary.failed++
          continue
        }
        const cancelledIds = new Set(
          ((cancelledRaw ?? []) as Array<{ id: string }>).map((r) => r.id)
        )
        cancelledCount = cancelledIds.size
        auditRows = candidates.filter((c) => cancelledIds.has(c.id))
      }
    } catch (err) {
      subLog.error({ err }, 'jobs.billing_tour_auto_pause.cancel_threw')
      captureJobError('billing-tour-auto-pause', err, { venueId: sub.venue_id })
      summary.failed++
      continue
    }

    const pausedAtIso = new Date().toISOString()
    const nextMetadata = buildPausedMetadata(
      sub.metadata,
      cancelledCount,
      pausedAtIso,
      archive
    )

    if (archive) {
      subLog.info(
        {
          archivedPausedAt: archive.paused_at,
          archivedResumedAt: archive.resumed_at,
          archivedPausedCount: archive.paused_count,
        },
        'jobs.billing_tour_auto_pause.history_archived'
      )
    }

    const { error: metaErr } = await supabase
      .from('subscriptions')
      .update({ metadata: nextMetadata })
      .eq('id', sub.id)

    if (metaErr) {
      subLog.error(
        { err: metaErr, cancelledCount, isRearm },
        'jobs.billing_tour_auto_pause.metadata_write_failed'
      )
      captureJobError('billing-tour-auto-pause', metaErr, { venueId: sub.venue_id })
      // We already cancelled the tours; mark failed so the next run
      // re-attempts the metadata stamp. The re-arm guard
      // (isPausedForCurrentWindow) handles the retry correctly because
      // the stale `tours_resumed_at` would still be present.
      summary.failed++
      continue
    }

    if (isRearm) {
      subLog.info(
        { cancelledCount, pausedAtIso },
        'jobs.billing_tour_auto_pause.rearmed'
      )
      summary.rearmed++
    } else {
      subLog.info(
        { cancelledCount, pausedAtIso },
        'jobs.billing_tour_auto_pause.paused'
      )
    }
    summary.paused++

    // Phase 8M — write one unified status-event audit row per cancelled
    // tour. Sequential (not parallel) because typical past-due venues
    // have a small handful of future tours; the overhead is negligible
    // and serial calls keep error attribution simple in logs. Audit
    // failures are non-fatal and surface in `summary.audit_failed`.
    for (const row of auditRows) {
      const result = await recordTourStatusEvent({
        venueId: sub.venue_id,
        tourId: row.id,
        leadId: row.lead_id,
        actorKind: 'cron',
        actorId: 'billing-tour-auto-pause',
        action: 'auto_pause_cancel',
        previousStatus: row.status,
        newStatus: 'cancelled',
        reason: 'past_due_7_days',
        metadata: {
          subscription_id: sub.id,
          current_period_end: sub.current_period_end,
          tours_paused_at: pausedAtIso,
          auto_pause_run: true,
          rearm: isRearm,
        },
      })
      if (!result.ok) {
        // Already logged + Sentry-captured inside the helper. We just
        // count it here so the run summary surfaces a non-zero value
        // for operators to spot a pattern across runs.
        summary.audit_failed++
      }
    }
    summary.cancelled_tours += cancelledCount
  }

  log.info(summary, 'jobs.billing_tour_auto_pause.scan_complete')
  return summary
}

// ---------------------------------------------------------------------------
// Inngest binding
// ---------------------------------------------------------------------------

export const billingTourAutoPauseFn = inngest.createFunction(
  {
    id: 'billing-tour-auto-pause',
    name: 'Past-due tour auto-pause (daily, 7-day grace, re-arm aware)',
    retries: 1,
    triggers: [{ cron: SCHEDULE }],
  },
  async () => runAutoPauseScan()
)

// Exported for unit tests + manual reruns.
export {
  runAutoPauseScan,
  alreadyPaused,
  isPausedForCurrentWindow,
  extractPriorPausePair,
  buildPausedMetadata,
}
