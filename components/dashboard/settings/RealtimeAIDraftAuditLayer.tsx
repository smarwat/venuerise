'use client'

import { useEffect, useRef } from 'react'
import { createClient } from '@/lib/supabase/client'

/**
 * Phase 8AO — RealtimeAIDraftAuditLayer.
 *
 * Non-rendering client component that subscribes to `ai_actions`
 * INSERTs filtered by venue, narrows client-side to
 * `agent='venuerise' AND action='draft_regenerate'`, and dispatches a
 * browser CustomEvent (`venuerise:ai-draft-audit-fired`) on a 1s
 * trailing debounce so the AIDraftAuditCard (or any future consumer)
 * can refresh without a tight realtime → fetch loop.
 *
 * Why a separate non-rendering layer instead of the card subscribing
 * directly:
 *   - The card may unmount/remount when filter chips change; the
 *     subscription lifetime should track the page, not the card.
 *   - Other future consumers (a topbar notification badge, e.g.) can
 *     listen for the same event without duplicating the subscription.
 *
 * RLS posture: `ai_actions` SELECT is gated to venue members
 * (migration 005 / Phase 6B). The browser anon client can only see
 * rows it would already be able to read; realtime respects RLS the
 * same way.
 *
 * Realtime publication caveat: `ai_actions` must be in the
 * `supabase_realtime` publication for INSERTs to fire client-side.
 * If it isn't, this layer silently no-ops — the card's manual
 * Refresh button keeps the UX usable. The RUNBOOK records the one-
 * time SQL needed to enable it:
 *
 *   alter publication supabase_realtime add table public.ai_actions;
 */

const EVENT_NAME = 'venuerise:ai-draft-audit-fired'
const DEBOUNCE_MS = 1000

interface Props {
  venueId: string
}

export default function RealtimeAIDraftAuditLayer({ venueId }: Props) {
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (!venueId) return
    const supabase = createClient()
    const channel = supabase
      .channel(`ai-actions:venue:${venueId}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'ai_actions',
          filter: `venue_id=eq.${venueId}`,
        },
        (payload) => {
          // Narrow client-side. Supabase realtime filters are limited
          // to scalar equality, so we accept all venue inserts and
          // discard non-draft-regenerate rows here.
          const row = (payload as { new?: Record<string, unknown> | null }).new
          if (!row) return
          if (row.agent !== 'venuerise') return
          if (row.action !== 'draft_regenerate') return
          if (debounceRef.current) clearTimeout(debounceRef.current)
          debounceRef.current = setTimeout(() => {
            try {
              window.dispatchEvent(new CustomEvent(EVENT_NAME))
            } catch {
              // CustomEvent is universally supported; defensive
              // swallow keeps the realtime channel alive even if a
              // sandboxed iframe rejects construction.
            }
          }, DEBOUNCE_MS)
        }
      )
      .subscribe()
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
      supabase.removeChannel(channel)
    }
  }, [venueId])

  return null
}
