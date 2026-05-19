'use client'

import { useEffect, useState } from 'react'
import { Loader2, Mail, CheckCircle2, AlertTriangle } from 'lucide-react'
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardSubtitle,
} from '@/components/dashboard/ui/Card'
import { Button } from '@/components/dashboard/ui/Button'
import { Badge } from '@/components/dashboard/ui/Badge'

/**
 * Phase 8T → 8U — admin/owner-only daily digest preference card.
 *
 * Phase 8U switches the underlying API from venue-level subscription
 * metadata to per-user `venue_members.metadata`. The card now:
 *
 *   - Reads `cadence` + `weekly_day` + `source` from
 *     `GET /api/admin/digest/preferences`.
 *   - Shows a source badge so the operator knows whether they're
 *     looking at their own preference, the venue fallback, the
 *     legacy disabled flag, or the global default.
 *   - When the user picks "Weekly", a second select appears for the
 *     day of week. Defaults to Monday.
 *   - Save writes back to `POST` with `{ cadence, weekly_day }`.
 *
 * Parent page enforces the role gate; the card also handles 401/403
 * defensively from the API.
 */

type Cadence = 'daily' | 'weekly' | 'off'
type WeeklyDay = 'sun' | 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat'
type Source = 'member' | 'subscription' | 'legacy_disabled' | 'default'

const CADENCE_OPTIONS: ReadonlyArray<{ value: Cadence; label: string; help: string }> = [
  {
    value: 'daily',
    label: 'Daily summaries',
    help: 'One email each morning (8am UTC) summarizing the last 24h of tour activity.',
  },
  {
    value: 'weekly',
    label: 'Weekly summaries',
    help: 'One email each week, on the day you choose below (UTC), summarizing the last 24h.',
  },
  {
    value: 'off',
    label: 'Off',
    help: 'No activity summary emails for your account. You can still view the activity feed below.',
  },
]

const WEEKLY_DAY_OPTIONS: ReadonlyArray<{ value: WeeklyDay; label: string }> = [
  { value: 'sun', label: 'Sunday' },
  { value: 'mon', label: 'Monday' },
  { value: 'tue', label: 'Tuesday' },
  { value: 'wed', label: 'Wednesday' },
  { value: 'thu', label: 'Thursday' },
  { value: 'fri', label: 'Friday' },
  { value: 'sat', label: 'Saturday' },
]

const SOURCE_LABELS: Record<Source, { label: string; variant: 'navy' | 'blue' | 'default' }> = {
  member:           { label: 'Using your preference',    variant: 'navy' },
  subscription:     { label: 'Using venue fallback',     variant: 'blue' },
  legacy_disabled:  { label: 'Using legacy opt-out',     variant: 'default' },
  default:          { label: 'Using default',            variant: 'default' },
}

interface PreferencesResponseBody {
  cadence?: string
  weekly_day?: string | null
  source?: string
}

type FetchState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; cadence: Cadence; weeklyDay: WeeklyDay; source: Source }

type SaveState =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'saved' }
  | { kind: 'error'; message: string }

function coerceCadence(raw: unknown): Cadence {
  if (raw === 'daily' || raw === 'weekly' || raw === 'off') return raw
  return 'daily'
}
function coerceWeeklyDay(raw: unknown): WeeklyDay {
  if (
    raw === 'sun' || raw === 'mon' || raw === 'tue' || raw === 'wed' ||
    raw === 'thu' || raw === 'fri' || raw === 'sat'
  ) return raw
  return 'mon'
}
function coerceSource(raw: unknown): Source {
  if (
    raw === 'member' || raw === 'subscription' ||
    raw === 'legacy_disabled' || raw === 'default'
  ) return raw
  return 'default'
}

