import 'server-only'
import { inngest } from '../client'
import { createServiceClient } from '@/lib/supabase/service'
import { sendEmail } from '@/lib/integrations/email'
import {
  createDigestUnsubscribeUrl,
  createDigestResubscribeUrl,
  digestUnsubscribeSecretConfigured,
  DigestUnsubscribeTokenError,
} from '@/lib/integrations/digest-unsubscribe-token'
import {
  getDigestCadence,
  shouldSendDigestForCadence,
  resolveEffectiveDigestPreference,
  weeklyDayLabel,
  type DigestCadence,
  type DigestWeeklyDay,
} from '@/lib/billing/operator-digest-preferences'
import { log } from '@/lib/log'
import { captureJobError } from '@/lib/observability/sentry'
import { recordDigestAuditEvent } from '@/lib/billing/digest-audit-events'
import {
  composeRevenueOsDigestSummary,
  summaryHasActionableContent,
  type RevenueOsDigestSummary,
  type RevenueOsDigestLeadSlice,
} from '@/lib/revenue-os/digest-summary'
import { parseRevenueOsSettings } from '@/lib/revenue-os/settings'
import {
  isLostReason,
  LOST_REASON_LABEL,
  type LostReason,
} from '@/lib/revenue-os/reactivation'
import type {
  LeakageInboundActivity,
  LeakageOutboundActivity,
  LeakageTour,
} from '@/lib/revenue-os/leakage'

// Phase 8S — once-per-process guard for the "DIGEST_UNSUBSCRIBE_SECRET
// missing" warn. Same pattern as the Phase 8K tour-action secret check
// inside tour-notifications.ts.
let _missingUnsubSecretWarned = false

/**
 * Phase 8R — daily operator activity digest.
 *
 * Scans `public.tour_status_events` for the last 24 hours, groups by
 * venue, and emails the venue owner a compact summary: total events,
 * counts by action, counts by actor_kind, and a link to
 * `/dashboard/settings/billing` where the full audit feed lives.
 *
 * ── SAFETY POSTURE ────────────────────────────────────────────────────────
 * Hard-gated by `OPERATOR_DIGEST_ENABLED === '1'`. With the flag absent
 * or any other value, `runDigestScan()` short-circuits to
 * `{ skipped: true, reason: 'disabled' }` before any DB read. This
 * mirrors the Phase 8N `TOUR_STATUS_BACKFILL` pattern — operators opt
 * in explicitly per environment.
 *
 * Cron schedule `0 8 * * *` (daily 8am UTC). Operators with cleaner
 * regional preferences can adjust at deploy time.
 *
 * ── IDEMPOTENCY ───────────────────────────────────────────────────────────
 * Best-effort de-dup via `outbound_messages`: before sending, we look
 * for an existing row with the same venue + lead/owner identity + a
 * digest marker (`metadata.tour_digest_date` = today's UTC date). If
 * one is found, we skip. The window is small enough that a true race
 * (cron fired twice in the same minute) wouldn't be caught — that's an
 * accepted trade-off documented in BILLING-QA §7u; a future migration
 * could add a proper `digest_sends` table for absolute single-send.
 *
 * ── FAILURE POSTURE ───────────────────────────────────────────────────────
 * - Per-venue failures NEVER abort the batch (mirrors the Phase 8F
 *   auto-pause cron).
 * - Provider errors + owner-lookup failures get `captureJobError` so
 *   operators see them in Sentry, but the summary returns normally.
 * - Returns `{ scannedVenues, sent, skipped, failed }` for the Inngest
 *   run summary.
 */

const SCHEDULE = '0 8 * * *' // daily 8am UTC
const LOOKBACK_HOURS = 24
const MAX_VENUES_PER_RUN = 200
// Phase 8U — cap per-venue fan-out so a misconfigured venue with
// dozens of admin/owner rows doesn't dominate a single cron run.
const MAX_RECIPIENTS_PER_VENUE = 10

interface RunSummary {
  scannedVenues: number
  sent: number
  skipped: number
  failed: number
}

interface DigestEventRow {
  venue_id: string
  action: string
  actor_kind: string
}

interface VenueAggregate {
  total: number
  byAction: Record<string, number>
  byActor: Record<string, number>
}

interface OwnerInfo {
  userId: string
  email: string
}

function digestEnabled(): boolean {
  return process.env.OPERATOR_DIGEST_ENABLED === '1'
}

/**
 * Phase 8AD — optional `digest_send_cron` audit-event writes. Default
 * off because a busy multi-venue deployment can produce a high audit-
 * row volume (one row per recipient per day). Operators who need
 * forensic "who got the digest at 8:03am UTC on Tuesday?" coverage
 * flip this on per environment.
 */
function cronAuditEnabled(): boolean {
  return process.env.DIGEST_AUDIT_LOG_CRON_SENDS === '1'
}

/** Email-mask helper matching the Phase 8Y format. */
function maskEmail(addr: string | null | undefined): string | null {
  if (!addr || typeof addr !== 'string') return null
  const at = addr.indexOf('@')
  if (at < 1) return null
  return `${addr.slice(0, 1)}***${addr.slice(at)}`
}

function isoDateUtc(d: Date): string {
  return d.toISOString().slice(0, 10)
}

/**
 * Look up the earliest owner of a venue + resolve their email via the
 * Supabase Auth admin. Mirrors the helper used by Phase 7K dunning +
 * Phase 7M recovery + Phase 7H trial reminder.
 *
 * Returns null on any lookup failure — the caller treats the venue as
 * "skip with no_owner_email" rather than escalating.
 */
async function findOwnerEmail(
  supabase: ReturnType<typeof createServiceClient>,
  venueId: string
): Promise<OwnerInfo | null> {
  const { data: memberRow, error: memberErr } = await supabase
    .from('venue_members')
    .select('user_id')
    .eq('venue_id', venueId)
    .eq('role', 'owner')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()

  if (memberErr || !memberRow) return null
  const userId = (memberRow as { user_id: string }).user_id

  try {
    const { data: userRes } = await supabase.auth.admin.getUserById(userId)
    const email = userRes.user?.email
    if (!email) return null
    return { userId, email }
  } catch {
    return null
  }
}

/**
 * Phase 8R idempotency probe — looks for an existing outbound_messages
 * row for this venue on today's UTC date with the digest marker.
 *
 * NOT a perfect single-send guarantee. Two crons firing within the
 * same minute would both probe + both find no row + both send. Real
 * deployments run a single Inngest worker per function, so this is a
 * narrow exposure; documented in BILLING-QA §7u.
 */
async function digestAlreadySentToday(
  supabase: ReturnType<typeof createServiceClient>,
  venueId: string,
  todayUtc: string
): Promise<boolean> {
  const { data, error } = await supabase
    .from('outbound_messages')
    .select('id')
    .eq('venue_id', venueId)
    .eq('related_table', 'tour_status_events')
    .filter('metadata->>tour_digest_date', 'eq', todayUtc)
    .limit(1)
    .maybeSingle()
  if (error) {
    // On lookup failure, fall through to a send. Worst case: an
    // operator gets a second digest. Acceptable; logging the lookup
    // failure is sufficient.
    log.warn(
      { err: error, venueId, todayUtc },
      'jobs.operator_activity_digest.idempotency_lookup_failed'
    )
    return false
  }
  return Boolean(data)
}

// ============================================================================
// Phase 8U — per-recipient helpers
// ============================================================================

interface DigestRecipient {
  userId: string
  email: string
  memberMetadata: Record<string, unknown> | null
}

/**
 * Phase 8U — fan-out roster. Loads every owner/admin member of the
 * venue, resolves each user's email via the Supabase Auth admin, and
 * returns the slice up to `MAX_RECIPIENTS_PER_VENUE`. Members without
 * a resolvable email are dropped silently.
 *
 * Phase 8V — switched from serial to bounded-concurrency (5) auth
 * lookups via Promise.allSettled. Supabase's `auth.admin.getUserById`
 * is one HTTP round-trip per call; a true batched endpoint
 * (`auth.admin.listUsers` with an id filter) DOES exist but the
 * filter expression syntax (`email.in.(…)`) doesn't accept user-id
 * arrays in the version we're pinned to, and switching to
 * `listUsers({ perPage: 1000 })` + client-side filter would tour
 * every auth user in the tenant on every cron tick — strictly worse
 * for tenants with > a few hundred users. Bounded concurrency is the
 * safe middle ground: a 10-recipient venue now finishes in roughly
 * the same wall-clock time as 2 serial calls, with per-failure
 * isolation.
 */
