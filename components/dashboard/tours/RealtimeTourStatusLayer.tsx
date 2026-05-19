'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import RealtimeToast from '@/components/dashboard/realtime/RealtimeToast'

/**
 * Phase 8O — Supabase Realtime subscription for `public.tour_status_events`.
 *
 * Mirrors the Phase 8B/8C `RealtimeLeadsLayer` + `RealtimeToursLayer`
 * pattern. Subscribes to `tour-status-events:venue:${venueId}` with a
 * server-side `venue_id=eq.…` filter so the channel can't leak cross-
 * venue rows even if a future regression weakens client-side filtering.
 *
 * On every INSERT we show a soft "Tour activity recorded" toast and
 * call `router.refresh()` so the parent server component re-fetches.
 * That naturally repaints:
 *   - the billing-page TourStatusActivityFeed (server-rendered)
 *   - the tours-page Upcoming Tours list (if the new event reflects a
 *     status change the page already reads)
 *
 * We deliberately do NOT subscribe to UPDATE/DELETE — the audit table
 * is append-only by RLS, so listening for INSERT is sufficient.
 *
 * ── PREREQ ────────────────────────────────────────────────────────────────
 * `tour_status_events` must be in the `supabase_realtime` publication.
 * Applied via ops command (not a migration file) in Phase 8O:
 *
 *   alter publication supabase_realtime add table public.tour_status_events;
 *
 * If the table is missing from the publication, the channel subscribes
 * successfully but receives no events. See RUNBOOK §7 for the re-apply
 * recipe.
 */

interface RealtimeTourStatusLayerProps {
  venueId: string
}

// Phase 8P — trailing-edge debounce window for `router.refresh()` calls.
// 1000ms is the sweet spot: bulk-cancel of 50 tours fires one refresh
// (instead of 50), while a single isolated event still feels responsive
// — the lead's "Tour activity recorded" toast appears immediately and
// the DOM refresh follows within a second.
//
// We do NOT debounce the toast — every INSERT still surfaces visually so
// operators see the bulk volume in the activity stream, just without
// hammering the server with refreshes.
const REFRESH_DEBOUNCE_MS = 1000

export default function RealtimeTourStatusLayer({
  venueId,
}: RealtimeTourStatusLayerProps) {
  const router = useRouter()
  const [toast, setToast] = useState<string | null>(null)
  // Refs hold the pending timeout + the latest router instance so the
  // subscription callback can fire-and-coalesce without re-subscribing
  // on every render.
  const pendingRefreshRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const routerRef = useRef(router)
  // Keep the latest router reference current without restarting the
  // Supabase subscription on every render — re-subscribing is expensive
  // and would drop in-flight events.
  routerRef.current = router

  useEffect(() => {
    if (!venueId) return
    const supabase = createClient()
    const channel = supabase
      .channel(`tour-status-events:venue:${venueId}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'tour_status_events',
          filter: `venue_id=eq.${venueId}`,
        },
        () => {
          // Toast immediately — gives operators visual feedback on
          // every insert even when the refresh is coalesced.
          setToast('Tour activity recorded')

          // Trailing debounce on the refresh. Each new event resets
          // the timer; only the last one survives the window.
          if (pendingRefreshRef.current) {
            clearTimeout(pendingRefreshRef.current)
          }
          pendingRefreshRef.current = setTimeout(() => {
            pendingRefreshRef.current = null
            routerRef.current.refresh()
          }, REFRESH_DEBOUNCE_MS)
        }
      )
      .subscribe()

    return () => {
      // Best-effort cleanup. `removeChannel` returns a promise we don't
      // await — Supabase's internal cleanup is async and the effect
      // teardown runs synchronously.
      supabase.removeChannel(channel)
      // Phase 8P — drop any pending refresh so a fast unmount doesn't
      // schedule a refresh after the component is gone (no harm, but
      // chatty in dev logs).
      if (pendingRefreshRef.current) {
        clearTimeout(pendingRefreshRef.current)
        pendingRefreshRef.current = null
      }
    }
  }, [venueId])

  if (!toast) return null
  return <RealtimeToast message={toast} onClose={() => setToast(null)} />
}