export default function DigestPreferencesCard() {
  const [state, setState] = useState<FetchState>({ kind: 'loading' })
  const [draftCadence, setDraftCadence] = useState<Cadence>('daily')
  const [draftWeeklyDay, setDraftWeeklyDay] = useState<WeeklyDay>('mon')
  const [save, setSave] = useState<SaveState>({ kind: 'idle' })
  const [reloadTick, setReloadTick] = useState(0)

  useEffect(() => {
    let cancelled = false
    const abort = new AbortController()
    setState({ kind: 'loading' })
    ;(async () => {
      try {
        const res = await fetch('/api/admin/digest/preferences', {
          method: 'GET',
          signal: abort.signal,
          credentials: 'same-origin',
        })
        if (cancelled) return
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { error?: unknown } | null
          const code =
            body && typeof body.error === 'string' ? body.error : `HTTP ${res.status}`
          setState({ kind: 'error', message: code })
          return
        }
        const body = (await res.json()) as PreferencesResponseBody
        const cadence = coerceCadence(body.cadence)
        const weeklyDay = coerceWeeklyDay(body.weekly_day)
        const source = coerceSource(body.source)
        setState({ kind: 'ready', cadence, weeklyDay, source })
        setDraftCadence(cadence)
        setDraftWeeklyDay(weeklyDay)
      } catch (err) {
        if (cancelled) return
        if (err instanceof DOMException && err.name === 'AbortError') return
        setState({
          kind: 'error',
          message: err instanceof Error ? err.message : 'Network error',
        })
      }
    })()
    return () => {
      cancelled = true
      abort.abort()
    }
  }, [reloadTick])

  async function handleSave() {
    if (state.kind !== 'ready') return
    const cadenceChanged = draftCadence !== state.cadence
    const dayChanged = draftCadence === 'weekly' && draftWeeklyDay !== state.weeklyDay
    if (!cadenceChanged && !dayChanged) {
      setSave({ kind: 'saved' })
      setTimeout(() => setSave({ kind: 'idle' }), 1500)
      return
    }
    setSave({ kind: 'saving' })
    try {
      const body: { cadence: Cadence; weekly_day?: WeeklyDay } = {
        cadence: draftCadence,
      }
      if (draftCadence === 'weekly') body.weekly_day = draftWeeklyDay
      const res = await fetch('/api/admin/digest/preferences', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        const errBody = (await res.json().catch(() => null)) as { error?: unknown } | null
        const code =
          errBody && typeof errBody.error === 'string' ? errBody.error : `HTTP ${res.status}`
        setSave({ kind: 'error', message: code })
        return
      }
      setSave({ kind: 'saved' })
      setReloadTick((n) => n + 1)
      setTimeout(() => setSave((s) => (s.kind === 'saved' ? { kind: 'idle' } : s)), 2000)
    } catch (err) {
      setSave({
        kind: 'error',
        message: err instanceof Error ? err.message : 'Network error',
      })
    }
  }

  const ready = state.kind === 'ready' ? state : null
  const dirty = ready
    ? draftCadence !== ready.cadence ||
      (draftCadence === 'weekly' && draftWeeklyDay !== ready.weeklyDay)
    : false
  const saving = save.kind === 'saving'

  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Activity digest</CardTitle>
          <CardSubtitle>
            This setting applies to your user account for this venue.
          </CardSubtitle>
        </div>
        <div className="shrink-0 flex items-center gap-2">
          {ready && (
            <Badge variant={SOURCE_LABELS[ready.source].variant}>
              {SOURCE_LABELS[ready.source].label}
            </Badge>
          )}
          <div className="w-9 h-9 rounded-xl bg-[#EFF6FF] border border-[#BFDBFE] flex items-center justify-center">
            <Mail className="w-4 h-4 text-[#1D4ED8]" />
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {state.kind === 'loading' && (
          <div className="flex items-center gap-2 text-[13px] text-[#475569] py-3">
            <Loader2 className="w-4 h-4 animate-spin" />
            Loading current preference…
          </div>
        )}

        {state.kind === 'error' && (
          <div className="rounded-lg bg-[#FEF2F2] border border-[#FECACA] px-3 py-2.5 text-[12px] text-[#B91C1C] mb-3 flex items-start gap-2">
            <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
            <div className="flex-1 min-w-0">
              <p>Couldn&apos;t load digest preferences: {state.message}</p>
              <button
                type="button"
                onClick={() => setReloadTick((n) => n + 1)}
                className="mt-1 text-[#B91C1C] underline hover:no-underline"
              >
                Retry
              </button>
            </div>
          </div>
        )}

        {ready && (
          <>
            <fieldset className="space-y-2">
              <legend className="sr-only">Activity digest cadence</legend>
              {CADENCE_OPTIONS.map((opt) => {
                const checked = draftCadence === opt.value
                return (
                  <label
                    key={opt.value}
                    className={`flex items-start gap-3 rounded-xl border px-3 py-2.5 cursor-pointer transition-colors ${
                      checked
                        ? 'border-[#1D4ED8] bg-[#EFF6FF]'
                        : 'border-[#E2E8F0] bg-white hover:border-[#CBD5E1] hover:bg-[#F8FAFC]'
                    }`}
                  >
                    <input
                      type="radio"
                      name="digest_cadence"
                      value={opt.value}
                      checked={checked}
                      onChange={() => {
                        setDraftCadence(opt.value)
                        if (save.kind === 'saved' || save.kind === 'error') {
                          setSave({ kind: 'idle' })
                        }
                      }}
                      className="mt-1 accent-[#1D4ED8]"
                    />
                    <div className="flex-1 min-w-0">
                      <p className="text-[13px] font-semibold text-[#0F172A]">{opt.label}</p>
                      <p className="text-[11px] text-[#64748B] mt-0.5">{opt.help}</p>
                    </div>
                  </label>
                )
              })}
            </fieldset>

            {/* Phase 8U — weekly day picker. Only renders when the
                operator has Weekly selected, mirroring the cron's
                semantics (the day-of-week is irrelevant otherwise). */}
            {draftCadence === 'weekly' && (
              <label className="mt-3 inline-flex items-center gap-2 text-[12px] text-[#475569]">
                <span className="text-[#94A3B8]">Send on</span>
                <select
                  value={draftWeeklyDay}
                  onChange={(e) => {
                    setDraftWeeklyDay(e.target.value as WeeklyDay)
                    if (save.kind === 'saved' || save.kind === 'error') {
                      setSave({ kind: 'idle' })
                    }
                  }}
                  className="rounded-lg border border-[#E2E8F0] bg-white px-2.5 py-1 text-[12px] text-[#0F172A] focus:outline-none focus:ring-2 focus:ring-[#3B82F6]/30 focus:border-[#1D4ED8]"
                >
                  {WEEKLY_DAY_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
                <span className="text-[#94A3B8]">(UTC)</span>
              </label>
            )}

            <div className="mt-4 flex items-center gap-2.5">
              <Button
                variant="primary"
                size="sm"
                onClick={handleSave}
                disabled={saving || (!dirty && save.kind !== 'error')}
              >
                {saving ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : save.kind === 'saved' ? (
                  <CheckCircle2 className="w-3.5 h-3.5" />
                ) : null}
                {saving ? 'Saving…' : save.kind === 'saved' ? 'Saved' : 'Save preference'}
              </Button>
              {save.kind === 'saved' && (
                <span className="text-[11px] text-[#059669]">
                  Digest preference updated.
                </span>
              )}
              {save.kind === 'error' && (
                <span className="text-[11px] text-[#B91C1C]">
                  Couldn&apos;t save: {save.message}
                </span>
              )}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  )
}