const RECIPIENT_LOOKUP_CONCURRENCY = 5

async function findDigestRecipients(
  supabase: ReturnType<typeof createServiceClient>,
  venueId: string,
  requestId?: string
): Promise<DigestRecipient[]> {
  const { data: rows, error } = await supabase
    .from('venue_members')
    .select('user_id, metadata')
    .eq('venue_id', venueId)
    .in('role', ['owner', 'admin'])
    .order('created_at', { ascending: true })
    .limit(MAX_RECIPIENTS_PER_VENUE)

  if (error || !rows) {
    log.warn(
      { err: error, venueId, requestId },
      'jobs.operator_activity_digest.recipients_lookup_failed'
    )
    return []
  }

  type MemberRow = { user_id: string; metadata: Record<string, unknown> | null }
  const memberRows = rows as MemberRow[]

  // Phase 8V — bounded-concurrency worker pool. Mirrors the
  // `runWithConcurrency` shape in `lib/integrations/tour-notifications.ts`
  // but kept local since the digest cron is the only caller; a third
  // call site would justify extraction.
  const out: DigestRecipient[] = new Array(memberRows.length)
  let cursor = 0
  async function worker(): Promise<void> {
    while (true) {
      const idx = cursor++
      if (idx >= memberRows.length) return
      const row = memberRows[idx]
      try {
        const { data: userRes } = await supabase.auth.admin.getUserById(row.user_id)
        const email = userRes.user?.email
        if (!email) continue
        out[idx] = {
          userId: row.user_id,
          email,
          memberMetadata: row.metadata ?? null,
        }
      } catch (err) {
        // Per-member lookup failure logs with userId + requestId (no
        // raw email, no PII) and skips that slot. The roster shrinks
        // by one but the venue's other recipients still get the
        // digest.
        log.warn(
          { err, userId: row.user_id, venueId, requestId },
          'operator_digest.recipient_lookup_failed'
        )
      }
    }
  }
  const workers = Array.from(
    { length: Math.min(RECIPIENT_LOOKUP_CONCURRENCY, memberRows.length) },
    () => worker()
  )
  await Promise.allSettled(workers)

  // Compact the sparse array — workers may have skipped slots due to
  // no-email or per-member failures.
  return out.filter((r): r is DigestRecipient => r !== undefined)
}

/**
 * Phase 8U → 8W — per-recipient idempotency probe. Looks for an
 * existing outbound_messages row for THIS venue + THIS user on today's
 * UTC date that was sent BY THE CRON (not by the Phase 8V preview or
 * any future manual operator send).
 *
 * Probe keys (Phase 8W):
 *   metadata->>'tour_digest_date'                = <today>
 *   metadata->>'tour_digest_recipient_user_id'   = <userId>
 *   metadata->>'tour_digest_send_kind'           = 'cron'
 *
 * The `send_kind` filter is the Phase 8W discriminator. Previews
 * deliberately write `send_kind='preview'` so this probe ignores them
 * — the cron should still send the day's real digest even if an
 * operator clicked "Send sample" earlier today.
 *
 * Same "fail open on lookup error" posture as the Phase 8R probe.
 */
async function digestAlreadySentToRecipientToday(
  supabase: ReturnType<typeof createServiceClient>,
  venueId: string,
  userId: string,
  todayUtc: string
): Promise<boolean> {
  const { data, error } = await supabase
    .from('outbound_messages')
    .select('id')
    .eq('venue_id', venueId)
    .eq('related_table', 'tour_status_events')
    .filter('metadata->>tour_digest_date', 'eq', todayUtc)
    .filter('metadata->>tour_digest_recipient_user_id', 'eq', userId)
    .filter('metadata->>tour_digest_send_kind', 'eq', 'cron')
    .limit(1)
    .maybeSingle()
  if (error) {
    log.warn(
      { err: error, venueId, userId, todayUtc },
      'jobs.operator_activity_digest.per_recipient_idempotency_lookup_failed'
    )
    return false
  }
  return Boolean(data)
}

function aggregateEvents(rows: DigestEventRow[]): Map<string, VenueAggregate> {
  const out = new Map<string, VenueAggregate>()
  for (const row of rows) {
    let agg = out.get(row.venue_id)
    if (!agg) {
      agg = { total: 0, byAction: {}, byActor: {} }
      out.set(row.venue_id, agg)
    }
    agg.total++
    agg.byAction[row.action] = (agg.byAction[row.action] ?? 0) + 1
    agg.byActor[row.actor_kind] = (agg.byActor[row.actor_kind] ?? 0) + 1
  }
  return out
}

function formatCountsBlock(counts: Record<string, number>): string {
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1])
  if (entries.length === 0) return '(none)'
  return entries.map(([k, v]) => `  - ${k}: ${v}`).join('\n')
}

/**
 * Phase 8X — send-kind discriminator. Mirrors the
 * `metadata.tour_digest_send_kind` value on the outbound row. Used by
 * the footer builder to decide which preference links to surface:
 *
 *   - 'cron'    — no resubscribe link (recipient cadence is never 'off'
 *                 on a successful cron send); unsubscribe link present.
 *   - 'preview' — both unsubscribe and resubscribe links present so the
 *                 operator can QA the full preference loop in one click.
 *   - 'manual'  — both links present; manual sends are operator-driven
 *                 and the recipient may need either action.
 */
export type DigestSendKind = 'cron' | 'preview' | 'manual'

interface DigestBodyArgs {
  venueName: string | null
  venueId: string
  agg: VenueAggregate
  appUrl: string
  /** Phase 8S — optional opt-out URL, absent when the secret isn't configured. */
  unsubscribeUrl?: string | null
  /**
   * Phase 8X — optional per-user resubscribe URL. Always omitted on
   * cron sends (recipient is by definition opted-in when cron sends).
   * Always present on preview / manual when the secret is configured.
   */
  resubscribeUrl?: string | null
  /**
   * Phase 8T — current cadence for the venue. Surfaced in the email
   * footer so operators always know which schedule they're on.
   * Defaults to `'daily'` when omitted for back-compat.
   */
  cadence?: DigestCadence
  /**
   * Phase 8U — when cadence is `'weekly'`, the day-of-week (UTC) the
   * recipient is scheduled to receive the digest. Surfaced in the
   * footer so the operator knows which day they'll see this next.
   */
  weeklyDay?: DigestWeeklyDay | null
  /**
   * Phase 8X — discriminator. Defaults to `'cron'` for back-compat
   * with the Phase 8R/8S call sites that constructed body args before
   * this field existed.
   */
  sendKind?: DigestSendKind
  /**
   * Phase 8AU — Revenue OS digest summary. Optional for back-compat
   * with legacy callers (tests, ad-hoc reruns). When present, the
   * body builders lead with the Revenue OS sections — speed-to-lead,
   * follow-up recovery, tour booking, leakage snapshot — and demote
   * the operator activity log to a "log" section lower in the email.
   * When absent, the builders render the legacy
   * tour_status_events-only content.
   */
  revenueOs?: RevenueOsDigestSummary | null
}

function cadenceSentence(
  c: DigestCadence | undefined,
  weeklyDay: DigestWeeklyDay | null | undefined
): string {
  switch (c) {
    case 'weekly': {
      const day = weeklyDay ?? 'mon'
      return `You are receiving weekly activity summaries every ${weeklyDayLabel(day)}.`
    }
    case 'off':
      // Shouldn't reach the body builder when cadence is 'off' (the
      // cron skips before send), but render a coherent string anyway
      // for any test/preview caller that constructs this directly.
      return 'You are not currently subscribed to activity summaries.'
    case 'daily':
    case undefined:
    default:
      return 'You are receiving daily activity summaries.'
  }
}

