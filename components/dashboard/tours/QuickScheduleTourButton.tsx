'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { CalendarCheck, Loader2 } from 'lucide-react'
import { Button } from '@/components/dashboard/ui/Button'
import {
  nextTuesdayAtTenAm,
  QUICK_TOUR_DURATION_MIN,
  QUICK_TOUR_NOTES,
} from '@/lib/demo/demo-tour'

/**
 * Phase 8C — quick-schedule-a-tour button rendered inside LeadDetailPanel.
 *
 * Posts to the real `/api/tours` endpoint (Phase 7B, gated to SALES_ROLES
 * + the Phase 7D billing gate). Defaults:
 *   - `scheduled_at`: next Tuesday at 10:00 local time (see lib/demo/demo-tour.ts)
 *   - `duration_minutes`: 60
 *   - `location_notes`: "Quick-scheduled from demo dashboard."
 *
 * The button is hidden for stages where a tour doesn't make sense:
 *   - `lost`, `booked` — final outcomes, no further tour planning needed
 *   - `new_inquiry` — usually too early; the AI is still qualifying
 *
 * Visible for: `qualified`, `tour_scheduled`, `tour_completed`, `negotiation`.
 * Re-scheduling on a lead that already has a tour is intentionally allowed
 * — the API doesn't dedupe, and a salesperson may genuinely want to book
 * a second walk-through.
 *
 * On success → inline "Tour scheduled" + `router.refresh()` so the
 * LeadDetailPanel parent can pick up any side-effects. The /dashboard/tours
 * realtime layer (Phase 8C `RealtimeToursLayer`) pulls the new row into
 * the calendar without manual refresh.
 *
 * On failure → inline error. We never throw or unmount the panel.
 */

const HIDDEN_STAGES = new Set(['lost', 'booked', 'new_inquiry'])

interface QuickScheduleTourButtonProps {
  leadId: string
  stage: string
}

type Status =
  | { kind: 'idle' }
  | { kind: 'busy' }
  | { kind: 'success' }
  | { kind: 'error'; message: string }

export default function QuickScheduleTourButton({
  leadId,
  stage,
}: QuickScheduleTourButtonProps) {
  const router = useRouter()
  const [status, setStatus] = useState<Status>({ kind: 'idle' })

  if (HIDDEN_STAGES.has(stage)) return null

  async function handleClick() {
    setStatus({ kind: 'busy' })
    try {
      const res = await fetch('/api/tours', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          lead_id: leadId,
          scheduled_at: nextTuesdayAtTenAm(),
          duration_minutes: QUICK_TOUR_DURATION_MIN,
          location_notes: QUICK_TOUR_NOTES,
        }),
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: unknown } | null
        const code = body && typeof body.error === 'string' ? body.error : `HTTP ${res.status}`
        setStatus({ kind: 'error', message: humanize(code) })
        return
      }
      setStatus({ kind: 'success' })
      // Auto-dismiss the success state after 2.5s so re-clicks are easy.
      window.setTimeout(() => setStatus({ kind: 'idle' }), 2500)
      router.refresh()
    } catch (err) {
      setStatus({
        kind: 'error',
        message: err instanceof Error ? err.message : 'Network error',
      })
    }
  }

  return (
    <div className="flex flex-col items-stretch gap-1">
      <Button
        variant="secondary"
        size="sm"
        onClick={handleClick}
        disabled={status.kind === 'busy'}
        className="w-full"
      >
        {status.kind === 'busy' ? (
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
        ) : (
          <CalendarCheck className="w-3.5 h-3.5" />
        )}
        {status.kind === 'busy'
          ? 'Scheduling…'
          : status.kind === 'success'
            ? 'Tour scheduled ✓'
            : 'Quick schedule tour'}
      </Button>
      {status.kind === 'error' && (
        <div className="text-[11px] text-[#B91C1C] text-center">{status.message}</div>
      )}
    </div>
  )
}

function humanize(code: string): string {
  switch (code) {
    case 'forbidden':
      return 'Sales / coordinator role required.'
    case 'no_venue':
    case 'Venue not found':
      return 'No venue context.'
    case 'subscription_required':
      return 'Subscription required (billing gate is enabled).'
    case 'rate_limited':
      return 'Rate limited — wait a moment.'
    default:
      return `Tour create failed (${code})`
  }
}
