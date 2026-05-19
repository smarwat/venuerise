'use client'

import { useCallback, useEffect, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { format } from 'date-fns'
import {
  Clock,
  MapPin,
  CheckCircle2,
  Loader2,
  CalendarCheck,
  History,
} from 'lucide-react'
import { Badge } from '@/components/dashboard/ui/Badge'
import { Button } from '@/components/dashboard/ui/Button'
import EditTourDrawer, { type EditableTour } from './EditTourDrawer'
import TourAuditDrawer from './TourAuditDrawer'

/**
 * Phase 8E — interactive Upcoming Tours list + edit drawer host.
 *
 * The tours page stays a Server Component. This client wrapper takes the
 * already-fetched tour rows and:
 *   1. Renders each upcoming row (`status ∈ scheduled|confirmed`) as a
 *      button — click opens the EditTourDrawer prefilled with that row.
 *   2. Surfaces a small "Mark confirmed" inline action on `scheduled`
 *      rows for a 1-click status flip without opening the full drawer.
 *
 * Calendar grid stays server-rendered for now — the spec calls for a
 * surgical pass, and the calendar cells are dense + don't benefit much
 * from per-cell click handlers when the Upcoming Tours list already
 * covers the edit flow. A future phase can wrap the calendar too.
 *
 * Visual identity matches the prior server-rendered Upcoming Tours JSX
 * pixel-for-pixel so the move from server → client is invisible.
 */

type TourStatus = 'scheduled' | 'confirmed' | 'completed' | 'cancelled' | 'no_show'

const STATUS_CONFIG: Record<
  TourStatus,
  { label: string; variant: React.ComponentProps<typeof Badge>['variant'] }
> = {
  scheduled: { label: 'Scheduled', variant: 'blue' },
  confirmed: { label: 'Confirmed', variant: 'navy' },
  completed: { label: 'Completed', variant: 'green' },
  cancelled: { label: 'Cancelled', variant: 'default' },
  no_show: { label: 'No Show', variant: 'red' },
}

interface UpcomingTour extends EditableTour {
  // Always present on the page-side fetch — broadens the editable type
  // for what the page actually loads.
  status: TourStatus
  scheduled_at: string
}

interface TourInteractionClientProps {
  /** Upcoming Tours rows passed in pre-filtered + pre-sliced by the page. */
  tours: UpcomingTour[]
}

// Phase 8P — light client-side UUID shape check for the `audit_tour`
// query value. The drawer's own fetch is the real authority — this
// just protects against rendering with garbage like `?audit_tour=hello`.
// We accept any non-empty string that LOOKS uuid-ish; the API call
// fails cleanly if it's wrong, and the drawer's forbidden/error states
// handle it.
const UUID_RX = /^[0-9a-fA-F-]{30,40}$/
function isAuditTourIdShapeValid(v: string | null): v is string {
  return typeof v === 'string' && UUID_RX.test(v)
}

export default function TourInteractionClient({ tours }: TourInteractionClientProps) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [selectedTour, setSelectedTour] = useState<EditableTour | null>(null)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [confirmingId, setConfirmingId] = useState<string | null>(null)
  const [confirmError, setConfirmError] = useState<string | null>(null)
  // Phase 8N — per-tour audit drawer state. Mounted once at the bottom so
  // a single drawer instance handles every row's Audit click.
  // Phase 8P — initial state derives from the URL so a deep-linked tab
  // (`?audit_tour=<uuid>`) opens the drawer automatically. The drawer
  // mounts hidden when `audit_tour` is absent.
  const initialAuditId = searchParams.get('audit_tour')
  const initiallyValid = isAuditTourIdShapeValid(initialAuditId)
  const [auditTourId, setAuditTourId] = useState<string | null>(
    initiallyValid ? initialAuditId : null
  )
  const [auditOpen, setAuditOpen] = useState<boolean>(initiallyValid)

  // Phase 8P — keep the URL in sync if an external nav (Back/Forward,
  // a sibling component) changes `audit_tour`. We treat the URL as the
  // source of truth for drawer presence; local clicks call `setAudit*`
  // AND update the URL via `updateAuditParam` below.
  useEffect(() => {
    const next = searchParams.get('audit_tour')
    if (!isAuditTourIdShapeValid(next)) {
      if (auditOpen) {
        setAuditOpen(false)
        setAuditTourId(null)
      }
      return
    }
    if (next !== auditTourId) {
      setAuditTourId(next)
      setAuditOpen(true)
    } else if (!auditOpen) {
      setAuditOpen(true)
    }
    // We intentionally don't depend on `auditOpen`/`auditTourId` — this
    // effect only re-runs on URL change, and the local state mirrors
    // the URL one-way. Local state changes that AREN'T URL-driven go
    // through `updateAuditParam`, which writes the URL first.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams])

  // Phase 8P — single helper for writing the audit_tour query while
  // preserving every other param (notably `month=YYYY-MM` from the
  // Phase 8E MonthNavClient). `router.replace` so filter/drawer state
  // doesn't pollute browser history.
  const updateAuditParam = useCallback(
    (tourId: string | null) => {
      const params = new URLSearchParams(searchParams.toString())
      if (tourId) params.set('audit_tour', tourId)
      else params.delete('audit_tour')
      const query = params.toString()
      router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false })
    },
    [router, pathname, searchParams]
  )

  function openAudit(tourId: string) {
    setAuditTourId(tourId)
    setAuditOpen(true)
    updateAuditParam(tourId)
  }

  function openEdit(tour: UpcomingTour) {
    setSelectedTour(tour)
    setDrawerOpen(true)
  }

  async function markConfirmed(tour: UpcomingTour) {
    setConfirmingId(tour.id)
    setConfirmError(null)
    try {
      const res = await fetch(`/api/tours/${encodeURIComponent(tour.id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'confirmed' }),
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: unknown } | null
        const code =
          body && typeof body.error === 'string' ? body.error : `HTTP ${res.status}`
        setConfirmError(`Couldn't confirm: ${code}`)
        return
      }
      router.refresh()
    } catch (err) {
      setConfirmError(err instanceof Error ? err.message : 'Network error')
    } finally {
      setConfirmingId(null)
    }
  }

  if (tours.length === 0) {
    return (
      <div className="text-center py-10">
        <div className="w-11 h-11 rounded-xl bg-[#F1F5F9] flex items-center justify-center mx-auto mb-2.5">
          <CalendarCheck className="w-5 h-5 text-[#0F172A]" />
        </div>
        <p className="text-[13px] text-[#475569]">No upcoming tours this month.</p>
      </div>
    )
  }

  return (
    <>
      <div className="space-y-2.5">
        {tours.map((tour) => {
          const cfg = STATUS_CONFIG[tour.status]
          const isConfirming = confirmingId === tour.id
          const canConfirm = tour.status === 'scheduled' && !isConfirming
          return (
            <div
              key={tour.id}
              className="bg-[#F8FAFC] border border-[#E2E8F0] rounded-2xl p-3.5 hover:border-[#CBD5E1] hover:bg-white transition-colors"
            >
              <div className="flex items-start gap-2.5">
                {/* Click-to-edit covers the avatar + lead + meta — the
                    most natural tap target. The action buttons next to
                    the badge sit outside this button so they don't
                    accidentally open the drawer. */}
                <button
                  type="button"
                  className="flex items-start gap-2.5 flex-1 min-w-0 text-left rounded-xl focus:outline-none focus-visible:ring-2 focus-visible:ring-[#3B82F6]/30"
                  onClick={() => openEdit(tour)}
                >
                  <div className="w-9 h-9 rounded-full bg-gradient-to-br from-[#1E293B] to-[#0F172A] flex items-center justify-center text-white text-[12px] font-bold shrink-0">
                    {tour.lead?.name?.charAt(0) ?? '?'}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-[13px] font-semibold text-[#0F172A] truncate">
                      {tour.lead?.name ?? 'Unknown'}
                    </p>
                    <div className="flex items-center gap-2 text-[11px] text-[#475569] mt-0.5">
                      <span className="inline-flex items-center gap-1">
                        <Clock className="w-3 h-3" />
                        {format(new Date(tour.scheduled_at), 'MMM d • h:mm a')}
                      </span>
                    </div>
                    {tour.location_notes ? (
                      <div className="flex items-center gap-1 text-[11px] text-[#94A3B8] mt-1">
                        <MapPin className="w-3 h-3" />
                        {tour.location_notes}
                      </div>
                    ) : null}
                  </div>
                </button>

                <div className="flex flex-col items-end gap-1.5 shrink-0">
                  <Badge variant={cfg.variant}>{cfg.label}</Badge>
                  {canConfirm && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2 text-[11px]"
                      onClick={(e) => {
                        e.stopPropagation()
                        markConfirmed(tour)
                      }}
                    >
                      {isConfirming ? (
                        <Loader2 className="w-3 h-3 animate-spin" />
                      ) : (
                        <CheckCircle2 className="w-3 h-3" />
                      )}
                      Mark confirmed
                    </Button>
                  )}
                  {/* Phase 8N — per-tour audit drawer trigger. `stopPropagation`
                      so the click doesn't also open the EditTourDrawer (the
                      parent button covers the avatar + meta block). */}
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 text-[11px]"
                    onClick={(e) => {
                      e.stopPropagation()
                      openAudit(tour.id)
                    }}
                  >
                    <History className="w-3 h-3" />
                    Audit
                  </Button>
                </div>
              </div>
            </div>
          )
        })}
      </div>

      {confirmError && (
        <div className="mt-3 rounded-lg bg-[#FEF2F2] border border-[#FECACA] px-3 py-2 text-xs text-[#B91C1C]">
          {confirmError}
        </div>
      )}

      <EditTourDrawer
        open={drawerOpen}
        onOpenChange={(next) => {
          setDrawerOpen(next)
          if (!next) setSelectedTour(null)
        }}
        tour={selectedTour}
      />
      {/* Phase 8N — audit drawer mounted once, reused across rows.
          Phase 8P — closing the drawer also strips `audit_tour` from
          the URL while preserving the `month=YYYY-MM` Phase 8E query. */}
      <TourAuditDrawer
        tourId={auditTourId}
        open={auditOpen}
        onOpenChange={(next) => {
          setAuditOpen(next)
          if (!next) {
            setAuditTourId(null)
            updateAuditParam(null)
          }
        }}
      />
    </>
  )
}
