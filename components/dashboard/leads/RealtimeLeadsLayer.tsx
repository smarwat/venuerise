'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import RealtimeToast from '@/components/dashboard/realtime/RealtimeToast'

/**
 * Phase 8B — Supabase Realtime subscription for the /dashboard/leads page.
 *
 * STRATEGY
 *   The leads page is a Server Component; KanbanBoard is a stateful
 *   Client Component initialized once with `initialLeads`. We don't push
 *   payload diffs into KanbanBoard directly (would require a state
 *   refactor). Instead we call `router.refresh()` on every change — Next
 *   re-runs the server component, the new `initialLeads` flow into
 *   KanbanBoard, and a small `useEffect` in KanbanBoard re-syncs local
 *   state to the new prop (added in this phase).
 *
 *   For INSERTs we ALSO surface a toast so the operator sees the live
 *   update happen — that's the demo moment. UPDATE/DELETE refresh silently.
 *
 * CHANNEL
 *   `leads:venue:${venueId}` filtered server-side by `venue_id=eq.…`.
 *   The publication already includes `public.leads` (migration 001).
 *
 * AUTH
 *   The browser client uses the user's anon session. RLS on `public.leads`
 *   restricts realtime to rows the user can SELECT — i.e. their own
 *   venue (Phase 6B `leads: select for members`). A leak via Realtime
 *   isn't possible without first widening the table's SELECT policy.
 *
 * THROTTLING
 *   We don't debounce — at demo volume (1 click → 1 lead) this is fine.
 *   Under production load a flood of inserts could trigger N refreshes;
 *   if that ever bites, add a 250ms trailing debounce inside this layer.
 */

interface RealtimeLeadsLayerProps {
  venueId: string
}

export default function RealtimeLeadsLayer({ venueId }: RealtimeLeadsLayerProps) {
  const router = useRouter()
  const [toast, setToast] = useState<string | null>(null)

  useEffect(() => {
    if (!venueId) return
    const supabase = createClient()
    const channel = supabase
      .channel(`leads:venue:${venueId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'leads',
          filter: `venue_id=eq.${venueId}`,
        },
        (payload) => {
          if (payload.eventType === 'INSERT') {
            const lead = payload.new as { name?: string } | null
            const name = lead?.name ?? 'New lead'
            setToast(`New lead just landed: ${name}`)
          }
          router.refresh()
        }
      )
      .subscribe()

    return () => {
      // unsubscribe returns a Promise we don't await — fine on unmount.
      supabase.removeChannel(channel)
    }
  }, [venueId, router])

  if (!toast) return null
  return <RealtimeToast message={toast} onClose={() => setToast(null)} />
}
