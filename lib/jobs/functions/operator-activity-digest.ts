import 'server-only'
import { inngest } from '../client'
import { createServiceClient } from '@/lib/supabase/service'
import { sendEmail } from '@/lib/integrations/email'
import {
  createDigestUnsubscribeUrl,
  digestUnsubscribeSecretConfigured,
  DigestUnsubscribeTokenError,
} from '@/lib/integrations/digest-unsubscribe-token'
import { log } from '@/lib/log'
import { captureJobError } from '@/lib/observability/sentry'

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

interface DigestBodyArgs {
  venueName: string | null
  venueId: string
  agg: VenueAggregate
  appUrl: string
  /** Phase 8S — optional opt-out URL, absent when the secret isn't configured. */
  unsubscribeUrl?: string | null
}

/**
 * Phase 8R + 8S — plain-text digest body. Stays the canonical
 * fallback for clients that strip HTML.
 */
function buildOperatorDigestText(args: DigestBodyArgs): string {
  const venueLabel = args.venueName?.trim() || `Venue ${args.venueId.slice(0, 8)}`
  const settingsUrl = `${args.appUrl}/dashboard/settings/billing`
  const unsubBlock = args.unsubscribeUrl
    ? `\nNo longer want these summaries? Unsubscribe:\n${args.unsubscribeUrl}\n`
    : ''
  return (
    `Hi there,\n\n` +
    `Here's your VenueRise tour activity for the last 24 hours.\n\n` +
    `Venue: ${venueLabel}\n` +
    `Total events: ${args.agg.total}\n\n` +
    `By action:\n${formatCountsBlock(args.agg.byAction)}\n\n` +
    `By actor:\n${formatCountsBlock(args.agg.byActor)}\n\n` +
    `Full audit feed (admins only):\n${settingsUrl}\n` +
    unsubBlock +
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

  const unsubLine = args.unsubscribeUrl
    ? `<p style="margin:0;font-size:11px;line-height:1.55;color:#94A3B8;">
         Don't want these summaries? <a href="${escapeHtml(args.unsubscribeUrl)}" style="color:#64748B;text-decoration:underline;">Unsubscribe</a>.
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
            <p style="margin:0 0 8px 0;font-size:12px;line-height:1.5;color:#64748B;">
              Reply to this email if you'd like us to dial the digest cadence or scope.
            </p>
            ${unsubLine}
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
 * Looks up the most-recent subscription for the venue and decides
 * whether the digest should send. The unsubscribe route writes
 * `metadata.digest_disabled = true` onto this same row.
 *
 * Returns:
 *   - `{ optedOut: true }`  → cron should skip with `skipped_disabled`
 *   - `{ optedOut: false }` → cron proceeds (includes the no-subscription case)
 */
async function isDigestOptedOut(
  supabase: ReturnType<typeof createServiceClient>,
  venueId: string
): Promise<{ optedOut: boolean }> {
  const { data, error } = await supabase
    .from('subscriptions')
    .select('id, metadata')
    .eq('venue_id', venueId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) {
    // On lookup failure, fall through to send. Worst case: an opted-out
    // venue gets one extra digest while ops debugs the DB read.
    log.warn(
      { err: error, venueId },
      'jobs.operator_activity_digest.opt_out_lookup_failed'
    )
    return { optedOut: false }
  }
  if (!data) return { optedOut: false }
  const row = data as SubscriptionRowForDigest
  const flag = (row.metadata ?? {})['digest_disabled']
  return { optedOut: flag === true }
}

/**
 * Phase 8S — wraps `createDigestUnsubscribeUrl` with a process-once
 * warn when the secret is missing. Returns null on any failure so the
 * digest sender can fall through to a link-less email rather than
 * skipping the whole send.
 */
function tryBuildUnsubscribeUrl(venueId: string): string | null {
  if (!digestUnsubscribeSecretConfigured()) {
    if (!_missingUnsubSecretWarned) {
      _missingUnsubSecretWarned = true
      log.warn(
        { op: 'jobs.operator_activity_digest.no_unsubscribe_secret' },
        'jobs.operator_activity_digest.no_unsubscribe_secret'
      )
    }
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

    // Phase 8S — opt-out check. Runs BEFORE the idempotency probe so
    // an opted-out venue's skip is attributed clearly. We never Sentry-
    // capture opt-out skips; they're an expected operator preference.
    const optOut = await isDigestOptedOut(supabase, venueId)
    if (optOut.optedOut) {
      venueLog.info({}, 'operator_digest.skipped_disabled')
      summary.skipped++
      continue
    }

    // Idempotency probe — see comment on `digestAlreadySentToday`.
    if (await digestAlreadySentToday(supabase, venueId, todayUtc)) {
      venueLog.info({}, 'jobs.operator_activity_digest.skip_already_sent_today')
      summary.skipped++
      continue
    }

    const owner = await findOwnerEmail(supabase, venueId)
    if (!owner) {
      venueLog.warn({}, 'jobs.operator_activity_digest.skip_no_owner_email')
      summary.skipped++
      continue
    }

    // Phase 8S — opt-out URL (null when DIGEST_UNSUBSCRIBE_SECRET is
    // unset/short — the email still sends, just without a link).
    const unsubscribeUrl = tryBuildUnsubscribeUrl(venueId)

    const bodyArgs: DigestBodyArgs = {
      venueName: venueNameById.get(venueId) ?? null,
      venueId,
      agg,
      appUrl,
      unsubscribeUrl,
    }
    const text = buildOperatorDigestText(bodyArgs)
    const html = buildOperatorDigestHtml(bodyArgs)

    let result
    try {
      result = await sendEmail({
        to: owner.email,
        subject: 'VenueRise daily activity summary',
        text,
        html,
        venueId,
        relatedTable: 'tour_status_events',
        metadata: {
          tour_digest_date: todayUtc,
          tour_digest_total: String(agg.total),
        },
      })
    } catch (err) {
      venueLog.error({ err }, 'jobs.operator_activity_digest.send_threw')
      captureJobError('operator-activity-digest', err, { venueId })
      summary.failed++
      continue
    }

    if (!result.delivered) {
      // Suppression / console-fallback / provider error. We don't
      // mark the digest as sent — next-day's run will retry.
      if (result.error?.startsWith('suppressed:')) {
        venueLog.warn(
          { reason: result.error },
          'jobs.operator_activity_digest.skipped_suppressed'
        )
        summary.skipped++
      } else if (!result.error) {
        // Console fallback — dev environment with no Resend config.
        venueLog.warn(
          { provider: result.provider },
          'jobs.operator_activity_digest.console_fallback'
        )
        summary.skipped++
      } else {
        venueLog.error(
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

    venueLog.info(
      { provider: result.provider, messageId: result.messageId },
      'jobs.operator_activity_digest.sent'
    )
    summary.sent++
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
  aggregateEvents,
  buildDigestBody,
  buildOperatorDigestText,
  // `buildOperatorDigestHtml` is already exported at its definition site.
}
