import 'server-only'
import { createServiceClient } from '@/lib/supabase/service'
import { log } from '@/lib/log'
import { captureApiError } from '@/lib/observability/sentry'

/**
 * Phase 8T — operator digest cadence model.
 *
 * Stored on `subscriptions.metadata.digest_cadence`. Three values:
 *   - `'daily'`  → cron sends every morning.
 *   - `'weekly'` → cron sends only on Monday UTC.
 *   - `'off'`   → cron skips entirely.
 *
 * ── BACKWARD COMPATIBILITY ────────────────────────────────────────────────
 * Phase 8S shipped a binary opt-out via `metadata.digest_disabled = true`.
 * Phase 8T promotes that to a cadence field, but keeps the legacy flag
 * working:
 *
 *   - `digest_disabled === true`   → coerced to cadence `'off'` regardless
 *     of what `digest_cadence` says.
 *   - Missing cadence + no `digest_disabled` → default cadence `'daily'`.
 *   - Setting cadence to `'off'` ALSO writes `digest_disabled = true` +
 *     `digest_disabled_at` so legacy callers / dashboards reading the
 *     flag stay coherent.
 *   - Setting cadence to `'daily'` or `'weekly'` REMOVES `digest_disabled`
 *     + `digest_disabled_at` so the venue genuinely flips back on.
 *
 * This lets the unsubscribe link from Phase 8S continue to work (it now
 * sets BOTH `digest_disabled = true` AND `digest_cadence = 'off'`) and
 * gives admins a more expressive surface on the billing settings page.
 *
 * `server-only` because the writer uses the service-role client.
 */

export type DigestCadence = 'daily' | 'weekly' | 'off'
export type DigestWeeklyDay = 'sun' | 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat'

export const DIGEST_CADENCES: readonly DigestCadence[] = ['daily', 'weekly', 'off']
export const DIGEST_WEEKLY_DAYS: readonly DigestWeeklyDay[] = [
  'sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat',
]
const DEFAULT_WEEKLY_DAY: DigestWeeklyDay = 'mon'

export function isDigestCadence(v: unknown): v is DigestCadence {
  return v === 'daily' || v === 'weekly' || v === 'off'
}

export function isDigestWeeklyDay(v: unknown): v is DigestWeeklyDay {
  return (
    v === 'sun' || v === 'mon' || v === 'tue' || v === 'wed' ||
    v === 'thu' || v === 'fri' || v === 'sat'
  )
}

// `Date.getUTCDay()` returns 0..6 (Sun..Sat). Map back to our string code.
const UTC_DAY_TO_CODE: readonly DigestWeeklyDay[] = [
  'sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat',
]

export function weeklyDayLabel(day: DigestWeeklyDay): string {
  switch (day) {
    case 'sun': return 'Sunday'
    case 'mon': return 'Monday'
    case 'tue': return 'Tuesday'
    case 'wed': return 'Wednesday'
    case 'thu': return 'Thursday'
    case 'fri': return 'Friday'
    case 'sat': return 'Saturday'
  }
}

/**
 * Resolve the effective cadence from a subscription's metadata.
 *
 * Priority (highest first):
 *   1. `digest_disabled === true` → always `'off'` (legacy compat).
 *   2. `digest_cadence` if it's a valid enum value.
 *   3. Default `'daily'`.
 */
export function getDigestCadence(
  metadata: Record<string, unknown> | null | undefined
): DigestCadence {
  if (!metadata) return 'daily'
  if (metadata.digest_disabled === true) return 'off'
  const v = metadata.digest_cadence
  if (isDigestCadence(v)) return v
  return 'daily'
}

/**
 * Pure send-decision helper used by the cron. Takes the effective
 * cadence + a `now` Date and returns whether to send.
 *
 * - `'off'`   → never.
 * - `'daily'` → always.
 * - `'weekly'`→ only on Monday UTC (`getUTCDay() === 1`).
 *
 * Exported for unit-test access.
 */
