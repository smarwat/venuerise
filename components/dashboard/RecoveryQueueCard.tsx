import Link from 'next/link'
import { ArrowRight, Heart, Snowflake, Flame, CalendarCheck, Handshake } from 'lucide-react'
import { createClient } from '@/lib/supabase/server'
import { parseRevenueOsSettings } from '@/lib/revenue-os/settings'
import {
  computeRecoverySignals,
  type RecoveryLeadSignal,
  type RecoveryReason,
} from '@/lib/revenue-os/recovery'
import type {
  LeakageLead,
  LeakageInboundActivity,
  LeakageOutboundActivity,
  LeakageTour,
} from '@/lib/revenue-os/leakage'

/**
 * Phase 8AS — Follow-Up Recovery queue card (Overview surface).
 *
 * Revenue OS direction: the operator should see the highest-value
 * stalled leads on the Overview without hunting for them. This card
 * shows the top 5 from `computeRecoverySignals` ranked by composite
 * score (lead_score + reason count + days since activity).
 *
 * Each row links to `/dashboard/leads?lead=<id>` so clicking opens
 * the drawer directly (Phase 8AL deep-link). The drawer's recovery
 * explainer (Phase 8AS) carries the full reason set + the "Use
 * suggestion in draft" path.
 *
 * Read-only, server-rendered. Best-effort: a probe failure collapses
 * to the empty-state branch so the Overview keeps rendering.
 */

interface Props {
  venueId: string | null
}

const ICON_BY_REASON: Record<RecoveryReason, typeof Heart> = {
  cold_lead: Snowflake,
  high_fit_idle: Flame,
  qualified_no_tour: Handshake,
  tour_pending_confirm: CalendarCheck,
  negotiation_stalled: Handshake,
}

const TONE_BY_REASON: Record<
  RecoveryReason,
  { ring: string; iconBg: string; iconText: string }
> = {
  cold_lead: {
    ring: 'border-[#E2E8F0]',
    iconBg: 'bg-[#F1F5F9]',
    iconText: 'text-[#475569]',
  },
  high_fit_idle: {
    ring: 'border-[#FCD9A1]',
    iconBg: 'bg-[#FFFBEB]',
    iconText: 'text-[#B45309]',
  },
  qualified_no_tour: {
    ring: 'border-[#FCD9A1]',
    iconBg: 'bg-[#FFFBEB]',
    iconText: 'text-[#B45309]',
  },
  tour_pending_confirm: {
    ring: 'border-[#BFDBFE]',
    iconBg: 'bg-[#EFF6FF]',
    iconText: 'text-[#1D4ED8]',
  },
  negotiation_stalled: {
    ring: 'border-[#FCD9A1]',
    iconBg: 'bg-[#FFFBEB]',
    iconText: 'text-[#B45309]',
  },
}

async function fetchRecoveryQueue(venueId: string): Promise<{
  signals: RecoveryLeadSignal[]
  leadsById: Map<string, { id: string; name: string; lead_score: number }>
  probeError: boolean
}> {
  const supabase = await createClient()
  // 0. Venue metadata → settings.
  const { data: venueRow } = await supabase
    .from('venues')
    .select('metadata')
    .eq('id', venueId)
    .maybeSingle()
  const settings = parseRevenueOsSettings(
    (venueRow as { metadata?: unknown } | null)?.metadata
  )

  // 1. In-flight leads. We also pull `name` here so the card can
  //    render rows without a second lookup.
  const { data: leadRows, error: leadsErr } = await supabase
    .from('leads')
    .select('id, name, stage, lead_score, created_at, updated_at')
    .eq('venue_id', venueId)
    .not('stage', 'in', '(booked,lost)')
    .order('created_at', { ascending: false })
    .limit(500)
  if (leadsErr) {
    return {
      signals: [],
      leadsById: new Map(),
      probeError: true,
    }
  }
  const rawLeads = (leadRows ?? []) as Array<{
    id: string
    name: string
    stage: string
    lead_score: number
    created_at: string
    updated_at: string
  }>
  const leads: LeakageLead[] = rawLeads.map((l) => ({
    id: l.id,
    stage: l.stage,
    lead_score: l.lead_score,
    created_at: l.created_at,
    updated_at: l.updated_at,
  }))
  const leadsById = new Map(
    rawLeads.map((l) => [
      l.id,
      { id: l.id, name: l.name, lead_score: l.lead_score },
    ])
  )

  // 2. Batched message activity reduced to first-outbound /
  //    last-inbound per lead.
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

  // 3. Tours scoped to the lead slice (just status + scheduled_at
  //    are needed by the helper).
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
  return { signals, leadsById, probeError: false }
}

