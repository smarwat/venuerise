'use client'

import { useState } from 'react'
import Link from 'next/link'
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  Layers,
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
 * GTM-0A.2 — Revenue Recovery LOAD/Stress Demo card.
 *
 * Sibling of `RevenueRecoveryDemoCard` (GTM-0A, 24-lead hand-crafted
 * demo). This one generates 25–1000 leads with messages, tours, and
 * realistic source/channel distribution so the dashboard can be
 * stress-tested under load.
 *
 * The route enforces ADMIN_ROLES; non-admin clicks return a 4xx
 * and the card renders the inline error. Reset only matches
 * `demo_seed_type='load'` + `demo_seed_version='gtm_0a_2'` so it
 * NEVER deletes the GTM-0A hand-crafted demo.
 */

type Distribution = {
  stages: Record<string, number>
  sources: Record<string, number>
  channels: Record<string, number>
  lostReasons: Record<string, number>
  leakageSignals: Record<string, number>
}

type SeedResult = {
  success: boolean
  venueId: string
  profile: 'balanced' | 'high_volume' | 'messy_channels' | 'sales_demo'
  leadCountRequested: number
  leadCountClamped: number
  created: Record<string, number>
  distribution: Distribution
  reset: Record<string, number>
  warnings: string[]
  durationMs: number
}

type SubmitState =
  | { kind: 'idle' }
  | { kind: 'submitting' }
  | { kind: 'success'; result: SeedResult }
  | { kind: 'error'; message: string }

const LEAD_COUNT_OPTIONS = [100, 250, 500, 1000] as const
const PROFILE_OPTIONS = [
  { value: 'balanced', label: 'Balanced — default healthy pipeline' },
  { value: 'high_volume', label: 'High volume — overflowing new inquiries' },
  { value: 'messy_channels', label: 'Messy channels — manual-required heavy' },
  { value: 'sales_demo', label: 'Sales demo — every signal lit up' },
] as const

