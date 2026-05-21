import Link from 'next/link'
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardSubtitle,
} from '@/components/dashboard/ui/Card'
import { ArrowRight, Clock } from 'lucide-react'
import { createClient } from '@/lib/supabase/server'
import { parseRevenueOsSettings } from '@/lib/revenue-os/settings'
import {
  computeSpeedToLeadRollup,
  type SpeedToLeadRollupBucket,
} from '@/lib/revenue-os/sla-rollup'
import type {
  LeakageOutboundActivity,
} from '@/lib/revenue-os/leakage'

/**
 * Phase 8AR — Speed-to-Lead roll-up card.
 *
 * Server-rendered, admin-only, mounted on
 * `/dashboard/settings/billing` near `RevenueOsSettingsCard`. The
 * card answers the owner's "how are we doing on speed-to-lead this
 * week?" question without making them dig through audit drawers.
 *
 * Data is **derived**, never stored — the helper reads the same
 * `leads` + outbound `messages` slice the leakage layer already
 * consumes. There's no new table, no cache, no cron. If the venue
 * adjusts their SLA on the settings card and reloads, the roll-up
 * recomputes against the new threshold immediately.
 *
 * Best-effort: any probe failure collapses to the empty-state branch
 * so the billing page still renders.
 */

interface Props {
  venueId: string
}

const WINDOW_DAYS = 7

function formatMinutes(min: number | null): string {
  if (min === null) return '—'
  if (min < 60) return `${min}m`
  const h = Math.floor(min / 60)
  const rest = min % 60
  return rest === 0 ? `${h}h` : `${h}h ${rest}m`
}

function formatPct(rate: number | null): string {
  if (rate === null) return '—'
  return `${Math.round(rate * 100)}%`
}

function rateTone(rate: number | null): {
  pill: string
  text: string
} {
  if (rate === null)
    return {
      pill: 'bg-[#F1F5F9] text-[#475569] border-[#E2E8F0]',
      text: 'text-[#475569]',
    }
  if (rate >= 0.85)
    return {
      pill: 'bg-[#ECFDF5] text-[#047857] border-[#A7F3D0]',
      text: 'text-[#047857]',
    }
  if (rate >= 0.6)
    return {
      pill: 'bg-[#EFF6FF] text-[#1D4ED8] border-[#BFDBFE]',
      text: 'text-[#1D4ED8]',
    }
  return {
    pill: 'bg-[#FFFBEB] text-[#B45309] border-[#FCD9A1]',
    text: 'text-[#B45309]',
  }
}

async function fetchRollup(venueId: string): Promise<{
  ok: true
  rollup: ReturnType<typeof computeSpeedToLeadRollup>
  slaMinutes: number
} | { ok: false }> {
  const supabase = await createClient()

  // 1. Venue settings (clamped via parseRevenueOsSettings).
  const { data: venueRow } = await supabase
    .from('venues')
    .select('metadata')
    .eq('id', venueId)
    .maybeSingle()
  const settings = parseRevenueOsSettings(
    (venueRow as { metadata?: unknown } | null)?.metadata
  )

  // 2. Leads created in the last (WINDOW_DAYS + 1) days. The extra
  //    day buffers the helper so a lead created just before midnight
  //    in the operator's timezone still scores cleanly into the
  //    UTC-day buckets.
  const windowStartIso = new Date(
    Date.now() - (WINDOW_DAYS + 1) * 24 * 60 * 60 * 1000
  ).toISOString()
  const { data: leadRows, error: leadsErr } = await supabase
    .from('leads')
    .select('id, created_at')
    .eq('venue_id', venueId)
    .gte('created_at', windowStartIso)
    .order('created_at', { ascending: false })
    .limit(500)
  if (leadsErr) return { ok: false }
  const leads = (leadRows ?? []) as Array<{ id: string; created_at: string }>

  // 3. Earliest outbound message per lead. We pull ASC + reduce so
  //    the first hit per lead wins.
  const outboundByLead = new Map<string, string | null>()
  if (leads.length > 0) {
    const leadIds = leads.map((l) => l.id)
    const { data: msgRows } = await supabase
      .from('messages')
      .select('lead_id, created_at')
      .eq('venue_id', venueId)
      .in('role', ['ai', 'human'])
      .in('lead_id', leadIds)
      .order('created_at', { ascending: true })
      .limit(5000)
    for (const m of (msgRows as Array<{
      lead_id: string
      created_at: string
    }> | null) ?? []) {
      if (!outboundByLead.has(m.lead_id)) {
        outboundByLead.set(m.lead_id, m.created_at)
      }
    }
  }
  const outbound: LeakageOutboundActivity[] = leads.map((l) => ({
    lead_id: l.id,
    first_outbound_at: outboundByLead.get(l.id) ?? null,
  }))

  const rollup = computeSpeedToLeadRollup({
    leads,
    outbound,
    settings,
    days: WINDOW_DAYS,
  })
  return { ok: true, rollup, slaMinutes: settings.firstReplySlaMinutes }
}

