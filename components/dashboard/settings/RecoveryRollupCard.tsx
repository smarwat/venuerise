import Link from 'next/link'
import { ArrowRight, Heart } from 'lucide-react'
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardSubtitle,
} from '@/components/dashboard/ui/Card'
import { createClient } from '@/lib/supabase/server'
import { parseRevenueOsSettings } from '@/lib/revenue-os/settings'
import {
  computeRecoverySignals,
  type RecoveryLeadSignal,
} from '@/lib/revenue-os/recovery'
import type {
  LeakageLead,
  LeakageInboundActivity,
  LeakageOutboundActivity,
  LeakageTour,
} from '@/lib/revenue-os/leakage'

/**
 * Phase 8AS — Recovery roll-up card.
 *
 * Owner-facing companion to the Overview RecoveryQueueCard. Lives on
 * `/dashboard/settings/billing` next to `SpeedToLeadRollupCard` so
 * the admin can see the recovery pipeline alongside the SLA
 * pipeline.
 *
 * Read-only. Derived each render — no new tables, no cron, no cache.
 * Reuses the same `computeRecoverySignals` helper so the counts
 * agree with the Overview queue + the leads-board recovery filter.
 */

interface Props {
  venueId: string
}

async function fetchRecoveryRollup(venueId: string): Promise<{
  ok: true
  signals: RecoveryLeadSignal[]
} | { ok: false }> {
  const supabase = await createClient()
  const { data: venueRow } = await supabase
    .from('venues')
    .select('metadata')
    .eq('id', venueId)
    .maybeSingle()
  const settings = parseRevenueOsSettings(
    (venueRow as { metadata?: unknown } | null)?.metadata
  )

  const { data: leadRows, error: leadsErr } = await supabase
    .from('leads')
    .select('id, stage, lead_score, created_at, updated_at')
    .eq('venue_id', venueId)
    .not('stage', 'in', '(booked,lost)')
    .order('created_at', { ascending: false })
    .limit(500)
  if (leadsErr) return { ok: false }
  const leads = (leadRows ?? []) as LeakageLead[]

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
        if (!outboundMap.has(m.lead_id)) outboundMap.set(m.lead_id, m.created_at)
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

  const { data: tourRows } = await supabase
    .from('tours')
    .select('id, lead_id, status, scheduled_at')
    .eq('venue_id', venueId)
    .limit(500)
  const tours = (tourRows ?? []) as LeakageTour[]

  const signals = computeRecoverySignals({
    leads,
    inbound,
    outbound,
    tours,
    settings,
  })
  return { ok: true, signals }
}

export default async function RecoveryRollupCard({ venueId }: Props) {
  let outcome: Awaited<ReturnType<typeof fetchRecoveryRollup>> = { ok: false }
  try {
    outcome = await fetchRecoveryRollup(venueId)
  } catch {
    outcome = { ok: false }
  }

  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Recovery pipeline</CardTitle>
          <CardSubtitle>
            How many leads are stalled and worth a human touch right now.
          </CardSubtitle>
        </div>
        <div className="shrink-0 w-9 h-9 rounded-xl bg-[#FFFBEB] border border-[#FCD9A1] flex items-center justify-center">
          <Heart className="w-4 h-4 text-[#B45309]" />
        </div>
      </CardHeader>
      <CardContent>
        {!outcome.ok ? (
          <div className="rounded-2xl border border-dashed border-[#E2E8F0] bg-white p-5 text-[12.5px] text-[#64748B] text-center">
            Couldn&apos;t load the recovery pipeline right now. The data
            will refresh on the next page load.
          </div>
        ) : (
          <RollupBody signals={outcome.signals} />
        )}
      </CardContent>
    </Card>
  )
}

function RollupBody({ signals }: { signals: RecoveryLeadSignal[] }) {
  const stalled = signals.length
  // High-fit stalled = composite score above the "lead_score 80 +
  // one reason" floor (10 * 80 + 20 * 1 = 820).
  const highFitStalled = signals.filter((s) => s.score >= 820).length
  const qualifiedNoTour = signals.filter((s) =>
    s.reasons.includes('qualified_no_tour')
  ).length

  if (stalled === 0) {
    return (
      <div className="rounded-2xl border border-[#D1FAE5] bg-[#ECFDF5] px-3.5 py-3 flex items-center gap-2.5 text-[12.5px] text-[#047857]">
        <span className="w-7 h-7 rounded-lg bg-white/70 border border-[#A7F3D0] text-[#047857] flex items-center justify-center shrink-0">
          <Heart className="w-3.5 h-3.5" />
        </span>
        <span>
          No stalled leads in the recovery queue. The pipeline is
          flowing — keep nurturing.
        </span>
      </div>
    )
  }

  return (
    <>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-3">
        <KpiTile
          label="Stalled leads"
          value={String(stalled)}
          hint="Across all recovery reasons"
        />
        <KpiTile
          label="High-fit stalled"
          value={String(highFitStalled)}
          hint="Lead score at or above the high-fit threshold"
          valueClass={highFitStalled > 0 ? 'text-[#B45309]' : undefined}
        />
        <KpiTile
          label="Qualified · no tour"
          value={String(qualifiedNoTour)}
          hint="Most actionable — offer two tour windows"
          valueClass={qualifiedNoTour > 0 ? 'text-[#B45309]' : undefined}
        />
      </div>
      <Link
        href="/dashboard/leads?leakage=follow_up_recovery"
        className="inline-flex items-center gap-1.5 text-[11.5px] px-2.5 py-1.5 rounded-md text-[#1D4ED8] hover:bg-[#EFF6FF]"
      >
        Open recovery queue
        <ArrowRight className="w-3 h-3" />
      </Link>
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