export function shouldSendDigestForCadence(
  cadence: DigestCadence,
  now: Date
): boolean {
  if (cadence === 'off') return false
  if (cadence === 'daily') return true
  // 'weekly': Monday UTC. Sunday is 0, Monday is 1, ... Saturday is 6.
  return now.getUTCDay() === 1
}

// ============================================================================
// Writer — used by the admin POST + the unsubscribe route
// ============================================================================

export interface SetDigestCadenceResult {
  ok: boolean
  /** Present on success. */
  subscriptionId?: string
  /** One of: 'subscription_not_found' | 'lookup_failed' | 'update_failed'. */
  reason?: 'subscription_not_found' | 'lookup_failed' | 'update_failed'
}

/**
 * Update the latest subscription row for a venue to the requested
 * cadence. Preserves every unrelated metadata key + maintains the
 * legacy `digest_disabled` flag in sync.
 *
 *   cadence='off'              → cadence + digest_disabled=true + digest_disabled_at
 *   cadence='daily'|'weekly'   → cadence; strips digest_disabled + digest_disabled_at
 *
 * Never throws — returns a typed result. The caller maps reasons to
 * HTTP status codes / log lines.
 */
export async function setDigestCadenceForVenue(
  venueId: string,
  cadence: DigestCadence,
  requestId?: string
): Promise<SetDigestCadenceResult> {
  const svc = createServiceClient()
  const reqLog = log.child({
    requestId,
    venueId,
    cadence,
    op: 'operator_digest.set_cadence',
  })

  // 1. Read the latest subscription row (same priority as the rest of
  // the operator surface — most-recently-created wins).
  const { data: subRaw, error: subErr } = await svc
    .from('subscriptions')
    .select('id, metadata')
    .eq('venue_id', venueId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (subErr) {
    reqLog.error({ err: subErr }, 'operator_digest.cadence_lookup_failed')
    captureApiError(subErr, {
      requestId,
      route: 'operator_digest.setDigestCadenceForVenue',
      venueId,
    })
    return { ok: false, reason: 'lookup_failed' }
  }
  if (!subRaw) {
    reqLog.info({}, 'operator_digest.cadence_no_subscription')
    return { ok: false, reason: 'subscription_not_found' }
  }

  const row = subRaw as { id: string; metadata: Record<string, unknown> | null }
  const baseMetadata = (row.metadata ?? {}) as Record<string, unknown>

  // 2. Build the next metadata.
  const next: Record<string, unknown> = { ...baseMetadata }
  next.digest_cadence = cadence
  if (cadence === 'off') {
    next.digest_disabled = true
    next.digest_disabled_at = new Date().toISOString()
  } else {
    // Re-enabling — strip the legacy disabled flags. Everything else
    // (notably `tour_pause_history`, `stripe_subscription_id`, etc.)
    // survives.
    delete next.digest_disabled
    delete next.digest_disabled_at
  }

  const { error: updateErr } = await svc
    .from('subscriptions')
    .update({ metadata: next })
    .eq('id', row.id)

  if (updateErr) {
    reqLog.error({ err: updateErr, subscriptionId: row.id }, 'operator_digest.cadence_update_failed')
    captureApiError(updateErr, {
      requestId,
      route: 'operator_digest.setDigestCadenceForVenue',
      venueId,
    })
    return { ok: false, reason: 'update_failed' }
  }

  reqLog.info({ subscriptionId: row.id }, 'operator_digest.cadence_updated')
  return { ok: true, subscriptionId: row.id }
}

// ============================================================================
// Phase 8U — per-user (venue_member) preferences
// ============================================================================

/**
 * Phase 8U — read just the cadence value from arbitrary metadata
 * (member or subscription). Returns null when the field is absent or
 * not a recognized enum value, so the caller can fall through to the
 * next source in the priority chain.
 */
export function getDigestCadenceFromMetadata(
  metadata: unknown
): DigestCadence | null {
  if (!metadata || typeof metadata !== 'object') return null
  const v = (metadata as Record<string, unknown>).digest_cadence
  return isDigestCadence(v) ? v : null
}

/**
 * Phase 8U — read just the weekly day from arbitrary metadata.
 * Returns null when absent or invalid.
 */
export function getDigestWeeklyDayFromMetadata(
  metadata: unknown
): DigestWeeklyDay | null {
  if (!metadata || typeof metadata !== 'object') return null
  const v = (metadata as Record<string, unknown>).digest_weekly_day
  return isDigestWeeklyDay(v) ? v : null
}

/**
 * Phase 8U — the effective-preference resolver used by the cron's
 * per-member fan-out.
 *
 * Priority (highest first):
 *   1. `memberMetadata.digest_cadence` (per-user preference)
 *   2. `subscriptionMetadata.digest_cadence` (venue-level)
 *   3. `subscriptionMetadata.digest_disabled === true` → `'off'`
 *      (legacy Phase 8S flag)
 *   4. Default `'daily'`
 *
 * Weekly-day source mirrors the cadence source: if the cadence comes
 * from member metadata, use the member's weekly_day; if it comes from
 * subscription metadata, use the subscription's. When cadence resolves
 * to `'weekly'` and no weekly_day is set anywhere, default to
 * `'mon'` (Monday UTC).
 *
 * `shouldSend` collapses cadence + the current UTC day into a single
 * boolean; `reason` provides the operator-facing skip code so the cron
 * can log the right event.
 */
export function resolveEffectiveDigestPreference(args: {
  memberMetadata: unknown
  subscriptionMetadata: unknown
  now?: Date
}): {
  cadence: DigestCadence
  weeklyDay: DigestWeeklyDay | null
  shouldSend: boolean
  reason: 'send' | 'off' | 'weekly_wrong_day'
  source: 'member' | 'subscription' | 'legacy_disabled' | 'default'
} {
  const memberCadence = getDigestCadenceFromMetadata(args.memberMetadata)
  const subCadence = getDigestCadenceFromMetadata(args.subscriptionMetadata)

  let cadence: DigestCadence
  let source: 'member' | 'subscription' | 'legacy_disabled' | 'default'

  if (memberCadence) {
    cadence = memberCadence
    source = 'member'
  } else if (subCadence) {
    cadence = subCadence
    source = 'subscription'
  } else if (
    args.subscriptionMetadata &&
    typeof args.subscriptionMetadata === 'object' &&
    (args.subscriptionMetadata as Record<string, unknown>).digest_disabled === true
  ) {
    cadence = 'off'
    source = 'legacy_disabled'
  } else {
    cadence = 'daily'
    source = 'default'
  }

  // Weekly day is only meaningful when cadence === 'weekly'. Source
  // matches whichever side of the chain provided the cadence so the
  // operator's mental model ("my preference / venue preference") stays
  // coherent.
  let weeklyDay: DigestWeeklyDay | null = null
  if (cadence === 'weekly') {
    weeklyDay =
      source === 'member'
        ? getDigestWeeklyDayFromMetadata(args.memberMetadata) ?? DEFAULT_WEEKLY_DAY
        : getDigestWeeklyDayFromMetadata(args.subscriptionMetadata) ??
          DEFAULT_WEEKLY_DAY
  }

  if (cadence === 'off') {
    return { cadence, weeklyDay, shouldSend: false, reason: 'off', source }
  }
  if (cadence === 'daily') {
    return { cadence, weeklyDay, shouldSend: true, reason: 'send', source }
  }
  // weekly
  const now = args.now ?? new Date()
  const todayCode = UTC_DAY_TO_CODE[now.getUTCDay()]
  if (todayCode !== weeklyDay) {
    return { cadence, weeklyDay, shouldSend: false, reason: 'weekly_wrong_day', source }
  }
  return { cadence, weeklyDay, shouldSend: true, reason: 'send', source }
}

// ============================================================================
// Per-user writer
// ============================================================================

export interface SetMemberDigestPreferenceArgs {
  venueId: string
  userId: string
  cadence: DigestCadence
  weeklyDay?: DigestWeeklyDay | null
  requestId?: string
}

export type SetMemberDigestPreferenceResult =
  | { ok: true; metadata: Record<string, unknown> }
  | { ok: false; error: 'member_not_found' | 'lookup_failed' | 'update_failed' }

/**
 * Phase 8U — write a per-user digest preference into the matching
 * `venue_members.metadata` row.
 *
 * Cadence-specific behavior:
 *   - cadence='off'    → set `digest_cadence='off'` + `digest_disabled_at=now`;
 *                        REMOVE `digest_weekly_day`.
 *   - cadence='daily'  → set `digest_cadence='daily'`; REMOVE
 *                        `digest_disabled_at` + `digest_weekly_day`.
 *   - cadence='weekly' → set `digest_cadence='weekly'` +
 *                        `digest_weekly_day = weeklyDay ?? 'mon'`;
 *                        REMOVE `digest_disabled_at`.
 *
 * Preserves every unrelated metadata key.
 * Never throws — returns a typed `Result`. Service-role write so the
 * caller doesn't need to thread a Supabase client through.
 */
export async function setMemberDigestPreference(
  args: SetMemberDigestPreferenceArgs
): Promise<SetMemberDigestPreferenceResult> {
  const svc = createServiceClient()
  const reqLog = log.child({
    requestId: args.requestId,
    venueId: args.venueId,
    userId: args.userId,
    cadence: args.cadence,
    op: 'operator_digest.set_member_preference',
  })

  // 1. Load the existing member row so we can preserve unrelated keys.
  const { data: memberRaw, error: memberErr } = await svc
    .from('venue_members')
    .select('venue_id, user_id, metadata')
    .eq('venue_id', args.venueId)
    .eq('user_id', args.userId)
    .maybeSingle()

  if (memberErr) {
    reqLog.error({ err: memberErr }, 'operator_digest.member_lookup_failed')
    captureApiError(memberErr, {
      requestId: args.requestId,
      route: 'operator_digest.setMemberDigestPreference',
      venueId: args.venueId,
    })
    return { ok: false, error: 'lookup_failed' }
  }
  if (!memberRaw) {
    reqLog.info({}, 'operator_digest.member_not_found')
    return { ok: false, error: 'member_not_found' }
  }

  const baseMetadata =
    ((memberRaw as { metadata: Record<string, unknown> | null }).metadata ?? {}) as
      Record<string, unknown>
  const next: Record<string, unknown> = { ...baseMetadata }

  // 2. Apply the cadence-specific transform.
  next.digest_cadence = args.cadence
  if (args.cadence === 'off') {
    next.digest_disabled_at = new Date().toISOString()
    delete next.digest_weekly_day
  } else if (args.cadence === 'daily') {
    delete next.digest_disabled_at
    delete next.digest_weekly_day
  } else {
    // weekly
    next.digest_weekly_day =
      args.weeklyDay && isDigestWeeklyDay(args.weeklyDay)
        ? args.weeklyDay
        : DEFAULT_WEEKLY_DAY
    delete next.digest_disabled_at
  }

  const { error: updateErr } = await svc
    .from('venue_members')
    .update({ metadata: next })
    .eq('venue_id', args.venueId)
    .eq('user_id', args.userId)

  if (updateErr) {
    reqLog.error({ err: updateErr }, 'operator_digest.member_update_failed')
    captureApiError(updateErr, {
      requestId: args.requestId,
      route: 'operator_digest.setMemberDigestPreference',
      venueId: args.venueId,
    })
    return { ok: false, error: 'update_failed' }
  }

  reqLog.info(
    { weeklyDay: next.digest_weekly_day ?? null },
    'operator_digest.member_preference_updated'
  )
  return { ok: true, metadata: next }
}
