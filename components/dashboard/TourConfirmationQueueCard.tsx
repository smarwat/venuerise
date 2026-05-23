import Link from 'next/link'
import { ArrowRight, CalendarCheck, Users } from 'lucide-react'
import { format } from 'date-fns'
import { createClient } from '@/lib/supabase/server'
import {
  computeTourBookingSignals,
  unconfirmedScheduledTours,
  type TourBookingSignal,
} from '@/lib/revenue-os/tour-booking'
import type { LeakageLead, LeakageTour } from '@/lib/revenue-os/leakage'

/**
 * Phase 8AT — Tour Confirmation Queue (Overview surface).
 *
 * Surfaces the future scheduled-but-not-confirmed tours so the
 * operator can fire a confirm message before the slot slips.
 *
 * Read-only, server-rendered, derived from existing `leads` + `tours`
 * tables only. No new endpoint. Best-effort: a probe failure
 * collapses to the empty-state branch so the Overview keeps
 * rendering.
 */

interface Props {
  venueId: string | null
}

async function fetchUnconfirmedQueue(venueId: string): Promise<{
  ok: true
  rows: Array<{
    signal: TourBookingSignal
    leadName: string | null
    leadScore: number | null
    guestCount: number | null
    monthSlug: string
  }>
} | { ok: false }> {
  const supabase = await createClient()

  // 1. Pull all in-flight leads. The confirmation queue specifically
  //    cares about future scheduled-status tours, but we need lead
  //    name + score + guest_count for the row layout, so we pull a
  //    bounded slice + join later in memory.
  const { data: leadRows, error: leadsErr } = await supabase
    .from('leads')
    .select('id, name, stage, lead_score, guest_count, created_at, updated_at')
    .eq('venue_id', venueId)
    .not('stage', 'in', '(lost)')
    .order('created_at', { ascending: false })
    .limit(500)
  if (leadsErr) return { ok: false }
  const rawLeads = (leadRows ?? []) as Array<{
    id: string
    name: string
    stage: string
    lead_score: number
    guest_count: number | null
    created_at: string
    updated_at: string
  }>
  const leadById = new Map(rawLeads.map((l) => [l.id, l]))
  const helperLeads: LeakageLead[] = rawLeads.map((l) => ({
    id: l.id,
    stage: l.stage,
    lead_score: l.lead_score,
    created_at: l.created_at,
    updated_at: l.updated_at,
  }))

  // 2. Future scheduled tours only. We cast a slightly wider net
  //    (no upper bound on scheduled_at) so the helper can also
  //    surface tour_today rows, but the confirmation queue narrows
  //    to unconfirmed in the dedicated extractor below.
  const { data: tourRows } = await supabase
    .from('tours')
    .select('id, lead_id, status, scheduled_at')
    .eq('venue_id', venueId)
    .in('status', ['scheduled', 'confirmed'])
    .limit(500)
  const tours = (tourRows ?? []) as LeakageTour[]

  const allSignals = computeTourBookingSignals({
    leads: helperLeads,
    tours,
  })
  const unconfirmed = unconfirmedScheduledTours(allSignals)

  const rows = unconfirmed.slice(0, 5).map((sig) => {
    const lead = leadById.get(sig.leadId)
    const monthSlug = sig.scheduledAt
      ? format(new Date(sig.scheduledAt), 'yyyy-MM')
      : ''
    return {
      signal: sig,
      leadName: lead?.name ?? null,
      leadScore: lead?.lead_score ?? null,
      guestCount: lead?.guest_count ?? null,
      monthSlug,
    }
  })

  return { ok: true, rows }
}

