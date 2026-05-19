import 'server-only'
import { inngest } from '../client'
import { createServiceClient } from '@/lib/supabase/service'
import { log } from '@/lib/log'
import { captureJobError } from '@/lib/observability/sentry'
import { recordDigestAuditEvent } from '@/lib/billing/digest-audit-events'

/**
 * Phase 8AB — weekly digest audit retention.
 *
 * Soft-archives `outbound_messages` digest rows older than the
 * configured retention window. The Phase 8Y/8Z audit feed already
 * defaults to excluding archived rows; this job is what actually
 * stamps the `digest_archived` marker so old rows fall out of the
 * default view without being deleted.
 *
 * ── SAFETY POSTURE ────────────────────────────────────────────────────────
 * Hard-gated by `DIGEST_AUDIT_RETENTION_ENABLED === '1'`. With the
 * flag absent or any other value, `runRetentionScan()` short-circuits
 * to `{ skipped: true, reason: 'disabled' }` before any DB read.
 * Mirrors the Phase 8R `OPERATOR_DIGEST_ENABLED` gate — operators
 * opt in explicitly per environment.
 *
 * Cron schedule `0 9 * * 1` (weekly, Monday 9am UTC). Off-cycle from
 * the 8am UTC operator digest so the two crons don't compete for the
 * same Inngest worker slot.
 *
 * ── ARCHIVAL MARKER ───────────────────────────────────────────────────────
 * Soft-delete only — we NEVER drop the row. Merge into existing
 * metadata:
 *
 *   {
 *     digest_archived: true,
 *     digest_archived_at: <iso>,
 *     digest_archived_reason: 'retention_policy',
 *     digest_retention_days: <N>
 *   }
 *
 * Existing keys (tour_digest_send_kind, tour_digest_recipient_user_id,
 * etc.) are preserved — `?include_archived=true` on the sends route
 * still surfaces these rows with the full context intact.
 *
 * ── FAILURE POSTURE ───────────────────────────────────────────────────────
 * - Per-row failures count as `failed` but NEVER abort the batch.
 * - Batch is hard-capped at 500 rows per run. A backlog larger than
 *   that needs multiple cron ticks (weekly = ~52 ticks/year of
 *   headroom).
 * - Unexpected DB errors get `captureJobError` and surface in the
 *   summary; the cron returns normally.
 */

const SCHEDULE = '0 9 * * 1' // weekly Monday 9am UTC
const BATCH_LIMIT = 500
const MIN_RETENTION_DAYS = 30
const MAX_RETENTION_DAYS = 3650
const DEFAULT_RETENTION_DAYS = 365

interface RunSummary {
  scanned: number
  archived: number
  failed: number
  retentionDays: number
}

function retentionEnabled(): boolean {
  return process.env.DIGEST_AUDIT_RETENTION_ENABLED === '1'
}

/**
 * Phase 8AC — dry-run mode. Returns candidate rows + counts WITHOUT
 * mutating. Lets operators preview what the next real run will
 * archive before flipping the live flag. Independent of the main
 * enabled flag — both must be `'1'` for dry-run to engage; if
 * retention is disabled, the cron still short-circuits as before.
 */
function dryRunEnabled(): boolean {
  return process.env.DIGEST_AUDIT_RETENTION_DRY_RUN === '1'
}

function parseRetentionDays(): number {
  const raw = process.env.DIGEST_AUDIT_RETENTION_DAYS
  const parsed = raw ? Number.parseInt(raw, 10) : NaN
  if (!Number.isFinite(parsed)) return DEFAULT_RETENTION_DAYS
  if (parsed < MIN_RETENTION_DAYS) return MIN_RETENTION_DAYS
  if (parsed > MAX_RETENTION_DAYS) return MAX_RETENTION_DAYS
  return parsed
}

interface CandidateRow {
  id: string
  // Phase 8AC — pulled so the post-batch audit summary can fan out
  // one digest_audit_events row per distinct venue represented in
  // the archived set. Tiny extra payload; query plan unchanged.
  venue_id: string
  metadata: Record<string, unknown> | null
}

interface DryRunSummary {
  dry_run: true
  candidate_count: number
  sample_ids: string[]
  retention_days: number
}

async function runRetentionScan(): Promise<
  | RunSummary
  | DryRunSummary
  | { skipped: true; reason: 'disabled' }
