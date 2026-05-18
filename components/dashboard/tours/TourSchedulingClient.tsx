'use client'

import { useState } from 'react'
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