/**
 * Phase 8R + 8S + 8X — plain-text digest body. Stays the canonical
 * fallback for clients that strip HTML.
 *
 * Phase 8X — footer now always includes a "Manage your digest
 * preferences" pointer at `${appUrl}/dashboard/settings/billing`, and
 * conditionally includes:
 *   - Unsubscribe link (any sendKind, when secret configured)
 *   - Re-enable daily digest link (preview / manual only, when secret
 *     configured) — cron is skipped because cadence is never 'off' on
 *     a successful cron send, so the link would just add clutter.
 */
function buildOperatorDigestText(args: DigestBodyArgs): string {
  const venueLabel = args.venueName?.trim() || `Venue ${args.venueId.slice(0, 8)}`
  const settingsUrl = `${args.appUrl}/dashboard/settings/billing`
  const dashboardUrl = `${args.appUrl}/dashboard`
  const recoveryUrl = `${args.appUrl}/dashboard/leads?leakage=follow_up_recovery`
  const tourBookingUrl = `${args.appUrl}/dashboard/leads?leakage=tour_booking`
  const sendKind: DigestSendKind = args.sendKind ?? 'cron'
  const includeResubscribe = sendKind !== 'cron' && Boolean(args.resubscribeUrl)
  const summary = args.revenueOs ?? null

  const unsubBlock = args.unsubscribeUrl
    ? `\nNo longer want these summaries? Unsubscribe:\n${args.unsubscribeUrl}\n`
    : ''
  const resubBlock = includeResubscribe
    ? `\nRe-enable Revenue OS digest:\n${args.resubscribeUrl}\n`
    : ''

  // Phase 8AU — the new Revenue OS-first body. When the caller
  // supplies a `revenueOs` summary (cron, preview, manual all do as
  // of Phase 8AU), we lead with revenue language. The legacy
  // tour-activity-only body remains the fallback for any caller that
  // hasn't been upgraded (mostly unit tests).
  if (summary) {
    const opening =
      summary.leakage.totalAttentionItems > 0
        ? `${summary.leakage.totalAttentionItems} revenue opportunit${summary.leakage.totalAttentionItems === 1 ? 'y' : 'ies'} need${summary.leakage.totalAttentionItems === 1 ? 's' : ''} attention today.`
        : 'No urgent leakage detected today. Keep response speed tight.'
    const topRisk = summary.leakage.topPriorityLabel
      ? `Top risk: ${summary.leakage.topPriorityLabel}.\n`
      : ''

    const speed = summary.speedToLead
    const speedBlock = [
      `SPEED-TO-LEAD (last 7 days)`,
      `Median first reply: ${
        speed.medianMinutesToFirstReply === null
          ? '—'
          : `${speed.medianMinutesToFirstReply} min`
      }`,
      `SLA hit rate: ${
        speed.metRate === null ? '—' : `${Math.round(speed.metRate * 100)}%`
      }`,
      `${speed.pendingOverdue} lead${speed.pendingOverdue === 1 ? '' : 's'} overdue for first reply`,
      speed.totalMeasured > 0
        ? `Leads measured: ${speed.totalMeasured}`
        : null,
    ]
      .filter((s): s is string => s !== null)
      .join('\n')

    const recovery = summary.recovery
    const recoveryHeader = `FOLLOW-UP RECOVERY\nStalled leads: ${recovery.stalledLeads} (${recovery.highFitStalled} high-fit)`
    const recoveryRows =
      recovery.topLeads.length > 0
        ? `\nTop stalled leads:\n${recovery.topLeads
            .map(
              (r) =>
                `  - ${r.name} · ${r.lead_score ?? '—'} score · ${r.suggested_action_title}`
            )
            .join('\n')}`
        : `\n(Nobody stalled — keep nurturing.)`

    const tour = summary.tourBooking
    const tourHeader = `TOUR BOOKING\nQualified leads without tours: ${tour.qualifiedNoTour}\nUnconfirmed tours: ${tour.unconfirmedTours}\nTours today: ${tour.toursToday}`
    const tourRows =
      tour.topUnconfirmed.length > 0
        ? `\nNext unconfirmed tours:\n${tour.topUnconfirmed
            .map(
              (t) =>
                `  - ${t.name}${t.scheduled_at ? ` · ${formatScheduledLine(t.scheduled_at)}` : ''}`
            )
            .join('\n')}`
        : ''

    // Phase 8BD — Reactivation candidates this week. Counts + top
    // 3 lost leads. Operator-supplied reasons only; no autonomous
    // outreach (the body explicitly says so via the section copy).
    const react = summary.reactivation
    const reactivationBlock =
      react.candidateCount > 0
        ? `REACTIVATION CANDIDATES THIS WEEK\nCandidates: ${react.candidateCount} (${react.strongCount} strong)\nTop leads:\n${react.topLeads
            .map((r) => {
              const reasonLabel = r.reason ? LOST_REASON_LABEL[r.reason] : 'No reason recorded'
              return `  - ${r.name} · ${reasonLabel}`
            })
            .join('\n')}\nOpen the queue: ${args.appUrl}/dashboard/leads?leakage=reactivation`
        : `REACTIVATION CANDIDATES THIS WEEK\n(No reactivation candidates this week — nothing cooled long enough yet.)`

    const activityHeader = `OPERATOR ACTIVITY LOG (24h)`
    const activityBlock =
      args.agg.total === 0
        ? `${activityHeader}\n(No tour status events in the last 24h.)`
        : `${activityHeader}\nTotal events: ${args.agg.total}\n\nBy action:\n${formatCountsBlock(args.agg.byAction)}\n\nBy actor:\n${formatCountsBlock(args.agg.byActor)}`

    return (
      `Hi there,\n\n` +
      `Here's where your venue may be leaking revenue and where the team should focus next.\n\n` +
      `Venue: ${venueLabel}\n\n` +
      `REVENUE LEAKAGE SNAPSHOT\n${opening}\n${topRisk}\n` +
      `${speedBlock}\n\n` +
      `${recoveryHeader}${recoveryRows}\n\n` +
      `${tourHeader}${tourRows}\n\n` +
      `${reactivationBlock}\n\n` +
      `${activityBlock}\n\n` +
      `OPEN IN THE DASHBOARD\nRevenue OS overview: ${dashboardUrl}\nRecovery queue: ${recoveryUrl}\nTour Booking queue: ${tourBookingUrl}\nReactivation queue: ${args.appUrl}/dashboard/leads?leakage=reactivation\nFull audit feed (admins only): ${settingsUrl}\n` +
      `\nManage your Revenue OS digest preferences from Billing Settings:\n${settingsUrl}\n` +
      unsubBlock +
      resubBlock +
      `\n${cadenceSentence(args.cadence, args.weeklyDay)}` +
      `\nReply to this email if you'd like us to dial the digest cadence or scope.`
    )
  }

  // Legacy fallback (no Revenue OS summary supplied).
  return (
    `Hi there,\n\n` +
    `Here's your VenueRise tour activity for the last 24 hours.\n\n` +
    `Venue: ${venueLabel}\n` +
    `Total events: ${args.agg.total}\n\n` +
    `By action:\n${formatCountsBlock(args.agg.byAction)}\n\n` +
    `By actor:\n${formatCountsBlock(args.agg.byActor)}\n\n` +
    `Full audit feed (admins only):\n${settingsUrl}\n` +
    `\nManage your digest preferences from Billing Settings:\n${settingsUrl}\n` +
    unsubBlock +
    resubBlock +
    `\n${cadenceSentence(args.cadence, args.weeklyDay)}` +
    `\nReply to this email if you'd like us to dial the digest cadence or scope.`
  )
}

/**
 * Phase 8AU — format a UTC-ish scheduled timestamp into a compact
 * "Mon, Mar 4 · 2:30 PM" string suitable for plaintext digest rows.
 * Falls back to the raw ISO when the input doesn't parse.
 */
function formatScheduledLine(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const weekday = d.toLocaleDateString(undefined, { weekday: 'short' })
  const date = d.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  })
  const time = d.toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  })
  return `${weekday}, ${date} · ${time}`
}