> {
  if (!retentionEnabled()) {
    log.info(
      {
        flag: 'DIGEST_AUDIT_RETENTION_ENABLED',
        value: process.env.DIGEST_AUDIT_RETENTION_ENABLED ?? null,
      },
      'jobs.digest_audit_retention.skipped_disabled'
    )
    return { skipped: true, reason: 'disabled' }
  }

  const retentionDays = parseRetentionDays()
  const cutoffIso = new Date(
    Date.now() - retentionDays * 24 * 60 * 60 * 1000
  ).toISOString()
  const supabase = createServiceClient()

  log.info(
    { schedule: SCHEDULE, retentionDays, cutoffIso, batchLimit: BATCH_LIMIT },
    'jobs.digest_audit_retention.scan_start'
  )

  // 1. Select candidates. The `not.eq` against the metadata key skips
  // already-archived rows so re-runs are idempotent. We deliberately
  // scope to digest rows only (`related_table='tour_status_events'`
  // AND `metadata->>'tour_digest_send_kind' IS NOT NULL`) — this job
  // must NEVER archive tour-notification or lead-facing outbound
  // rows that share the table.
  const { data: rowsRaw, error: queryErr } = await supabase
    .from('outbound_messages')
    .select('id, venue_id, metadata')
    .eq('related_table', 'tour_status_events')
    .not('metadata->>tour_digest_send_kind', 'is', null)
    .lt('created_at', cutoffIso)
    .or(
      // Exclude rows already archived. The two-clause `.or()` handles
      // both the "key absent" and "key present but not 'true'" cases
      // — PostgREST's `not.eq` alone treats missing keys as non-
      // matching, which is what we want, but we add the `is.null`
      // branch for belt-and-suspenders coverage.
      'metadata->>digest_archived.is.null,metadata->>digest_archived.neq.true'
    )
    .order('created_at', { ascending: true })
    .limit(BATCH_LIMIT)

  if (queryErr) {
    log.error(
      { errorMessage: queryErr.message },
      'jobs.digest_audit_retention.query_failed'
    )
    captureJobError('digest-audit-retention', queryErr, {})
    throw new Error(
      `digest audit retention query failed: ${queryErr.message}`
    )
  }

  const rows = (rowsRaw ?? []) as CandidateRow[]

  // Phase 8AC — dry-run short-circuit. Engages ONLY when retention
  // is itself enabled AND the dry-run flag is set. Lets operators
  // preview "what would the next real run touch?" without mutating
  // a single row. Deliberately writes no audit event — dry-run is a
  // diagnostic, not an operator action.
  if (dryRunEnabled()) {
    const dryRunSummary: DryRunSummary = {
      dry_run: true,
      candidate_count: rows.length,
      // Cap the surfaced sample so a 500-row batch doesn't dump
      // half a megabyte of UUIDs into Inngest run history. Operators
      // who need the full set can query directly.
      sample_ids: rows.slice(0, 25).map((r) => r.id),
      retention_days: retentionDays,
    }
    log.info(
      {
        retentionDays,
        candidateCount: rows.length,
        sampleCount: dryRunSummary.sample_ids.length,
      },
      'jobs.digest_audit_retention.dry_run'
    )
    return dryRunSummary
  }

  const summary: RunSummary = {
    scanned: rows.length,
    archived: 0,
    failed: 0,
    retentionDays,
  }

  if (rows.length === 0) {
    log.info(summary, 'jobs.digest_audit_retention.scan_complete')
    return summary
  }

  // Phase 8AC — per-venue archive accumulator. Built while iterating
  // the row set so we don't need a second pass to compute the
  // per-venue summary used by the audit write below.
  const perVenue = new Map<string, { archived: number; failed: number }>()
  function bumpVenue(
    venueId: string,
    field: 'archived' | 'failed'
  ): void {
    const entry = perVenue.get(venueId) ?? { archived: 0, failed: 0 }
    entry[field]++
    perVenue.set(venueId, entry)
  }

  // 2. Per-row update. Sequential — soft-archive volume per week is
  // low and per-row error attribution keeps Sentry signal clean. A
  // future phase could parallelize via the bounded-concurrency pool
  // pattern if a multi-tenant deployment outgrows this.
  const nowIso = new Date().toISOString()
  for (const row of rows) {
    const baseMetadata = (row.metadata ?? {}) as Record<string, unknown>
    const nextMetadata: Record<string, unknown> = {
      ...baseMetadata,
      digest_archived: true,
      digest_archived_at: nowIso,
      digest_archived_reason: 'retention_policy',
      digest_retention_days: retentionDays,
    }
    const { error: updateErr } = await supabase
      .from('outbound_messages')
      .update({ metadata: nextMetadata })
      .eq('id', row.id)
    if (updateErr) {
      summary.failed++
      bumpVenue(row.venue_id, 'failed')
      log.warn(
        { err: updateErr, rowId: row.id, venueId: row.venue_id },
        'jobs.digest_audit_retention.row_archive_failed'
      )
      // Per-row failures never abort the batch.
      continue
    }
    summary.archived++
    bumpVenue(row.venue_id, 'archived')
  }

  // Phase 8AC — write one digest_audit_events summary per venue
  // represented in the batch. Helper is best-effort: failures log
  // + Sentry-capture inside the helper and never throw, so the
  // retention summary itself always returns cleanly.
  for (const [venueId, counts] of perVenue.entries()) {
    await recordDigestAuditEvent({
      venueId,
      actorKind: 'cron',
      actorUserId: null,
      action: 'digest_retention_archive',
      metadata: {
        archived_count: counts.archived,
        failed_count: counts.failed,
        retention_days: retentionDays,
        batch_limit: BATCH_LIMIT,
      },
    })
  }

  log.info(summary, 'jobs.digest_audit_retention.scan_complete')
  return summary
}

// ---------------------------------------------------------------------------
// Inngest binding
// ---------------------------------------------------------------------------

export const digestAuditRetentionFn = inngest.createFunction(
  {
    id: 'digest-audit-retention',
    name: 'Phase 8AB — weekly digest audit retention (env-gated)',
    retries: 1,
    triggers: [{ cron: SCHEDULE }],
  },
  async () => runRetentionScan()
)

// Exported for unit tests + manual reruns.
export { runRetentionScan, retentionEnabled, dryRunEnabled, parseRetentionDays }
