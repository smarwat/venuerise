'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import RealtimeToast from '@/components/dashboard/realtime/RealtimeToast'

/**
 * Phase 8Z — Supabase Realtime subscription for digest deliveries.
 *
 * Mirrors the Phase 8O `RealtimeTourStatusLayer` pattern but
 * subscribes to `public.outbound_messages` INSERTs and narrows to
 * digest rows in the handler (Postgres-side filter can't reach into
 * a jsonb column).
 *
 * On every qualifying INSERT we surface a "New digest send recorded"
 * toast and call `router.refresh()` so the server-rendered billing
 * page re-fetches. The mounted `DigestAuditFeed` is a client
 * component, but the surrounding billing-page server fetch is what
 * gives admins their realtime context (the feed re-fetches on its
 * own when its filter changes; the realtime layer is the gentle
 * nudge that something new happened).
 *
 * ── PREREQ ────────────────────────────────────────────────────────────────
 * `outbound_messages` must be in the `supabase_realtime` publication.
 * As of migration 001 the publication includes leads / messages /
 * conversations / tours only; `outbound_messages` is NOT in by
 * default. Apply out-of-band (not a migration file):
 *
 *   alter publication supabase_realtime add table public.outbound_messages;
 *
 * Without the publication entry, the channel subscribes successfully
 * but receives no events. See RUNBOOK "Digest audit feed not
 * updating live" for the re-apply recipe.
 *
 * ── HANDLER FILTERING ─────────────────────────────────────────────────────
 *   - `venue_id=eq.${venueId}` — server-side filter; the channel can't
 *     leak cross-venue rows even if the client filter regresses.
 *   - `related_table === 'tour_status_events'` — drops every non-
 *     digest outbound row (lead emails, tour notifications, etc).
 *   - `metadata.tour_digest_send_kind` present — drops any digest-
 *     adjacent row that pre-dates the Phase 8W discriminator.
 *
 * ── DEBOUNCE ──────────────────────────────────────────────────────────────
 * Trailing 1000ms debounce on `router.refresh()` (same window as
 * Phase 8P). Bulk sends from the cron coalesce into a single refresh;
 * the toast still fires per-event so operators see the volume.
 */

interface RealtimeDigestSendsLayerProps {
  venueId: string
}

const REFRESH_DEBOUNCE_MS = 1000

export default function RealtimeDigestSendsLayer({
  venueId,
}: RealtimeDigestSendsLayerProps) {
  const router = useRouter()
  const [toast, setToast] = useState<string | null>(null)
  const pendingRefreshRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const routerRef = useRef(router)
  routerRef.current = router

  useEffect(() => {
    if (!venueId) return
    const supabase = createClient()
    const channel = supabase
      .channel(`digest-sends:venue:${venueId}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'outbound_messages',
          filter: `venue_id=eq.${venueId}`,
        },
        (payload) => {
          // Two-step client-side filter — postgres filter can't reach
          // into jsonb. Drop non-digest outbound rows quietly so the
          // operator only sees the signal they care about.
          const row = (payload?.new ?? null) as Record<string, unknown> | null
          if (!row) return
          if (row.related_table !== 'tour_status_events') return
          const meta = row.metadata as Record<string, unknown> | null
          if (
            !meta ||
            typeof meta.tour_digest_send_kind !== 'string' ||
            meta.tour_digest_send_kind.length === 0
          ) {
            return
          }

          setToast('New digest send recorded')

          // Phase 8AA — if the brand-new outbound row is already
          // tagged `status='suppressed'` (Resend pre-flight matched
          // it against the suppression list immediately), tell the
          // sibling DigestSuppressionsCallout to refetch. Avoids a
          // page reload to surface a freshly-bounced address. Uses a
          // browser CustomEvent instead of a global store — there's
          // exactly one consumer and the lifetime is page-scoped.
          if (row.status === 'suppressed' && typeof window !== 'undefined') {
            window.dispatchEvent(
              new CustomEvent('venuerise:digest-suppression-refresh')
            )
          }

          // Phase 8AC — same pattern for the cron-health card: when
          // the new row was a cron send, ping the card to refetch
          // so its "last run" + lag minutes update without the
          // operator hitting Refresh. Preview/manual rows don't
          // affect cron health, so we narrow on send_kind.
          if (
            meta.tour_digest_send_kind === 'cron' &&
            typeof window !== 'undefined'
          ) {
            window.dispatchEvent(
              new CustomEvent('venuerise:digest-cron-fired')
            )
          }

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
      supabase.removeChannel(channel)
      if (pendingRefreshRef.current) {
        clearTimeout(pendingRefreshRef.current)
        pendingRefreshRef.current = null
      }
    }
  }, [venueId])

  if (!toast) return null
  return <RealtimeToast message={toast} onClose={() => setToast(null)} />
}
