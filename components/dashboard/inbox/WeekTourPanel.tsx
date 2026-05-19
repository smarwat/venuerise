import Link from 'next/link'
import { format } from 'date-fns'
import { CalendarDays, Clock, Users } from 'lucide-react'
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardSubtitle,
} from '@/components/dashboard/ui/Card'
import { Badge } from '@/components/dashboard/ui/Badge'

/**
 * Phase 8J — "This week's tours" inbox sidebar panel.
 *
 * Server-rendered, server-data-fed. The inbox page does the fetch + the
 * filter (`scheduled`/`confirmed` only, ascending by `scheduled_at`,
 * within the current Sun→Sat window) and passes a pre-narrowed shape in.
 * That keeps this component a pure presentation layer and makes the
 * empty/loading states trivial — no client-side fetch.
 *
 * Click target: each row is a link to `/dashboard/inbox/<lead_id>`, which
 * is the existing thread page for that lead. The operator can pivot
 * from "I see this lead has a tour Thursday" → their conversation
 * thread in one click without context-switching to /dashboard/tours.
 *
 * Visual identity: standard `Card` primitives + the existing Badge
 * variants ('blue' for scheduled, 'navy' for confirmed — matches the
 * Phase 8F TourLifecycleStrip vocabulary). No new design tokens.
 */

export interface WeekTour {
  id: string
  lead_id: string
  lead_name: string
  lead_email: string | null
  status: 'scheduled' | 'confirmed'
  scheduled_at: string
  duration_minutes: number | null
  guest_count?: number | null
}

interface WeekTourPanelProps {
  tours: WeekTour[]
}

const STATUS_VARIANT: Record<WeekTour['status'], 'blue' | 'navy'> = {
  scheduled: 'blue',
  confirmed: 'navy',
}

const STATUS_LABEL: Record<WeekTour['status'], string> = {
  scheduled: 'Scheduled',
  confirmed: 'Confirmed',
}

export default function WeekTourPanel({ tours }: WeekTourPanelProps) {
  return (
    <Card className="w-full max-w-md">
      <CardHeader>
        <div>
          <CardTitle>This week&apos;s tours</CardTitle>
          <CardSubtitle>
            Jump straight to the conversation for any scheduled or confirmed
            tour in the current week.
          </CardSubtitle>
        </div>
        <div className="shrink-0">
          <div className="w-9 h-9 rounded-xl bg-[#EFF6FF] border border-[#BFDBFE] flex items-center justify-center">
            <CalendarDays className="w-4 h-4 text-[#1D4ED8]" />
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {tours.length === 0 ? (
          <div className="px-1 py-3 text-[12px] text-[#64748B]">
            No tours this week.
          </div>
        ) : (
          <ul className="space-y-1.5">
            {tours.map((tour) => {
              const date = new Date(tour.scheduled_at)
              const dateStr = Number.isFinite(date.getTime())
                ? format(date, 'EEE MMM d · h:mm a')
                : tour.scheduled_at
              return (
                <li key={tour.id}>
                  <Link
                    href={`/dashboard/inbox/${tour.lead_id}`}
                    className="flex items-start gap-2.5 rounded-xl border border-[#E2E8F0] bg-white hover:border-[#CBD5E1] hover:bg-[#F8FAFC] transition-colors px-3 py-2.5"
                  >
                    <div className="w-8 h-8 rounded-full bg-gradient-to-br from-[#1E293B] to-[#0F172A] flex items-center justify-center text-white text-[11px] font-bold shrink-0">
                      {tour.lead_name?.charAt(0)?.toUpperCase() ?? '?'}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 min-w-0">
                        <p className="text-[12.5px] font-semibold text-[#0F172A] truncate">
                          {tour.lead_name || 'Unknown'}
                        </p>
                        <Badge variant={STATUS_VARIANT[tour.status]}>
                          {STATUS_LABEL[tour.status]}
                        </Badge>
                      </div>
                      <div className="flex items-center gap-2.5 mt-0.5 text-[11px] text-[#475569]">
                        <span className="inline-flex items-center gap-1">
                          <Clock className="w-3 h-3 text-[#94A3B8]" />
                          {dateStr}
                        </span>
                        {typeof tour.guest_count === 'number' &&
                          tour.guest_count > 0 && (
                            <span className="inline-flex items-center gap-1 text-[#94A3B8]">
                              <Users className="w-3 h-3" />
                              {tour.guest_count}
                            </span>
                          )}
                      </div>
                    </div>
                  </Link>
                </li>
              )
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}
