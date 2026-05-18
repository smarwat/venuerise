'use client'

import { useState } from 'react'
import { format } from 'date-fns'
import { CalendarCheck, CalendarPlus, Clock, Pencil } from 'lucide-react'
import { Badge } from '@/components/dashboard/ui/Badge'
import { Button } from '@/components/dashboard/ui/Button'
import ScheduleTourDrawer from '@/components/dashboard/tours/ScheduleTourDrawer'
import EditTourDrawer, {
  type EditableTour,
} from '@/components/dashboard/tours/EditTourDrawer'

/**
 * Phase 8F — at-a-glance tour lifecycle inside the inbox lead view.
 *
 * Renders a compact strip ABOVE the conversation thread that surfaces
 * the most relevant tour for the lead and a one-click action to schedule,
 * reschedule, or edit it.
 *
 * Three UI states (the server-side query in the page resolves "most
 * relevant tour" and hands us either the tour or null):
 *
 *   1. No tour ever        → "No tour scheduled yet" + Schedule tour
 *   2. Upcoming scheduled/  → date/time + status badge + Edit / reschedule
 *      confirmed
 *   3. Last tour cancelled/ → last status + Schedule another tour
 *      completed/no_show
 *
 * Reuses the Phase 8D/8E drawers verbatim — no duplicate scheduling logic.
 * Drawers refresh on success via `router.refresh()` so the strip re-fetches
 * its tour data and updates visibly without operator intervention.
 */

interface InboxLead {
  id: string
  name: string
  email?: string | null
  stage?: string | null
}

interface InboxTour {
  id: string
  lead_id: string
  scheduled_at: string
  duration_minutes?: number | null
  location_notes?: string | null
  status?: string | null
  lead?: {
    name?: string | null
    email?: string | null
  } | null
}

interface TourLifecycleStripProps {
  lead: InboxLead
  tour: InboxTour | null
}

const STATUS_LABEL: Record<string, string> = {
  scheduled: 'Scheduled',
  confirmed: 'Confirmed',
  completed: 'Completed',
  cancelled: 'Cancelled',
  no_show: 'No-show',
}

const STATUS_VARIANT: Record<string, React.ComponentProps<typeof Badge>['variant']> = {
  scheduled: 'blue',
  confirmed: 'navy',
  completed: 'green',
  cancelled: 'default',
  no_show: 'red',
}

function isUpcomingAndOpen(tour: InboxTour | null): boolean {
  if (!tour || !tour.status) return false
  if (!['scheduled', 'confirmed'].includes(tour.status)) return false
  return new Date(tour.scheduled_at).getTime() > Date.now()
}

export default function TourLifecycleStrip({ lead, tour }: TourLifecycleStripProps) {
  const [scheduleOpen, setScheduleOpen] = useState(false)
  const [editOpen, setEditOpen] = useState(false)
  const hasUpcoming = isUpcomingAndOpen(tour)

  // Build the drawer payloads up front so click handlers stay trivial.
  const drawerLead = [
    { id: lead.id, name: lead.name, email: lead.email, stage: lead.stage },
  ]
  const editableTour: EditableTour | null = tour
    ? {
        id: tour.id,
        lead_id: tour.lead_id,
        scheduled_at: tour.scheduled_at,
        duration_minutes: tour.duration_minutes,
        location_notes: tour.location_notes,
        status: tour.status,
        lead: { name: lead.name, email: lead.email },
      }
    : null

  return (
    <>
      <div className="border-b border-[#F1F5F9] bg-[#F8FAFC] px-6 py-3 flex items-center gap-3">
        <div className="w-8 h-8 rounded-lg bg-white border border-[#E2E8F0] flex items-center justify-center shrink-0">
          {hasUpcoming ? (
            <CalendarCheck className="w-4 h-4 text-[#1D4ED8]" />
          ) : (
            <CalendarPlus className="w-4 h-4 text-[#475569]" />
          )}
        </div>

        <div className="flex-1 min-w-0 flex items-center gap-2.5 text-[12px]">
          {hasUpcoming && tour ? (
            <>
              <span className="text-[#475569] inline-flex items-center gap-1">
                <Clock className="w-3 h-3 text-[#94A3B8]" />
                {format(new Date(tour.scheduled_at), 'EEE MMM d • h:mm a')}
              </span>
              <Badge variant={STATUS_VARIANT[tour.status ?? 'scheduled'] ?? 'default'}>
                {STATUS_LABEL[tour.status ?? 'scheduled'] ?? tour.status}
              </Badge>
              {tour.duration_minutes ? (
                <span className="text-[#94A3B8]">{tour.duration_minutes}m</span>
              ) : null}
            </>
          ) : tour ? (
            <>
              <span className="text-[#475569]">Last tour</span>
              <Badge variant={STATUS_VARIANT[tour.status ?? 'cancelled'] ?? 'default'}>
                {STATUS_LABEL[tour.status ?? 'cancelled'] ?? tour.status}
              </Badge>
              <span className="text-[#94A3B8]">
                {format(new Date(tour.scheduled_at), 'MMM d, yyyy')}
              </span>
            </>
          ) : (
            <span className="text-[#475569]">No tour scheduled yet.</span>
          )}
        </div>

        <div className="shrink-0">
          {hasUpcoming ? (
            <Button variant="secondary" size="sm" onClick={() => setEditOpen(true)}>
              <Pencil className="w-3.5 h-3.5" />
              Edit / reschedule
            </Button>
          ) : (
            <Button variant="secondary" size="sm" onClick={() => setScheduleOpen(true)}>
              <CalendarCheck className="w-3.5 h-3.5" />
              {tour ? 'Schedule another tour' : 'Schedule tour'}
            </Button>
          )}
        </div>
      </div>

      {/* Drawers — mounted once so they portal correctly and don't get
          unmounted when state flips. Single-item leads list pre-selects
          the active lead; the operator can't accidentally schedule
          against the wrong row from this entry point. */}
      <ScheduleTourDrawer
        open={scheduleOpen}
        onOpenChange={setScheduleOpen}
        leads={drawerLead}
        defaultLeadId={lead.id}
        defaultNotes="Scheduled from inbox."
      />
      {editableTour && (
        <EditTourDrawer
          open={editOpen}
          onOpenChange={setEditOpen}
          tour={editableTour}
        />
      )}
    </>
  )
}
