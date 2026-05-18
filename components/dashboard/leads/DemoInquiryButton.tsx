'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Sparkles, Loader2, ChevronDown } from 'lucide-react'
import { Button } from '@/components/dashboard/ui/Button'
import {
  buildDemoInquiry,
  DEMO_INQUIRY_VARIANTS,
  DEMO_INQUIRY_VARIANT_ORDER,
  type DemoInquiryVariant,
} from '@/lib/demo/demo-inquiry'

/**
 * Phase 8B → 8C — demo-mode "Send test inquiry" button + variant select.
 *
 * Only rendered by the caller when `NEXT_PUBLIC_DEMO_BUTTON === '1'`.
 *
 * Phase 8C extension: a native `<select>` next to the button lets the
 * operator pick which of three preset payloads to send. Each fires a
 * real `/api/widget` POST so the full pipeline runs (lead insert →
 * conversation pre-create → Inngest enqueue → AI qualification → first
 * AI message → follow-up schedule).
 *
 * Realtime (Phase 8B's RealtimeLeadsLayer) picks up the new lead and
 * routes a `router.refresh()`. As a fallback (e.g. Realtime not
 * configured), we trigger a manual refresh after 2s.
 *
 * Why a native `<select>` instead of a Radix dropdown? Keeps the bundle
 * lean (no new deps), keyboard-accessible by default, and the demo
 * doesn't need pixel-perfect styling — the surrounding Button shell
 * carries the design.
 */

interface DemoInquiryButtonProps {
  venueId: string
}

export default function DemoInquiryButton({ venueId }: DemoInquiryButtonProps) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [variant, setVariant] = useState<DemoInquiryVariant>('garden')

  async function handleClick() {
    if (!venueId) {
      setError('No venue context — sign in as the venue owner first.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const payload = buildDemoInquiry(venueId, variant)
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
      // websockets), force a refresh after 2 seconds.
      window.setTimeout(() => router.refresh(), 2000)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-2">
        {/* Native select — accessible, zero new deps, matches the surrounding
            Input style enough for an internal demo control. */}
        <div className="relative">
          <select
            value={variant}
            onChange={(e) => setVariant(e.target.value as DemoInquiryVariant)}
            disabled={busy}
            aria-label="Demo inquiry variant"
            className="appearance-none h-8 pl-3 pr-7 rounded-lg bg-white border border-[#E2E8F0] text-xs text-[#0F172A] hover:border-[#CBD5E1] focus:outline-none focus:border-[#1D4ED8] focus:ring-[3px] focus:ring-[#3B82F6]/15 disabled:opacity-60"
          >
            {DEMO_INQUIRY_VARIANT_ORDER.map((v) => (
              <option key={v} value={v}>
                {DEMO_INQUIRY_VARIANTS[v].label}
              </option>
            ))}
          </select>
          <ChevronDown className="pointer-events-none w-3 h-3 text-[#94A3B8] absolute right-2 top-1/2 -translate-y-1/2" />
        </div>
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
      </div>
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
