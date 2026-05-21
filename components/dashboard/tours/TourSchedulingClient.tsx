'use client'

import { useEffect, useState } from 'react'
import { Plus } from 'lucide-react'
import { Button } from '@/components/dashboard/ui/Button'
import ScheduleTourDrawer, {
  type ScheduleTourDrawerLead,
} from './ScheduleTourDrawer'

/**
 * Phase 8D — small client wrapper that owns the drawer's open state.
 *
 * Mounted from the server-rendered tours page so the page itself stays
 * a Server Component. Renders only the "Schedule tour" button + the
 * drawer; everything else on /dashboard/tours stays on the server.
 *
 * The leads list comes from the server-side fetch in the page — we don't
 * re-fetch on the client. After a successful schedule the drawer triggers
 * `router.refresh()` internally + (combined with `RealtimeToursLayer`) the
 * calendar updates without operator intervention.
 */

interface TourSchedulingClientProps {
  leads: ScheduleTourDrawerLead[]
}

export default function TourSchedulingClient({ leads }: TourSchedulingClientProps) {
  const [open, setOpen] = useState(false)

  // Phase 8AK — CommandPalette quick-action wiring. Open the drawer
  // either from the `venuerise:open-schedule-tour` CustomEvent
  // (palette fires it after navigation) or from the `?schedule_tour=1`
  // URL fallback (used when navigating in from a different route, so
  // the event would fire before this component mounts). After
  // consuming the query param we strip it from the URL so a refresh
  // doesn't re-trigger the drawer.
  useEffect(() => {
    if (typeof window === 'undefined') return
    const params = new URLSearchParams(window.location.search)
    if (params.get('schedule_tour') === '1') {
      setOpen(true)
      try {
        params.delete('schedule_tour')
        const next =
          window.location.pathname +
          (params.toString() ? `?${params.toString()}` : '') +
          window.location.hash
        window.history.replaceState({}, '', next)
      } catch {
        // sandboxed iframe edge case — drawer still opens, URL stays.
      }
    }
    const onOpen = () => setOpen(true)
    window.addEventListener('venuerise:open-schedule-tour', onOpen)
    return () => {
      window.removeEventListener('venuerise:open-schedule-tour', onOpen)
    }
  }, [])

  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>
        <Plus className="w-3.5 h-3.5" />
        Schedule Tour
      </Button>
      <ScheduleTourDrawer
        open={open}
        onOpenChange={setOpen}
        leads={leads}
      />
    </>
  )
}
