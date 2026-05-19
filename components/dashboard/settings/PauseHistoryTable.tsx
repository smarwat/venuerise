'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { CalendarOff, CheckCircle2, Loader2, History } from 'lucide-react'
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardSubtitle,
} from '@/components/dashboard/ui/Card'
import { Badge } from '@/components/dashboard/ui/Badge'
import { Button } from '@/components/dashboard/ui/Button'

/**
 * Phase 8I — Tour pause/resume audit surface.
 *
 * Renders on `/dashboard/settings/billing` below the BillingStatusCard.
 * Shows:
 *   1. The CURRENT pause state (if any), with a "Clear pause" CTA that
 *      hits POST /api/admin/tours/clear-pause.
 *   2. The last N archived pause/resume cycles from
 *      `subscriptions.metadata.tour_pause_history`.
 *
 * Server-side: `app/(dashboard)/dashboard/settings/billing/page.tsx`
 * reads the subscription metadata via the service client and passes the
 * already-parsed `current` + `items` shapes in. That keeps this
 * component purely presentational (and makes the empty/loading states
 * trivial — there's no client-side fetch).
 *
 * The Clear pause action is the only mutating affordance. It's hidden
 * unless `current.paused_at` is truthy, so a non-paused venue can't
 * accidentally fire it. The button shows inline success/error feedback
 * and calls `router.refresh()` on success to re-render the table.
 *
 * Visual identity: standard Card primitives. No new design tokens — the
 * status pill uses the existing Badge variants (`navy` for paused +
 * `green` for cleared), the timestamps are slate-500.
 */

export interface PauseHistoryCurrent {
  paused_at: string | null
  paused_reason: string | null
  paused_count: number | null
  resumed_at: string | null
  resumed_reason: string | null
}

export interface PauseHistoryItem {
  paused_at: string
  resumed_at: string
  paused_reason: string | null
  resumed_reason: string | null
  paused_count: number | null
  archived_at: string
}

interface PauseHistoryTableProps {
  current: PauseHistoryCurrent
  items: PauseHistoryItem[]
}

type ClearState =
  | { kind: 'idle' }
  | { kind: 'submitting' }
  | { kind: 'success' }
  | { kind: 'error'; message: string }

function fmt(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  // Locale-free; matches the rest of the dashboard's audit-style dates.
  return d.toUTCString().replace(/ \d{2}:\d{2}:\d{2} GMT$/, '')
}

function fmtRange(pausedIso: string, resumedIso: string): string {
  const ms = new Date(resumedIso).getTime() - new Date(pausedIso).getTime()
  if (!Number.isFinite(ms) || ms < 0) return '—'
  const days = Math.floor(ms / (24 * 60 * 60 * 1000))
  if (days >= 1) return `${days} day${days === 1 ? '' : 's'}`
  const hours = Math.max(1, Math.floor(ms / (60 * 60 * 1000)))
  return `${hours} hour${hours === 1 ? '' : 's'}`
}

