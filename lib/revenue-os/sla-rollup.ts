import type { RevenueOsSettings } from './settings'
import {
  computeLeadSpeedToLeadScores,
  type LeakageOutboundActivity,
} from './leakage'

/**
 * Phase 8AR — Speed-to-Lead roll-up.
 *
 * Pure helper. No Supabase client, no React, no env reads — the SLA
 * roll-up card and any future digest reuse the same scoring path so
 * "what the owner sees in the weekly summary" exactly matches "what
 * the operator sees on the per-lead chip."
 *
 * The roll-up is **derived from the same inputs the leakage helper
 * already consumes** (a lead slice + earliest-outbound-per-lead),
 * which keeps the audit story simple — we never compute the same
 * metric two different ways.
 */

export interface RollupLead {
  id: string
  created_at: string
}

export interface SpeedToLeadRollupBucket {
  date: string
  met: number
  missed: number
  pendingOverdue: number
}

export interface SpeedToLeadRollup {
  total: number
  met: number
  missed: number
  pendingHealthy: number
  pendingOverdue: number
  unknown: number
  /** met / (met + missed). Null when there are zero scored leads —
   *  callers should render "—" rather than 0 in that case. */
  metRate: number | null
  /** Median minutes-to-first-reply across leads with an actual
   *  outbound. Null when no leads have a first reply yet. */
  medianMinutesToFirstReply: number | null
  /** 90th-percentile minutes-to-first-reply. Same null semantics. */
  p90MinutesToFirstReply: number | null
  /** Sparkline series bucketed by lead `created_at` (UTC day). The
   *  array is always length = `days`, sorted oldest → newest, with
   *  zero-filled days where nothing happened. */
  sparkline: SpeedToLeadRollupBucket[]
}

function percentile(sortedAsc: number[], pct: number): number | null {
  if (sortedAsc.length === 0) return null
  // Linear interpolation, R-7. Matches numpy's default.
  const rank = (pct / 100) * (sortedAsc.length - 1)
  const lo = Math.floor(rank)
  const hi = Math.ceil(rank)
  if (lo === hi) return sortedAsc[lo]
  const frac = rank - lo
  return Math.round(sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * frac)
}

function utcDayString(d: Date): string {
  // YYYY-MM-DD in UTC. Stable across server time zones.
  return d.toISOString().slice(0, 10)
}

function startOfUtcDay(d: Date): Date {
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0)
  )
}

/**
 * Compute the Speed-to-Lead roll-up for a window of recently-created
 * leads.
 *
 * `args.days` defaults to 7; the caller fetches a wide enough slice
 * (typically `days + 1` to capture leads created early in the
 * "pending-overdue" tail). Leads created outside the window are
 * silently dropped here so callers can over-fetch safely.
 *
 * `metRate` divides by met + missed only — pending leads are
 * excluded from the denominator because they haven't decided yet.
 * That avoids the "100% met because every lead is brand new" trap
 * and the "0% met because every lead is still pending" trap.
 */
export function computeSpeedToLeadRollup(args: {
  leads: ReadonlyArray<RollupLead>
  outbound: ReadonlyArray<LeakageOutboundActivity>
  settings: Pick<RevenueOsSettings, 'firstReplySlaMinutes'>
  now?: Date
  days?: number
}): SpeedToLeadRollup {
  const now = args.now ?? new Date()
  const days = args.days ?? 7
  const windowStart = new Date(
    startOfUtcDay(now).getTime() - (days - 1) * 24 * 60 * 60 * 1000
  )

  // Filter to the requested window. Anything older bleeds into the
  // wider audit views; the roll-up's job is "what happened RECENTLY."
  const inWindow = args.leads.filter((l) => {
    const t = new Date(l.created_at).getTime()
    return Number.isFinite(t) && t >= windowStart.getTime()
  })

  const scores = computeLeadSpeedToLeadScores(
    inWindow,
    args.outbound,
    args.settings,
    now
  )

  let met = 0
  let missed = 0
  let pendingHealthy = 0
  let pendingOverdue = 0
  let unknown = 0
  const repliedMinutes: number[] = []

  // Sparkline scaffolding: every UTC day in the window pre-populated
  // with zeros so an empty day renders as a "0" bar instead of being
  // absent from the chart.
  const buckets = new Map<string, SpeedToLeadRollupBucket>()
  for (let i = 0; i < days; i += 1) {
    const dayStart = new Date(
      windowStart.getTime() + i * 24 * 60 * 60 * 1000
    )
    const key = utcDayString(dayStart)
    buckets.set(key, { date: key, met: 0, missed: 0, pendingOverdue: 0 })
  }

  const leadByIdCreatedAt = new Map<string, string>(
    inWindow.map((l) => [l.id, l.created_at])
  )

  for (const s of scores) {
    if (s.status === 'unknown') {
      unknown += 1
      continue
    }
    if (s.status === 'met') {
      met += 1
      if (s.minutesToFirstReply !== null) {
        repliedMinutes.push(s.minutesToFirstReply)
      }
    } else if (s.status === 'missed') {
      missed += 1
      if (s.minutesToFirstReply !== null) {
        repliedMinutes.push(s.minutesToFirstReply)
      }
    } else if (s.status === 'pending') {
      // The helper's band split: score 60 = pending healthy (still
      // inside the SLA window); score <= 30 = pending overdue.
      if (s.score <= 30) pendingOverdue += 1
      else pendingHealthy += 1
    }
    // Sparkline assignment — bucket by the lead's created_at day.
    const createdAt = leadByIdCreatedAt.get(s.leadId)
    if (!createdAt) continue
    const key = utcDayString(new Date(createdAt))
    const bucket = buckets.get(key)
    if (!bucket) continue
    if (s.status === 'met') bucket.met += 1
    else if (s.status === 'missed') bucket.missed += 1
    else if (s.status === 'pending' && s.score <= 30) bucket.pendingOverdue += 1
  }

  const total = inWindow.length
  // metRate denominator is decided leads only. Pending/unknown leads
  // haven't crossed the SLA line yet, so they don't deserve a vote.
  const decided = met + missed
  const metRate = decided > 0 ? met / decided : null

  const sortedReplied = [...repliedMinutes].sort((a, b) => a - b)
  const medianMinutesToFirstReply = sortedReplied.length > 0
    ? percentile(sortedReplied, 50)
    : null
  const p90MinutesToFirstReply = sortedReplied.length > 0
    ? percentile(sortedReplied, 90)
    : null

  return {
    total,
    met,
    missed,
    pendingHealthy,
    pendingOverdue,
    unknown,
    metRate,
    medianMinutesToFirstReply,
    p90MinutesToFirstReply,
    sparkline: Array.from(buckets.values()),
  }
}
