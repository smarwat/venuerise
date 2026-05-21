import Link from 'next/link'
import {
  ArrowRight,
  AlertTriangle,
  CalendarClock,
  Flame,
  Snowflake,
  Clock,
} from 'lucide-react'
import { createClient } from '@/lib/supabase/server'
import { parseRevenueOsSettings } from '@/lib/revenue-os/settings'
import {
  computeRevenueLeakage,
  type LeakageLead,
  type LeakageOutboundActivity,
  type LeakageInboundActivity,
  type LeakageSignal,
  type LeakageSignalKey,
  type LeakageTour,
} from '@/lib/revenue-os/leakage'

/**
 * Phase 8AP → 8AQ — Revenue Leakage Brief.
 *
 * 8AP: server-rendered tile grid with hardcoded thresholds.
 * 8AQ: thresholds now flow from per-venue `venues.metadata.revenue_os`
 *      via `parseRevenueOsSettings`; the actual scoring lives in
 *      `lib/revenue-os/leakage.ts` (pure helper) so the leads board +
 *      lead drawer can reuse the same math. Tiles are also Links now,
 *      so clicking "5 high-fit idle" jumps straight to
 *      /dashboard/leads?leakage=high_fit_idle.
 *
 * Read-only. No mutations. Uses only existing tables.
 *
 * Best-effort: any individual probe error collapses to the safe
 * "no leakage detected" branch rather than failing the whole page.
 */

interface RevenueLeakageBriefProps {
  /** Venue to compute leakage for. Null collapses to an empty brief. */
  venueId: string | null
}

// ---------------------------------------------------------------------------
// Visual tone map. The helper carries the severity; the card decides
// what color it paints with.
// ---------------------------------------------------------------------------

const TONE_CLASSES: Record<
  LeakageSignal['severity'],
  { wrap: string; iconBg: string; iconText: string; count: string }
> = {
  red:   { wrap: 'border-[#FECACA]', iconBg: 'bg-[#FEF2F2]', iconText: 'text-[#B91C1C]', count: 'text-[#B91C1C]' },
  amber: { wrap: 'border-[#FCD9A1]', iconBg: 'bg-[#FFFBEB]', iconText: 'text-[#B45309]', count: 'text-[#B45309]' },
  blue:  { wrap: 'border-[#BFDBFE]', iconBg: 'bg-[#EFF6FF]', iconText: 'text-[#1D4ED8]', count: 'text-[#1D4ED8]' },
  slate: { wrap: 'border-[#E2E8F0]', iconBg: 'bg-[#F1F5F9]', iconText: 'text-[#475569]', count: 'text-[#0F172A]' },
}

const ICON_BY_KEY: Record<LeakageSignalKey, typeof Flame> = {
  slow_first_reply: Clock,
  high_fit_idle: Flame,
  no_tour_booked: AlertTriangle,
  tour_pending_confirm: CalendarClock,
  cold_lead_recovery: Snowflake,
}

// ---------------------------------------------------------------------------
// Tile destinations. Each leakage signal links to the surface where
// the operator can act on it. `tour_pending_confirm` jumps to the
// tours page because that's where confirmation lives; the rest deep-
// link the leads board with a `?leakage=` filter (Phase 8AQ leads
// filter support).
// ---------------------------------------------------------------------------

const HREF_BY_KEY: Record<LeakageSignalKey, string> = {
  slow_first_reply: '/dashboard/leads?leakage=slow_first_reply',
  high_fit_idle: '/dashboard/leads?leakage=high_fit_idle',
  no_tour_booked: '/dashboard/leads?leakage=no_tour_booked',
  tour_pending_confirm: '/dashboard/tours',
  cold_lead_recovery: '/dashboard/leads?leakage=cold_lead_recovery',
}

// ---------------------------------------------------------------------------
// Data fetch — narrow shapes, then hand the work to the pure helper.
// ---------------------------------------------------------------------------