export default function PauseHistoryTable({
  current,
  items,
}: PauseHistoryTableProps) {
  const router = useRouter()
  const [clear, setClear] = useState<ClearState>({ kind: 'idle' })
  const hasActivePause = Boolean(current.paused_at)
  const hasHistory = items.length > 0

  async function handleClearPause() {
    if (!hasActivePause) return
    setClear({ kind: 'submitting' })
    try {
      const res = await fetch('/api/admin/tours/clear-pause', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: unknown } | null
        const code =
          body && typeof body.error === 'string' ? body.error : `HTTP ${res.status}`
        setClear({ kind: 'error', message: `Couldn't clear: ${code}` })
        return
      }
      setClear({ kind: 'success' })
      // Re-fetch server data so the Current state collapses + a fresh
      // history row (if the cron later archives this clear-pause cycle)
      // shows up on its own. The clear-pause endpoint itself does NOT
      // append to history — only the cron does, on the next re-pause.
      router.refresh()
    } catch (err) {
      setClear({
        kind: 'error',
        message: err instanceof Error ? err.message : 'Network error',
      })
    }
  }

  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Tour pause history</CardTitle>
          <CardSubtitle>
            When auto-pause fires for past-due billing, the cycle gets
            recorded here.
          </CardSubtitle>
        </div>
        <div className="shrink-0">
          <Badge variant={hasActivePause ? 'red' : 'green'}>
            {hasActivePause ? 'Paused' : 'Active'}
          </Badge>
        </div>
      </CardHeader>

      <CardContent>
        {/* Current pause card — only when a pause is active. */}
        {hasActivePause && (
          <div className="mb-4 rounded-2xl border border-[#FECACA] bg-[#FEF2F2] px-4 py-3.5">
            <div className="flex items-start gap-3">
              <div className="w-9 h-9 rounded-xl bg-white border border-[#FECACA] flex items-center justify-center shrink-0">
                <CalendarOff className="w-4 h-4 text-[#B91C1C]" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-[13px] font-semibold text-[#7F1D1D]">
                  Active pause
                </p>
                <p className="text-[12px] text-[#991B1B]/85 mt-0.5">
                  Paused {fmt(current.paused_at)} ·{' '}
                  {current.paused_count ?? 0} tour
                  {(current.paused_count ?? 0) === 1 ? '' : 's'} cancelled
                  {current.paused_reason ? ` · reason: ${current.paused_reason}` : ''}
                </p>
              </div>
              <Button
                variant="secondary"
                size="sm"
                onClick={handleClearPause}
                disabled={clear.kind === 'submitting' || clear.kind === 'success'}
              >
                {clear.kind === 'submitting' ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : clear.kind === 'success' ? (
                  <CheckCircle2 className="w-3.5 h-3.5 text-[#059669]" />
                ) : null}
                {clear.kind === 'submitting'
                  ? 'Clearing…'
                  : clear.kind === 'success'
                    ? 'Cleared'
                    : 'Clear pause'}
              </Button>
            </div>
            {clear.kind === 'error' && (
              <p className="mt-2 text-[11px] text-[#B91C1C]">{clear.message}</p>
            )}
          </div>
        )}

        {/* History list. */}
        {hasHistory ? (
          <div className="border border-[#E2E8F0] rounded-2xl overflow-hidden">
            <table className="w-full text-left">
              <thead>
                <tr className="bg-[#F8FAFC] border-b border-[#E2E8F0]">
                  <th className="px-4 py-2 text-[10px] font-semibold text-[#94A3B8] uppercase tracking-wider">
                    Paused
                  </th>
                  <th className="px-4 py-2 text-[10px] font-semibold text-[#94A3B8] uppercase tracking-wider">
                    Resumed
                  </th>
                  <th className="px-4 py-2 text-[10px] font-semibold text-[#94A3B8] uppercase tracking-wider">
                    Duration
                  </th>
                  <th className="px-4 py-2 text-[10px] font-semibold text-[#94A3B8] uppercase tracking-wider">
                    Cancelled
                  </th>
                  <th className="px-4 py-2 text-[10px] font-semibold text-[#94A3B8] uppercase tracking-wider">
                    Reason
                  </th>
                </tr>
              </thead>
              <tbody>
                {items.map((it, idx) => (
                  <tr
                    key={`${it.archived_at}-${idx}`}
                    className="border-b border-[#F1F5F9] last:border-b-0 hover:bg-[#F8FAFC] transition-colors"
                  >
                    <td className="px-4 py-2.5 text-[12px] text-[#0F172A] font-medium">
                      {fmt(it.paused_at)}
                    </td>
                    <td className="px-4 py-2.5 text-[12px] text-[#475569]">
                      {fmt(it.resumed_at)}
                    </td>
                    <td className="px-4 py-2.5 text-[12px] text-[#475569]">
                      {fmtRange(it.paused_at, it.resumed_at)}
                    </td>
                    <td className="px-4 py-2.5 text-[12px] text-[#475569]">
                      {it.paused_count ?? '—'}
                    </td>
                    <td className="px-4 py-2.5 text-[11px] text-[#64748B]">
                      {it.paused_reason ?? '—'}
                      {it.resumed_reason ? ` → ${it.resumed_reason}` : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : hasActivePause ? (
          // Active pause but no prior cycles — no need for an empty list line.
          null
        ) : (
          <div className="flex items-center gap-3 text-[12px] text-[#64748B] px-2 py-3">
            <div className="w-9 h-9 rounded-xl bg-[#F1F5F9] flex items-center justify-center shrink-0">
              <History className="w-4 h-4 text-[#0F172A]" />
            </div>
            <span>No tour pause history yet.</span>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
