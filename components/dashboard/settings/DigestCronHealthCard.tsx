'use client'

import { useCallback, useEffect, useState } from 'react'
import { Loader2, RefreshCw, AlertTriangle, CheckCircle2, Clock } from 'lucide-react'
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardSubtitle,
} from '@/components/dashboard/ui/Card'

/**
 * Phase 8AB — DigestCronHealthCard
 *
 * Compact health indicator for the Phase 8R operator-activity-digest
 * cron. Backed by `/api/admin/digest/cron-health`, which infers
 * status from the most-recent `cron`-tagged outbound digest row
 * inside a 72h window.
 *
 * Important: this is a delivery-derived heuristic, NOT an Inngest
 * run-history check. A `no_data` status can be perfectly normal for
 * a venue that hadn't had any tour activity in the last 24h (the
 * cron skips zero-event venues). The card explicitly says so to
 * prevent operator misreads.
 */

interface CronHealthBody {
  venue_id: string
  ok: boolean
  last_run_at: string | null
  lag_minutes: number | null
  status: 'ok' | 'stale' | 'no_data'
  expected_schedule: string
  last_summary: {
    status: string | null
    event_count: number | null
    recipient_user_id: string | null
    cadence: string | null
    weekly_day: string | null
  } | null
}

type FetchState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; body: CronHealthBody }

