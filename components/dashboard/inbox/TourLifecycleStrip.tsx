'use client'

import { useEffect, useState } from 'react'
import { format } from 'date-fns'
import {
  CalendarCheck,
  CalendarPlus,
  Clock,
  Pencil,
  RotateCcw,
  History,
} from 'lucide-react'
import { Badge } from '@/components/dashboard/ui/Badge'
import { Button } from '@/components/dashboard/ui/Button'
import ScheduleTourDrawer from '@/components/dashboard/tours/ScheduleTourDrawer'
import EditTourDrawer, {
  type EditableTour,
} from '@/components/dashboard/tours/EditTourDrawer'
import TourAuditDrawer from '@/components/dashboard/tours/TourAuditDrawer'
import {
  actorLabel,
  actionLabel,
  formatAuditTime,
  statusLabel,
  type TourStatusEvent,
} from '@/components/dashboard/tours/tour-audit-types'

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

function isCancelled(tour: InboxTour | null): boolean {
  return tour?.status === 'cancelled'
}

export default function TourLifecycleStrip({ lead, tour }: TourLifecycleStripProps) {
  // Phase 8I — `scheduleMode` distinguishes the two ways the schedule
  // drawer can open from this strip:
  //   'fresh'  → no defaults, drawer falls back to next Tuesday 10am
  //   'rebook' → seed the drawer with the cancelled tour's slot + notes
  // We mount ONE drawer and switch its props based on mode so we don't
  // get into the "two drawers fighting for the same portal" mess.
  const [scheduleMode, setScheduleMode] = useState<'fresh' | 'rebook' | null>(null)
  const [editOpen, setEditOpen] = useState(false)
  // Phase 8N — full-audit drawer state. Same drawer component as the
  // /dashboard/tours page; we mount our own instance so the inbox view
  // doesn't depend on the tours-page parent.
  const [auditOpen, setAuditOpen] = useState(false)
  // Phase 8N — recent activity panel state. We fetch the latest 5 events
  // for the relevant tour. Non-admins get 401/403 which we hide silently
  // (the panel is admin-only by virtue of the underlying endpoint's
  // requireAdmin() gate).
  const [recentEvents, setRecentEvents] = useState<TourStatusEvent[] | null>(null)
  const [recentVisible, setRecentVisible] = useState(false)
  const hasUpcoming = isUpcomingAndOpen(tour)
  const lastWasCancelled = !hasUpcoming && isCancelled(tour)

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

  // Phase 8I — re-schedule defaults pulled from the cancelled tour, so
  // operators recovering bookings click less. We don't touch the old
  // cancelled row; submit POSTs a NEW /api/tours entry.
  const rebookDefaults =
    lastWasCancelled && tour
      ? {
          scheduledAt: tour.scheduled_at,
          durationMinutes: tour.duration_minutes ?? 60,
          notes:
            (tour.location_notes && tour.location_notes.trim().length > 0
              ? tour.location_notes
              : 'Re-scheduled from inbox after cancellation.'),
        }
      : null

  const isRebookMode = scheduleMode === 'rebook' && rebookDefaults !== null
  const tourIdForAudit = tour?.id ?? null

  // Phase 8N — fetch the last 5 status events for the relevant tour.
  // - No tour → no panel.
  // - 401/403/404 → hide silently (non-admin operators don't see this).
  // - Network/other error → hide silently, never disrupt the main strip.
  useEffect(() => {
    if (!tourIdForAudit) {
      setRecentVisible(false)
      setRecentEvents(null)
      return
    }
    let cancelled = false
    const abort = new AbortController()
    ;(async () => {
      try {
        const url = `/api/admin/tours/status-events?tour_id=${encodeURIComponent(
          tourIdForAudit
        )}&limit=5`
        const res = await fetch(url, {
          method: 'GET',
          signal: abort.signal,
          credentials: 'same-origin',
        })
        if (cancelled) return
        if (res.status === 401 || res.status === 403 || res.status === 404) {
          // Quietly hide for non-admins. No console noise — this is the
          // expected path for sales / coordinator / viewer roles.
          setRecentVisible(false)
          setRecentEvents(null)
          return
        }
        if (!res.ok) {
          // Other server-side hiccup — hide without disrupting the strip.
          setRecentVisible(false)
          setRecentEvents(null)
          return
        }
        const body = (await res.json()) as { items?: TourStatusEvent[] } | null
        const items = (body?.items ?? []) as TourStatusEvent[]
        setRecentEvents(items)
        setRecentVisible(true)
      } catch {
        // AbortError on unmount is expected; everything else is a
        // best-effort failure that should not surface to the operator.
        if (!cancelled) {
          setRecentVisible(false)
          setRecentEvents(null)
        }
      }
    })()
    return () => {
      cancelled = true
      abort.abort()
    }
  }, [tourIdForAudit])

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

        <div className="shrink-0 flex items-center gap-2">
          {hasUpcoming ? (
            <Button variant="secondary" size="sm" onClick={() => setEditOpen(true)}>
              <Pencil className="w-3.5 h-3.5" />
              Edit / reschedule
            </Button>
          ) : (
            <>
              {/* Phase 8I — for cancelled tours, surface a "Re-schedule
                  cancelled tour" shortcut that opens the drawer with the
                  cancelled slot prefilled. The "Schedule another" path
                  remains the fallback for the other terminal statuses
                  (completed / no_show) so the operator still has a clean
                  blank-slate option for those. */}
              {lastWasCancelled && (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setScheduleMode('rebook')}
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                  Re-schedule cancelled tour
                </Button>
              )}
              <Button
                variant={lastWasCancelled ? 'ghost' : 'secondary'}
                size="sm"
                onClick={() => setScheduleMode('fresh')}
              >
                <CalendarCheck className="w-3.5 h-3.5" />
                {tour ? 'Schedule another tour' : 'Schedule tour'}
              </Button>
            </>
          )}
        </div>
      </div>

      {/* Phase 8N — recent activity panel. Renders only when:
          (a) there's a tour to query, AND
          (b) the API returned a 2xx — non-admins get 401/403/404 and we
              silently hide so the panel never leaks the admin endpoint's
              existence to non-admin roles. */}
      {recentVisible && recentEvents && tourIdForAudit && (
        <div className="border-b border-[#F1F5F9] bg-white px-6 py-3">
          <div className="flex items-center justify-between gap-2 mb-2">
            <div className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-[#475569] uppercase tracking-wider">
              <History className="w-3 h-3 text-[#94A3B8]" />
              Recent tour activity
            </div>
            <button
              type="button"
              onClick={() => setAuditOpen(true)}
              className="text-[11px] font-medium text-[#1D4ED8] hover:text-[#1E40AF] transition-colors"
            >
              View full audit
            </button>
          </div>
          {recentEvents.length === 0 ? (
            <p className="text-[12px] text-[#64748B]">
              No status changes recorded yet for this tour.
            </p>
          ) : (
            <ul className="space-y-1.5">
              {recentEvents.map((event) => (
                <li
                  key={event.id}
                  className="flex items-center gap-2 text-[11px] text-[#475569]"
                >
                  <Badge
                    variant={
                      event.actor_kind === 'lead_token'
                        ? 'blue'
                        : event.actor_kind === 'operator'
                          ? 'navy'
                          : 'default'
                    }
                  >
                    {actorLabel(event.actor_kind)}
                  </Badge>
                  <span className="text-[#0F172A] font-medium">
                    {actionLabel(event.action)}
                  </span>
                  <span className="text-[#94A3B8]">
                    {statusLabel(event.previous_status)} →{' '}
                    {statusLabel(event.new_status)}
                  </span>
                  <span className="ml-auto text-[#64748B] whitespace-nowrap">
                    {formatAuditTime(event.occurred_at)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* Drawers — mounted once so they portal correctly and don't get
          unmounted when state flips. Single-item leads list pre-selects
          the active lead; the operator can't accidentally schedule
          against the wrong row from this entry point. */}
      <ScheduleTourDrawer
        open={scheduleMode !== null}
        onOpenChange={(next) => setScheduleMode(next ? scheduleMode ?? 'fresh' : null)}
        leads={drawerLead}
        defaultLeadId={lead.id}
        defaultNotes={
          isRebookMode ? rebookDefaults.notes : 'Scheduled from inbox.'
        }
        defaultScheduledAt={isRebookMode ? rebookDefaults.scheduledAt : undefined}
        defaultDurationMinutes={
          isRebookMode ? rebookDefaults.durationMinutes : undefined
        }
      />
      {editableTour && (
        <EditTourDrawer
          open={editOpen}
          onOpenChange={setEditOpen}
          tour={editableTour}
        />
      )}
      {/* Phase 8N — full audit drawer. Opens from the "View full audit"
          button in the recent activity panel above. The drawer itself
          gracefully handles the 401/403 case for non-admins, but the
          panel only renders for admins so the trigger is naturally gated. */}
      <TourAuditDrawer
        tourId={tourIdForAudit}
        open={auditOpen}
        onOpenChange={setAuditOpen}
      />
    </>
  )
}
