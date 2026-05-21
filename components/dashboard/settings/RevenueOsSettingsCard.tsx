'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Gauge,
  Loader2,
  AlertTriangle,
  CheckCircle2,
} from 'lucide-react'
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardSubtitle,
} from '@/components/dashboard/ui/Card'
import { Badge } from '@/components/dashboard/ui/Badge'
import { Button } from '@/components/dashboard/ui/Button'
import {
  DEFAULT_REVENUE_OS_SETTINGS,
  REVENUE_OS_CLAMP_BOUNDS,
  type RevenueOsSettings,
} from '@/lib/revenue-os/settings'

/**
 * Phase 8AQ — Revenue OS settings card.
 *
 * Admin-only surface on /dashboard/settings/billing. Four numeric
 * inputs map directly to `lib/revenue-os/settings.ts`:
 *
 *   - first reply SLA (minutes)
 *   - high-fit threshold (lead score)
 *   - stale high-fit window (hours)
 *   - cold-lead recovery window (days)
 *
 * Reads/writes via /api/admin/revenue-os/settings (Phase 8AQ admin
 * route). The route clamps every field defensively, so even a
 * hand-crafted curl can't smuggle a junk value past the read path.
 *
 * Page-level `isAdmin` gate surrounds this card; the endpoint also
 * enforces requireAdmin() so non-admins see 401/403 on the network
 * call.
 */

type FetchState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | {
      kind: 'ready'
      settings: RevenueOsSettings
      source: 'venue_metadata' | 'default'
    }

type SaveState =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'saved' }
  | { kind: 'error'; message: string }

// Phase 8AV — narrow the key type so we can keep this list strictly
// numeric (the mode select is rendered separately below).
type NumericSettingKey =
  | 'firstReplySlaMinutes'
  | 'highFitThreshold'
  | 'staleHighFitHours'
  | 'coldLeadDays'
  | 'brandVoiceConfidenceFloor'
  | 'tourDurationMinutes'
  | 'tourBufferMinutes'

const FIELDS: ReadonlyArray<{
  key: NumericSettingKey
  label: string
  help: string
  unit: string
}> = [
  {
    key: 'firstReplySlaMinutes',
    label: 'First reply SLA',
    help: 'New inquiries waiting longer than this with no outbound reply trigger the "slow first reply" leakage signal.',
    unit: 'minutes',
  },
  {
    key: 'highFitThreshold',
    label: 'High-fit threshold',
    help: 'Lead score at or above this counts as a high-fit lead for leakage signals.',
    unit: 'score',
  },
  {
    key: 'staleHighFitHours',
    label: 'Stale high-fit window',
    help: 'A high-fit lead with no activity for this many hours is surfaced as "high-fit idle".',
    unit: 'hours',
  },
  {
    key: 'coldLeadDays',
    label: 'Cold lead recovery window',
    help: 'An in-flight lead with no inbound message for this many days is surfaced for recovery.',
    unit: 'days',
  },
  {
    // Phase 8AV — Brand Voice floor. 0..100 score. Below this an AI
    // draft variant surfaces the "Low confidence" chip in the
    // LeadDetailDrawer + the escalation gate behaves per mode.
    key: 'brandVoiceConfidenceFloor',
    label: 'Brand voice confidence floor',
    help: 'AI draft variants scoring below this need operator review. The escalation mode below decides whether Approve & send is blocked.',
    unit: 'score',
  },
  {
    // Phase 8BC — default tour duration. Used when the
    // TourReadinessPanel generates slot suggestions + when the
    // ScheduleTourDrawer initializes its duration field. Operator
    // can still override per tour from the drawer.
    key: 'tourDurationMinutes',
    label: 'Default tour duration',
    help: 'Used when suggesting tour windows.',
    unit: 'minutes',
  },
  {
    // Phase 8BC — buffer time between tours. Extends each existing
    // tour's end by this much during the conflict check so two
    // tours aren't suggested back-to-back.
    key: 'tourBufferMinutes',
    label: 'Buffer time between tours',
    help: 'Buffer prevents back-to-back tours from being suggested too tightly.',
    unit: 'minutes',
  },
]

// Phase 8AV — escalation mode options (separate from the numeric
// fields because it's an enum + needs different UI controls).
const ESCALATION_MODES: ReadonlyArray<{
  value: 'off' | 'warn' | 'block'
  label: string
  help: string
}> = [
  {
    value: 'off',
    label: 'Visibility only',
    help: 'Show the low-confidence chip in the draft drawer but never block Approve & send.',
  },
  {
    value: 'warn',
    label: 'Warn operator',
    help: 'Show the chip + a soft "Operator approval recommended" line. Approve & send stays clickable.',
  },
  {
    value: 'block',
    label: 'Require regenerate or edit',
    help: 'Hard-block Approve & send until the operator regenerates, saves an edit, or picks a higher-confidence variant.',
  },
]

