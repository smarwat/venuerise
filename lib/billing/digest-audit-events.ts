import 'server-only'
import { createServiceClient } from '@/lib/supabase/service'
import { log } from '@/lib/log'
import { captureApiError } from '@/lib/observability/sentry'

/**
 * Phase 8AC — append-only audit log for the digest system.
 *
 * Wraps the `public.digest_audit_events` table (migration 017) with
 * a single best-effort writer. Mirrors the Phase 8M
 * `recordTourStatusEvent` shape so call sites in the suppression
 * routes + retention cron stay narrow.
 *
 * ── DESIGN CONTRACT ───────────────────────────────────────────────────────
 *   - NEVER throws. Caller HTTP responses must not depend on audit
 *     write success.
 *   - Failures log + Sentry-capture, then return `{ ok: false }`.
 *   - PII boundary: callers pass `targetEmailMasked` already masked;
 *     this helper never accepts a raw email and never logs one.
 *   - Metadata is passed through as opaque jsonb. The log line emits
 *     metadata KEYS only (no values) so a payload containing a uuid
 *     doesn't accidentally hit log retention.
 *
 * ── ACTION VOCABULARY (Phase 8AC initial set) ─────────────────────────────
 *   'suppression_remove'        — per-row suppression delete succeeded
 *   'suppression_remove_noop'   — per-row suppression delete idempotent no-op
 *   'suppression_remove_all'    — bulk summary row (metadata: removed_count, attempted_count)
 *   'digest_retention_archive'  — retention cron per-venue summary
 *
 * Future actions (manual digest sends, cadence flips, member backfill)
 * can be added without changing the helper.
 */

export type DigestAuditActorKind = 'operator' | 'cron' | 'system'

export interface RecordDigestAuditEventArgs {
  venueId: string
  actorKind: DigestAuditActorKind
  action: string
  actorUserId?: string | null
  targetUserId?: string | null
  /** MUST be masked (`o***@example.com`) — helper never sees raw. */
  targetEmailMasked?: string | null
  /** Free-text operator breadcrumb. Capped 240 chars by the schema. */
  reason?: string | null
  metadata?: Record<string, unknown>
  /** Optional for log correlation; mirrors the rest of the admin surface. */
  requestId?: string
}

export type RecordDigestAuditEventResult =
  | { ok: true; id: string | null }
  | { ok: false; error: string }

export async function recordDigestAuditEvent(
  args: RecordDigestAuditEventArgs
): Promise<RecordDigestAuditEventResult> {
  // Cheap input checks. The DB will reject any malformed payload, but
  // failing fast here keeps Sentry signal cleaner.
  if (!args.venueId || typeof args.venueId !== 'string') {
    return { ok: false, error: 'venue_id_missing' }
  }
  if (!args.action || typeof args.action !== 'string') {
    return { ok: false, error: 'action_missing' }
  }

  // Truncate operator-supplied reason defensively. Schema cap is 240
  // (Phase 8AA), but a misbehaving caller passing a giant string
  // would otherwise burn DB row size + log noise.
  const reason =
    typeof args.reason === 'string' && args.reason.length > 0
      ? args.reason.slice(0, 240)
      : null

  // Logger-safe metadata digest — KEYS only, never values. A future
  // audit-feed UI surfaces the full metadata to admins via the API
  // route; logs stay narrow so PII inside the jsonb doesn't leak.
  const metadataKeys = args.metadata
    ? Object.keys(args.metadata).sort()
    : []

  const supabase = createServiceClient()
  try {
    const { data, error } = await supabase
      .from('digest_audit_events')
      .insert({
        venue_id: args.venueId,
        actor_user_id: args.actorUserId ?? null,
        actor_kind: args.actorKind,
        action: args.action,
        target_user_id: args.targetUserId ?? null,
        target_email_masked: args.targetEmailMasked ?? null,
        reason,
        metadata: args.metadata ?? {},
      })
      .select('id')
      .single()

    if (error) {
      // Phase 8AF — detect the partial-unique-index violation from
      // migration 019. Postgres reports `23505` for unique-constraint
      // violations; PostgREST surfaces it via `error.code === '23505'`
      // alongside a descriptive `error.message`. Treat as non-fatal
      // for cron-send rows (the dedupe is belt-and-suspenders; the
      // outbound_messages send_kind probe already guards the real
      // delivery). Other actions' duplicates aren't expected — log
      // them at warn instead of error.
      const isDuplicate =
        (error as { code?: string }).code === '23505' ||
        /duplicate key value violates unique constraint/i.test(
          error.message ?? ''
        )
      if (isDuplicate) {
        log.info(
          {
            requestId: args.requestId,
            venueId: args.venueId,
            actorKind: args.actorKind,
            action: args.action,
            targetUserId: args.targetUserId ?? null,
            metadataKeys,
          },
          'digest_audit_events.duplicate_skipped'
        )
        return { ok: false, error: 'duplicate' }
      }
      log.error(
        {
          requestId: args.requestId,
          venueId: args.venueId,
          actorKind: args.actorKind,
          action: args.action,
          targetUserId: args.targetUserId ?? null,
          metadataKeys,
          errorMessage: error.message,
        },
        'digest_audit_events.insert_failed'
      )
      captureApiError(error, {
        requestId: args.requestId,
        route: 'lib/billing/digest-audit-events',
        venueId: args.venueId,
      })
      return { ok: false, error: error.message }
    }

    log.info(
      {
        requestId: args.requestId,
        id: data?.id ?? null,
        venueId: args.venueId,
        actorKind: args.actorKind,
        action: args.action,
        actorUserId: args.actorUserId ?? null,
        targetUserId: args.targetUserId ?? null,
        metadataKeys,
      },
      'digest_audit_events.recorded'
    )
    return { ok: true, id: (data?.id as string | undefined) ?? null }
  } catch (err) {
    // The helper contract is "never throw" — even a transport-level
    // failure must surface as `{ ok: false }`. Caller already
    // committed the user-facing side effect (suppression delete /
    // retention archive); a missing audit row should never roll that
    // back.
    const message = err instanceof Error ? err.message : 'unknown_error'
    log.error(
      {
        requestId: args.requestId,
        venueId: args.venueId,
        actorKind: args.actorKind,
        action: args.action,
        metadataKeys,
        errorMessage: message,
      },
      'digest_audit_events.insert_threw'
    )
    captureApiError(err, {
      requestId: args.requestId,
      route: 'lib/billing/digest-audit-events',
      venueId: args.venueId,
    })
    return { ok: false, error: message }
  }
}
