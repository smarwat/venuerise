import 'server-only'
import { inngest } from '../client'
import { createServiceClient } from '@/lib/supabase/service'
import { sendEmail } from '@/lib/integrations/email'
import { createBillingPortalSession, BillingError } from '@/lib/billing/billing-service'
import { appendSubscriptionMetadataArray } from '@/lib/billing/subscription-metadata'
import { log } from '@/lib/log'
import { captureJobError } from '@/lib/observability/sentry'

/**
 * Phase 7K — past-due dunning cron.
 *
 * Daily 4pm UTC. For every `past_due` subscription, sends the venue
 * owner an "update your payment method" email containing a short-lived
 * Stripe Customer Portal URL. Stops after 3 attempts per current_period_end.
 *
 * ── DESIGN ─────────────────────────────────────────────────────────────────
 * Mirrors the Phase 7H trial-reminder job:
 *   - idempotency lives on `subscriptions.metadata.dunning_sent` (jsonb
 *     array, no new tables required),
 *   - we only flip the "sent" flag when `sendEmail({...}).delivered === true`,
 *   - console-fallback (no Resend) doesn't consume the attempt slot.
 *
 * Stop-after-3 policy:
 *   - We count entries in `metadata.dunning_sent` whose key matches the
 *     current `current_period_end` date. The fourth time the row would
 *     normally fire, we log `escalation_needed` + Sentry-capture and skip.
 *     When the period rolls over (or Stripe lands an `invoice.paid` event
 *     that flips status back to active), the counter naturally resets.
 *
 * 48-hour spacing:
 *   - We never send a second dunning email within 48h of the previous one,
 *     even if the cron is invoked twice (e.g. manual operator trigger).
 *
 * Stripe portal URL:
 *   - Created on-demand via `createBillingPortalSession`. Stripe expires
 *     these URLs after ~1h, which is fine: the email is sent now and the
 *     owner usually opens it within minutes. If they open it tomorrow,
 *     they get a Stripe-side "expired" page; the email also includes a
 *     fallback link to /dashboard/settings/billing where they can
 *     re-generate the portal session.
 *
 * Status guard:
 *   - We hard-filter on `status='past_due'` in the candidate query AND
 *     re-check in the loop body. A subscription that flips back to active
 *     mid-batch (rare — webhook + cron racing) skips its dunning email.
 *
 * Logging posture:
 *   - No raw emails ever appear in log lines (sendEmail's own redaction
 *     handles delivery observability).
 *   - We log `venueId`, `subscriptionId`, `attempt`, `key` — no PII.
 */

const SCHEDULE = '0 16 * * *' // daily 4pm UTC
const BATCH_LIMIT = 100
const MAX_ATTEMPTS = 3
const MIN_HOURS_BETWEEN = 48
const REMINDER_KIND = 'past_due' as const

const MS_HOUR = 60 * 60 * 1000

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SubscriptionRow {
  id: string
  venue_id: string
  status: string
  current_period_end: string | null
  metadata: Record<string, unknown> | null
}

interface DunningEntry {
  kind: 'past_due'
  key: string
  attempt: number
  sent_at: string
  provider: 'resend' | 'console' | 'unknown'
  message_id?: string
}

interface RunSummary {
  scanned: number
  sent: number
  skipped: number
  failed: number
  escalation_needed: number
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10)
}

function getDunningEntries(metadata: Record<string, unknown> | null): DunningEntry[] {
  if (!metadata) return []
  const raw = (metadata as { dunning_sent?: unknown }).dunning_sent
  if (!Array.isArray(raw)) return []
  return raw.filter(
    (r): r is DunningEntry =>
      r !== null &&
      typeof r === 'object' &&
      typeof (r as { key?: unknown }).key === 'string'
  )
}

function getCurrentPeriodDunningEntries(
  entries: DunningEntry[],
  currentPeriodEndDate: string
): DunningEntry[] {
  // Entries are keyed by `dunning:<venue>:<YYYY-MM-DD>:attempt-N`; we filter
  // by the embedded date so a previous period's attempts don't gate the new
  // period's attempt counter.
  return entries.filter((e) => e.key.includes(`:${currentPeriodEndDate}:`))
}

