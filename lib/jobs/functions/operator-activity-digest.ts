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
  const sendKind: DigestSendKind = args.sendKind ?? 'cron'
  const includeResubscribe = sendKind !== 'cron' && Boolean(args.resubscribeUrl)

  const unsubBlock = args.unsubscribeUrl
    ? `\nNo longer want these summaries? Unsubscribe:\n${args.unsubscribeUrl}\n`
    : ''
  const resubBlock = includeResubscribe
    ? `\nRe-enable daily digest:\n${args.resubscribeUrl}\n`
    : ''

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
  const dateStr = new Date().toUTCString().replace(/ \d{2}:\d{2}:\d{2} GMT$/, ' UTC')
  const sendKind: DigestSendKind = args.sendKind ?? 'cron'
  const includeResubscribe = sendKind !== 'cron' && Boolean(args.resubscribeUrl)

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

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>VenueRise daily activity summary</title>
</head>
<body style="margin:0;padding:0;background:#F4F6FB;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#0F172A;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F4F6FB;padding:32px 16px;">
  <tr>
    <td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#FFFFFF;border:1px solid #E2E8F0;border-radius:20px;box-shadow:0 4px 14px rgba(15,23,42,0.06);">
        <tr>
          <td style="padding:28px 28px 8px 28px;">
            <p style="margin:0 0 4px 0;font-size:13px;color:#64748B;">Hi there,</p>
            <h1 style="margin:0 0 12px 0;font-size:20px;line-height:1.3;font-weight:600;color:#0F172A;">VenueRise daily activity summary</h1>
            <p style="margin:0 0 16px 0;font-size:13px;line-height:1.55;color:#475569;">
              Tour activity for <strong style="color:#0F172A;">${escapeHtml(venueLabel)}</strong> in the last 24 hours.
              <span style="color:#94A3B8;">${escapeHtml(dateStr)}</span>
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
            <a href="${escapeHtml(settingsUrl)}" style="display:inline-block;background:#0F172A;color:#FFFFFF;text-decoration:none;font-size:13px;font-weight:600;padding:10px 18px;border-radius:10px;box-shadow:0 2px 6px rgba(15,23,42,0.18);">View full audit</a>
          </td>
        </tr>
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
}
