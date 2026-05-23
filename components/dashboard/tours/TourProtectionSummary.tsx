import Link from 'next/link'
import {
  ArrowRight,
  CalendarCheck,
  CalendarClock,
  HeartHandshake,
  Coins,
  AlertCircle,
} from 'lucide-react'

/**
 * GTM-0F — Tours page revenue protection summary.
 *
 * Sits above the calendar. Reframes the page from a generic
 * schedule view into a revenue-protection queue. Five tiles
 * answer the venue owner's question: "which tours are at risk
 * of becoming lost weddings?"
 *
 * Tiles:
 *   1. Tours to confirm       — scheduled, not yet confirmed
 *   2. Tours this week        — scheduled+confirmed in current week
 *   3. Needs follow-up        — completed where the linked lead isn't booked yet
 *   4. Upcoming tour value    — sum of linked lead budget on scheduled+confirmed
 *   5. No-shows this month    — count of no_show rows for the displayed month
 *
 * Pure presentational. All counts derive from the tours array the
 * page already loaded (extended with `leads(stage, budget)`).
 * Zero-value tiles are HIDDEN rather than rendered as "0" so the
 * surface never says "0 risks today" with five empty boxes.
 */

type TourLite = {
  status: string | null
  scheduled_at: string | null
  leads?: { stage?: string | null; budget?: number | null } | null
}

interface Props {
  /** Broader window than the displayed month — used for "tours
   *  to confirm" and "completed needs follow-up" which the
   *  operator cares about regardless of which month is in view. */
  tours: ReadonlyArray<TourLite>
  /** The displayed month (1st-of-month). Used for the "No-shows
   *  this month" tile so the count tracks the month nav. */
  displayMonth: Date
}