function getLatestSentAt(entries: DunningEntry[]): Date | null {
  if (entries.length === 0) return null
  let latest: number | null = null
  for (const e of entries) {
    const t = new Date(e.sent_at).getTime()
    if (Number.isFinite(t) && (latest === null || t > latest)) latest = t
  }
  return latest === null ? null : new Date(latest)
}

function buildDunningKey(
  venueId: string,
  currentPeriodEndDate: string,
  attempt: number
): string {
  return `dunning:${venueId}:${currentPeriodEndDate}:attempt-${attempt}`
}

function appendDunningEntry(
  existing: Record<string, unknown> | null,
  entry: DunningEntry
): Record<string, unknown> {
  const base = (existing ?? {}) as Record<string, unknown>
  const prior = Array.isArray(base.dunning_sent) ? (base.dunning_sent as unknown[]) : []
  return { ...base, dunning_sent: [...prior, entry] }
}

// ---------------------------------------------------------------------------
// Owner lookup (same shape as Phase 7H — earliest owner)
// ---------------------------------------------------------------------------

interface OwnerInfo {
  userId: string
  email: string
}

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

// ---------------------------------------------------------------------------
// Core run
// ---------------------------------------------------------------------------

async function runDunningScan(): Promise<RunSummary> {
  const summary: RunSummary = {
    scanned: 0,
    sent: 0,
    skipped: 0,
    failed: 0,
    escalation_needed: 0,
  }
  const supabase = createServiceClient()
  const now = new Date()

  log.info({ schedule: SCHEDULE }, 'jobs.billing_dunning.scan_start')

  const { data, error } = await supabase
    .from('subscriptions')
    .select('id, venue_id, status, current_period_end, metadata')
    .eq('status', 'past_due')
    .not('current_period_end', 'is', null)
    .order('current_period_end', { ascending: true })
    .limit(BATCH_LIMIT)

  if (error) {
    log.error(
      { errorMessage: error.message },
      'jobs.billing_dunning.candidate_query_failed'
    )
    captureJobError('billing-dunning', error, {})
    throw new Error(`dunning candidate query failed: ${error.message}`)
  }

  const rows = (data ?? []) as SubscriptionRow[]
  summary.scanned = rows.length

  for (const sub of rows) {
    if (sub.status !== 'past_due') {
      // Defense in depth — the filter above should already exclude these,
      // but a row can flip mid-batch (rare). Skip silently.
      summary.skipped++
      continue
    }
    if (!sub.current_period_end) {
      summary.skipped++
      continue
    }

    const periodDate = isoDate(new Date(sub.current_period_end))
    const allEntries = getDunningEntries(sub.metadata)
    const currentPeriodEntries = getCurrentPeriodDunningEntries(allEntries, periodDate)
    const attempt = currentPeriodEntries.length + 1

    const subLog = log.child({
      venueId: sub.venue_id,
      subscriptionId: sub.id,
      periodDate,
      attempt,
      op: 'jobs.billing_dunning.process',
    })

    // Stop-after-3.
    if (currentPeriodEntries.length >= MAX_ATTEMPTS) {
      subLog.warn(
        { existingAttempts: currentPeriodEntries.length },
        'jobs.billing_dunning.escalation_needed'
      )
      captureJobError(
        'billing-dunning',
        new Error(
          `Dunning escalation needed: ${MAX_ATTEMPTS} attempts already sent for venue ${sub.venue_id} period ${periodDate}`
        ),
        { venueId: sub.venue_id }
      )
      summary.escalation_needed++
      summary.skipped++
      continue
    }

    // 48-hour spacing between attempts in the same period.
    const latest = getLatestSentAt(currentPeriodEntries)
    if (latest) {
      const hoursSince = (now.getTime() - latest.getTime()) / MS_HOUR
      if (hoursSince < MIN_HOURS_BETWEEN) {
        subLog.info(
          { hoursSinceLast: Math.round(hoursSince) },
          'jobs.billing_dunning.skip_too_recent'
        )
        summary.skipped++
        continue
      }
    }

    const key = buildDunningKey(sub.venue_id, periodDate, attempt)

    // Owner lookup.
    const owner = await findOwnerEmail(supabase, sub.venue_id)
    if (!owner) {
      subLog.warn({}, 'jobs.billing_dunning.skip_no_owner_email')
      summary.skipped++
      continue
    }

    // Stripe portal URL. createBillingPortalSession throws `BillingError`
    // (e.g. `billing_customer_not_found`) when the venue has no Stripe
    // customer; we treat that as a hard skip (no point emailing a portal
    // link we can't generate).
    let portalUrl: string | null = null
    try {
      const portal = await createBillingPortalSession({
        userId: owner.userId,
        venueId: sub.venue_id,
        requestId: undefined,
      })
      portalUrl = portal.url
    } catch (err) {
      if (err instanceof BillingError) {
        subLog.warn(
          { code: err.code },
          'jobs.billing_dunning.portal_unavailable'
        )
      } else {
        subLog.error({ err }, 'jobs.billing_dunning.portal_failed')
      }
      captureJobError('billing-dunning', err, { venueId: sub.venue_id })
      summary.failed++
      continue
    }

    const appUrl = (process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000').replace(/\/$/, '')
    const fallbackUrl = `${appUrl}/dashboard/settings/billing`
    const text =
      `Your VenueRise subscription is past due — Stripe couldn't process the most ` +
      `recent payment. Updates to your payment method will retry the charge automatically.\n\n` +
      `Some workspace features may be limited until the payment clears. Read-only ` +
      `access to existing leads + the public widget remain available throughout.\n\n` +
      `Update your payment method (secure Stripe link):\n${portalUrl}\n\n` +
      `Or manage everything from your dashboard:\n${fallbackUrl}\n\n` +
      `Reply to this email if you'd rather we sort it out together.`

    let result
    try {
      result = await sendEmail({
        to: owner.email,
        subject: 'Action needed: update your VenueRise payment method',
        text,
        venueId: sub.venue_id,
        relatedTable: 'subscriptions',
        relatedId: sub.id,
      })
    } catch (err) {
      subLog.error({ err }, 'jobs.billing_dunning.send_threw')
      captureJobError('billing-dunning', err, { venueId: sub.venue_id })
      summary.failed++
      continue
    }

    if (!result.delivered) {
      // Console-fallback OR provider error. We never consume an attempt
      // slot under either — next run retries once Resend is wired or the
      // outage clears.
      subLog.warn(
        { provider: result.provider, errorMessage: result.error },
        result.error
          ? 'jobs.billing_dunning.send_failed'
          : 'jobs.billing_dunning.console_fallback'
      )
      if (result.error) {
        captureJobError('billing-dunning', new Error(result.error), {
          venueId: sub.venue_id,
        })
        summary.failed++
      } else {
        summary.skipped++
      }
      continue
    }

    // Delivered — append entry atomically (Phase 7L). The RPC handles the
    // race between this cron and the Stripe webhook sync; helper returns
    // null on failure and logs/captures internally. We count those as
    // hard failures so the operator sees a non-zero `failed` value and
    // can investigate before the next 48h window opens.
    const entry: DunningEntry = {
      kind: REMINDER_KIND,
      key,
      attempt,
      sent_at: new Date().toISOString(),
      provider: (result.provider as DunningEntry['provider']) ?? 'unknown',
      message_id: result.messageId,
    }
    const updated = await appendSubscriptionMetadataArray({
      subscriptionId: sub.id,
      arrayKey: 'dunning_sent',
      // Spread into a plain record so TS accepts the strict interface
      // against the helper's Record<string, unknown> signature.
      entry: { ...entry },
      requestId: undefined,
    })

    if (!updated) {
      subLog.error({}, 'jobs.billing_dunning.metadata_append_failed')
      summary.failed++
      continue
    }

    subLog.info(
      { provider: result.provider, messageId: result.messageId },
      'jobs.billing_dunning.sent'
    )
    summary.sent++
  }

  log.info(summary, 'jobs.billing_dunning.scan_complete')
  return summary
}

// ---------------------------------------------------------------------------
// Inngest binding
// ---------------------------------------------------------------------------

export const billingDunningFn = inngest.createFunction(
  {
    id: 'billing-dunning',
    name: 'Past-due dunning emails (daily, stop after 3 per period)',
    retries: 1,
    triggers: [{ cron: SCHEDULE }],
  },
  async () => runDunningScan()
)

// Exported for unit tests + manual reruns.
export {
  runDunningScan,
  getDunningEntries,
  getCurrentPeriodDunningEntries,
  getLatestSentAt,
  buildDunningKey,
  appendDunningEntry,
}
