'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Sparkles, Loader2 } from 'lucide-react'
import { Button } from '@/components/dashboard/ui/Button'
import { buildDemoInquiry } from '@/lib/demo/demo-inquiry'

/**
 * Phase 8B — demo-mode "Send test inquiry" button.
 *
 * Only rendered by the caller when `NEXT_PUBLIC_DEMO_BUTTON === '1'`.
 * Posts a real payload to `/api/widget` so the FULL pipeline runs:
 *   widget intake → lead insert → conversation pre-create → Inngest enqueue →
 *   AI qualification → first AI message → follow-up schedule.
 *
 * Realtime (Phase 8B's RealtimeLeadsLayer) picks up the new lead and
 * routes a `router.refresh()`. As a fallback (e.g. Realtime not configured),
 * we trigger a manual refresh after 2s if the realtime layer didn't.
 */

interface DemoInquiryButtonProps {
  venueId: string
}

export default function DemoInquiryButton({ venueId }: DemoInquiryButtonProps) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleClick() {
    if (!venueId) {
      setError('No venue context — sign in as the venue owner first.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const payload = buildDemoInquiry(venueId)
      const res = await fetch('/api/widget', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: unknown } | null
        const code = body && typeof body.error === 'string' ? body.error : `HTTP ${res.status}`
        setError(humanize(code))
        return
      }
      // Realtime should reload the page within a few hundred ms. If it
      // doesn't (e.g. Realtime publication not synced, browser blocked
      // websockets), force a refresh after 2 seconds so the demo doesn't
      // hang on an empty kanban.
      window.setTimeout(() => router.refresh(), 2000)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        variant="secondary"
        size="sm"
        onClick={handleClick}
        disabled={busy}
        title="Demo-only — fires a real /api/widget POST"
      >
        {busy ? (
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
        ) : (
          <Sparkles className="w-3.5 h-3.5" />
        )}
        {busy ? 'Sending…' : 'Send test inquiry'}
      </Button>
      {error && (
        <div className="text-[11px] text-[#B91C1C] max-w-xs text-right">{error}</div>
      )}
    </div>
  )
}

function humanize(code: string): string {
  switch (code) {
    case 'origin_not_allowed':
      return 'Widget rejected the request — make sure NEXT_PUBLIC_APP_URL matches this host.'
    case 'Venue not found':
    case 'venue_not_found':
      return 'Venue lookup failed. Re-onboard or check the venue id.'
    case 'rate_limited':
      return 'Slow down — the widget rate-limited us.'
    default:
      return `Widget request failed (${code})`
  }
}
