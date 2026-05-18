import 'server-only'
import { inngest } from '../client'
import { createServiceClient } from '@/lib/supabase/service'
import { sendEmail } from '@/lib/integrations/email'
import { log } from '@/lib/log'
import { captureJobError } from '@/lib/observability/sentry'
import { appendSubscriptionMetadataArray } from '@/lib/billing/subscription-metadata'

/**
 * Phase 7H — billing trial reminder cron.
 *
 * Sends a "your trial ends in 3 days" email to the venue owner of every
 * subscription whose `trial_end` lands on (now + 3 days), in UTC. Runs
 * once a day so we don't double-fire even when the cron drifts by a few
 * minutes between runs.
 *
 * ── IDEMPOTENCY ─────────────────────────────────────────────────────────────
 * We piggyback on `subscriptions.metadata` (already migrated; jsonb default
 * '{}'). After a successful send we append an entry to
 * `metadata.reminders_sent`:
 *
 *   { kind: 'trial_3d',
 *     key:  'trial_3d:<venue_id>:<trial_end YYYY-MM-DD>',
 *     sent_at, provider, message_id }
 *
 * Before sending, we skip any row whose existing `reminders_sent` already
 * contains an entry with the same `key`. The key shape includes both venue
 * and trial_end date so:
 *   - extending a trial (new trial_end) re-arms the reminder for the new date
 *   - a same-day re-run is a no-op (cron drift safe)
 *   - a venue with multiple trial rows still gets at most one reminder per
 *     row per date
 *
 * ── DELIVERY HONESTY ────────────────────────────────────────────────────────
 * Following the Phase 3 tour-reminder convention: we ONLY persist the
 * reminders_sent entry when `sendEmail({...}).delivered === true`. Console-
 * fallback (no Resend configured) does NOT flip the flag — that would
 * silently consume the reminder window and the owner would never hear from us.
 *
 * Provider error → log + Sentry + continue batch (don't sink the whole run).
 *
 * ── PRIVACY ─────────────────────────────────────────────────────────────────
 * No raw emails in logs. The Supabase admin SDK is the only place the owner
 * email touches code, and `sendEmail` already has its own redacted logging.
 */

const SCHEDULE = '0 14 * * *' // daily 2pm UTC
const BATCH_LIMIT = 100
const REMINDER_KIND = 'trial_3d' as const
const DAYS_BEFORE = 3
const MS_DAY = 24 * 60 * 60 * 1000

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SubscriptionRow {
  id: string
  venue_id: string
  trial_end: string | null
  metadata: Record<string, unknown> | null
}

interface ReminderEntry {
  kind: string
  key: string
  sent_at: string
  provider: 'resend' | 'console' | 'unknown'
  message_id?: string
}

interface RunSummary {
  scanned: number
  sent: number
  skipped: number
  failed: number
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Truncate a Date to YYYY-MM-DD (UTC). Stable across timezones. */
function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10)
}

/** Inclusive lower / exclusive upper bounds for the target UTC day. */
function targetWindow(now: Date, daysAhead: number): { startIso: string; endIso: string; dateIso: string } {
  const target = new Date(now.getTime() + daysAhead * MS_DAY)
  const start = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), target.getUTCDate()))
  const end = new Date(start.getTime() + MS_DAY)
  return {
    startIso: start.toISOString(),
    endIso: end.toISOString(),
    dateIso: isoDate(start),
  }
}

function reminderKeyFor(venueId: string, trialEndIso: string): string {
  return `${REMINDER_KIND}:${venueId}:${isoDate(new Date(trialEndIso))}`
}

function alreadyReminded(metadata: Record<string, unknown> | null, key: string): boolean {
  if (!metadata) return false
  const raw = metadata.reminders_sent
  if (!Array.isArray(raw)) return false
  return raw.some(
    (r) => r && typeof r === 'object' && 'key' in r && (r as { key: unknown }).key === key
  )
}

// (Phase 7L) — local `appendReminder` helper removed; writes now go
// through `appendSubscriptionMetadataArray` which is atomic at the SQL
// level. The read-side `alreadyReminded` check above stays as a cheap
// pre-flight; the new RPC handles the write race.

// ---------------------------------------------------------------------------
// Owner lookup
// ---------------------------------------------------------------------------

interface OwnerInfo {
  userId: string
  email: string
}

