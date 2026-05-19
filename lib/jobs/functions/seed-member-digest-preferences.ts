import 'server-only'
import { inngest } from '../client'
import { createServiceClient } from '@/lib/supabase/service'
import { log } from '@/lib/log'
import { captureJobError } from '@/lib/observability/sentry'

/**
 * Phase 8V — one-shot backfill: write an explicit
 * `metadata.digest_cadence = 'daily'` onto every existing owner/admin
 * `venue_members` row that doesn't already carry a `digest_cadence`
 * value.
 *
 * Why: Phase 8U's effective-preference resolver falls through to
 * `'daily'` when neither member nor subscription metadata sets a
 * cadence. This works correctly at runtime, but the billing-page
 * `DigestPreferencesCard` then shows a "Using default" source badge
 * for every long-time admin — which surprises operators who'd
 * expected to see their preference reflected. Writing the default
 * explicitly flips the badge to "Using your preference" and gives
 * future opt-out audits a clean per-member trail.
 *
 * ── SAFETY POSTURE ────────────────────────────────────────────────────────
 * Hard-gated by `SEED_MEMBER_DIGEST === '1'`. Without the env flag,
 * `runMemberDigestBackfill()` short-circuits with
 * `{ skipped: true, reason: 'disabled' }` before any DB work. Same
 * pattern as Phase 8N's `seed-tour-status-events` backfill.
 *
 * Triggered ONLY by a manual `admin/member-digest-preferences.backfill`
 * event — there's no cron schedule. Operators send the event via the
 * Inngest dashboard.
 *
 * ── IDEMPOTENCY ───────────────────────────────────────────────────────────
 * The candidate query filters to rows where `metadata->>'digest_cadence'`
 * is null. Re-running is a no-op for already-backfilled rows; safe to
 * invoke multiple times.
 *
 * ── BOUNDS ────────────────────────────────────────────────────────────────
 * Caps at 1000 rows per run. A venue platform with more admin/owner
 * members would need multiple invocations; documented in BILLING-QA
 * §7ac.
 */

const BATCH_LIMIT = 1000

interface RunSummary {
  scanned: number
  updated: number
  skipped: number
  failed: number
}

function backfillEnabled(): boolean {
  return process.env.SEED_MEMBER_DIGEST === '1'
}

async function runMemberDigestBackfill(): Promise<
  RunSummary | { skipped: true; reason: 'disabled' }
> {
  if (!backfillEnabled()) {
    log.info(
      {
        flag: 'SEED_MEMBER_DIGEST',
        value: process.env.SEED_MEMBER_DIGEST ?? null,
      },
      'jobs.seed_member_digest_preferences.skipped_disabled'
    )
    return { skipped: true, reason: 'disabled' }
  }

  const supabase = createServiceClient()
  log.info(
    { batchLimit: BATCH_LIMIT },
    'jobs.seed_member_digest_preferences.scan_start'
  )

  // 1. Candidate query — owner/admin members whose metadata has no
  // `digest_cadence` key. PostgREST's `is.null` filter on a jsonb
  // text extract correctly matches both "key absent" AND "key
  // explicitly null" cases, so the predicate is precise.
  const { data: rows, error } = await supabase
    .from('venue_members')
    .select('venue_id, user_id, metadata')
    .in('role', ['owner', 'admin'])
    .is('metadata->>digest_cadence', null)
    .order('created_at', { ascending: true })
    .limit(BATCH_LIMIT)

  if (error) {
    log.error(
      { errorMessage: error.message },
      'jobs.seed_member_digest_preferences.candidate_query_failed'
    )
    captureJobError('seed-member-digest-preferences', error, {})
    throw new Error(`member digest backfill query failed: ${error.message}`)
  }

  type CandidateRow = {
    venue_id: string
    user_id: string
    metadata: Record<string, unknown> | null
  }
  const candidates = (rows ?? []) as CandidateRow[]
  const summary: RunSummary = {
    scanned: candidates.length,
    updated: 0,
    skipped: 0,
    failed: 0,
  }

  if (candidates.length === 0) {
    log.info(summary, 'jobs.seed_member_digest_preferences.scan_complete')
    return summary
  }

  // 2. Per-row update. Sequential because the typical backfill batch
  // is small (one venue, handful of admins) and serial keeps Sentry
  // attribution clean. Per-row failures NEVER abort the batch.
  for (const row of candidates) {
    const baseMetadata = (row.metadata ?? {}) as Record<string, unknown>

    // Defense in depth — re-check the key isn't set. PostgREST's
    // `is.null` on a jsonb extract should already exclude this case,
    // but a race between candidate fetch + per-row update is
    // theoretically possible if a parallel admin POST sets the
    // preference mid-batch. Skip rather than overwrite.
    if (baseMetadata.digest_cadence !== undefined && baseMetadata.digest_cadence !== null) {
      summary.skipped++
      continue
    }

    const nextMetadata: Record<string, unknown> = {
      ...baseMetadata,
      digest_cadence: 'daily',
    }

    const { error: updateErr } = await supabase
      .from('venue_members')
      .update({ metadata: nextMetadata })
      .eq('venue_id', row.venue_id)
      .eq('user_id', row.user_id)

    if (updateErr) {
      log.error(
        {
          err: updateErr,
          venueId: row.venue_id,
          userId: row.user_id,
        },
        'jobs.seed_member_digest_preferences.update_failed'
      )
      captureJobError('seed-member-digest-preferences', updateErr, {
        venueId: row.venue_id,
      })
      summary.failed++
      continue
    }

    summary.updated++
  }

  log.info(summary, 'jobs.seed_member_digest_preferences.scan_complete')
  return summary
}

// ---------------------------------------------------------------------------
// Inngest binding
// ---------------------------------------------------------------------------

export const seedMemberDigestPreferencesFn = inngest.createFunction(
  {
    id: 'seed-member-digest-preferences',
    name: 'Phase 8V — backfill explicit daily cadence onto owner/admin venue_members (env-gated)',
    retries: 0,
    // Manual trigger only — no cron. Operators send the event via the
    // Inngest dashboard with both `SEED_MEMBER_DIGEST=1` set.
    triggers: [{ event: 'admin/member-digest-preferences.backfill' }],
  },
  async () => runMemberDigestBackfill()
)

// Exported for unit tests + manual reruns.
export { runMemberDigestBackfill, backfillEnabled }
