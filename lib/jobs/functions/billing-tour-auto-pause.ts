import 'server-only'
import { inngest } from '../client'
import { createServiceClient } from '@/lib/supabase/service'
import { log } from '@/lib/log'
import { captureJobError } from '@/lib/observability/sentry'

/**
 * Phase 8F — past-due tour auto-pause cron.
 *
 * Daily at 6pm UTC. For every venue whose subscription has been `past_due`
 * for more than 7 days AND has not already been paused, we:
 *   1. Cancel every future `scheduled|confirmed` tour for that venue
 *      (we never touch completed / cancelled / no_show / past rows).
 *   2. Stamp `subscriptions.metadata` with `tours_paused_at`,
 *      `tours_paused_reason='past_due_7_days'`, and `tours_paused_count`.
 *
 * ── DESIGN ─────────────────────────────────────────────────────────────────
 * Idempotency: the candidate query excludes any subscription that already
 * has `metadata.tours_paused_at` set. So a second run on the same day is a
 * no-op for already-paused venues. If billing recovers (status flips away
 * from past_due), a future operator-initiated reset can clear the metadata
 * flags — out of scope for this phase.
 *
 * 7-day grace: we read `current_period_end` and require it to be at least
 * 7 full days in the past. This matches the dunning cron's 3-attempt
 * cadence — by the time we get here, the venue has already received their
 * full sequence of dunning emails.
 *
 * Tour write strategy: bulk `UPDATE tours SET status='cancelled' WHERE
 * venue_id=$ AND scheduled_at > now() AND status IN ('scheduled','confirmed')`.
 * The realtime layer (Phase 8C) will push the change to any open dashboard
 * tabs. We don't write `outcome` on these rows because the canonical
 * "why" lives in `subscriptions.metadata.tours_paused_reason`.
 *
 * Metadata write strategy: direct service-role `UPDATE` rather than the
 * Phase 7L atomic-append RPC. These are scalar metadata fields (not array
 * entries), and the webhook-overwrite race is acceptable for an
 * operational flag — even if Stripe's webhook lands at the exact moment
 * we're writing, the worst case is one missed pause stamp that the next
 * daily run will reapply.
 *
 * Logging posture:
 *   - No raw emails / lead names / tour notes in log lines.
 *   - We log venueId, subscriptionId, periodEnd, cancelled count — no PII.
 *   - Per-venue failures don't abort the batch; they get Sentry-captured
 *     and the loop continues so a single bad venue can't block the rest.
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
  cancelled_tours: number
  skipped: number
  failed: number
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function alreadyPaused(metadata: Record<string, unknown> | null): boolean {
  if (!metadata) return false
  const v = (metadata as { tours_paused_at?: unknown }).tours_paused_at
  return typeof v === 'string' && v.length > 0
}

function buildPausedMetadata(
  existing: Record<string, unknown> | null,
  cancelledCount: number,
  pausedAtIso: string
): Record<string, unknown> {
  const base = (existing ?? {}) as Record<string, unknown>
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
    cancelled_tours: 0,
    skipped: 0,
    failed: 0,
  }
  const supabase = createServiceClient()
  const now = new Date()
  const cutoff = new Date(now.getTime() - GRACE_DAYS * MS_DAY)

  log.info(
    { schedule: SCHEDULE, graceDays: GRACE_DAYS, cutoff: cutoff.toISOString() },
    'jobs.billing_tour_auto_pause.scan_start'
  )

  // Candidate query: past_due + period ended > 7 days ago. We can't filter
  // metadata.tours_paused_at IS NULL via PostgREST jsonb in a single
  // chainable call easily, so we filter in JS below — the candidate set is
  // small (past_due venues are rare).
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
    if (alreadyPaused(sub.metadata)) {
      summary.skipped++
      continue
    }
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

    // Cancel future scheduled/confirmed tours. The `.select('id')` lets us
    // count exactly what was touched (Postgres can shift status mid-update
    // in rare cases; we trust the returned rows over the candidate count).
    let cancelledCount = 0
    try {
      const { data: cancelledRaw, error: cancelErr } = await supabase
        .from('tours')
        .update({ status: 'cancelled' })
        .eq('venue_id', sub.venue_id)
        .in('status', ['scheduled', 'confirmed'])
        .gt('scheduled_at', now.toISOString())
        .select('id')

      if (cancelErr) {
        subLog.error({ err: cancelErr }, 'jobs.billing_tour_auto_pause.cancel_failed')
        captureJobError('billing-tour-auto-pause', cancelErr, { venueId: sub.venue_id })
        summary.failed++
        continue
      }
      cancelledCount = (cancelledRaw as Array<{ id: string }> | null)?.length ?? 0
    } catch (err) {
      subLog.error({ err }, 'jobs.billing_tour_auto_pause.cancel_threw')
      captureJobError('billing-tour-auto-pause', err, { venueId: sub.venue_id })
      summary.failed++
      continue
    }

    // Stamp metadata. We use a direct UPDATE rather than the Phase 7L
    // atomic-append RPC because these are scalar fields, not array entries.
    // The webhook race window is small (cron runs nightly) and the worst
    // case (Stripe overwriting our flag on the same minute) self-heals on
    // the next nightly pass.
    const pausedAtIso = new Date().toISOString()
    const nextMetadata = buildPausedMetadata(sub.metadata, cancelledCount, pausedAtIso)
    const { error: metaErr } = await supabase
      .from('subscriptions')
      .update({ metadata: nextMetadata })
      .eq('id', sub.id)

    if (metaErr) {
      subLog.error(
        { err: metaErr, cancelledCount },
        'jobs.billing_tour_auto_pause.metadata_write_failed'
      )
      captureJobError('billing-tour-auto-pause', metaErr, { venueId: sub.venue_id })
      // We already cancelled the tours; mark as failed so the next run
      // re-attempts the metadata stamp (alreadyPaused() will return false).
      summary.failed++
      continue
    }

    subLog.info(
      { cancelledCount, pausedAtIso },
      'jobs.billing_tour_auto_pause.paused'
    )
    summary.paused++
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
    name: 'Past-due tour auto-pause (daily, 7-day grace)',
    retries: 1,
    triggers: [{ cron: SCHEDULE }],
  },
  async () => runAutoPauseScan()
)

// Exported for unit tests + manual reruns.
export { runAutoPauseScan, alreadyPaused, buildPausedMetadata }