// Backward-compat alias for any existing caller. Phase 8S renamed to
// `buildOperatorDigestText` so the HTML counterpart's name stays
// symmetric.
const buildDigestBody = buildOperatorDigestText

// ---------------------------------------------------------------------------
// Phase 8S — HTML template
// ---------------------------------------------------------------------------

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function htmlCountsRows(counts: Record<string, number>): string {
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1])
  if (entries.length === 0) {
    return `<tr><td colspan="2" style="padding:10px 16px;font-size:12px;color:#94A3B8;">(none)</td></tr>`
  }
  return entries
    .map(
      ([k, v]) => `<tr>
  <td style="padding:8px 16px;border-bottom:1px solid #F1F5F9;font-size:12px;color:#475569;width:60%;">${escapeHtml(k)}</td>
  <td style="padding:8px 16px;border-bottom:1px solid #F1F5F9;font-size:13px;color:#0F172A;font-weight:600;text-align:right;">${v}</td>
</tr>`
    )
    .join('')
}

/**
 * Phase 8S — Outlook-safe HTML digest body. Mirrors the visual
 * identity of the Phase 8L tour notification template:
 *   - Slate page background
 *   - White rounded card
 *   - Brand-blue total chip
 *   - Two stacked tables for action / actor counts
 *   - Inline CSS only, no external assets, max-width 480px
 *
 * Pure function — easy to unit test independently of `sendEmail`.
 */