async function fetchLeakageInputs(venueId: string): Promise<{
  signals: LeakageSignal[]
  probeError: boolean
}> {
  const supabase = await createClient()

  // 0. Pull venue metadata so we can derive Revenue OS settings.
  //    A missing/malformed row collapses to defaults — never blocks.
  const { data: venueRow } = await supabase
    .from('venues')
    .select('metadata')
    .eq('id', venueId)
    .maybeSingle()
  const settings = parseRevenueOsSettings(
    (venueRow as { metadata?: unknown } | null)?.metadata
  )

  // 1. In-flight leads only. Booked/lost aren't leakage signals.
  const { data: leadRows, error: leadsErr } = await supabase
    .from('leads')
    .select('id, stage, lead_score, created_at, updated_at')
    .eq('venue_id', venueId)
    .not('stage', 'in', '(booked,lost)')
    .order('created_at', { ascending: false })
    .limit(500)
  if (leadsErr) {
    return { signals: [], probeError: true }
  }
  const leads = (leadRows ?? []) as LeakageLead[]
  const leadIds = leads.map((l) => l.id)

  // 2. Outbound + inbound message activity, batched. We pull
  //    everything in window and reduce per-lead in memory — the helper
  //    cares only about first_outbound_at / last_inbound_at.
  const outboundMap = new Map<string, string | null>()
  const inboundMap = new Map<string, string | null>()
  if (leadIds.length > 0) {
    const { data: msgRows } = await supabase
      .from('messages')
      .select('lead_id, role, created_at')
      .eq('venue_id', venueId)
      .in('lead_id', leadIds)
      .order('created_at', { ascending: true })
      .limit(5000)
    for (const m of (msgRows as Array<{
      lead_id: string
      role: string
      created_at: string
    }> | null) ?? []) {
      if (m.role === 'ai' || m.role === 'human') {
        // First outbound = the earliest one we see. The ascending sort
        // means the first hit per lead is the winner.
        if (!outboundMap.has(m.lead_id)) {
          outboundMap.set(m.lead_id, m.created_at)
        }
      } else if (m.role === 'lead') {
        // Latest inbound = overwrite with each newer one we see.
        // Ascending sort means the LAST write per lead is the latest.
        inboundMap.set(m.lead_id, m.created_at)
      }
    }
  }
  const outbound: LeakageOutboundActivity[] = Array.from(
    outboundMap.entries()
  ).map(([lead_id, first_outbound_at]) => ({ lead_id, first_outbound_at }))
  const inbound: LeakageInboundActivity[] = Array.from(
    inboundMap.entries()
  ).map(([lead_id, last_inbound_at]) => ({ lead_id, last_inbound_at }))

  // 3. Tours — we need lead_id + status + scheduled_at for two of the
  //    five signals (no_tour_booked + tour_pending_confirm).
  const { data: tourRows } = await supabase
    .from('tours')
    .select('id, lead_id, status, scheduled_at')
    .eq('venue_id', venueId)
    .limit(500)
  const tours = (tourRows ?? []) as LeakageTour[]

  const signals = computeRevenueLeakage({
    leads,
    outbound,
    inbound,
    tours,
    settings,
  })
  return { signals, probeError: false }
}