function humanize(code: string): string {
  switch (code) {
    case 'unauthorized':
      return 'Please sign in again to seed demo data.'
    case 'forbidden':
    case 'tenant_access_forbidden':
      return 'Only owners and admins can seed load demo data.'
    case 'no_venue':
    case 'venue_not_found':
      return 'No active workspace found.'
    case 'validation_failed':
      return 'Invalid request. Refresh the page and try again.'
    case 'rate_limited':
      return 'Too many seed requests. Wait a minute and try again.'
    case 'lead_count_out_of_range':
      return 'Lead count is out of range (25–1000 allowed).'
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

function DistTable({
  title,
  rows,
}: {
  title: string
  rows: Record<string, number>
}) {
  const entries = Object.entries(rows).filter(([, v]) => v > 0)
  if (entries.length === 0) return null
  return (
    <div>
      <div className="text-[11px] font-semibold uppercase tracking-wider text-[#94A3B8] mb-1">
        {title}
      </div>
      <div className="grid grid-cols-2 gap-x-4 gap-y-0.5">
        {entries.map(([k, v]) => (
          <CountRow key={k} label={k} value={v} />
        ))}
      </div>
    </div>
  )
}

export default function RevenueRecoveryLoadDemoCard() {
  const [reset, setReset] = useState(false)
  const [leadCount, setLeadCount] = useState<number>(250)
  const [profile, setProfile] =
    useState<(typeof PROFILE_OPTIONS)[number]['value']>('balanced')
  const [state, setState] = useState<SubmitState>({ kind: 'idle' })

  async function handleSeed() {
    setState({ kind: 'submitting' })
    try {
      const res = await fetch(
        '/api/admin/demo/revenue-recovery-load-seed',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            lead_count: leadCount,
            profile,
            reset_existing_demo_data: reset,
          }),
        }
      )
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
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-[#EFF6FF] text-[#1D4ED8] shrink-0">
            <Layers className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <CardTitle>Revenue Recovery load / stress demo</CardTitle>
            <CardSubtitle>
              Generate 25–1000 leads with conversations, tours, and
              realistic source attribution so the dashboard can be
              tested under load. Reset only removes load-seed rows
              (never touches the 24-lead hand-crafted demo or real
              data).
            </CardSubtitle>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <div className="grid sm:grid-cols-2 gap-4 mb-3">
          <label className="block text-[12.5px]">
            <span className="block text-[#0F172A] font-medium mb-1">
              Lead count
            </span>
            <select
              value={leadCount}
              onChange={(e) => setLeadCount(Number(e.target.value))}
              disabled={busy}
              className="w-full rounded-md border border-[#CBD5E1] bg-white px-2 py-1.5 text-[#0F172A]"
            >
              {LEAD_COUNT_OPTIONS.map((n) => (
                <option key={n} value={n}>
                  {n.toLocaleString()} leads
                </option>
              ))}
            </select>
          </label>
          <label className="block text-[12.5px]">
            <span className="block text-[#0F172A] font-medium mb-1">
              Profile
            </span>
            <select
              value={profile}
              onChange={(e) =>
                setProfile(
                  e.target.value as (typeof PROFILE_OPTIONS)[number]['value']
                )
              }
              disabled={busy}
              className="w-full rounded-md border border-[#CBD5E1] bg-white px-2 py-1.5 text-[#0F172A]"
            >
              {PROFILE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
        </div>

        <label className="flex items-center gap-2 text-[12.5px] text-[#475569] mb-3">
          <input
            type="checkbox"
            checked={reset}
            onChange={(e) => setReset(e.target.checked)}
            disabled={busy}
            className="rounded border-[#CBD5E1]"
          />
          Reset previous load-seed rows first (does NOT touch the
          24-lead hand-crafted demo)
        </label>

        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={handleSeed} disabled={busy} variant="primary">
            {busy ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" /> Seeding…
              </>
            ) : (
              <>
                <Layers className="h-4 w-4" /> Seed load demo
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
          <div className="mt-4 rounded-md border border-[#E2E8F0] bg-[#F8FAFC] p-3 space-y-3">
            <div className="flex items-center gap-2 text-[12.5px] font-semibold text-[#047857]">
              <CheckCircle2 className="h-4 w-4" />
              Load demo seeded in {(state.result.durationMs / 1000).toFixed(1)}s.
            </div>
            <div className="grid grid-cols-2 gap-x-6 gap-y-1">
              <CountRow
                label="Leads"
                value={state.result.created.leads ?? 0}
                tone="positive"
              />
              <CountRow
                label="Conversations"
                value={state.result.created.conversations ?? 0}
              />
              <CountRow
                label="Messages"
                value={state.result.created.messages ?? 0}
              />
              <CountRow
                label="Tours"
                value={state.result.created.tours ?? 0}
              />
              {(state.result.reset.leads ?? 0) > 0 && (
                <CountRow
                  label="Reset leads"
                  value={state.result.reset.leads}
                  tone="muted"
                />
              )}
            </div>

            <DistTable title="Stage mix" rows={state.result.distribution.stages} />
            <DistTable title="Source mix" rows={state.result.distribution.sources} />
            <DistTable title="Channel mix" rows={state.result.distribution.channels} />
            <DistTable
              title="Leakage signals"
              rows={state.result.distribution.leakageSignals}
            />
            {Object.keys(state.result.distribution.lostReasons).length > 0 && (
              <DistTable
                title="Lost reasons"
                rows={state.result.distribution.lostReasons}
              />
            )}

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
          Load demo data is for stress testing, profiling, and large
          sales demos. It is NOT real customer data. Reset removes
          only rows tagged{' '}
          <code className="text-[10px]">demo_seed_type=&apos;load&apos;</code>{' '}
          — the hand-crafted 24-lead GTM-0A demo and real venue data
          are never touched.
        </p>
      </CardContent>
    </Card>
  )
}
