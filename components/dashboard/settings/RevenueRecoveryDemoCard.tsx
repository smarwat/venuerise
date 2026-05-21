'use client'

import { useState } from 'react'
import Link from 'next/link'
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  Sparkles,
} from 'lucide-react'
import {
  Card,
  CardContent,
  CardHeader,
  CardSubtitle,
  CardTitle,
} from '@/components/dashboard/ui/Card'
import { Button } from '@/components/dashboard/ui/Button'

/**
 * GTM-0A — Revenue Recovery Demo card.
 *
 * Admin-only seed CTA. Sister of the Phase 9J `DemoModeCard` (which
 * toggles the visual banner). This card writes the actual demo
 * dataset to the venue so the dashboard tells the Revenue OS story
 * within 30 seconds.
 *
 * The route enforces ADMIN_ROLES; non-admin clicks return a 4xx and
 * the card renders the inline error. We deliberately don't
 * client-side gate by role — the simpler posture is "anyone with
 * billing-page access sees the card; only admins succeed when they
 * click."
 */

type SeedResult = {
  success: boolean
  venueId: string
  created: Record<string, number>
  skipped: Record<string, number>
  reset: Record<string, number>
  warnings: string[]
}

type SubmitState =
  | { kind: 'idle' }
  | { kind: 'submitting' }
  | { kind: 'success'; result: SeedResult }
  | { kind: 'error'; message: string }

function humanize(code: string): string {
  switch (code) {
    case 'unauthorized':
      return 'Please sign in again to seed demo data.'
    case 'forbidden':
    case 'tenant_access_forbidden':
      return 'Only owners and admins can seed the Revenue Recovery demo.'
    case 'no_venue':
    case 'venue_not_found':
      return 'No active workspace found.'
    case 'validation_failed':
      return 'Invalid request. Refresh the page and try again.'
    case 'rate_limited':
      return 'Too many seed requests. Wait a minute and try again.'
    case 'unexpected_error':
      return 'Server error while seeding. Try again or contact support.'
    default:
      return code
  }
}

function CountRow({
  label,
  value,
  tone,
}: {
  label: string
  value: number
  tone?: 'neutral' | 'positive' | 'muted'
}) {
  if (value === 0 && tone !== 'positive') return null
  const color =
    tone === 'positive'
      ? 'text-[#047857]'
      : tone === 'muted'
        ? 'text-[#94A3B8]'
        : 'text-[#0F172A]'
  return (
    <div className="flex justify-between text-[12px]">
      <span className="text-[#475569]">{label}</span>
      <span className={`font-semibold tabular-nums ${color}`}>{value}</span>
    </div>
  )
}

export default function RevenueRecoveryDemoCard() {
  const [reset, setReset] = useState(false)
  const [state, setState] = useState<SubmitState>({ kind: 'idle' })

  async function handleSeed() {
    setState({ kind: 'submitting' })
    try {
      const res = await fetch('/api/admin/demo/revenue-recovery-seed', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          reset_existing_demo_data: reset,
        }),
      })
      const json = (await res.json().catch(() => null)) as
        | (SeedResult & { error?: string })
        | null
      if (!res.ok || !json || json.success !== true) {
        const code =
          json && typeof json.error === 'string'
            ? json.error
            : `request_failed_${res.status}`
        setState({ kind: 'error', message: humanize(code) })
        return
      }
      setState({ kind: 'success', result: json })
    } catch (err) {
      setState({
        kind: 'error',
        message: err instanceof Error ? err.message : 'Network error',
      })
    }
  }

  const busy = state.kind === 'submitting'

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start gap-3 min-w-0">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-[#FFFBEB] text-[#B45309] shrink-0">
            <Sparkles className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <CardTitle>Revenue Recovery demo mode</CardTitle>
            <CardSubtitle>
              Seed a realistic wedding venue pipeline with revenue
              leaks, source attribution, stale leads, tours, and
              booked revenue. Use this only for demos or pilot setup
              — it is not real customer data.
            </CardSubtitle>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <label className="flex items-center gap-2 text-[12.5px] text-[#475569] mb-3">
          <input
            type="checkbox"
            checked={reset}
            onChange={(e) => setReset(e.target.checked)}
            disabled={busy}
            className="rounded border-[#CBD5E1]"
          />
          Reset previous demo seed first
        </label>

        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={handleSeed} disabled={busy} variant="primary">
            {busy ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" /> Seeding…
              </>
            ) : (
              <>
                <Sparkles className="h-4 w-4" /> Seed demo data
              </>
            )}
          </Button>
          {state.kind === 'success' && (
            <Link
              href="/dashboard"
              className="text-[12.5px] font-medium text-[#1D4ED8] hover:underline"
            >
              View dashboard →
            </Link>
          )}
        </div>

        {state.kind === 'error' && (
          <div className="mt-4 flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-[12.5px] text-amber-900">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{state.message}</span>
          </div>
        )}

        {state.kind === 'success' && (
          <div className="mt-4 rounded-md border border-[#E2E8F0] bg-[#F8FAFC] p-3 space-y-2">
            <div className="flex items-center gap-2 text-[12.5px] font-semibold text-[#047857]">
              <CheckCircle2 className="h-4 w-4" />
              Demo data seeded.
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1">
              <CountRow label="Leads" value={state.result.created.leads ?? 0} tone="positive" />
              <CountRow label="Conversations" value={state.result.created.conversations ?? 0} />
              <CountRow label="Messages" value={state.result.created.messages ?? 0} />
              <CountRow label="Tours" value={state.result.created.tours ?? 0} />
              <CountRow label="Channel connections" value={state.result.created.channel_connections ?? 0} />
              <CountRow label="Knowledge entries" value={state.result.created.knowledge_base ?? 0} />
              <CountRow label="Availability slots" value={state.result.created.tour_availability ?? 0} />
              <CountRow label="Blackouts" value={state.result.created.tour_blackouts ?? 0} />
              {(state.result.reset.leads ?? 0) > 0 && (
                <CountRow label="Reset leads" value={state.result.reset.leads} tone="muted" />
              )}
              {(state.result.reset.channel_connections ?? 0) > 0 && (
                <CountRow label="Reset channels" value={state.result.reset.channel_connections} tone="muted" />
              )}
            </div>
            {state.result.warnings.length > 0 && (
              <details className="mt-2">
                <summary className="text-[11px] font-medium text-[#B45309] cursor-pointer">
                  {state.result.warnings.length} warning
                  {state.result.warnings.length === 1 ? '' : 's'}
                </summary>
                <ul className="mt-1 list-disc pl-5 text-[11px] text-[#92400E] space-y-0.5">
                  {state.result.warnings.map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        )}

        <p className="mt-4 text-[11px] text-[#94A3B8] italic leading-relaxed">
          Demo data is for sales demos and pilot setup. It is not
          evidence of real customer performance and should not be
          mixed with production reporting unless clearly marked.
          Reset removes only rows this seed created — real venue
          data is never touched.
        </p>
      </CardContent>
    </Card>
  )
}