export default async function TourConfirmationQueueCard({ venueId }: Props) {
  let outcome: Awaited<ReturnType<typeof fetchUnconfirmedQueue>> = { ok: false }
  if (venueId) {
    try {
      outcome = await fetchUnconfirmedQueue(venueId)
    } catch {
      outcome = { ok: false }
    }
  }

  const rows = outcome.ok ? outcome.rows : []
  const isEmpty = outcome.ok && rows.length === 0

  return (
    <section className="rounded-2xl border border-[#E6E8EF] bg-white shadow-card overflow-hidden">
      <div className="flex items-start justify-between gap-3 px-5 pt-4 pb-3 border-b border-[#F1F5F9]">
        <div className="min-w-0">
          <div className="text-[10.5px] uppercase tracking-[0.14em] text-[#94A3B8] font-semibold mb-1">
            Tour protection
          </div>
          <h2 className="text-[15px] font-semibold text-[#0F172A] leading-tight">
            Tours that need confirmation
          </h2>
          <p className="text-[11.5px] text-[#64748B] mt-1">
            Scheduled visits that need clear confirmation before they slip.
          </p>
        </div>
        <Link
          href="/dashboard/leads?leakage=tour_booking"
          className="inline-flex items-center gap-1 text-[11.5px] px-2.5 py-1 rounded-md text-[#1D4ED8] hover:bg-[#EFF6FF] shrink-0"
        >
          Open queue
          <ArrowRight className="w-3 h-3" />
        </Link>
      </div>

      <div className="px-5 py-4">
        {!outcome.ok ? (
          <div className="rounded-xl border border-dashed border-[#E2E8F0] bg-white px-3.5 py-3 text-[12.5px] text-[#64748B]">
            Couldn&apos;t load the confirmation queue right now — the
            data will refresh on the next page load.
          </div>
        ) : isEmpty ? (
          <div className="rounded-xl border border-[#D1FAE5] bg-[#ECFDF5] px-3.5 py-3 flex items-center gap-2.5 text-[12.5px] text-[#047857]">
            <span className="w-7 h-7 rounded-lg bg-white/70 border border-[#A7F3D0] text-[#047857] flex items-center justify-center shrink-0">
              <CalendarCheck className="w-3.5 h-3.5" />
            </span>
            <span>
              No unconfirmed tours right now. Calendar looks tight.
            </span>
          </div>
        ) : (
          <ul className="divide-y divide-[#F1F5F9]">
            {rows.map((row) => {
              const when = row.signal.scheduledAt
                ? format(
                    new Date(row.signal.scheduledAt),
                    "EEE, MMM d · h:mm a"
                  )
                : 'unscheduled'
              return (
                <li
                  key={`${row.signal.leadId}:${row.signal.tourId ?? ''}`}
                  className="py-3 flex items-start gap-3"
                >
                  <span className="w-9 h-9 rounded-[10px] bg-[#EFF6FF] border border-[#BFDBFE] text-[#1D4ED8] flex items-center justify-center shrink-0">
                    <CalendarCheck className="w-4 h-4" />
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-[13px] font-semibold text-[#0F172A] truncate">
                        {row.leadName ?? 'Unknown lead'}
                      </span>
                      {row.leadScore != null && (
                        <span className="text-[10.5px] uppercase tracking-[0.12em] text-[#94A3B8] font-semibold">
                          Score {row.leadScore}
                        </span>
                      )}
                      {row.guestCount != null && (
                        <span className="inline-flex items-center gap-1 text-[11px] text-[#475569]">
                          <Users className="w-3 h-3 text-[#94A3B8]" />
                          {row.guestCount}
                        </span>
                      )}
                    </div>
                    <p className="mt-0.5 text-[11.5px] text-[#475569] leading-snug">
                      {when} ·{' '}
                      <span className="text-[#1D4ED8]">
                        Suggested · {row.signal.suggestedAction.title}
                      </span>
                    </p>
                  </div>
                  <div className="flex flex-col items-end gap-1 shrink-0">
                    <Link
                      href={`/dashboard/leads?lead=${encodeURIComponent(row.signal.leadId)}`}
                      className="inline-flex items-center gap-1 text-[11.5px] px-2 py-1 rounded-md text-[#1D4ED8] hover:bg-[#EFF6FF]"
                    >
                      Open lead
                      <ArrowRight className="w-3 h-3" />
                    </Link>
                    {row.signal.tourId && row.monthSlug && (
                      <Link
                        href={`/dashboard/tours?month=${encodeURIComponent(row.monthSlug)}&audit_tour=${encodeURIComponent(row.signal.tourId)}`}
                        className="text-[10.5px] text-[#94A3B8] hover:text-[#475569]"
                      >
                        Open tours
                      </Link>
                    )}
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </div>

      <div className="px-5 py-2.5 border-t border-[#F1F5F9] bg-[#F8FAFC] text-[11px] text-[#64748B] flex items-center justify-between gap-3">
        <span>
          Confirmed tours are the closest proxy to revenue — protect them before they slip.
        </span>
        <span className="hidden sm:inline text-[#94A3B8]">
          Booked + confirmed tours are the closest proxy to revenue.
        </span>
      </div>
    </section>
  )
}