export default async function SpeedToLeadRollupCard({ venueId }: Props) {
  let outcome: Awaited<ReturnType<typeof fetchRollup>> = { ok: false }
  try {
    outcome = await fetchRollup(venueId)
  } catch {
    // Fail closed to the empty state — billing page must keep
    // rendering even if a single probe goes sideways.
    outcome = { ok: false }
  }

  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Speed-to-Lead this week</CardTitle>
          <CardSubtitle>
            Median first-reply, SLA met rate, and overdue replies for the
            last {WINDOW_DAYS} days.
          </CardSubtitle>
        </div>
        <div className="shrink-0 w-9 h-9 rounded-xl bg-[#EFF6FF] border border-[#BFDBFE] flex items-center justify-center">
          <Clock className="w-4 h-4 text-[#1D4ED8]" />
        </div>
      </CardHeader>
      <CardContent>
        {!outcome.ok ? (
          <div className="rounded-2xl border border-dashed border-[#E2E8F0] bg-white p-5 text-[12.5px] text-[#64748B] text-center">
            Couldn&apos;t load Speed-to-Lead roll-up right now. The data
            will refresh on the next page load.
          </div>
        ) : outcome.rollup.total === 0 ? (
          <div className="rounded-2xl border border-dashed border-[#E2E8F0] bg-white p-5 text-[12.5px] text-[#64748B] text-center">
            No leads measured in this window yet. Once a new inquiry
            lands, its speed-to-reply score will appear here.
          </div>
        ) : (
          <RollupBody
            rollup={outcome.rollup}
            slaMinutes={outcome.slaMinutes}
          />
        )}
      </CardContent>
    </Card>
  )
}