export default async function RecoveryQueueCard({ venueId }: Props) {
  let signals: RecoveryLeadSignal[] = []
  let leadsById: Map<string, { id: string; name: string; lead_score: number }> =
    new Map()
  let probeError = false
  if (venueId) {
    try {
      const result = await fetchRecoveryQueue(venueId)
      signals = result.signals
      leadsById = result.leadsById
      probeError = result.probeError
    } catch {
      probeError = true
    }
  }

  const top = signals.slice(0, 5)
  const isEmpty = !probeError && top.length === 0

  return (
    <section className="rounded-2xl border border-[#E6E8EF] bg-white shadow-card overflow-hidden">
      <div className="flex items-start justify-between gap-3 px-5 pt-4 pb-3 border-b border-[#F1F5F9]">
        <div className="min-w-0">
          <div className="text-[10.5px] uppercase tracking-[0.14em] text-[#94A3B8] font-semibold mb-1">
            Revenue recovery
          </div>
          <h2 className="text-[15px] font-semibold text-[#0F172A] leading-tight">
            High-value leads to recover
          </h2>
          <p className="text-[11.5px] text-[#64748B] mt-1">
            Leads with buying intent that still need a human touch.
          </p>
        </div>
        <Link
          href="/dashboard/leads?leakage=follow_up_recovery"
          className="inline-flex items-center gap-1 text-[11.5px] px-2.5 py-1 rounded-md text-[#1D4ED8] hover:bg-[#EFF6FF] shrink-0"
        >
          Open queue
          <ArrowRight className="w-3 h-3" />
        </Link>
      </div>

      <div className="px-5 py-4">
        {probeError ? (
          <div className="rounded-xl border border-dashed border-[#E2E8F0] bg-white px-3.5 py-3 text-[12.5px] text-[#64748B]">
            Couldn&apos;t score the recovery queue right now — the data
            will refresh on the next page load.
          </div>
        ) : isEmpty ? (
          <div className="rounded-xl border border-[#D1FAE5] bg-[#ECFDF5] px-3.5 py-3 flex items-center gap-2.5 text-[12.5px] text-[#047857]">
            <span className="w-7 h-7 rounded-lg bg-white/70 border border-[#A7F3D0] text-[#047857] flex items-center justify-center shrink-0">
              <Heart className="w-3.5 h-3.5" />
            </span>
            <span>
              No stalled high-value leads right now. Keep nurturing the
              pipeline.
            </span>
          </div>
        ) : (
          <ul className="divide-y divide-[#F1F5F9]">
            {top.map((sig) => {
              const lead = leadsById.get(sig.leadId)
              const Icon = ICON_BY_REASON[sig.primaryReason]
              const tone = TONE_BY_REASON[sig.primaryReason]
              return (
                <li key={sig.leadId}>
                  <Link
                    href={`/dashboard/leads?lead=${encodeURIComponent(sig.leadId)}`}
                    className={`flex items-start gap-3 py-3 px-2 -mx-2 rounded-xl hover:bg-[#F8FAFC] border ${tone.ring} border-transparent hover:border-[#E2E8F0] transition-colors`}
                  >
                    <span
                      className={`w-9 h-9 rounded-[10px] ${tone.iconBg} ${tone.iconText} flex items-center justify-center shrink-0`}
                    >
                      <Icon className="w-4 h-4" />
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-[13px] font-semibold text-[#0F172A] truncate">
                          {lead?.name ?? 'Unknown lead'}
                        </span>
                        <span className="text-[10.5px] uppercase tracking-[0.12em] text-[#94A3B8] font-semibold">
                          Score {lead?.lead_score ?? '—'}
                        </span>
                        <span className="text-[10.5px] uppercase tracking-[0.12em] text-[#475569] font-semibold">
                          · {sig.label}
                        </span>
                      </div>
                      <p className="mt-0.5 text-[11.5px] text-[#475569] leading-snug">
                        {sig.helper}
                      </p>
                      <p className="mt-1 text-[11px] text-[#1D4ED8]">
                        Suggested · {sig.suggestedAction.title}
                      </p>
                    </div>
                    <ArrowRight className="w-3.5 h-3.5 text-[#94A3B8] mt-1 shrink-0" />
                  </Link>
                </li>
              )
            })}
          </ul>
        )}
      </div>

      <div className="px-5 py-2.5 border-t border-[#F1F5F9] bg-[#F8FAFC] text-[11px] text-[#64748B] flex items-center justify-between gap-3">
        <span>
          Recovery agent is monitoring cold, idle, and tourless leads.
        </span>
        <span className="hidden sm:inline text-[#94A3B8]">
          Suggestions never auto-send. Operator stays in control.
        </span>
      </div>
    </section>
  )
}
