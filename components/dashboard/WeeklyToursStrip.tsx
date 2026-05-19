import Link from 'next/link'
import { ArrowRight } from 'lucide-react'

/**
 * Phase 8AG — Tours-this-week strip for the Overview page.
 *
 * Pure presentational. Parent builds a `days` array spanning the
 * current Mon–Sun (UTC) and pre-grouped tours by day. The strip
 * renders 7 cards, highlights "today" with the navy fill from the
 * reference, and shows a compact item list per day (time + name +
 * kind tag, with an optional score chip).
 *
 * Empty days render an em-dash; an empty week (no tours at all)
 * still shows the 7-card grid so the layout stays calm.
 */

export interface WeeklyTourItem {
  time: string
  name: string
  kind?: 'discovery' | 'second' | 'florist' | 'internal' | 'group' | 'wedding' | string
  score?: number | null
}

export interface WeeklyTourDay {
  day: string // 'Mon', 'Tue', …
  date: number | string
  /** True for the card highlighted as "today". */
  today?: boolean
  items: WeeklyTourItem[]
}

interface WeeklyToursStripProps {
  rangeLabel?: string
  summaryLabel?: string
  days: WeeklyTourDay[]
  calendarHref?: string
}

function kindStyle(kind: string | undefined): { bg: string; fg: string; label: string } {
  switch (kind) {
    case 'discovery':
      return { bg: 'bg-[#EFF4FF]', fg: 'text-[#2563EB]', label: 'Discovery' }
    case 'second':
      return { bg: 'bg-[#F1F5F9]', fg: 'text-[#475569]', label: '2nd tour' }
    case 'florist':
      return { bg: 'bg-[#E7F7EE]', fg: 'text-[#0F8A5B]', label: 'Florist visit' }
    case 'internal':
      return { bg: 'bg-[#F1F5F9]', fg: 'text-[#64748B]', label: 'Internal' }
    case 'group':
      return { bg: 'bg-[#EFF4FF]', fg: 'text-[#2563EB]', label: 'Group tour' }
    case 'wedding':
      return { bg: 'bg-[#0F172A]', fg: 'text-white', label: 'Wedding' }
    default:
      return { bg: 'bg-[#F1F5F9]', fg: 'text-[#475569]', label: (kind ?? 'Tour') as string }
  }
}

function scoreColor(score: number | null | undefined): string {
  if (score == null) return 'text-[#94A3B8]'
  if (score >= 90) return 'text-[#0F8A5B]'
  if (score >= 80) return 'text-[#2563EB]'
  if (score >= 70) return 'text-[#475569]'
  return 'text-[#94A3B8]'
}

export default function WeeklyToursStrip({
  rangeLabel,
  summaryLabel,
  days,
  calendarHref = '/dashboard/tours',
}: WeeklyToursStripProps) {
  return (
    <div className="bg-white border border-[#E6E8EF] rounded-[18px] shadow-card p-5 flex flex-col gap-3.5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-[10.5px] uppercase tracking-[0.14em] text-[#64748B] font-semibold">
            Tours this week
          </div>
          <div className="text-[12px] text-[#64748B] mt-1">
            {rangeLabel ? (
              <>
                {rangeLabel}
                {summaryLabel ? <> · {summaryLabel}</> : null}
              </>
            ) : (
              summaryLabel ?? ' '
            )}
          </div>
        </div>
        <Link
          href={calendarHref}
          className="inline-flex items-center gap-1.5 text-[12px] text-[#475569] hover:text-[#0F172A] px-2.5 py-1.5 rounded-lg border border-[#E6E8EF] hover:bg-[#F8FAFC] transition-colors"
        >
          Open calendar
          <ArrowRight className="w-3 h-3" />
        </Link>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-7 gap-2">
        {days.map((d, i) => {
          const isToday = Boolean(d.today)
          return (
            <div
              key={`${d.day}-${i}`}
              className={
                isToday
                  ? 'rounded-[14px] p-3 bg-[#0F172A] text-white border border-[#0F172A] min-h-[130px] flex flex-col gap-2 relative'
                  : 'rounded-[14px] p-3 bg-[#F8FAFC] text-[#0F172A] border border-[#E6E8EF] min-h-[130px] flex flex-col gap-2 relative'
              }
            >
              <div className="flex items-center justify-between">
                <span
                  className={
                    isToday
                      ? 'text-[10.5px] uppercase tracking-[0.14em] opacity-75'
                      : 'text-[10.5px] uppercase tracking-[0.14em] text-[#64748B]'
                  }
                >
                  {d.day}
                </span>
                {isToday && (
                  <span className="relative inline-flex w-2 h-2 rounded-full bg-emerald-400">
                    <span className="absolute inset-[-3px] rounded-full bg-emerald-400/30 animate-ping" />
                  </span>
                )}
              </div>
              <div className="text-[24px] font-semibold leading-none tabular-nums">
                {d.date}
              </div>
              <div className="flex flex-col gap-1.5 mt-1">
                {d.items.length === 0 ? (
                  <div className={isToday ? 'text-[11px] opacity-40' : 'text-[11px] text-[#94A3B8]'}>
                    —
                  </div>
                ) : (
                  d.items.slice(0, 2).map((it, j) => {
                    const k = kindStyle(it.kind)
                    return (
                      <div
                        key={j}
                        className={
                          isToday
                            ? 'p-2 rounded-lg bg-white/[0.06] border border-white/[0.08] text-[11px]'
                            : 'p-2 rounded-lg bg-white border border-[#E6E8EF] text-[11px]'
                        }
                      >
                        <div className="flex items-center justify-between">
                          <span
                            className={
                              isToday
                                ? 'font-mono text-[10px] opacity-75'
                                : 'font-mono text-[10px] text-[#64748B]'
                            }
                          >
                            {it.time}
                          </span>
                          {it.score != null && (
                            <span
                              className={
                                'text-[9.5px] font-semibold ' + scoreColor(it.score)
                              }
                            >
                              {it.score}
                            </span>
                          )}
                        </div>
                        <div
                          className={
                            isToday
                              ? 'text-[11.5px] leading-snug text-white mt-0.5'
                              : 'text-[11.5px] leading-snug text-[#0F172A] mt-0.5'
                          }
                        >
                          {it.name}
                        </div>
                        <div
                          className={
                            'mt-1 text-[9.5px] uppercase tracking-[0.1em] font-semibold ' +
                            (isToday && it.kind === 'wedding'
                              ? 'text-white/80'
                              : k.fg)
                          }
                        >
                          {k.label}
                        </div>
                      </div>
                    )
                  })
                )}
                {d.items.length > 2 && (
                  <div
                    className={
                      isToday
                        ? 'text-[10px] opacity-75'
                        : 'text-[10px] text-[#64748B]'
                    }
                  >
                    +{d.items.length - 2} more
                  </div>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
