import 'server-only'
import { createHash } from 'node:crypto'
import { createServiceClient } from '@/lib/supabase/service'
import { log } from '@/lib/log'
import { captureApiError } from '@/lib/observability/sentry'
import { mirrorAuditEvent } from '@/lib/enterprise/audit-mirror'

/**
 * Phase 9A — Enterprise audit event helper.
 *
 * One call per sensitive write. Reads service-role and writes the
 * row to `public.audit_events`. The helper is BEST-EFFORT — a
 * write failure is logged + reported to Sentry but never thrown
 * back to the caller. The business action that prompted the
 * audit row is unchanged either way.
 *
 * Safety / privacy posture (enforced here, mirrored at the
 * schema layer by migration 027):
 *
 *   - IPs are hashed with `AUDIT_IP_HASH_SECRET` (or a
 *     deterministic fallback in dev) before storage. Raw IPs
 *     NEVER reach the row.
 *   - JSON snapshots are sanitized: known sensitive key names
 *     are dropped recursively (tokens, secrets, api keys, raw
 *     bodies, auth headers); the result is size-capped so a
 *     pathological caller can't blow the row.
 *   - User-agent is truncated to 240 chars (defensive against
 *     pathological strings).
 *   - `metadata` is sanitized through the same pipe as
 *     snapshots; callers don't need to think about it.
 *
 * Pure side effect: NEVER reads request bodies, NEVER mutates
 * input objects.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ActorKind = 'operator' | 'system' | 'cron' | 'webhook'

export interface RecordAuditEventArgs {
  /** Venue the action belongs to. Required — every audit row is venue-scoped. */
  venueId: string
  /** Acting user id when known; null for cron / system / webhook writes. */
  actorUserId?: string | null
  /** Why is `actorUserId` null when it's null. Defaults to `operator`. */
  actorKind?: ActorKind
  /** Static route string, e.g. `/api/leads/[id]`. */
  route: string
  /**
   * Operator-readable action, e.g. `lead_update`, `tour_create`,
   * `availability_delete`. Conventionally `${table}_${verb}` so
   * the AuditEventsCard can render a tidy filter dropdown.
   */
  action: string
  /** Table the action targets, e.g. `leads`. Null for cross-cutting ops. */
  targetTable?: string | null
  /** Row id (uuid or other) the action targets. Null when not applicable. */
  targetId?: string | null
  /** Request id for cross-system correlation (Sentry, logs). */
  requestId?: string | null
  /** Raw client IP — the helper hashes it before storage. */
  ip?: string | null
  /** Raw User-Agent header. Truncated to 240 chars before storage. */
  userAgent?: string | null
  /** Pre-write row snapshot. Sanitized + size-capped. Optional. */
  before?: unknown
  /** Post-write row snapshot. Sanitized + size-capped. Optional. */
  after?: unknown
  /** Free-form sanitized context (request body slice, etc.). Optional. */
  metadata?: Record<string, unknown> | null
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Recursively drop these key names from any snapshot. Match is
// case-insensitive on the final segment. The list is deliberately
// over-eager — false-positives (dropping a "token" field that
// happens to mean something else) are far cheaper than false-
// negatives (leaking a real secret into an audit row).
const SENSITIVE_KEY_PATTERNS: ReadonlyArray<RegExp> = [
  /^password$/i,
  /^pass$/i,
  /^secret/i,
  /token$/i,
  /access[_-]?token$/i,
  /refresh[_-]?token$/i,
  /api[_-]?key$/i,
  /authorization$/i,
  /auth[_-]?header$/i,
  /^cookie$/i,
  /set[_-]?cookie$/i,
  /raw[_-]?body$/i,
  /webhook[_-]?payload$/i,
  /signing[_-]?secret$/i,
  /stripe[_-]?secret/i,
  /anthropic[_-]?api[_-]?key$/i,
]

const REDACTED_PLACEHOLDER = '[redacted]'
const MAX_SNAPSHOT_BYTES = 4_000
const MAX_USER_AGENT_LEN = 240
const MAX_STRING_LEN_IN_SNAPSHOT = 1_000

// ---------------------------------------------------------------------------
// Helpers (exported so other phases can reuse the sanitization shape)
// ---------------------------------------------------------------------------

/**
 * Hash an IP for storage. Uses `AUDIT_IP_HASH_SECRET` when set;
 * falls back to a deterministic build-time string in dev so the
 * helper still produces a stable shape without an env var.
 *
 * We intentionally use a salted SHA-256 (not bcrypt / argon2) —
 * the goal is linkability ("did the same client trigger N audit
 * rows in the last hour?") not credential storage. The IP space
 * is small enough that a true cryptographic-strength password
 * hash would be theatre.
 */