function money(n: number): string {
  if (n <= 0) return '—'
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`
  if (n >= 10_000) return `$${Math.round(n / 1000)}k`
  return `$${n.toLocaleString()}`
}

function startOfWeek(d: Date): Date {
  const out = new Date(d)
  const dow = out.getDay() // 0 = Sun
  out.setDate(out.getDate() - dow)
  out.setHours(0, 0, 0, 0)
  return out
}

function endOfWeek(d: Date): Date {
  const out = startOfWeek(d)
  out.setDate(out.getDate() + 7) // exclusive
  return out
}

function startOfMonth(d: Date): Date {
  const out = new Date(d)
  out.setDate(1)
  out.setHours(0, 0, 0, 0)
  return out
}

function endOfMonth(d: Date): Date {
  const out = startOfMonth(d)
  out.setMonth(out.getMonth() + 1) // exclusive
  return out
}

export default function TourProtectionSummary({ tours, displayMonth }: Props) {
  const now = new Date()
  const weekStart = startOfWeek(now).getTime()
  const weekEnd = endOfWeek(now).getTime()
  const monthStart = startOfMonth(displayMonth).getTime()
  const monthEnd = endOfMonth(displayMonth).getTime()

  // Helpers ---------------------------------------------------------------
  const parseAt = (t: TourLite): number | null => {
    if (!t.scheduled_at) return null
    const ms = new Date(t.scheduled_at).getTime()
    return Number.isFinite(ms) ? ms : null
  }
  const leadIsBooked = (t: TourLite) => t.leads?.stage === 'booked'
  const leadIsLost = (t: TourLite) => t.leads?.stage === 'lost'

  // 1. Tours to confirm: scheduled (not confirmed), in the future,
  //    not cancelled.
  const toursToConfirm = tours.filter((t) => {
    if (t.status !== 'scheduled') return false
    const at = parseAt(t)
    if (at === null) return false
    return at > now.getTime()
  }).length

  // 2. Tours this week: scheduled OR confirmed in the current week.
  const toursThisWeek = tours.filter((t) => {
    if (!t.status || !['scheduled', 'confirmed'].includes(t.status)) return false
    const at = parseAt(t)
    if (at === null) return false
    return at >= weekStart && at < weekEnd
  }).length

  // 3. Completed needs follow-up: completed AND linked lead not booked
  //    and not lost. (Lost tours are surfaced separately as a recovery
  //    candidate via the leakage filters on /dashboard/leads.)
  const completedFollowup = tours.filter((t) => {
    if (t.status !== 'completed') return false
    if (leadIsBooked(t)) return false
    if (leadIsLost(t)) return false
    return true
  }).length

  // 4. Upcoming tour value: sum of linked lead budget on
  //    scheduled+confirmed tours in the future.
  const upcomingValue = tours.reduce((sum, t) => {
    if (!t.status || !['scheduled', 'confirmed'].includes(t.status)) return sum
    const at = parseAt(t)
    if (at === null || at <= now.getTime()) return sum
    const b = t.leads?.budget ?? 0
    return sum + (b > 0 ? b : 0)
  }, 0)

  // 5. No-shows this month (tracks the month nav).
  const noShowsThisMonth = tours.filter((t) => {
    if (t.status !== 'no_show') return false
    const at = parseAt(t)
    if (at === null) return false
    return at >= monthStart && at < monthEnd
  }).length

  const tiles = [
    {
      key: 'to_confirm',
      label: 'Tours to confirm',
      helper: 'Scheduled visits awaiting a clear yes.',
      value: toursToConfirm > 0 ? toursToConfirm.toString() : '—',
      Icon: CalendarCheck,
      tone: { bg: 'bg-[#FAF7F0]', text: 'text-[#92763C]', ring: 'border-[#E8DCC4]' },
      href: '/dashboard/leads?leakage=tour_booking',
    },
    {
      key: 'this_week',
      label: 'Tours this week',
      helper: 'Scheduled or confirmed across the next seven days.',
      value: toursThisWeek > 0 ? toursThisWeek.toString() : '—',
      Icon: CalendarClock,
      tone: { bg: 'bg-[#EFF6FF]', text: 'text-[#1D4ED8]', ring: 'border-[#BFDBFE]' },
    },
    {
      key: 'completed_followup',
      label: 'Needs follow-up',
      helper: 'Toured but not booked — follow up while interest is warm.',
      value: completedFollowup > 0 ? completedFollowup.toString() : '—',
      Icon: HeartHandshake,
      tone: { bg: 'bg-[#FAF7F0]', text: 'text-[#92763C]', ring: 'border-[#E8DCC4]' },
    },
    {
      key: 'upcoming_value',
      label: 'Upcoming tour value',
      helper: 'Estimated from couple budgets on upcoming visits.',
      value: money(upcomingValue),
      Icon: Coins,
      tone: { bg: 'bg-[#ECFDF5]', text: 'text-[#047857]', ring: 'border-[#A7F3D0]' },
    },
    {
      key: 'no_shows',
      label: 'No-shows this month',
      helper: 'Recover or reschedule quickly.',
      value: noShowsThisMonth > 0 ? noShowsThisMonth.toString() : '—',
      Icon: AlertCircle,
      tone: { bg: 'bg-[#FEF2F2]', text: 'text-[#B91C1C]', ring: 'border-[#FECACA]' },
    },
  ]

  const visible = tiles.filter((t) => t.value !== '—')

  return (
    <section className="rounded-2xl border border-[#E6E8EF] bg-white shadow-card overflow-hidden mb-6">
      <div className="relative px-5 py-4 lg:px-6 lg:py-5 bg-gradient-to-br from-white via-white to-[#FAF7F0]">
        <div className="absolute left-0 top-0 bottom-0 w-1 bg-gradient-to-b from-[#C5A572] via-[#92763C] to-[#C5A572]" />
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="min-w-0">
            <div className="text-[10.5px] uppercase tracking-[0.16em] text-[#92763C] font-semibold mb-1">
              Tour protection
            </div>
            <h2 className="text-[17px] font-semibold text-[#0F172A] leading-tight tracking-[-0.018em]">
              {visible.length > 0
                ? 'Tour risks this week'
                : 'No urgent tour risks right now'}
            </h2>
            <p className="mt-1 text-[12.5px] text-[#475569] leading-relaxed max-w-2xl">
              Protect every scheduled visit until it becomes a booked wedding.
            </p>
          </div>
        </div>
      </div>

      {visible.length > 0 && (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-px bg-[#F1F5F9] border-t border-[#F1F5F9]">
          {visible.map((t) => {
            const Icon = t.Icon
            const inner = (
              <>
                <div className="flex items-center gap-2">
                  <span
                    className={`w-7 h-7 rounded-lg ${t.tone.bg} ${t.tone.text} flex items-center justify-center shrink-0`}
                  >
                    <Icon className="w-3.5 h-3.5" />
                  </span>
                  <span className="text-[10.5px] uppercase tracking-[0.12em] text-[#64748B] font-semibold truncate">
                    {t.label}
                  </span>
                </div>
                <div>
                  <div
                    className={`text-[22px] leading-none font-semibold tabular-nums tracking-[-0.022em] text-[#0F172A]`}
                  >
                    {t.value}
                  </div>
                  <div className="mt-1 text-[10.5px] text-[#64748B] leading-snug">
                    {t.helper}
                  </div>
                </div>
                {t.href ? (
                  <div className="flex items-center gap-1 text-[10.5px] font-medium text-[#1D4ED8] mt-auto">
                    Open queue
                    <ArrowRight className="w-3 h-3" />
                  </div>
                ) : null}
              </>
            )
            const className =
              'bg-white px-4 py-3 flex flex-col gap-2 min-w-0 transition-colors ' +
              (t.href ? 'hover:bg-[#FAFBFD]' : '')
            return t.href ? (
              <Link key={t.key} href={t.href} className={className}>
                {inner}
              </Link>
            ) : (
              <div key={t.key} className={className}>
                {inner}
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}