function RollupBody({
  rollup,
  slaMinutes,
}: {
  rollup: ReturnType<typeof computeSpeedToLeadRollup>
  slaMinutes: number
}) {
  const tone = rateTone(rollup.metRate)
  return (
    <>
      {/* KPI strip */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
        <KpiTile
          label="Median first reply"
          value={formatMinutes(rollup.medianMinutesToFirstReply)}
          hint={
            rollup.p90MinutesToFirstReply !== null
              ? `p90 · ${formatMinutes(rollup.p90MinutesToFirstReply)}`
              : 'sample too small for p90'
          }
        />
        <KpiTile
          label="SLA met rate"
          value={formatPct(rollup.metRate)}
          hint={
            rollup.metRate === null
              ? 'no decided replies yet'
              : `${rollup.met} met · ${rollup.missed} missed`
          }
          valueClass={tone.text}
        />
        <KpiTile
          label="Overdue replies"
          value={String(rollup.pendingOverdue)}
          hint={
            rollup.pendingHealthy > 0
              ? `${rollup.pendingHealthy} still inside SLA`
              : 'none still inside SLA'
          }
          valueClass={
            rollup.pendingOverdue > 0 ? 'text-[#B45309]' : 'text-[#475569]'
          }
        />
        <KpiTile
          label="Leads measured"
          value={String(rollup.total)}
          hint={`SLA target · ${formatMinutes(slaMinutes)}`}
        />
      </div>

      {/* Sparkline strip */}
      <div className="mb-4">
        <div className="text-[10.5px] uppercase tracking-[0.14em] text-[#94A3B8] font-semibold mb-2">
          Daily breakdown
        </div>
        <Sparkline buckets={rollup.sparkline} />
      </div>

      {/* CTA + footnote */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <p className="text-[11.5px] text-[#64748B] max-w-[420px] leading-snug">
          Pending leads aren&apos;t counted in the SLA met rate — they
          haven&apos;t crossed the line yet. Median and p90 use only
          leads that already received a first reply.
        </p>
        <Link
          href="/dashboard/leads?leakage=slow_first_reply"
          className="inline-flex items-center gap-1.5 text-[11.5px] px-2.5 py-1.5 rounded-md text-[#1D4ED8] hover:bg-[#EFF6FF] shrink-0"
        >
          Review slow replies
          <ArrowRight className="w-3 h-3" />
        </Link>
      </div>
    </>
  )
}

function KpiTile({
  label,
  value,
  hint,
  valueClass,
}: {
  label: string
  value: string
  hint: string
  valueClass?: string
}) {
  return (
    <div className="rounded-xl border border-[#E6E8EF] bg-white px-3 py-2.5 flex flex-col gap-1.5 min-w-0">
      <div className="text-[10.5px] uppercase tracking-[0.14em] text-[#64748B] font-semibold">
        {label}
      </div>
      <div
        className={`text-[22px] font-semibold leading-none tabular-nums tracking-[-0.02em] ${valueClass ?? 'text-[#0F172A]'}`}
      >
        {value}
      </div>
      <div className="text-[10.5px] text-[#94A3B8] leading-snug truncate">
        {hint}
      </div>
    </div>
  )
}

function Sparkline({ buckets }: { buckets: SpeedToLeadRollupBucket[] }) {
  const max = Math.max(
    1,
    ...buckets.map((b) => b.met + b.missed + b.pendingOverdue)
  )
  return (
    <div className="flex items-end gap-1 h-[64px]">
      {buckets.map((b) => {
        const total = b.met + b.missed + b.pendingOverdue
        const heightPct = (total / max) * 100
        const day = new Date(b.date).toLocaleDateString(undefined, {
          weekday: 'short',
        })
        return (
          <div
            key={b.date}
            className="flex-1 min-w-0 flex flex-col items-center gap-1"
            title={`${b.date} · ${b.met} met · ${b.missed} missed · ${b.pendingOverdue} overdue`}
          >
            <div className="w-full flex-1 flex flex-col-reverse rounded-md overflow-hidden border border-[#E2E8F0] bg-[#F8FAFC]">
              {total > 0 ? (
                <>
                  {b.met > 0 && (
                    <div
                      className="bg-[#10B981]"
                      style={{ height: `${(b.met / total) * heightPct}%` }}
                    />
                  )}
                  {b.missed > 0 && (
                    <div
                      className="bg-[#D97706]"
                      style={{ height: `${(b.missed / total) * heightPct}%` }}
                    />
                  )}
                  {b.pendingOverdue > 0 && (
                    <div
                      className="bg-[#DC2626]"
                      style={{
                        height: `${(b.pendingOverdue / total) * heightPct}%`,
                      }}
                    />
                  )}
                </>
              ) : null}
            </div>
            <div className="text-[9.5px] text-[#94A3B8] tabular-nums">
              {day.slice(0, 2)}
            </div>
          </div>
        )
      })}
    </div>
  )
}
