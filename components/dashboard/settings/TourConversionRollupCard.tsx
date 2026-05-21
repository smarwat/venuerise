import Link from 'next/link'
import { ArrowRight, CalendarCheck } from 'lucide-react'
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardSubtitle,
} from '@/components/dashboard/ui/Card'
import { createClient } from '@/lib/supabase/server'

/**
 * Phase 8AT — Tour Conversion Roll-Up card.
 *
 * Owner-facing companion to the Overview TourConfirmationQueueCard.
 * Lives on `/dashboard/settings/billing` next to the other
 * Revenue OS roll-ups so the admin can see the whole pipeline
 * (Speed-to-Lead, Recovery, Tour Booking) in one column.
 *
 * Reads existing `leads` + `tours` tables only. No new endpoint, no
 * cron, no cache — derived each render. Pending leads in the
 * qualified pool don't disqualify a venue from getting a useful
 * scheduled-rate number; we count anything that became qualified in
 * the window.
 */

const WINDOW_DAYS = 30

interface Props {
  venueId: string
}

interface Counts {
  qualifiedOrLater: number
  scheduledOrLater: number
  confirmedOrCompleted: number
}

async function fetchCounts(
  venueId: string
): Promise<{ ok: true; counts: Counts } | { ok: false }> {
  const supabase = await createClient()
  const sinceIso = new Date(
    Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000
  ).toISOString()

  // 1. Leads created in the window that reached qualified-or-later.
  //    We treat "qualified or later" inclusively (qualified,
  //    tour_scheduled, tour_completed, negotiation, booked) so a
  //    fast-converting lead still appears in the denominator —
  //    otherwise venues with great conversion would paradoxically
  //    show lower scheduled-rates because their leads moved past
  //    `qualified` before the snapshot.
  const QUALIFIED_OR_LATER = [
    'qualified',
    'tour_scheduled',
    'tour_completed',
    'negotiation',
    'booked',
  ]
  const { data: qualifiedLeads, error: qErr } = await supabase
    .from('leads')
    .select('id')
    .eq('venue_id', venueId)
    .in('stage', QUALIFIED_OR_LATER)
    .gte('created_at', sinceIso)
    .limit(2000)
  if (qErr) return { ok: false }
  const qualifiedIds = ((qualifiedLeads ?? []) as Array<{ id: string }>).map(
    (l) => l.id
  )
  const qualifiedOrLater = qualifiedIds.length

  // 2. Tours scheduled within the window. We count tour ROWS (not
  //    distinct leads) so a venue that re-schedules a tour after a
  //    cancel still gets credit for the re-attempt. Status filter
  //    catches anything that crossed the scheduled line.
  if (qualifiedIds.length === 0) {
    return {
      ok: true,
      counts: { qualifiedOrLater: 0, scheduledOrLater: 0, confirmedOrCompleted: 0 },
    }
  }
  const TOUR_SCHEDULED_OR_LATER = [
    'scheduled',
    'confirmed',
    'completed',
    'no_show',
  ]
  const { data: scheduledTours } = await supabase
    .from('tours')
    .select('id, status, created_at')
    .eq('venue_id', venueId)
    .in('lead_id', qualifiedIds)
    .in('status', TOUR_SCHEDULED_OR_LATER)
    .limit(2000)
  const scheduledOrLater = (scheduledTours ?? []).length
  const confirmedOrCompleted = (
    (scheduledTours ?? []) as Array<{ status: string }>
  ).filter((t) => t.status === 'confirmed' || t.status === 'completed').length

  return {
    ok: true,
    counts: { qualifiedOrLater, scheduledOrLater, confirmedOrCompleted },
  }
}

function formatPct(numerator: number, denominator: number): string {
  if (denominator <= 0) return '—'
  return `${Math.round((numerator / denominator) * 100)}%`
}

function rateTone(rate: number | null): string {
  if (rate === null) return 'text-[#475569]'
  if (rate >= 0.7) return 'text-[#047857]'
  if (rate >= 0.4) return 'text-[#1D4ED8]'
  return 'text-[#B45309]'
}

export default async function TourConversionRollupCard({ venueId }: Props) {
  let outcome: Awaited<ReturnType<typeof fetchCounts>> = { ok: false }
  try {
    outcome = await fetchCounts(venueId)
  } catch {
    outcome = { ok: false }
  }

  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Tour conversion (30d)</CardTitle>
          <CardSubtitle>
            Qualified → Scheduled → Confirmed across the last
            {' '}
            {WINDOW_DAYS} days.
          </CardSubtitle>
        </div>
        <div className="shrink-0 w-9 h-9 rounded-xl bg-[#EFF6FF] border border-[#BFDBFE] flex items-center justify-center">
          <CalendarCheck className="w-4 h-4 text-[#1D4ED8]" />
        </div>
      </CardHeader>
      <CardContent>
        {!outcome.ok ? (
          <div className="rounded-2xl border border-dashed border-[#E2E8F0] bg-white p-5 text-[12.5px] text-[#64748B] text-center">
            Couldn&apos;t load tour conversion right now. The data will
            refresh on the next page load.
          </div>
        ) : outcome.counts.qualifiedOrLater === 0 ? (
          <div className="rounded-2xl border border-dashed border-[#E2E8F0] bg-white p-5 text-[12.5px] text-[#64748B] text-center">
            No qualified leads in this window yet. Once leads reach
            qualified, this card will track how many move to scheduled
            and confirmed.
          </div>
        ) : (
          <RollupBody counts={outcome.counts} />
        )}
      </CardContent>
    </Card>
  )
}

function RollupBody({ counts }: { counts: Counts }) {
  const scheduledRate =
    counts.qualifiedOrLater > 0
      ? counts.scheduledOrLater / counts.qualifiedOrLater
      : null
  const confirmedRate =
    counts.scheduledOrLater > 0
      ? counts.confirmedOrCompleted / counts.scheduledOrLater
      : null
  return (
    <>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-3">
        <Tile
          label="Qualified leads"
          value={String(counts.qualifiedOrLater)}
          hint="Reached qualified or beyond"
        />
        <Tile
          label="Tours scheduled"
          value={String(counts.scheduledOrLater)}
          hint={`Scheduled rate · ${formatPct(counts.scheduledOrLater, counts.qualifiedOrLater)}`}
          valueClass={rateTone(scheduledRate)}
        />
        <Tile
          label="Tours confirmed"
          value={String(counts.confirmedOrCompleted)}
          hint={`Confirmed rate · ${formatPct(counts.confirmedOrCompleted, counts.scheduledOrLater)}`}
          valueClass={rateTone(confirmedRate)}
        />
      </div>
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <p className="text-[11.5px] text-[#64748B] max-w-[420px] leading-snug">
          Counts include leads that moved past qualified within the
          window. Booked weddings still count as scheduled tours so
          fast converters aren&apos;t penalized.
        </p>
        <Link
          href="/dashboard/leads?leakage=tour_booking"
          className="inline-flex items-center gap-1.5 text-[11.5px] px-2.5 py-1.5 rounded-md text-[#1D4ED8] hover:bg-[#EFF6FF] shrink-0"
        >
          Open Tour Booking queue
          <ArrowRight className="w-3 h-3" />
        </Link>
      </div>
    </>
  )
}

function Tile({
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