function clampForUi(
  key: NumericSettingKey,
  value: number
): number {
  const b = REVENUE_OS_CLAMP_BOUNDS[key]
  if (!Number.isFinite(value)) return DEFAULT_REVENUE_OS_SETTINGS[key]
  return Math.max(b.min, Math.min(b.max, Math.round(value)))
}

export default function RevenueOsSettingsCard() {
  const [state, setState] = useState<FetchState>({ kind: 'loading' })
  const [draft, setDraft] = useState<RevenueOsSettings>(
    DEFAULT_REVENUE_OS_SETTINGS
  )
  const [save, setSave] = useState<SaveState>({ kind: 'idle' })
  const [reloadTick, setReloadTick] = useState(0)

  useEffect(() => {
    let cancelled = false
    setState({ kind: 'loading' })
    ;(async () => {
      try {
        const res = await fetch('/api/admin/revenue-os/settings', {
          credentials: 'same-origin',
        })
        if (cancelled) return
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as
            | { error?: string }
            | null
          setState({
            kind: 'error',
            message: body?.error ?? `HTTP ${res.status}`,
          })
          return
        }
        const body = (await res.json()) as {
          settings: RevenueOsSettings
          source: 'venue_metadata' | 'default'
        }
        setState({
          kind: 'ready',
          settings: body.settings,
          source: body.source,
        })
        setDraft(body.settings)
      } catch (err) {
        if (cancelled) return
        setState({
          kind: 'error',
          message: err instanceof Error ? err.message : 'Network error',
        })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [reloadTick])

  const dirty = useMemo(() => {
    if (state.kind !== 'ready') return false
    return (
      draft.firstReplySlaMinutes !== state.settings.firstReplySlaMinutes ||
      draft.highFitThreshold !== state.settings.highFitThreshold ||
      draft.staleHighFitHours !== state.settings.staleHighFitHours ||
      draft.coldLeadDays !== state.settings.coldLeadDays ||
      // Phase 8AV — brand voice fields were rendered + edited but
      // never included in the dirty check, so the Save button stayed
      // disabled when ONLY a brand-voice setting changed. Fixed here
      // alongside the 8BC additions.
      draft.brandVoiceConfidenceFloor !==
        state.settings.brandVoiceConfidenceFloor ||
      draft.brandVoiceEscalationMode !==
        state.settings.brandVoiceEscalationMode ||
      // Phase 8BC — tour duration + buffer.
      draft.tourDurationMinutes !== state.settings.tourDurationMinutes ||
      draft.tourBufferMinutes !== state.settings.tourBufferMinutes
    )
  }, [state, draft])

  const handleSave = useCallback(async () => {
    if (state.kind !== 'ready' || !dirty) return
    setSave({ kind: 'saving' })
    try {
      const res = await fetch('/api/admin/revenue-os/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          settings: {
            firstReplySlaMinutes: draft.firstReplySlaMinutes,
            highFitThreshold: draft.highFitThreshold,
            staleHighFitHours: draft.staleHighFitHours,
            coldLeadDays: draft.coldLeadDays,
            // Phase 8AV — include brand voice fields so the Save
            // button actually persists them. Pre-existing gap; fixed
            // here to keep the save body honest.
            brandVoiceConfidenceFloor: draft.brandVoiceConfidenceFloor,
            brandVoiceEscalationMode: draft.brandVoiceEscalationMode,
            // Phase 8BC — tour duration + buffer feed the
            // TourReadinessPanel slot-suggestion helper.
            tourDurationMinutes: draft.tourDurationMinutes,
            tourBufferMinutes: draft.tourBufferMinutes,
          },
        }),
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as
          | { error?: string }
          | null
        setSave({
          kind: 'error',
          message: body?.error ?? `HTTP ${res.status}`,
        })
        return
      }
      const body = (await res.json()) as { settings: RevenueOsSettings }
      // Adopt the server-clamped values so the inputs reflect any
      // clamps the route applied.
      setState({
        kind: 'ready',
        settings: body.settings,
        source: 'venue_metadata',
      })
      setDraft(body.settings)
      setSave({ kind: 'saved' })
      setTimeout(
        () => setSave((s) => (s.kind === 'saved' ? { kind: 'idle' } : s)),
        1800
      )
    } catch (err) {
      setSave({
        kind: 'error',
        message: err instanceof Error ? err.message : 'Network error',
      })
    }
  }, [state, draft, dirty])

  const handleReset = useCallback(() => {
    if (state.kind !== 'ready') return
    setDraft(DEFAULT_REVENUE_OS_SETTINGS)
  }, [state])

  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Revenue OS thresholds</CardTitle>
          <CardSubtitle>
            These settings power Revenue Leakage Watch and Speed-to-Lead
            scoring.
          </CardSubtitle>
        </div>
        <div className="shrink-0 flex items-center gap-2">
          {state.kind === 'ready' && (
            <Badge variant={state.source === 'venue_metadata' ? 'navy' : 'default'}>
              {state.source === 'venue_metadata'
                ? 'Custom for this venue'
                : 'Using defaults'}
            </Badge>
          )}
          <div className="w-9 h-9 rounded-xl bg-[#EFF6FF] border border-[#BFDBFE] flex items-center justify-center">
            <Gauge className="w-4 h-4 text-[#1D4ED8]" />
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {state.kind === 'loading' && (
          <div className="flex items-center gap-2 text-[13px] text-[#475569] py-3">
            <Loader2 className="w-4 h-4 animate-spin" />
            Loading Revenue OS thresholds…
          </div>
        )}

        {state.kind === 'error' && (
          <div className="rounded-lg bg-[#FEF2F2] border border-[#FECACA] px-3 py-2.5 text-[12px] text-[#B91C1C] mb-3 flex items-start gap-2">
            <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
            <div className="flex-1 min-w-0">
              <p>
                Couldn&apos;t load Revenue OS thresholds: {state.message}
              </p>
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

        {state.kind === 'ready' && (
          <>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-4">
              {FIELDS.map((f) => {
                const bounds = REVENUE_OS_CLAMP_BOUNDS[f.key]
                const value = draft[f.key]
                return (
                  <label key={f.key} className="block">
                    <div className="flex items-center justify-between gap-2 mb-1">
                      <span className="text-[12.5px] font-semibold text-[#0F172A]">
                        {f.label}
                      </span>
                      <span className="text-[10.5px] uppercase tracking-[0.14em] text-[#94A3B8] font-semibold">
                        {f.unit}
                      </span>
                    </div>
                    <input
                      type="number"
                      min={bounds.min}
                      max={bounds.max}
                      step={1}
                      value={value}
                      onChange={(e) =>
                        setDraft((prev) => ({
                          ...prev,
                          [f.key]: clampForUi(f.key, Number(e.target.value)),
                        }))
                      }
                      className="w-full rounded-lg border border-[#E2E8F0] bg-white px-3 py-2 text-[13px] text-[#0F172A] focus:outline-none focus:ring-2 focus:ring-[#3B82F6]/30 focus:border-[#1D4ED8]"
                    />
                    <p className="mt-1 text-[10.5px] text-[#64748B] leading-snug">
                      {f.help}{' '}
                      <span className="text-[#94A3B8]">
                        (range {bounds.min}–{bounds.max})
                      </span>
                    </p>
                  </label>
                )
              })}
            </div>

            {/* Phase 8AV — Brand Voice escalation mode. Lives in its
                own row so the operator reads it as a related but
                separate decision from the floor threshold. */}
            <div className="mb-4">
              <div className="flex items-center justify-between gap-2 mb-1">
                <span className="text-[12.5px] font-semibold text-[#0F172A]">
                  Brand voice escalation
                </span>
                <span className="text-[10.5px] uppercase tracking-[0.14em] text-[#94A3B8] font-semibold">
                  mode
                </span>
              </div>
              <div className="flex flex-col sm:flex-row gap-2">
                {ESCALATION_MODES.map((opt) => {
                  const active = draft.brandVoiceEscalationMode === opt.value
                  return (
                    <label
                      key={opt.value}
                      className={`flex-1 cursor-pointer rounded-lg border px-3 py-2.5 transition-colors ${
                        active
                          ? 'border-[#1D4ED8] bg-[#EFF6FF]'
                          : 'border-[#E2E8F0] bg-white hover:bg-[#F8FAFC]'
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <input
                          type="radio"
                          name="brand-voice-mode"
                          value={opt.value}
                          checked={active}
                          onChange={() =>
                            setDraft((prev) => ({
                              ...prev,
                              brandVoiceEscalationMode: opt.value,
                            }))
                          }
                          className="accent-[#1D4ED8]"
                        />
                        <span
                          className={`text-[12.5px] font-semibold ${
                            active ? 'text-[#0F172A]' : 'text-[#0F172A]'
                          }`}
                        >
                          {opt.label}
                        </span>
                      </div>
                      <p className="mt-1 text-[10.5px] text-[#64748B] leading-snug">
                        {opt.help}
                      </p>
                    </label>
                  )
                })}
              </div>
            </div>

            <div className="flex items-center gap-2 flex-wrap">
              <Button
                size="sm"
                onClick={handleSave}
                disabled={!dirty || save.kind === 'saving'}
              >
                {save.kind === 'saving' ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : null}
                Save changes
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={handleReset}
                disabled={save.kind === 'saving'}
              >
                Reset to defaults
              </Button>
              {save.kind === 'saved' && (
                <span className="inline-flex items-center gap-1 text-[11.5px] text-[#047857]">
                  <CheckCircle2 className="w-3.5 h-3.5" />
                  Saved
                </span>
              )}
              {save.kind === 'error' && (
                <span className="text-[11.5px] text-[#B91C1C]">
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
