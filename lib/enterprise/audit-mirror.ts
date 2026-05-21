import { createServiceClient } from '@/lib/supabase/service'
import { log } from '@/lib/log'
import { captureApiError } from '@/lib/observability/sentry'

/**
 * Phase 9C — Enterprise audit event mirror (tamper-evidence).
 *
 * Appends a copy of every successful `audit_events` insert into
 * `public.audit_event_mirror` (migration 028). The mirror:
 *
 *   - Has a stricter RLS posture: owner-only SELECT (the primary
 *     feed allows owner OR admin).
 *   - Has NO RLS write policies. All inserts go through this helper
 *     via service role; the REST surface cannot mutate the mirror.
 *   - Shares the primary row's UUID so reconciliation is a single
 *     join (when both rows are present) and drift (one missing) is
 *     trivially detectable.
 *
 * ── KNOWN LIMITATION ──────────────────────────────────────────────────────
 * This is NOT true WORM. An admin with direct database access (psql,
 * Supabase dashboard SQL editor) can still issue
 * `DELETE FROM audit_event_mirror`. The mirror separates feeds + closes
 * the REST mutation surface; it doesn't stop an authorized DB operator
 * from rewriting history. A future phase may add an external
 * append-only sink (object storage, third-party log shipper).
 *
 * ── REDACTION POSTURE ────────────────────────────────────────────────────
 * The mirror payload is the SAME jsonb the `recordAuditEvent` helper
 * already sanitized before the primary insert. Sensitive-key drop
 * happened ONCE upstream (password, secret, token, api_key,
 * authorization, cookie, webhook_payload, raw_body, stripe_secret,
 * anthropic_api_key); snapshots are size-capped at 4 KB; user-agent
 * truncated at 240 chars. This helper does NOT re-sanitize.
 *
 * Explicit non-goals — we will NEVER mirror:
 *   - raw auth headers
 *   - tokens
 *   - raw webhook bodies
 *   - raw message bodies
 *   - full email content
 *   - secrets
 *   - unmasked email addresses unless they were stored masked
 *     upstream (some audit rows record an `email_masked` metadata
 *     field; that masked form is fine to mirror).
 *
 * These are enforced at the `recordAuditEvent` write step; if a
 * caller violates the contract, the offending data lands in both
 * tables, and the upstream sanitization is the bug.
 *
 * ── BEHAVIOR ──────────────────────────────────────────────────────────────
 *   - Gated by `AUDIT_MIRROR_ENABLED=1`. When disabled the helper
 *     returns `{ ok: false, reason: 'disabled' }` immediately — no
 *     network call, no log noise.
 *   - Insert uses `onConflict: 'id'` (do-nothing) so a retry after
 *     a transient blip doesn't duplicate-row-error.
 *   - Failures are logged + Sentry-captured but NEVER thrown. The
 *     primary `audit_events` row already committed; the operator
 *     deserves their HTTP response. Operators monitor mirror
 *     health via the structured log line `audit_mirror.insert_failed`
 *     (a flood is a real signal — investigate).
 */

export interface MirrorAuditEventArgs {
  id: string
  venueId: string
  action: string
  targetTable: string | null
  targetId: string | null
  actorUserId: string | null
  actorKind: string
  route: string
  requestId: string | null
  createdAt: string
  /**
   * The already-sanitized payload from the primary `audit_events`
   * row. The helper writes it verbatim — no additional redaction.
   * Shape:
   *   {
   *     ip_hash: string | null,
   *     user_agent: string | null,
   *     before_snapshot: object | null,
   *     after_snapshot: object | null,
   *     metadata: object,
   *   }
   */
  payload: unknown
}

export type MirrorResult = { ok: true } | { ok: false; reason: string }

/**
 * Read `AUDIT_MIRROR_ENABLED` at call time (not module-load time) so
 * a test harness or a runtime config flip works without a restart.
 * The lookup is cheap; the gate is the hot path.
 */
function isMirrorEnabled(): boolean {
  return process.env.AUDIT_MIRROR_ENABLED === '1'
}

export async function mirrorAuditEvent(
  args: MirrorAuditEventArgs
): Promise<MirrorResult> {
  if (!isMirrorEnabled()) {
    return { ok: false, reason: 'disabled' }
  }

  try {
    // Defensive — never trust a malformed call to reach the DB.
    // recordAuditEvent already validated these upstream, but the
    // mirror is a second line of defense.
    if (
      typeof args.id !== 'string' ||
      args.id.length === 0 ||
      typeof args.venueId !== 'string' ||
      args.venueId.length === 0 ||
      typeof args.action !== 'string' ||
      args.action.length === 0 ||
      typeof args.route !== 'string' ||
      args.route.length === 0
    ) {
      log.warn(
        { id: args.id, route: args.route, action: args.action },
        'audit_mirror.invalid_args'
      )
      return { ok: false, reason: 'invalid_args' }
    }

    const row = {
      id: args.id,
      venue_id: args.venueId,
      actor_user_id: args.actorUserId,
      actor_kind: args.actorKind,
      route: args.route,
      action: args.action,
      target_table: args.targetTable,
      target_id: args.targetId,
      request_id: args.requestId,
      payload: args.payload ?? {},
      created_at: args.createdAt,
    }

    const svc = createServiceClient()
    // `onConflict: 'id'` + `ignoreDuplicates: true` makes the call
    // idempotent. If `recordAuditEvent` is ever retried (rare — it
    // only fires on success), the mirror won't duplicate-row-error.
    const { error } = await svc
      .from('audit_event_mirror')
      .upsert(row, { onConflict: 'id', ignoreDuplicates: true })

    if (error) {
      log.warn(
        {
          err: error,
          id: args.id,
          route: args.route,
          action: args.action,
        },
        'audit_mirror.insert_failed'
      )
      captureApiError(error, {
        requestId: args.requestId ?? undefined,
        route: args.route,
        userId: args.actorUserId ?? undefined,
        venueId: args.venueId,
      })
      return { ok: false, reason: 'insert_failed' }
    }
    return { ok: true }
  } catch (err) {
    // Sanitization / serialization shouldn't throw, but trap anyway
    // — the mirror NEVER throws. The primary row already committed.
    log.warn(
      {
        err,
        id: args.id,
        route: args.route,
        action: args.action,
      },
      'audit_mirror.helper_threw'
    )
    captureApiError(err, {
      requestId: args.requestId ?? undefined,
      route: args.route,
      userId: args.actorUserId ?? undefined,
      venueId: args.venueId,
    })
    return { ok: false, reason: 'helper_threw' }
  }
}

/**
 * Operator-facing health probe — does the helper believe the mirror
 * is enabled? Used by the health endpoint + the EnterpriseAuditEventsCard
 * indicator line.
 *
 * Note: this is the CONFIG state, not a live DB ping. A `true` here
 * means writes will be attempted; it does NOT prove the most recent
 * write succeeded. The `audit_mirror.insert_failed` log line is the
 * place to look for actual drift.
 */
export function isAuditMirrorConfigured(): boolean {
  return isMirrorEnabled()
}