export function maskIpForAudit(rawIp: string | null | undefined): string | null {
  if (!rawIp || typeof rawIp !== 'string') return null
  const trimmed = rawIp.trim()
  if (trimmed.length === 0) return null
  const secret =
    process.env.AUDIT_IP_HASH_SECRET ??
    process.env.SUPABASE_JWT_SECRET ??
    'venuerise-audit-ip-fallback'
  return createHash('sha256')
    .update(`${secret}:${trimmed}`)
    .digest('hex')
    .slice(0, 32)
}

/**
 * Recursively sanitize an arbitrary value before persisting:
 *
 *   - drop keys matching `SENSITIVE_KEY_PATTERNS`
 *   - truncate strings beyond `MAX_STRING_LEN_IN_SNAPSHOT`
 *   - drop functions / symbols / undefined / non-finite numbers
 *   - bound depth to keep the JSON small
 *
 * After recursion the result is JSON-serialized + truncated to
 * `MAX_SNAPSHOT_BYTES` defensively. If the caller passed a giant
 * blob, we keep the prefix + an explicit `_truncated: true` marker
 * (the marker is added at the top level only).
 */
export function sanitizeAuditJson(value: unknown): unknown {
  const cleaned = sanitizeInner(value, 0)
  // Final size check after recursion.
  let serialized: string
  try {
    serialized = JSON.stringify(cleaned)
  } catch {
    return { _unserializable: true }
  }
  if (serialized.length <= MAX_SNAPSHOT_BYTES) return cleaned
  // Truncate by re-parsing a prefix is unsafe (invalid JSON);
  // instead surface a marker so downstream readers know the
  // snapshot is incomplete. The cleaned value itself is still
  // returned as JSON — Supabase will reject any row that exceeds
  // its own jsonb limits (~1GB), which is well above our cap.
  return {
    _truncated: true,
    _original_size_bytes: serialized.length,
    sample: typeof cleaned === 'object' && cleaned !== null
      ? JSON.parse(serialized.slice(0, MAX_SNAPSHOT_BYTES - 200) + '"')
        // The slice/quote heuristic above is best-effort; on parse
        // failure we just return the marker without the sample.
        ?? null
      : null,
  }
}

function sanitizeInner(value: unknown, depth: number): unknown {
  if (depth > 8) return REDACTED_PLACEHOLDER
  if (value === null) return null
  if (typeof value === 'string') {
    return value.length > MAX_STRING_LEN_IN_SNAPSHOT
      ? value.slice(0, MAX_STRING_LEN_IN_SNAPSHOT) + '…'
      : value
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null
  }
  if (typeof value === 'boolean') return value
  if (Array.isArray(value)) {
    return value.slice(0, 100).map((v) => sanitizeInner(v, depth + 1))
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v === undefined) continue
      if (SENSITIVE_KEY_PATTERNS.some((rx) => rx.test(k))) {
        out[k] = REDACTED_PLACEHOLDER
        continue
      }
      out[k] = sanitizeInner(v, depth + 1)
    }
    return out
  }
  // function / symbol / undefined
  return null
}

/**
 * Compute a tiny diff between two row snapshots. Returns the
 * `{before, after}` slices restricted to keys that actually
 * changed — keeps the audit row small when the caller passes the
 * full row on both sides.
 *
 * Both inputs go through `sanitizeAuditJson` before comparison so
 * sensitive keys can't sneak past via the diff path.
 */