export default async function RevenueLeakageBrief({
  venueId,
}: RevenueLeakageBriefProps) {
  let signals: LeakageSignal[] = []
  let probeError = false
  if (venueId) {
    try {
      const result = await fetchLeakageInputs(venueId)
      signals = result.signals
      probeError = result.probeError
    } catch {
      // Revenue OS direction: this surface should NEVER break the
      // dashboard. A failed probe collapses to the "no leakage
      // detected" branch + a quiet footer note.
      probeError = true
    }
  }

  const totalLeakage = signals.reduce((s, sig) => s + sig.count, 0)
  const isClean = !probeError && totalLeakage === 0

  return (
    <section className="rounded-2xl border border-[#E6E8EF] bg-white shadow-card overflow-hidden">
      <div className="flex items-start justify-between gap-3 px-5 pt-4 pb-3 border-b border-[#F1F5F9]">
        <div className="min-w-0">
          <div className="text-[10.5px] uppercase tracking-[0.14em] text-[#94A3B8] font-semibold mb-1">
            Revenue OS
          </div>
          <h2 className="text-[15px] font-semibold text-[#0F172A] leading-tight">
            Revenue leakage watch
          </h2>
          <p className="text-[11.5px] text-[#64748B] mt-1">
            Where leads are most at risk of slipping. Updated each load.
          </p>
        </div>
        <Link
          href="/dashboard/leads"
          className="inline-flex items-center gap-1 text-[11.5px] px-2.5 py-1 rounded-md text-[#1D4ED8] hover:bg-[#EFF6FF] shrink-0"
        >
          Open leads
          <ArrowRight className="w-3 h-3" />
        </Link>
      </div>

      <div className="px-5 py-4">
        {isClean ? (
          <div className="rounded-xl border border-[#D1FAE5] bg-[#ECFDF5] px-3.5 py-3 flex items-center gap-2.5 text-[12.5px] text-[#047857]">
            <span className="w-7 h-7 rounded-lg bg-white/70 border border-[#A7F3D0] text-[#047857] flex items-center justify-center shrink-0">
              <Flame className="w-3.5 h-3.5" />
            </span>
            <span>
              No urgent leakage detected today. Your follow-up game is on
              point — keep going.
            </span>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-5 gap-2.5">
            {signals.map((s) => {
              const Icon = ICON_BY_KEY[s.key]
              const tone = TONE_CLASSES[s.severity]
              const isZero = s.count === 0
              const href = HREF_BY_KEY[s.key]
              // Phase 8AQ — tiles are Links when there's something
              // worth clicking through to. Zero-count tiles are
              // rendered as static divs so the operator's eye still
              // sees the agent is monitoring the surface, without
              // tempting an unnecessary nav.
              const inner = (
                <>
                  <div className="flex items-center justify-between gap-2">
                    <span
                      className={`w-7 h-7 rounded-lg ${
                        isZero
                          ? 'bg-white border border-[#E2E8F0] text-[#94A3B8]'
                          : `${tone.iconBg} ${tone.iconText}`
                      } flex items-center justify-center shrink-0`}
                    >
                      <Icon className="w-3.5 h-3.5" />
                    </span>
                    <span
                      className={`text-[22px] font-semibold leading-none tabular-nums tracking-[-0.02em] ${
                        isZero ? 'text-[#94A3B8]' : tone.count
                      }`}
                    >
                      {s.count}
                    </span>
                  </div>
                  <div className="min-w-0">
                    <div className="text-[12px] font-semibold text-[#0F172A] truncate">
                      {s.label}
                    </div>
                    <div className="text-[10.5px] text-[#64748B] mt-0.5 leading-snug">
                      {s.helper}
                    </div>
                  </div>
                </>
              )
              const className = `rounded-xl border ${
                isZero
                  ? 'border-[#E2E8F0] bg-[#F8FAFC]'
                  : `bg-white ${tone.wrap}`
              } px-3 py-2.5 flex flex-col gap-2 min-w-0 transition-colors ${
                isZero
                  ? ''
                  : 'hover:border-[#CBD5E1] hover:bg-[#F8FAFC] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#3B82F6]/30'
              }`
              return isZero ? (
                <div key={s.key} className={className}>
                  {inner}
                </div>
              ) : (
                <Link key={s.key} href={href} className={className}>
                  {inner}
                </Link>
              )
            })}
          </div>
        )}
      </div>

      {/* Phase 8AR — footer now leads with the Speed-to-Lead framing
          since that's the first operationalized Revenue OS metric.
          The right-side motto stays so the thesis language lives in
          the product chrome, not just docs. */}
      <div className="px-5 py-2.5 border-t border-[#F1F5F9] bg-[#F8FAFC] text-[11px] text-[#64748B] flex items-center justify-between gap-3">
        <span>
          {probeError
            ? 'Couldn’t score leakage right now — the data will refresh on the next page load.'
            : isClean
              ? 'No urgent leakage detected. Keep response speed tight.'
              : 'Speed-to-lead is the first revenue leak. The faster the reply, the higher the chance this lead becomes a tour.'}
        </span>
        <span className="hidden sm:inline text-[#94A3B8]">
          {isClean
            ? 'AI revenue manager is watching every inquiry.'
            : `${totalLeakage} item${totalLeakage === 1 ? '' : 's'} worth a touch today.`}
        </span>
      </div>
    </section>
  )
}