async function findOwnerEmail(
  supabase: ReturnType<typeof createServiceClient>,
  venueId: string
): Promise<OwnerInfo | null> {
  // Earliest owner row → the original owner. Multi-owner venues only get
  // one reminder per row per day; future "send to all owners" is a
  // separate decision.
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

// ---------------------------------------------------------------------------
// Core run
// ---------------------------------------------------------------------------

async function runTrialReminderScan(): Promise<RunSummary> {
  const summary: RunSummary = { scanned: 0, sent: 0, skipped: 0, failed: 0 }
  const supabase = createServiceClient()
  const now = new Date()
  const window = targetWindow(now, DAYS_BEFORE)

  log.info(
    { schedule: SCHEDULE, targetDate: window.dateIso },
    'jobs.billing_trial_reminder.scan_start'
  )

  // Candidate query.
  //
  // We can't easily say `trial_end::date = …` from supabase-js, so we use a
  // half-open range across the target UTC day. Equivalent for all real
  // timestamps; cheaper than a function-call filter.
  const { data, error } = await supabase
    .from('subscriptions')
    .select('id, venue_id, trial_end, metadata')
    .eq('status', 'trialing')
    .not('trial_end', 'is', null)
    .gte('trial_end', window.startIso)
    .lt('trial_end', window.endIso)
    .order('trial_end', { ascending: true })
    .limit(BATCH_LIMIT)

  if (error) {
    log.error(
      { errorMessage: error.message },
      'jobs.billing_trial_reminder.candidate_query_failed'
    )
    captureJobError('billing-trial-reminder', error, {})
    throw new Error(`trial-reminder candidate query failed: ${error.message}`)
  }

  const rows = (data ?? []) as SubscriptionRow[]
  summary.scanned = rows.length

  for (const sub of rows) {
    if (!sub.trial_end) {
      summary.skipped++
      continue
    }
    const key = reminderKeyFor(sub.venue_id, sub.trial_end)
    const subLog = log.child({
      venueId: sub.venue_id,
      subscriptionId: sub.id,
      key,
      op: 'jobs.billing_trial_reminder.process',
    })

    if (alreadyReminded(sub.metadata, key)) {
      subLog.info({}, 'jobs.billing_trial_reminder.skip_already_sent')
      summary.skipped++
      continue
    }

    const owner = await findOwnerEmail(supabase, sub.venue_id)
    if (!owner) {
      subLog.warn({}, 'jobs.billing_trial_reminder.skip_no_owner_email')
      summary.skipped++
      continue
    }

    const appUrl = (process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000').replace(/\/$/, '')
    const billingUrl = `${appUrl}/dashboard/settings/billing`
    const trialEndPretty = new Date(sub.trial_end).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      timeZone: 'UTC',
    })

    const text =
      `Your VenueRise trial wraps up on ${trialEndPretty}.\n\n` +
      `Start your subscription any time before then to keep your dashboard, ` +
      `AI replies, and tour automations running without interruption:\n` +
      `${billingUrl}\n\n` +
      `Payment is handled by Stripe — we never see your card details. If you ` +
      `have any questions about pricing or what's included, just reply to this email.`

    let result
    try {
      result = await sendEmail({
        to: owner.email,
        subject: 'Your VenueRise trial ends in 3 days',
        text,
        venueId: sub.venue_id,
        relatedTable: 'subscriptions',
        relatedId: sub.id,
      })
    } catch (err) {
      subLog.error({ err }, 'jobs.billing_trial_reminder.send_threw')
      captureJobError('billing-trial-reminder', err, { venueId: sub.venue_id })
      summary.failed++
      continue
    }

    if (!result.delivered) {
      // Console-fallback OR provider error. We do NOT flip the reminder
      // flag in either case so a future run (after Resend is wired or the
      // outage clears) retries.
      subLog.warn(
        { provider: result.provider, errorMessage: result.error },
        result.error
          ? 'jobs.billing_trial_reminder.send_failed'
          : 'jobs.billing_trial_reminder.console_fallback'
      )
      if (result.error) {
        captureJobError(
          'billing-trial-reminder',
          new Error(result.error),
          { venueId: sub.venue_id }
        )
        summary.failed++
      } else {
        summary.skipped++
      }
      continue
    }

    // Delivered → record the reminder via the atomic RPC (Phase 7L) so
    // a concurrent Stripe webhook sync can't overwrite this entry. The
    // helper returns null on failure (logs + Sentry-captures internally);
    // we treat that as a hard failure for the batch so the operator
    // notices in the summary counter.
    const entry: ReminderEntry = {
      kind: REMINDER_KIND,
      key,
      sent_at: new Date().toISOString(),
      provider: (result.provider as ReminderEntry['provider']) ?? 'unknown',
      message_id: result.messageId,
    }
    const updated = await appendSubscriptionMetadataArray({
      subscriptionId: sub.id,
      arrayKey: 'reminders_sent',
      // Spread into a plain record so TS accepts the strict interface
      // against the helper's Record<string, unknown> signature.
      entry: { ...entry },
      requestId: undefined,
    })

    if (!updated) {
      // The email IS in flight; we just can't record it. Logged + Sentry-
      // captured by the helper. Surface in the batch counter so the
      // operator sees a non-zero `failed` value and investigates.
      subLog.error({}, 'jobs.billing_trial_reminder.metadata_append_failed')
      summary.failed++
      continue
    }

    subLog.info(
      { provider: result.provider, messageId: result.messageId },
      'jobs.billing_trial_reminder.sent'
    )
    summary.sent++
  }

  log.info(summary, 'jobs.billing_trial_reminder.scan_complete')
  return summary
}

// ---------------------------------------------------------------------------
// Inngest binding
// ---------------------------------------------------------------------------

export const billingTrialReminderFn = inngest.createFunction(
  {
    id: 'billing-trial-reminder',
    name: 'Trial-ending reminder (daily, 3 days before trial_end)',
    retries: 1,
    triggers: [{ cron: SCHEDULE }],
  },
  async () => runTrialReminderScan()
)

// Exported for unit tests + manual reruns from a script if ever needed.
export { runTrialReminderScan }