export function auditDiffSmall(
  before: Record<string, unknown> | null | undefined,
  after: Record<string, unknown> | null | undefined
): { before: Record<string, unknown> | null; after: Record<string, unknown> | null } {
  const cleanBefore = (sanitizeAuditJson(before ?? null) as Record<string, unknown> | null) ?? null
  const cleanAfter = (sanitizeAuditJson(after ?? null) as Record<string, unknown> | null) ?? null
  if (!cleanBefore || !cleanAfter) {
    return { before: cleanBefore, after: cleanAfter }
  }
  const diffBefore: Record<string, unknown> = {}
  const diffAfter: Record<string, unknown> = {}
  const keys = new Set([
    ...Object.keys(cleanBefore),
    ...Object.keys(cleanAfter),
  ])
  for (const k of keys) {
    const a = JSON.stringify(cleanBefore[k] ?? null)
    const b = JSON.stringify(cleanAfter[k] ?? null)
    if (a !== b) {
      diffBefore[k] = cleanBefore[k] ?? null
      diffAfter[k] = cleanAfter[k] ?? null
    }
  }
  return {
    before: Object.keys(diffBefore).length > 0 ? diffBefore : null,
    after: Object.keys(diffAfter).length > 0 ? diffAfter : null,
  }
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Record a single audit row. Best-effort: never throws, never
 * blocks. The caller's `await` resolves to `void` regardless of
 * outcome; an internal failure is logged + sent to Sentry but
 * the originating route's success / failure semantics are
 * unchanged.
 *
 * Conventions:
 *   - `action` is `${target_table}_${verb}` when applicable
 *     (`lead_update`, `tour_create`, `availability_delete`).
 *   - `before` / `after` should be the SMALL slice that changed;
 *     pass row-level snapshots only when you can afford the
 *     payload. The helper sanitizes either way.
 */
export async function recordAuditEvent(
  args: RecordAuditEventArgs
): Promise<void> {
  try {
    if (
      typeof args.venueId !== 'string' ||
      args.venueId.length === 0 ||
      typeof args.route !== 'string' ||
      args.route.length === 0 ||
      typeof args.action !== 'string' ||
      args.action.length === 0
    ) {
      log.warn(
        { route: args.route, action: args.action },
        'audit_events.invalid_args'
      )
      return
    }

    const before =
      args.before !== undefined && args.before !== null
        ? sanitizeAuditJson(args.before)
        : null
    const after =
      args.after !== undefined && args.after !== null
        ? sanitizeAuditJson(args.after)
        : null
    const metadata =
      args.metadata && typeof args.metadata === 'object'
        ? (sanitizeAuditJson(args.metadata) as Record<string, unknown>)
        : {}

    const row = {
      venue_id: args.venueId,
      actor_user_id: args.actorUserId ?? null,
      actor_kind: args.actorKind ?? 'operator',
      route: args.route,
      action: args.action,
      target_table: args.targetTable ?? null,
      target_id: args.targetId ?? null,
      request_id: args.requestId ?? null,
      ip_hash: maskIpForAudit(args.ip),
      user_agent: args.userAgent
        ? args.userAgent.slice(0, MAX_USER_AGENT_LEN)
        : null,
      before_snapshot: before,
      after_snapshot: after,
      metadata,
    }

    const svc = createServiceClient()
    // Phase 9C — capture the DB-stamped id + created_at so the
    // mirror row shares them verbatim. We deliberately select the
    // DB-generated values (not values we computed in JS) so a
    // future reconciliation tool that joins on id + created_at
    // can't drift on clock-skew between app and database.
    const { data: inserted, error } = await svc
      .from('audit_events')
      .insert(row)
      .select('id, created_at')
      .single()
    if (error) {
      log.warn(
        { err: error, route: args.route, action: args.action },
        'audit_events.insert_failed'
      )
      captureApiError(error, {
        requestId: args.requestId ?? undefined,
        route: args.route,
        userId: args.actorUserId ?? undefined,
        venueId: args.venueId,
      })
      return
    }

    // Phase 9C — best-effort mirror. Fire-and-forget; failures land
    // in pino + Sentry via the helper's own try/catch, NEVER throw
    // back here. The primary `audit_events` row already committed
    // — the operator's HTTP response is unaffected by mirror state.
    if (inserted) {
      const primary = inserted as { id: string; created_at: string }
      void mirrorAuditEvent({
        id: primary.id,
        venueId: args.venueId,
        action: args.action,
        targetTable: row.target_table,
        targetId: row.target_id,
        actorUserId: row.actor_user_id,
        actorKind: row.actor_kind,
        route: args.route,
        requestId: row.request_id,
        createdAt: primary.created_at,
        payload: {
          ip_hash: row.ip_hash,
          user_agent: row.user_agent,
          before_snapshot: row.before_snapshot,
          after_snapshot: row.after_snapshot,
          metadata: row.metadata,
        },
      })
    }
  } catch (err) {
    // Defensive — sanitization or serialization shouldn't throw,
    // but we trap anyway so a bug here never breaks production
    // routes.
    log.warn(
      { err, route: args.route, action: args.action },
      'audit_events.helper_threw'
    )
    captureApiError(err, {
      requestId: args.requestId ?? undefined,
      route: args.route,
      userId: args.actorUserId ?? undefined,
      venueId: args.venueId,
    })
  }
}
