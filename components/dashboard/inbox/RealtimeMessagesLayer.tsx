'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'

/**
 * Phase 8B — realtime layer for the /dashboard/inbox list view.
 *
 * Subscribes to `public.conversations` filtered by `venue_id` so a brand-
 * new conversation (or an existing one whose `last_message_at` shifts)
 * triggers `router.refresh()` and the list re-orders.
 *
 * Why not just subscribe to `messages`? Two reasons:
 *   1. `ConversationThread` (the open-thread view) already subscribes to
 *      `messages` filtered by `conversation_id` — that's where new bubbles
 *      need to land in real time. Doing it again at the inbox-list level
 *      would double-trigger refreshes.
 *   2. The inbox list orders by `last_message_at`. Conversations table
 *      gets that field bumped by the orchestrator (via service-role)
 *      whenever a message arrives, so subscribing to conversations'
 *      UPDATEs gives us list re-ordering for free.
 *
 * AUTH / RLS
 *   The browser anon client only sees conversations the signed-in user
 *   has SELECT access to (Phase 6B `conversations: select for members`).
 *   Realtime respects RLS in the same way; we don't leak cross-tenant.
 */

interface RealtimeMessagesLayerProps {
  venueId: string
}

export default function RealtimeMessagesLayer({ venueId }: RealtimeMessagesLayerProps) {
  const router = useRouter()

  useEffect(() => {
    if (!venueId) return
    const supabase = createClient()
    const channel = supabase
      .channel(`conversations:venue:${venueId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'conversations',
          filter: `venue_id=eq.${venueId}`,
        },
        () => {
          router.refresh()
        }
      )
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [venueId, router])

  return null
}
