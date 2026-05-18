'use client'

import { useCallback } from 'react'
import { useRouter, useSearchParams, usePathname } from 'next/navigation'
import { addMonths, subMonths, format, parse, isValid } from 'date-fns'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { Button } from '@/components/dashboard/ui/Button'

/**
 * Phase 8E — URL-based month navigation for /dashboard/tours.
 *
 * URL contract: `/dashboard/tours?month=YYYY-MM`.
 * Absent or invalid `month` → page renders the current month (default).
 *
 * This component is purely a header control. It does NOT fetch tours
 * itself; clicking a chevron updates the URL via `router.push()` and
 * Next re-runs the server component to fetch the new month's rows.
 *
 * "Today" removes the param entirely so the URL stays clean when the
 * user is on the current month.
 */

const MONTH_PARAM = 'month'

interface MonthNavClientProps {
  /** YYYY-MM of the month currently being displayed (server-resolved). */
  currentMonth: string
  /** Display label, e.g. "October 2026" — server-computed for consistency. */
  currentMonthLabel: string
}

export default function MonthNavClient({
  currentMonth,
  currentMonthLabel,
}: MonthNavClientProps) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  const navigate = useCallback(
    (nextMonth: string | null) => {
      const params = new URLSearchParams(searchParams.toString())
      if (nextMonth) {
        params.set(MONTH_PARAM, nextMonth)
      } else {
        params.delete(MONTH_PARAM)
      }
      const qs = params.toString()
      router.push(qs ? `${pathname}?${qs}` : pathname)
    },
    [pathname, router, searchParams]
  )

  const goToMonth = useCallback(
    (offset: number) => {
      const base = parse(currentMonth, 'yyyy-MM', new Date())
      const target = isValid(base) ? base : new Date()
      const shifted = offset >= 0 ? addMonths(target, offset) : subMonths(target, -offset)
      navigate(format(shifted, 'yyyy-MM'))
    },
    [currentMonth, navigate]
  )

  const goToToday = useCallback(() => {
    // Drop the param — server default IS current month.
    navigate(null)
  }, [navigate])

  const todayMonth = format(new Date(), 'yyyy-MM')
  const isOnToday = currentMonth === todayMonth

  return (
    <div className="flex items-center gap-1.5">
      <Button
        variant="ghost"
        size="sm"
        onClick={() => goToMonth(-1)}
        aria-label="Previous month"
        className="h-9 w-9 px-0"
      >
        <ChevronLeft className="w-4 h-4" />
      </Button>
      <div className="text-[13px] font-medium text-[#0F172A] min-w-[140px] text-center">
        {currentMonthLabel}
      </div>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => goToMonth(1)}
        aria-label="Next month"
        className="h-9 w-9 px-0"
      >
        <ChevronRight className="w-4 h-4" />
      </Button>
      <Button
        variant="secondary"
        size="sm"
        onClick={goToToday}
        disabled={isOnToday}
        className="h-9"
      >
        Today
      </Button>
    </div>
  )
}