export function buildOperatorDigestHtml(args: DigestBodyArgs): string {
  const venueLabel = args.venueName?.trim() || `Venue ${args.venueId.slice(0, 8)}`
  const settingsUrl = `${args.appUrl}/dashboard/settings/billing`
  const dashboardUrl = `${args.appUrl}/dashboard`
  const recoveryUrl = `${args.appUrl}/dashboard/leads?leakage=follow_up_recovery`
  const tourBookingUrl = `${args.appUrl}/dashboard/leads?leakage=tour_booking`
  const dateStr = new Date().toUTCString().replace(/ \d{2}:\d{2}:\d{2} GMT$/, ' UTC')
  const sendKind: DigestSendKind = args.sendKind ?? 'cron'
  const includeResubscribe = sendKind !== 'cron' && Boolean(args.resubscribeUrl)
  const summary = args.revenueOs ?? null

  // Phase 8X — explicit "Manage your digest preferences" pointer in the
  // footer. Mirrors the plaintext block; same href as the "View full
  // audit" CTA but framed as the preference surface, so operators who
  // received the email instead of opening the app know where to go.
  const settingsLine = `<p style="margin:0 0 6px 0;font-size:11px;line-height:1.55;color:#94A3B8;">
         <a href="${escapeHtml(settingsUrl)}" style="color:#1D4ED8;text-decoration:underline;">Manage your digest preferences</a> from Billing Settings.
       </p>`

  const unsubLine = args.unsubscribeUrl
    ? `<p style="margin:0 0 6px 0;font-size:11px;line-height:1.55;color:#94A3B8;">
         Don't want these summaries? <a href="${escapeHtml(args.unsubscribeUrl)}" style="color:#64748B;text-decoration:underline;">Unsubscribe</a>.
       </p>`
    : ''
  const resubLine = includeResubscribe
    ? `<p style="margin:0;font-size:11px;line-height:1.55;color:#94A3B8;">
         <a href="${escapeHtml(args.resubscribeUrl as string)}" style="color:#1D4ED8;text-decoration:underline;">Re-enable daily digest</a> for your account.
       </p>`
    : ''

  // Phase 8AU — Revenue OS-first inner body. Falls back to the
  // legacy tour-activity block when no `summary` is supplied.
  const inner = summary
    ? renderRevenueOsInnerHtml({
        summary,
        venueLabel,
        dateStr,
        agg: args.agg,
        settingsUrl,
        dashboardUrl,
        recoveryUrl,
        tourBookingUrl,
      })
    : renderLegacyInnerHtml({ venueLabel, dateStr, agg: args.agg, settingsUrl })

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${summary ? 'Your VenueRise Revenue OS summary' : 'VenueRise daily activity summary'}</title>
</head>
<body style="margin:0;padding:0;background:#F4F6FB;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#0F172A;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F4F6FB;padding:32px 16px;">
  <tr>
    <td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#FFFFFF;border:1px solid #E2E8F0;border-radius:20px;box-shadow:0 4px 14px rgba(15,23,42,0.06);">
        ${inner}
        <tr>
          <td style="padding:0 28px 24px 28px;">
            <p style="margin:0 0 6px 0;font-size:12px;line-height:1.5;color:#475569;">
              ${escapeHtml(cadenceSentence(args.cadence, args.weeklyDay))}
            </p>
            <p style="margin:0 0 8px 0;font-size:12px;line-height:1.5;color:#64748B;">
              Reply to this email if you'd like us to dial the digest cadence or scope.
            </p>
            ${settingsLine}
            ${unsubLine}
            ${resubLine}
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`
}

/**
 * Phase 8AU — render the legacy "tour activity only" inner table
 * body. Used as a fallback when no Revenue OS summary is supplied.
 */
function renderLegacyInnerHtml(args: {
  venueLabel: string
  dateStr: string
  agg: VenueAggregate
  settingsUrl: string
}): string {
  return `<tr>
          <td style="padding:28px 28px 8px 28px;">
            <p style="margin:0 0 4px 0;font-size:13px;color:#64748B;">Hi there,</p>
            <h1 style="margin:0 0 12px 0;font-size:20px;line-height:1.3;font-weight:600;color:#0F172A;">VenueRise daily activity summary</h1>
            <p style="margin:0 0 16px 0;font-size:13px;line-height:1.55;color:#475569;">
              Tour activity for <strong style="color:#0F172A;">${escapeHtml(args.venueLabel)}</strong> in the last 24 hours.
              <span style="color:#94A3B8;">${escapeHtml(args.dateStr)}</span>
            </p>
            <div style="display:inline-block;background:#EFF6FF;border:1px solid #BFDBFE;color:#1D4ED8;font-size:13px;font-weight:600;padding:6px 12px;border-radius:9999px;margin-bottom:20px;">
              ${args.agg.total} event${args.agg.total === 1 ? '' : 's'}
            </div>
          </td>
        </tr>
        <tr>
          <td style="padding:0 28px 12px 28px;">
            <p style="margin:0 0 6px 0;font-size:11px;color:#94A3B8;text-transform:uppercase;letter-spacing:0.06em;font-weight:600;">By action</p>
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F8FAFC;border:1px solid #E2E8F0;border-radius:12px;">
              ${htmlCountsRows(args.agg.byAction)}
            </table>
          </td>
        </tr>
        <tr>
          <td style="padding:0 28px 16px 28px;">
            <p style="margin:0 0 6px 0;font-size:11px;color:#94A3B8;text-transform:uppercase;letter-spacing:0.06em;font-weight:600;">By actor</p>
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F8FAFC;border:1px solid #E2E8F0;border-radius:12px;">
              ${htmlCountsRows(args.agg.byActor)}
            </table>
          </td>
        </tr>
        <tr>
          <td style="padding:8px 28px 20px 28px;text-align:center;">
            <a href="${escapeHtml(args.settingsUrl)}" style="display:inline-block;background:#0F172A;color:#FFFFFF;text-decoration:none;font-size:13px;font-weight:600;padding:10px 18px;border-radius:10px;box-shadow:0 2px 6px rgba(15,23,42,0.18);">View full audit</a>
          </td>
        </tr>`
}

/**
 * Phase 8AU — render the Revenue OS-first inner table body. Owner-
 * readable, premium-feel, Outlook-safe inline-CSS only. Sections,
 * in order:
 *   1. Headline + opening
 *   2. Revenue leakage snapshot (3 metric tiles)
 *   3. Speed-to-Lead numbers
 *   4. Follow-up Recovery top stalled leads
 *   5. Tour Booking + next unconfirmed tours
 *   6. CTAs (dashboard / recovery / tour-booking)
 *   7. Operator activity log (demoted; smaller font, slate background)
 */
function renderRevenueOsInnerHtml(args: {
  summary: RevenueOsDigestSummary
  venueLabel: string
  dateStr: string
  agg: VenueAggregate
  settingsUrl: string
  dashboardUrl: string
  recoveryUrl: string
  tourBookingUrl: string
}): string {
  const { summary } = args
  const opening =
    summary.leakage.totalAttentionItems > 0
      ? `<strong style="color:#0F172A;">${summary.leakage.totalAttentionItems} revenue opportunit${summary.leakage.totalAttentionItems === 1 ? 'y' : 'ies'}</strong> need${summary.leakage.totalAttentionItems === 1 ? 's' : ''} attention.`
      : `<strong style="color:#0F172A;">No urgent leakage</strong> detected today. Keep response speed tight.`
  const topRiskLine = summary.leakage.topPriorityLabel
    ? `<p style="margin:6px 0 0 0;font-size:12.5px;color:#475569;line-height:1.55;">Top risk: <strong style="color:#0F172A;">${escapeHtml(summary.leakage.topPriorityLabel)}</strong>.</p>`
    : ''

  // 3 metric tiles for the leakage snapshot row.
  const speed = summary.speedToLead
  const speedMedianCell =
    speed.medianMinutesToFirstReply === null
      ? '—'
      : `${speed.medianMinutesToFirstReply}m`
  const speedRateCell =
    speed.metRate === null ? '—' : `${Math.round(speed.metRate * 100)}%`
  const tilesRow = `
        <tr>
          <td style="padding:0 28px 18px 28px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
              <tr>
                ${metricTile('Median first reply', speedMedianCell, `${speed.totalMeasured} leads measured`)}
                ${metricTile('SLA hit rate', speedRateCell, `${speed.met} met · ${speed.missed} missed`)}
                ${metricTile('Overdue replies', String(speed.pendingOverdue), 'Leads past SLA')}
              </tr>
            </table>
          </td>
        </tr>`

  // Recovery section — header + top leads or "calm" copy.
  const recovery = summary.recovery
  const recoveryRows =
    recovery.topLeads.length > 0
      ? recovery.topLeads
          .map(
            (r) => `<tr>
                <td style="padding:8px 14px;border-bottom:1px solid #F1F5F9;font-size:12.5px;color:#0F172A;">
                  <strong>${escapeHtml(r.name)}</strong>
                  ${r.lead_score !== null ? `<span style="color:#94A3B8;font-weight:400;"> · ${r.lead_score} score</span>` : ''}
                  <span style="color:#1D4ED8;font-weight:500;display:block;font-size:11.5px;margin-top:2px;">${escapeHtml(r.suggested_action_title)}</span>
                </td>
              </tr>`
          )
          .join('')
      : `<tr><td style="padding:10px 14px;font-size:12px;color:#94A3B8;">Nobody stalled — keep nurturing the pipeline.</td></tr>`
  const recoverySection = `
        <tr>
          <td style="padding:0 28px 16px 28px;">
            <p style="margin:0 0 6px 0;font-size:11px;color:#94A3B8;text-transform:uppercase;letter-spacing:0.06em;font-weight:600;">Follow-up recovery</p>
            <p style="margin:0 0 8px 0;font-size:12.5px;color:#475569;">
              ${recovery.stalledLeads} stalled lead${recovery.stalledLeads === 1 ? '' : 's'} · ${recovery.highFitStalled} high-fit
            </p>
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#FFFBEB;border:1px solid #FCD9A1;border-radius:12px;">
              ${recoveryRows}
            </table>
          </td>
        </tr>`

  // Tour Booking section.
  const tour = summary.tourBooking
  const tourRows =
    tour.topUnconfirmed.length > 0
      ? tour.topUnconfirmed
          .map(
            (t) => `<tr>
                <td style="padding:8px 14px;border-bottom:1px solid #F1F5F9;font-size:12.5px;color:#0F172A;">
                  <strong>${escapeHtml(t.name)}</strong>
                  ${t.lead_score !== null ? `<span style="color:#94A3B8;font-weight:400;"> · ${t.lead_score} score</span>` : ''}
                  ${t.scheduled_at ? `<span style="color:#1D4ED8;font-weight:500;display:block;font-size:11.5px;margin-top:2px;">${escapeHtml(formatScheduledLine(t.scheduled_at))}</span>` : ''}
                </td>
              </tr>`
          )
          .join('')
      : `<tr><td style="padding:10px 14px;font-size:12px;color:#94A3B8;">No tours waiting on a confirm.</td></tr>`
  const tourSection = `
        <tr>
          <td style="padding:0 28px 16px 28px;">
            <p style="margin:0 0 6px 0;font-size:11px;color:#94A3B8;text-transform:uppercase;letter-spacing:0.06em;font-weight:600;">Tour booking</p>
            <p style="margin:0 0 8px 0;font-size:12.5px;color:#475569;">
              ${tour.qualifiedNoTour} qualified · no tour · ${tour.unconfirmedTours} unconfirmed · ${tour.toursToday} today
            </p>
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#EFF6FF;border:1px solid #BFDBFE;border-radius:12px;">
              ${tourRows}
            </table>
          </td>
        </tr>`

  // CTA row — three soft buttons. The first is the primary navy.
  const ctaRow = `
        <tr>
          <td style="padding:8px 28px 20px 28px;text-align:center;">
            <a href="${escapeHtml(args.dashboardUrl)}" style="display:inline-block;background:#0F172A;color:#FFFFFF;text-decoration:none;font-size:13px;font-weight:600;padding:10px 18px;border-radius:10px;box-shadow:0 2px 6px rgba(15,23,42,0.18);margin:0 4px 6px 4px;">Open Revenue OS dashboard</a>
            <br/>
            <a href="${escapeHtml(args.recoveryUrl)}" style="display:inline-block;color:#1D4ED8;text-decoration:none;font-size:12.5px;font-weight:600;padding:6px 10px;margin:4px 4px 0 4px;">Review leakage queue →</a>
            <a href="${escapeHtml(args.tourBookingUrl)}" style="display:inline-block;color:#1D4ED8;text-decoration:none;font-size:12.5px;font-weight:600;padding:6px 10px;margin:4px 4px 0 4px;">Review tour booking queue →</a>
          </td>
        </tr>`

  // Operator activity log — demoted lower, smaller. Same content as
  // the legacy block but in a quieter container so the owner reads it
  // as an audit footnote rather than the headline.
  const activityLog =
    args.agg.total === 0
      ? `<p style="margin:0 0 6px 0;font-size:12px;color:#94A3B8;">No tour status events in the last 24h.</p>`
      : `
              <p style="margin:0 0 6px 0;font-size:11px;color:#94A3B8;text-transform:uppercase;letter-spacing:0.06em;font-weight:600;">By action</p>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#FFFFFF;border:1px solid #E2E8F0;border-radius:10px;margin-bottom:10px;">
                ${htmlCountsRows(args.agg.byAction)}
              </table>
              <p style="margin:0 0 6px 0;font-size:11px;color:#94A3B8;text-transform:uppercase;letter-spacing:0.06em;font-weight:600;">By actor</p>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#FFFFFF;border:1px solid #E2E8F0;border-radius:10px;">
                ${htmlCountsRows(args.agg.byActor)}
              </table>`
  const activitySection = `
        <tr>
          <td style="padding:0 28px 24px 28px;">
            <div style="background:#F8FAFC;border:1px solid #E2E8F0;border-radius:14px;padding:16px;">
              <p style="margin:0 0 4px 0;font-size:11px;color:#475569;text-transform:uppercase;letter-spacing:0.08em;font-weight:600;">Operator activity log (24h)</p>
              <p style="margin:0 0 10px 0;font-size:11.5px;color:#94A3B8;">Lower-priority audit context. The full feed lives in Billing Settings.</p>
              ${activityLog}
            </div>
          </td>
        </tr>`

  // Headline.
  return `<tr>
          <td style="padding:28px 28px 8px 28px;">
            <p style="margin:0 0 4px 0;font-size:13px;color:#64748B;">Hi there,</p>
            <h1 style="margin:0 0 10px 0;font-size:22px;line-height:1.25;font-weight:600;color:#0F172A;">Your VenueRise Revenue OS summary</h1>
            <p style="margin:0 0 14px 0;font-size:13px;line-height:1.55;color:#475569;">
              Here&rsquo;s where <strong style="color:#0F172A;">${escapeHtml(args.venueLabel)}</strong> may be leaking revenue and where the team should focus next.
              <span style="color:#94A3B8;">${escapeHtml(args.dateStr)}</span>
            </p>
          </td>
        </tr>
        <tr>
          <td style="padding:0 28px 16px 28px;">
            <div style="background:#F8FAFC;border:1px solid #E2E8F0;border-radius:14px;padding:14px 16px;">
              <p style="margin:0;font-size:13px;line-height:1.55;color:#0F172A;">${opening}</p>
              ${topRiskLine}
            </div>
          </td>
        </tr>
        ${tilesRow}
        ${recoverySection}
        ${tourSection}
        ${ctaRow}
        ${activitySection}`
}

/**
 * Phase 8AU — small metric tile used by the Revenue OS snapshot row.
 * Inline + table-based so Outlook still renders it cleanly.
 */
function metricTile(label: string, value: string, hint: string): string {
  return `<td style="width:33.33%;padding:0 4px;vertical-align:top;">
                  <div style="background:#FFFFFF;border:1px solid #E6E8EF;border-radius:12px;padding:10px 12px;">
                    <p style="margin:0 0 4px 0;font-size:10.5px;color:#64748B;text-transform:uppercase;letter-spacing:0.08em;font-weight:600;">${escapeHtml(label)}</p>
                    <p style="margin:0 0 4px 0;font-size:20px;color:#0F172A;font-weight:600;line-height:1;">${escapeHtml(value)}</p>
                    <p style="margin:0;font-size:10.5px;color:#94A3B8;line-height:1.4;">${escapeHtml(hint)}</p>
                  </div>
                </td>`
}

// Phase 8AU — Revenue OS-aware aliases. Same body shape as the
// upgraded `buildOperatorDigestText/Html`; named for the new content
// so call sites can self-document by import name. Callers that want
// the legacy fallback can simply omit the `revenueOs` field on args.
export const buildRevenueOsDigestText = buildOperatorDigestText
export const buildRevenueOsDigestHtml = buildOperatorDigestHtml

// ---------------------------------------------------------------------------
// Phase 8S — opt-out check + unsubscribe URL build
// ---------------------------------------------------------------------------

interface SubscriptionRowForDigest {
  id: string
  metadata: Record<string, unknown> | null
}

/**
 * Phase 8T — cadence-aware send decision.
 *
 * Replaces the Phase 8S `isDigestOptedOut` binary check. Returns the
 * effective cadence + a `shouldSend` boolean so the cron's per-venue
 * loop can distinguish:
 *   - 'off'    → skip, log `operator_digest.skipped_disabled`
 *   - 'weekly' on non-Monday → skip, log `operator_digest.skipped_cadence`
 *   - 'weekly' on Monday OR 'daily' → send
 *
 * On lookup failure we fall through to `'daily'` so an opted-out venue
 * gets at most one extra digest while ops debugs the DB read.
 */
async function resolveDigestDecision(
  supabase: ReturnType<typeof createServiceClient>,
  venueId: string,
  now: Date
): Promise<{ cadence: DigestCadence; shouldSend: boolean }> {
  const { data, error } = await supabase
    .from('subscriptions')
    .select('id, metadata')
    .eq('venue_id', venueId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) {
    log.warn(
      { err: error, venueId },
      'jobs.operator_activity_digest.cadence_lookup_failed'
    )
    return { cadence: 'daily', shouldSend: true }
  }
  if (!data) {
    // No subscription row yet — default cadence is 'daily', so we'd
    // send. Realistically a venue without a subscription wouldn't have
    // tour events to digest either, so this branch is mostly
    // hypothetical.
    return { cadence: 'daily', shouldSend: true }
  }
  const row = data as SubscriptionRowForDigest
  const cadence = getDigestCadence(row.metadata)
  return { cadence, shouldSend: shouldSendDigestForCadence(cadence, now) }
}

/**
 * Phase 8S — wraps `createDigestUnsubscribeUrl` with a process-once
 * warn when the secret is missing. Returns null on any failure so the
 * digest sender can fall through to a link-less email rather than
 * skipping the whole send.
 *
 * Phase 8X — exported so the preview + manual-send route handlers
 * (which also need to embed the unsubscribe link in their digest body)
 * share the same once-per-process secret-missing warning posture. The
 * companion `tryBuildResubscribeUrl` below shares the same flag.
 */
export function tryBuildUnsubscribeUrl(venueId: string): string | null {
  if (!digestUnsubscribeSecretConfigured()) {
    warnSecretMissingOnce()
    return null
  }
  try {
    return createDigestUnsubscribeUrl({ venueId })
  } catch (err) {
    if (err instanceof DigestUnsubscribeTokenError) {
      log.warn(
        { code: err.code, venueId },
        'jobs.operator_activity_digest.unsubscribe_url_build_failed'
      )
    } else {
      log.warn(
        { err, venueId },
        'jobs.operator_activity_digest.unsubscribe_url_build_failed'
      )
    }
    return null
  }
}

/**
 * Phase 8X — per-user resubscribe URL builder. Same once-per-process
 * warn + null-on-failure posture as `tryBuildUnsubscribeUrl`.
 *
 * The cron does NOT call this (recipient cadence is never 'off' on a
 * successful cron send). The preview + manual-send route handlers DO
 * call this so the email footer can offer one-click re-enable.
 */
export function tryBuildResubscribeUrl(
  venueId: string,
  userId: string
): string | null {
  if (!digestUnsubscribeSecretConfigured()) {
    warnSecretMissingOnce()
    return null
  }
  try {
    return createDigestResubscribeUrl({ venueId, userId })
  } catch (err) {
    if (err instanceof DigestUnsubscribeTokenError) {
      log.warn(
        { code: err.code, venueId, userId },
        'jobs.operator_activity_digest.resubscribe_url_build_failed'
      )
    } else {
      log.warn(
        { err, venueId, userId },
        'jobs.operator_activity_digest.resubscribe_url_build_failed'
      )
    }
    return null
  }
}

function warnSecretMissingOnce(): void {
  if (_missingUnsubSecretWarned) return
  _missingUnsubSecretWarned = true
  log.warn(
    { op: 'jobs.operator_activity_digest.no_unsubscribe_secret' },
    'jobs.operator_activity_digest.no_unsubscribe_secret'
  )
}

// ---------------------------------------------------------------------------
// Phase 8AU — shared Revenue OS summary fetcher.
//
// Composes the lead / message / tour / settings slice the digest body
// needs into one Supabase round-trip block + hands it to the pure
// `composeRevenueOsDigestSummary` helper. Used by the cron loop +
// preview + manual-send routes so all three render the same content.
//
// Best-effort: a probe failure returns `null` so the email still goes
// out (just without the Revenue OS sections — the existing operator
// activity body still renders).
// ---------------------------------------------------------------------------
export async function fetchRevenueOsDigestSummary(
  supabase: ReturnType<typeof createServiceClient>,
  venueId: string,
  options?: { now?: Date; speedToLeadWindowDays?: number }
): Promise<RevenueOsDigestSummary | null> {
  try {
    // 1. Venue metadata for settings parsing.
    const { data: venueRow } = await supabase
      .from('venues')
      .select('metadata')
      .eq('id', venueId)
      .maybeSingle()
    const settings = parseRevenueOsSettings(
      (venueRow as { metadata?: unknown } | null)?.metadata
    )

    // 2. In-flight leads + name slice. We scope to non-lost leads so
    //    the helpers see the whole pipeline (qualified, booked,
    //    etc.) — the speed-to-lead rollup also wants very-recent
    //    leads, and including booked-or-later doesn't hurt.
    const { data: leadRows, error: leadsErr } = await supabase
      .from('leads')
      .select('id, name, stage, lead_score, created_at, updated_at')
      .eq('venue_id', venueId)
      .not('stage', 'in', '(lost)')
      .order('created_at', { ascending: false })
      .limit(500)
    if (leadsErr) return null
    const rawLeads = (leadRows ?? []) as Array<{
      id: string
      name: string
      stage: string
      lead_score: number
      created_at: string
      updated_at: string
    }>
    const leads: RevenueOsDigestLeadSlice[] = rawLeads.map((l) => ({
      id: l.id,
      name: l.name,
      stage: l.stage,
      lead_score: l.lead_score,
      created_at: l.created_at,
      updated_at: l.updated_at,
    }))

    // 3. Message activity reduced to first-outbound / last-inbound.
    const inboundMap = new Map<string, string | null>()
    const outboundMap = new Map<string, string | null>()
    if (leads.length > 0) {
      const { data: msgRows } = await supabase
        .from('messages')
        .select('lead_id, role, created_at')
        .eq('venue_id', venueId)
        .in(
          'lead_id',
          leads.map((l) => l.id)
        )
        .order('created_at', { ascending: true })
        .limit(5000)
      for (const m of (msgRows as Array<{
        lead_id: string
        role: string
        created_at: string
      }> | null) ?? []) {
        if (m.role === 'ai' || m.role === 'human') {
          if (!outboundMap.has(m.lead_id)) {
            outboundMap.set(m.lead_id, m.created_at)
          }
        } else if (m.role === 'lead') {
          inboundMap.set(m.lead_id, m.created_at)
        }
      }
    }
    const inbound: LeakageInboundActivity[] = leads.map((l) => ({
      lead_id: l.id,
      last_inbound_at: inboundMap.get(l.id) ?? null,
    }))
    const outbound: LeakageOutboundActivity[] = leads.map((l) => ({
      lead_id: l.id,
      first_outbound_at: outboundMap.get(l.id) ?? null,
    }))

    // 4. Tours scoped to the venue.
    const { data: tourRows } = await supabase
      .from('tours')
      .select('id, lead_id, status, scheduled_at')
      .eq('venue_id', venueId)
      .limit(500)
    const tours = (tourRows ?? []) as LeakageTour[]

    // 5. Phase 8BD — lost leads + per-lead last lead-role message.
    // We pull these as a SEPARATE batch from the in-flight slice
    // (above) because the reactivation helper has its own gates
    // (cooling window, event-date guard, operator-supplied reason)
    // that the recovery + tour-booking helpers don't share. Bounded
    // by 500 to keep the job fast on long-tail venues.
    let lostLeadsForDigest: Array<{
      id: string
      name: string
      stage: string
      lead_score: number
      event_date: string | null
      updated_at: string
      lost_reason: LostReason | null
    }> = []
    const lostLeadLastInbound: Record<string, string | null> = {}
    try {
      const { data: lostRows } = await supabase
        .from('leads')
        .select(
          'id, name, stage, lead_score, event_date, updated_at, metadata'
        )
        .eq('venue_id', venueId)
        .eq('stage', 'lost')
        .order('updated_at', { ascending: false })
        .limit(500)
      const lost = ((lostRows ?? []) as Array<{
        id: string
        name: string
        stage: string
        lead_score: number
        event_date: string | null
        updated_at: string
        metadata: Record<string, unknown> | null
      }>)
      lostLeadsForDigest = lost.map((l) => {
        const block =
          l.metadata && typeof l.metadata === 'object'
            ? (l.metadata as { lost_reason?: unknown }).lost_reason
            : undefined
        const reason =
          block &&
          typeof block === 'object' &&
          isLostReason((block as { reason?: unknown }).reason)
            ? ((block as { reason: LostReason }).reason)
            : null
        return {
          id: l.id,
          name: l.name,
          stage: l.stage,
          lead_score: l.lead_score,
          event_date: l.event_date,
          updated_at: l.updated_at,
          lost_reason: reason,
        }
      })
      if (lostLeadsForDigest.length > 0) {
        const { data: lostMsgRows } = await supabase
          .from('messages')
          .select('lead_id, created_at')
          .eq('venue_id', venueId)
          .eq('role', 'lead')
          .in(
            'lead_id',
            lostLeadsForDigest.map((l) => l.id)
          )
          .order('created_at', { ascending: false })
        for (const m of (lostMsgRows as Array<{
          lead_id: string
          created_at: string
        }> | null) ?? []) {
          if (!(m.lead_id in lostLeadLastInbound)) {
            lostLeadLastInbound[m.lead_id] = m.created_at
          }
        }
        for (const l of lostLeadsForDigest) {
          if (!(l.id in lostLeadLastInbound)) {
            lostLeadLastInbound[l.id] = null
          }
        }
      }
    } catch {
      // Best-effort — a lost-lead probe failure should not break
      // the rest of the digest. We just ship reactivation as
      // empty.
    }

    return composeRevenueOsDigestSummary({
      leads,
      inbound,
      outbound,
      tours,
      settings,
      now: options?.now,
      speedToLeadWindowDays: options?.speedToLeadWindowDays,
      lostLeads: lostLeadsForDigest,
      lostLeadLastInbound,
    })
  } catch (err) {
    // Defensive: a single probe error must not break the digest.
    log.warn(
      { err, venueId },
      'jobs.operator_activity_digest.revenue_os_fetch_failed'
    )
    return null
  }
}

// Silence the unused-import warning when no caller reaches the
// composer's exported `summaryHasActionableContent` from here. The
// helper is re-exported via the index in case future digest content
// branches want to short-circuit when there's nothing to surface.
void summaryHasActionableContent

async function runDigestScan(): Promise<
  RunSummary | { skipped: true; reason: 'disabled' }
> {
  if (!digestEnabled()) {
    log.info(
      {
        flag: 'OPERATOR_DIGEST_ENABLED',
        value: process.env.OPERATOR_DIGEST_ENABLED ?? null,
      },
      'jobs.operator_activity_digest.skipped_disabled'
    )
    return { skipped: true, reason: 'disabled' }
  }

  const supabase = createServiceClient()
  const sinceIso = new Date(
    Date.now() - LOOKBACK_HOURS * 60 * 60 * 1000
  ).toISOString()
  const todayUtc = isoDateUtc(new Date())

  log.info(
    { schedule: SCHEDULE, sinceIso, todayUtc, maxVenuesPerRun: MAX_VENUES_PER_RUN },
    'jobs.operator_activity_digest.scan_start'
  )

  // 1. Pull the narrow event slice we need for aggregation. Three
  // columns — no metadata, no PII. We pull `actor_kind` + `action` so
  // the body builder can produce both breakdowns from one read.
  const { data: eventsRaw, error: eventsErr } = await supabase
    .from('tour_status_events')
    .select('venue_id, action, actor_kind')
    .gte('occurred_at', sinceIso)

  if (eventsErr) {
    log.error(
      { errorMessage: eventsErr.message },
      'jobs.operator_activity_digest.events_query_failed'
    )
    captureJobError('operator-activity-digest', eventsErr, {})
    throw new Error(`operator digest events query failed: ${eventsErr.message}`)
  }

  const events = (eventsRaw ?? []) as DigestEventRow[]
  const byVenue = aggregateEvents(events)
  const venueIds = Array.from(byVenue.keys()).slice(0, MAX_VENUES_PER_RUN)

  const summary: RunSummary = {
    scannedVenues: venueIds.length,
    sent: 0,
    skipped: 0,
    failed: 0,
  }

  if (venueIds.length === 0) {
    log.info(summary, 'jobs.operator_activity_digest.scan_complete')
    return summary
  }

  // 2. Resolve venue names in one batched read (optional context).
  const { data: venueRowsRaw } = await supabase
    .from('venues')
    .select('id, name')
    .in('id', venueIds)
  const venueNameById = new Map<string, string | null>()
  for (const v of ((venueRowsRaw ?? []) as Array<{ id: string; name: string | null }>)) {
    venueNameById.set(v.id, v.name)
  }

  const appUrl = (process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000').replace(/\/$/, '')

  // 3. Per-venue send. Sequential — typical past-day event volume is
  // a handful of venues, and serial execution keeps Sentry attribution
  // simple. Per-venue failures NEVER abort the batch.
  for (const venueId of venueIds) {
    const agg = byVenue.get(venueId)
    if (!agg || agg.total === 0) {
      summary.skipped++
      continue
    }

    const venueLog = log.child({
      venueId,
      total: agg.total,
      op: 'jobs.operator_activity_digest.process',
    })

    // Phase 8U — fan out per recipient. Each owner/admin member has
    // their own digest preference; the cron resolves the effective
    // cadence per recipient and sends/skips accordingly.
    //
    // Pre-fetch the venue's subscription metadata ONCE so every
    // per-recipient resolver sees the same fallback without a per-
    // member DB hit. The Phase 8S `tryBuildUnsubscribeUrl` is also a
    // venue-level call (token signs `venue_id`), so we hoist it out
    // of the inner loop too.
    const { data: subRaw, error: subErr } = await supabase
      .from('subscriptions')
      .select('id, metadata')
      .eq('venue_id', venueId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (subErr) {
      venueLog.warn(
        { err: subErr },
        'jobs.operator_activity_digest.subscription_lookup_failed'
      )
    }
    const subscriptionMetadata =
      (subRaw as { metadata?: Record<string, unknown> | null } | null)?.metadata ?? null
    const unsubscribeUrl = tryBuildUnsubscribeUrl(venueId)
    // Phase 8AU — compute the Revenue OS summary ONCE per venue.
    // Same summary feeds every recipient's email so the owner +
    // admin pair sees consistent numbers, and so we don't fan out
    // expensive joins per-recipient.
    const revenueOsSummary = await fetchRevenueOsDigestSummary(
      supabase,
      venueId,
      { now: new Date() }
    )
    const recipients = await findDigestRecipients(supabase, venueId)
    if (recipients.length === 0) {
      venueLog.warn({}, 'operator_digest.skipped_no_email')
      summary.skipped++
      continue
    }

    const now = new Date()
    let anySent = false

    for (const recipient of recipients) {
      const recipientLog = venueLog.child({
        userId: recipient.userId,
        op: 'operator_digest.recipient',
      })

      const pref = resolveEffectiveDigestPreference({
        memberMetadata: recipient.memberMetadata,
        subscriptionMetadata,
        now,
      })

      if (!pref.shouldSend) {
        if (pref.reason === 'off') {
          recipientLog.info(
            { cadence: pref.cadence, source: pref.source },
            'operator_digest.skipped_disabled'
          )
        } else {
          recipientLog.info(
            {
              cadence: pref.cadence,
              weeklyDay: pref.weeklyDay,
              source: pref.source,
            },
            'operator_digest.skipped_cadence'
          )
        }
        summary.skipped++
        continue
      }

      // Per-recipient idempotency probe (Phase 8U). The Phase 8R
      // probe was venue-wide; now that we fan out to many members we
      // narrow by recipient so a partial-batch retry doesn't double-
      // send to anyone who already received today's digest.
      if (await digestAlreadySentToRecipientToday(supabase, venueId, recipient.userId, todayUtc)) {
        recipientLog.info({}, 'operator_digest.skipped_duplicate')
        summary.skipped++
        continue
      }

      const bodyArgs: DigestBodyArgs = {
        venueName: venueNameById.get(venueId) ?? null,
        venueId,
        agg,
        appUrl,
        unsubscribeUrl,
        // Phase 8X — cron deliberately omits the resubscribe URL. A
        // recipient who reaches this branch has effective cadence
        // 'daily' or 'weekly' (off would have been skipped upstream),
        // so the re-enable link would just add clutter.
        resubscribeUrl: null,
        cadence: pref.cadence,
        weeklyDay: pref.weeklyDay,
        sendKind: 'cron',
        // Phase 8AU — Revenue OS summary computed once per venue
        // (above the recipient loop). Null when the probe failed;
        // the body builder falls back to the legacy
        // tour-activity-only template in that case.
        revenueOs: revenueOsSummary,
      }
      const text = buildOperatorDigestText(bodyArgs)
      const html = buildOperatorDigestHtml(bodyArgs)

      let result
      try {
        result = await sendEmail({
          to: recipient.email,
          subject: 'VenueRise daily activity summary',
          text,
          html,
          venueId,
          relatedTable: 'tour_status_events',
          metadata: {
            tour_digest_date: todayUtc,
            tour_digest_total: String(agg.total),
            // Phase 8U — per-recipient markers. The idempotency probe
            // above keys off these on subsequent runs.
            tour_digest_recipient_user_id: recipient.userId,
            tour_digest_cadence: pref.cadence,
            tour_digest_weekly_day: pref.weeklyDay ?? '',
            // Phase 8W — explicit send-kind discriminator. The
            // per-recipient probe filters on `send_kind='cron'` so
            // earlier-today previews ('preview') don't block today's
            // real digest. Future-proofs against manual operator
            // sends ('manual'), which the cron should likewise ignore.
            tour_digest_send_kind: 'cron',
          },
        })
      } catch (err) {
        recipientLog.error({ err }, 'jobs.operator_activity_digest.send_threw')
        captureJobError('operator-activity-digest', err, { venueId })
        summary.failed++
        continue
      }

      if (!result.delivered) {
        if (result.error?.startsWith('suppressed:')) {
          recipientLog.warn(
            { reason: result.error },
            'jobs.operator_activity_digest.skipped_suppressed'
          )
          summary.skipped++
        } else if (!result.error) {
          // Console fallback — dev environment with no Resend config.
          recipientLog.warn(
            { provider: result.provider },
            'jobs.operator_activity_digest.console_fallback'
          )
          summary.skipped++
        } else {
          recipientLog.error(
            { provider: result.provider, errorMessage: result.error },
            'jobs.operator_activity_digest.send_failed'
          )
          captureJobError(
            'operator-activity-digest',
            new Error(result.error),
            { venueId }
          )
          summary.failed++
        }
        continue
      }

      recipientLog.info(
        { provider: result.provider, messageId: result.messageId },
        'jobs.operator_activity_digest.sent'
      )
      summary.sent++
      anySent = true

      // Phase 8AD — optional per-recipient cron-send audit write.
      // Gated by DIGEST_AUDIT_LOG_CRON_SENDS=1 because every
      // successful send produces one audit row; a busy multi-venue
      // deployment can otherwise quickly accumulate noise. Helper
      // is best-effort and never throws, so a failure here can't
      // hide a successful send from the operator.
      if (cronAuditEnabled()) {
        await recordDigestAuditEvent({
          venueId,
          actorKind: 'cron',
          actorUserId: null,
          action: 'digest_send_cron',
          targetUserId: recipient.userId,
          targetEmailMasked: maskEmail(recipient.email),
          metadata: {
            venue_id: venueId,
            event_count: agg.total,
            cadence: pref.cadence,
            weekly_day: pref.weeklyDay ?? null,
            outbound_message_id: result.outboundMessageId ?? null,
            send_kind: 'cron',
          },
        })
      }
    }

    // Telemetry — if a venue had recipients but every single one
    // skipped (off / wrong day / duplicate / no email), surface that
    // cleanly. Doesn't count as a venue-level failure, just an info.
    if (!anySent) {
      venueLog.info(
        { recipientCount: recipients.length },
        'jobs.operator_activity_digest.venue_all_skipped'
      )
    }
  }

  log.info(summary, 'jobs.operator_activity_digest.scan_complete')
  return summary
}

// ---------------------------------------------------------------------------
// Inngest binding
// ---------------------------------------------------------------------------

export const operatorActivityDigestFn = inngest.createFunction(
  {
    id: 'operator-activity-digest',
    name: 'Phase 8R — daily 24h tour activity digest (env-gated)',
    retries: 1,
    triggers: [{ cron: SCHEDULE }],
  },
  async () => runDigestScan()
)

// Exported for unit tests + manual reruns.
export {
  runDigestScan,
  digestEnabled,
  cronAuditEnabled,
  aggregateEvents,
  buildDigestBody,
  buildOperatorDigestText,
  // `buildOperatorDigestHtml` is already exported at its definition site.
  // Phase 8AU exports:
  //   - `fetchRevenueOsDigestSummary` already exported at its definition site
  //   - `buildRevenueOsDigestText` + `buildRevenueOsDigestHtml` already
  //     exported at their alias definitions (`export const`)
}