function formatLag(minutes: number | null): string {
  if (minutes === null) return '—'
  if (minutes < 90) return `${minutes} min`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours} hr`
  const days = Math.round(hours / 24)
  return `${days} d`
}

function formatTime(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

interface StatusVisual {
  pillClass: string
  Icon: typeof CheckCircle2
  iconClass: string
  headline: string
  body: string
}

function visualForStatus(status: CronHealthBody['status']): StatusVisual {
  switch (status) {
    case 'ok':
      return {
        pillClass: 'bg-[#ECFDF5] text-[#047857] border-[#A7F3D0]',
        Icon: CheckCircle2,
        iconClass: 'text-[#047857]',
        headline: 'Digest cron looks healthy',
        body: 'A scheduled digest was recorded for this venue recently.',
      }
    case 'stale':
      return {
        pillClass: 'bg-[#FEF2F2] text-[#B91C1C] border-[#FECACA]',
        Icon: AlertTriangle,
        iconClass: 'text-[#B91C1C]',
        headline: 'Digest cron may be stale',
        body: "The most recent scheduled digest is older than expected. Check the Inngest dashboard for run history.",
      }
    case 'no_data':
      return {
        pillClass: 'bg-[#FFFBEB] text-[#B45309] border-[#FDE68A]',
        Icon: Clock,
        iconClass: 'text-[#B45309]',
        headline: 'No recent digest send found',
        body: 'This can be normal if the venue had no tour activity recently. The cron skips zero-event venues.',
      }
  }
}

// Phase 8AD — cron-fired toast auto-dismiss window. 4s matches the
// existing RealtimeToast cadence elsewhere; long enough for an
// operator to register the visual signal, short enough to clear
// before the next cron tick (worst case: 1/minute on a misbehaving
// cron) so the toast doesn't pile up.
const CRON_FIRED_TOAST_MS = 4000

export default function DigestCronHealthCard() {
  const [state, setState] = useState<FetchState>({ kind: 'loading' })
  // Phase 8AD — inline cron-fired toast. Surfaces "Digest cron just
  // ran." right below the card title for ~4s after every
  // `venuerise:digest-cron-fired` event. Card-local (no global
  // toast dependency); shares the same listener that triggers the
  // health refetch.
  const [cronFiredToast, setCronFiredToast] = useState<boolean>(false)

  const fetchHealth = useCallback(async (signal?: AbortSignal) => {
    setState((prev) => (prev.kind === 'ready' ? prev : { kind: 'loading' }))
    try {
      const res = await fetch('/api/admin/digest/cron-health', {
        method: 'GET',
        signal,
        credentials: 'same-origin',
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: unknown } | null
        const code =
          body && typeof body.error === 'string' ? body.error : `HTTP ${res.status}`
        setState({ kind: 'error', message: code })
        return
      }
      const body = (await res.json()) as CronHealthBody
      setState({ kind: 'ready', body })
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return
      setState({
        kind: 'error',
        message: err instanceof Error ? err.message : 'Network error',
      })
    }
  }, [])

  useEffect(() => {
    const abort = new AbortController()
    fetchHealth(abort.signal)
    return () => abort.abort()
  }, [fetchHealth])

  // Phase 8AC — listen for `venuerise:digest-cron-fired` events
  // dispatched by RealtimeDigestSendsLayer on cron INSERTs. Refetch
  // the health snapshot so the lag counter + "last run" timestamp
  // update without a manual click.
  //
  // Phase 8AD — also surface a small auto-dismissing inline toast so
  // the operator sees the trigger event, not just the refreshed
  // numbers. Keeps the toast card-local (no global RealtimeToast
  // dependency) — sits right under the card header.
  useEffect(() => {
    let dismissHandle: ReturnType<typeof setTimeout> | null = null
    const handler = () => {
      fetchHealth()
      setCronFiredToast(true)
      if (dismissHandle) clearTimeout(dismissHandle)
      dismissHandle = setTimeout(() => {
        setCronFiredToast(false)
        dismissHandle = null
      }, CRON_FIRED_TOAST_MS)
    }
    window.addEventListener('venuerise:digest-cron-fired', handler)
    return () => {
      window.removeEventListener('venuerise:digest-cron-fired', handler)
      if (dismissHandle) {
        clearTimeout(dismissHandle)
      }
    }
  }, [fetchHealth])

  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Digest cron health</CardTitle>
          <CardSubtitle>
            Inferred from the most recent scheduled digest send for this venue.
          </CardSubtitle>
        </div>
        <div className="shrink-0 flex items-center gap-2">
          <button
            type="button"
            onClick={() => fetchHealth()}
            className="inline-flex items-center gap-1.5 text-[12px] text-[#475569] hover:text-[#0F172A] px-2 py-1 rounded-lg hover:bg-[#F1F5F9]"
            title="Re-check cron health"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            Refresh
          </button>
        </div>
      </CardHeader>
      <CardContent>
        {/* Phase 8AD — inline cron-fired notice. Renders only when
            the realtime layer just dispatched a cron event; auto-
            clears after CRON_FIRED_TOAST_MS. CheckCircle2 reused
            from the success-state visuals so the icon vocabulary
            stays consistent. */}
        {cronFiredToast && (
          <div className="mb-3 rounded-lg bg-[#ECFDF5] border border-[#A7F3D0] px-3 py-2 text-[12px] text-[#047857] flex items-center gap-2">
            <CheckCircle2 className="w-3.5 h-3.5" />
            Digest cron just ran.
          </div>
        )}
        {state.kind === 'loading' && (
          <div className="flex items-center gap-2 text-[13px] text-[#475569] py-3">
            <Loader2 className="w-4 h-4 animate-spin" />
            Checking cron health…
          </div>
        )}

        {state.kind === 'error' && (
          <div className="rounded-lg bg-[#FEF2F2] border border-[#FECACA] px-3 py-2.5 text-[12px] text-[#B91C1C] flex items-start gap-2">
            <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
            <div className="flex-1 min-w-0">
              <p>Couldn&apos;t load cron health: {state.message}</p>
              <button
                type="button"
                onClick={() => fetchHealth()}
                className="mt-1 text-[#B91C1C] underline hover:no-underline"
              >
                Retry
              </button>
            </div>
          </div>
        )}

        {state.kind === 'ready' && (() => {
          const visual = visualForStatus(state.body.status)
          const { Icon } = visual
          return (
            <div className="space-y-3">
              <div className="flex items-start gap-2.5">
                <div
                  className={`w-8 h-8 rounded-xl flex items-center justify-center border ${visual.pillClass}`}
                >
                  <Icon className={`w-4 h-4 ${visual.iconClass}`} />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-[13px] font-semibold text-[#0F172A]">
                    {visual.headline}
                  </p>
                  <p className="text-[12px] text-[#475569] mt-0.5">
                    {visual.body}
                  </p>
                </div>
              </div>

              <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-[12px]">
                <div className="flex justify-between gap-3">
                  <dt className="text-[#94A3B8]">Expected</dt>
                  <dd className="text-[#475569]">{state.body.expected_schedule}</dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-[#94A3B8]">Last cron send</dt>
                  <dd className="text-[#0F172A]">
                    {formatTime(state.body.last_run_at)}
                  </dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-[#94A3B8]">Lag</dt>
                  <dd className="text-[#475569]">
                    {formatLag(state.body.lag_minutes)}
                  </dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-[#94A3B8]">Last status</dt>
                  <dd className="text-[#475569]">
                    {state.body.last_summary?.status ?? '—'}
                  </dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-[#94A3B8]">Event count</dt>
                  <dd className="text-[#475569]">
                    {state.body.last_summary?.event_count ?? '—'}
                  </dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-[#94A3B8]">Cadence</dt>
                  <dd className="text-[#475569]">
                    {state.body.last_summary?.cadence ?? '—'}
                    {state.body.last_summary?.cadence === 'weekly' &&
                    state.body.last_summary.weekly_day
                      ? ` · ${state.body.last_summary.weekly_day}`
                      : ''}
                  </dd>
                </div>
              </dl>

              <p className="text-[11px] text-[#94A3B8]">
                Heuristic — inferred from delivery rows, not Inngest run history.
                For unambiguous cron telemetry use the Inngest dashboard.
              </p>
            </div>
          )
        })()}
      </CardContent>
    </Card>
  )
}
