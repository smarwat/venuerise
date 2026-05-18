'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import RealtimeToast from '@/components/dashboard/realtime/RealtimeToast'

/**
 * Phase 8C — Supabase Realtime subscription for the /dashboard/tours page.
 *
 * Mirrors the Phase 8B `RealtimeLeadsLayer` shape. Subscribes to
 * `tours:venue:${venueId}` with a server-side `venue_id=eq.…` filter.
 * On any postgres_changes event (INSERT/UPDATE/DELETE) it calls
 * `router.refresh()` and shows a soft "Tours updated" toast.
 *
 * Tours table is in the supabase_realtime publication (migration 001).
 * RLS on `public.tours` restricts SELECT to venue members (Phase 6B), so
 * the subscription can't leak cross-venue rows even with a missing filter.
 *
 * UNMOUNT behavior: `supabase.removeChannel(channel)` returns a Promise we
 * don't await — fine because the effect's cleanup runs synchronously and
 * Supabase's internal cleanup is best-effort.
 */

interface RealtimeToursLayerProps {
  venueId: string
}

export default function RealtimeToursLayer({ venueId }: RealtimeToursLayerProps) {
  const router = useRouter()
  const [toast, setToast] = useState<string | null>(null)

  useEffect(() => {
    if (!venueId) return
    const supabase = createClient()
    const channel = supabase
      .channel(`tours:venue:${venueId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'tours',
          filter: `venue_id=eq.${venueId}`,
        },
        () => {
          setToast('Tours updated')
          router.refresh()
        }
      )
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [venueId, router])

  if (!toast) return null
  return <RealtimeToast message={toast} onClose={() => setToast(null)} />
}
