import 'server-only'
import { inngest } from '../client'
import { createServiceClient } from '@/lib/supabase/service'
import { recordTourStatusEvent } from '@/lib/integrations/tour-status-events'
import { log } from '@/lib/log'
import { captureJobError } from '@/lib/observability/sentry'

/**
 * Phase 8N — one-shot synthetic backfill for `tour_status_events`.
 *
 * Phase 8M started writing audit rows from every status-change path,
 * but tours that landed in their current status BEFORE that migration
 * have no rows. Operators looking at a legacy tour in the new audit
 * surfaces (drawer / inbox panel / billing feed) would see an empty
 * state and have to ask "did anything happen to this?".
 *
 * This job writes ONE synthetic row per legacy tour as a baseline
 * snapshot so the UI always has something to show:
 *
 *   actor_kind = 'system'
 *   actor_id   = 'backfill-8N'
 *   action     = 'legacy_status_snapshot'
 *   metadata   = { backfilled: true, source: 'phase_8n', tour_updated_at }
 *
 * ── SAFETY POSTURE ────────────────────────────────────────────────────────
 * This job intentionally has NO cron schedule. It runs ONLY when an
 * operator sends the `admin/tour-status-events.backfill` event via the
 * Inngest dashboard, AND the env flag `TOUR_STATUS_BACKFILL=1` is set
 * in the runtime environment. With either guard missing it short-
 * circuits with `{ skipped: true, reason: 'disabled' }`.
 *
 * The job is idempotent: it checks `tour_status_events` for each tour
 * and skips any row that already has at least one event. Re-running it
 * after a partial failure is safe.
 *
 * Bounded at 500 tours per run so a venue with thousands of legacy rows
 * can be processed across multiple manual triggers without monopolizing
 * the Inngest worker.
 */

const BATCH_LIMIT = 500
const LOOKBACK_DAYS = 90

interface RunSummary {
  scanned: number
  inserted: number
  skipped: number
  failed: number
}

function backfillEnabled(): boolean {
  return process.env.TOUR_STATUS_BACKFILL === '1'
}

async function runBackfillScan(): Promise<
  | RunSummary
  | { skipped: true; reason: 'disabled' }
> {
  if (!backfillEnabled()) {
    log.info(
      { flag: 'TOUR_STATUS_BACKFILL', value: process.env.TOUR_STATUS_BACKFILL ?? null },
      'jobs.seed_tour_status_events.skipped_disabled'
    )
    return { skipped: true, reason: 'disabled' }
  }

  const supabase = createServiceClient()
  const cutoff = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString()

  log.info(
    { lookbackDays: LOOKBACK_DAYS, cutoff, batchLimit: BATCH_LIMIT },
    'jobs.seed_tour_status_events.scan_start'
  )

  // Step 1 — candidate tours. We pull a generous slice so we can drop
  // already-audited ones in step 2 without losing throughput.
  const { data: toursRaw, error: toursErr } = await supabase
    .from('tours')
    .select('id, venue_id, lead_id, status, updated_at')
    .gte('updated_at', cutoff)
    .order('updated_at', { ascending: false })
    .limit(BATCH_LIMIT)

  if (toursErr) {
    log.error(
      { errorMessage: toursErr.message },
      'jobs.seed_tour_status_events.candidate_query_failed'
    )
    captureJobError('seed-tour-status-events', toursErr, {})
    throw new Error(`backfill candidate query failed: ${toursErr.message}`)
  }

  type CandidateRow = {
    id: string
    venue_id: string
    lead_id: string | null
    status: string | null
    updated_at: string
  }
  const tours = (toursRaw ?? []) as CandidateRow[]
  const summary: RunSummary = {
    scanned: tours.length,
    inserted: 0,
    skipped: 0,
    failed: 0,
  }

  if (tours.length === 0) {
    log.info(summary, 'jobs.seed_tour_status_events.scan_complete')
    return summary
  }

  // Step 2 — bulk-check which tours ALREADY have at least one event.
  // One round-trip with `in(id)` instead of one-per-tour. The result set
  // is just the tour_ids that DO have an event; the complement is what
  // we need to backfill.
  const tourIds = tours.map((t) => t.id)
  const { data: existingRaw, error: existingErr } = await supabase
    .from('tour_status_events')
    .select('tour_id')
    .in('tour_id', tourIds)

  if (existingErr) {
    log.error(
      { errorMessage: existingErr.message },
      'jobs.seed_tour_status_events.existing_check_failed'
    )
    captureJobError('seed-tour-status-events', existingErr, {})
    throw new Error(`backfill existing-row check failed: ${existingErr.message}`)
  }

  const alreadyAudited = new Set<string>(
    ((existingRaw ?? []) as Array<{ tour_id: string }>).map((r) => r.tour_id)
  )

  // Step 3 — per-tour insert via the shared helper. Serial because the
  // helper already Sentry-captures + logs each failure individually and
  // the typical backfill batch is small enough that parallelism doesn't
  // matter. Per-tour failures NEVER abort the batch.
  for (const tour of tours) {
    if (alreadyAudited.has(tour.id)) {
      summary.skipped++
      continue
    }
    const result = await recordTourStatusEvent({
      venueId: tour.venue_id,
      tourId: tour.id,
      leadId: tour.lead_id,
      actorKind: 'system',
      actorId: 'backfill-8N',
      action: 'legacy_status_snapshot',
      previousStatus: null,
      newStatus: tour.status ?? 'unknown',
      metadata: {
        backfilled: true,
        source: 'phase_8n',
        tour_updated_at: tour.updated_at,
      },
    })
    if (result.ok) {
      summary.inserted++
    } else {
      summary.failed++
    }
  }

  log.info(summary, 'jobs.seed_tour_status_events.scan_complete')
  return summary
}

// ---------------------------------------------------------------------------
// Inngest binding
// ---------------------------------------------------------------------------

export const seedTourStatusEventsFn = inngest.createFunction(
  {
    id: 'seed-tour-status-events',
    name: 'Phase 8N — one-shot synthetic tour status backfill (manual trigger only)',
    retries: 0,
    // No cron — must be invoked manually via the Inngest dashboard or
    // the typed `sendInngestEvent` helper. The env-flag guard inside
    // `runBackfillScan` is the second safety check.
    triggers: [{ event: 'admin/tour-status-events.backfill' }],
  },
  async () => runBackfillScan()
)

export { runBackfillScan, backfillEnabled }
