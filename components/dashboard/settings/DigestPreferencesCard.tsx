'use client'

import { useEffect, useRef, useState } from 'react'
import { Loader2, Mail, CheckCircle2, AlertTriangle, Send, MailCheck } from 'lucide-react'
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

// Phase 8Y — member picker types. The shape mirrors the
// /api/admin/digest/members response. `can_receive_digest` is `false`
// for members with no resolvable auth.users.email — the picker shows
// them but disables the option so the operator sees the gap rather
// than wondering why some members are missing.
interface MemberRow {
  user_id: string
  role: 'owner' | 'admin'
  email: string | null
  can_receive_digest: boolean
  is_current_user: boolean
}

type MembersState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; items: MemberRow[] }

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
  // Phase 8V — Send sample state. Distinct from `save` so a save +
  // a preview can transition independently without one stomping the
  // other's feedback message.
  const [preview, setPreview] = useState<SaveState>({ kind: 'idle' })
  // Phase 8X → 8Y — Send manual digest state. Distinct from preview so
  // the two surfaces can transition independently. Phase 8Y added the
  // member picker so manual sends can target another owner/admin
  // member of the venue; the picker state lives below.
  const [manual, setManual] = useState<SaveState>({ kind: 'idle' })
  // Phase 8Y — member picker. Defaults to current user; when the venue
  // has only one owner/admin member the UI collapses to "Sending to
  // you" without a select. Honor cadence toggle defaults to false
  // (bypass cadence) — the standard "send it now" UX. Operators QAing
  // weekly-day scheduling can flip it on to dry-run "would today's
  // cron send to this person?".
  const [members, setMembers] = useState<MembersState>({ kind: 'loading' })
  const [selectedRecipientId, setSelectedRecipientId] = useState<string | null>(null)
  const [respectCadence, setRespectCadence] = useState<boolean>(false)

  // Phase 8AK — CommandPalette "Send sample digest" deep-link.
  // When the URL contains `?digest_action=sample` (set by clicking the
  // palette quick action) we scroll the card into view and apply a
  // short-lived highlight ring so the operator's eye lands on the right
  // surface. We DON'T auto-fire `handleSendSample` — the operator still
  // has to confirm by clicking the button. After consuming the param we
  // strip it from the URL via history.replaceState so a page refresh
  // doesn't re-trigger the scroll/highlight.
  const cardRootRef = useRef<HTMLDivElement | null>(null)
  const [highlighted, setHighlighted] = useState(false)
  useEffect(() => {
    if (typeof window === 'undefined') return
    const params = new URLSearchParams(window.location.search)
    if (params.get('digest_action') !== 'sample') return
    // Scroll the card into view on next paint so the Card has mounted.
    const t1 = setTimeout(() => {
      cardRootRef.current?.scrollIntoView({
        behavior: 'smooth',
        block: 'start',
      })
      setHighlighted(true)
    }, 60)
    const t2 = setTimeout(() => setHighlighted(false), 2200)
    // Strip the param without disturbing the rest of the URL or the
    // browser back-stack.
    try {
      params.delete('digest_action')
      const next =
        window.location.pathname +
        (params.toString() ? `?${params.toString()}` : '') +
        window.location.hash
      window.history.replaceState({}, '', next)
    } catch {
      // history.replaceState can throw in sandbox iframes; the deep-link
      // UX still works, just the URL stays sticky.
    }
    return () => {
      clearTimeout(t1)
      clearTimeout(t2)
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    const abort = new AbortController()
    setMembers({ kind: 'loading' })
    ;(async () => {
      try {
        const res = await fetch('/api/admin/digest/members', {
          method: 'GET',
          signal: abort.signal,
          credentials: 'same-origin',
        })
        if (cancelled) return
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { error?: unknown } | null
          const code =
            body && typeof body.error === 'string' ? body.error : `HTTP ${res.status}`
          setMembers({ kind: 'error', message: code })
          return
        }
        const body = (await res.json()) as { items?: MemberRow[] }
        const items = Array.isArray(body.items) ? body.items : []
        setMembers({ kind: 'ready', items })
        // Default selection: the row marked `is_current_user`. Falls
        // back to the first receivable row if the API didn't tag one
        // (shouldn't happen — admin endpoint always marks the caller).
        const self = items.find((m) => m.is_current_user)
        const firstReceivable = items.find((m) => m.can_receive_digest)
        setSelectedRecipientId(self?.user_id ?? firstReceivable?.user_id ?? null)
      } catch (err) {
        if (cancelled) return
        if (err instanceof DOMException && err.name === 'AbortError') return
        setMembers({
          kind: 'error',
          message: err instanceof Error ? err.message : 'Network error',
        })
      }
    })()
    return () => {
      cancelled = true
      abort.abort()
    }
  }, [])

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

  // Phase 8V — send a sample digest to the current user's email so
  // they can verify cadence + template + Resend pipeline without
  // waiting for the next 8am UTC cron tick.
  //
  // Phase 8W — special-case the suppression branch (HTTP 409 with
  // `error: 'suppressed'`). Hard bounces and complaints land the
  // address on Resend's suppression list; sending again would just
  // re-trigger the same suppression. The friendlier inline copy below
  // tells the operator exactly what happened + the resolution path
  // ("contact support") instead of a raw `suppressed` token.
  async function handleSendSample() {
    if (state.kind !== 'ready') return
    setPreview({ kind: 'saving' })
    try {
      const res = await fetch('/api/admin/digest/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      if (!res.ok) {
        const errBody = (await res.json().catch(() => null)) as { error?: unknown } | null
        const code =
          errBody && typeof errBody.error === 'string' ? errBody.error : `HTTP ${res.status}`
        // Phase 8W — tag the suppressed case so the renderer can swap
        // in friendly copy without parsing error strings inline.
        if (res.status === 409 && code === 'suppressed') {
          setPreview({ kind: 'error', message: 'suppressed' })
          return
        }
        setPreview({ kind: 'error', message: code })
        return
      }
      // The endpoint returns 200 with `success: false` + a `reason`
      // field for the console-fallback dev path. Surface that cleanly
      // so the operator knows the email didn't actually fly.
      const body = (await res.json().catch(() => null)) as
        | { success?: boolean; reason?: string }
        | null
      if (body && body.success === false) {
        setPreview({ kind: 'error', message: body.reason ?? 'send_failed' })
        return
      }
      setPreview({ kind: 'saved' })
      setTimeout(
        () => setPreview((p) => (p.kind === 'saved' ? { kind: 'idle' } : p)),
        2500
      )
    } catch (err) {
      setPreview({
        kind: 'error',
        message: err instanceof Error ? err.message : 'Network error',
      })
    }
  }

  // Phase 8X → 8Y — send a MANUAL digest. Same delivery path as the
  // cron (and as preview), but the outbound row is tagged
  // `tour_digest_send_kind = 'manual'`. The Phase 8Y member picker
  // wires the selected `user_id` into the POST; the honor-cadence
  // checkbox toggles `respect_cadence`.
  //
  // Error message conventions for the renderer:
  //   - 'suppressed'        → amber friendly copy
  //   - 'skipped_off'       → amber "recipient cadence is off" copy
  //   - 'skipped_wrong_day' → amber "weekly digest not scheduled today"
  //   - anything else       → red generic error line
  async function handleSendManual() {
    if (state.kind !== 'ready') return
    setManual({ kind: 'saving' })
    try {
      const body: { user_id?: string; respect_cadence?: boolean } = {}
      // Only include user_id if we actually have a selection. If the
      // members fetch failed, fall through with no user_id — server
      // defaults to the caller.
      if (selectedRecipientId) body.user_id = selectedRecipientId
      if (respectCadence) body.respect_cadence = true

      const res = await fetch('/api/admin/digest/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        const errBody = (await res.json().catch(() => null)) as { error?: unknown } | null
        const code =
          errBody && typeof errBody.error === 'string' ? errBody.error : `HTTP ${res.status}`
        if (res.status === 409 && code === 'suppressed') {
          setManual({ kind: 'error', message: 'suppressed' })
          return
        }
        setManual({ kind: 'error', message: code })
        return
      }
      const resp = (await res.json().catch(() => null)) as
        | { success?: boolean; sent?: boolean; reason?: string }
        | null
      // Cadence-skip branch — only fires when respect_cadence === true.
      // Map the API's typed reason (`off` | `weekly_wrong_day`) onto
      // the renderer's amber-status codes.
      if (resp && resp.success === true && resp.sent === false) {
        if (resp.reason === 'off') {
          setManual({ kind: 'error', message: 'skipped_off' })
          return
        }
        if (resp.reason === 'weekly_wrong_day') {
          setManual({ kind: 'error', message: 'skipped_wrong_day' })
          return
        }
        setManual({ kind: 'error', message: resp.reason ?? 'skipped' })
        return
      }
      if (resp && resp.success === false) {
        setManual({ kind: 'error', message: resp.reason ?? 'send_failed' })
        return
      }
      setManual({ kind: 'saved' })
      setTimeout(
        () => setManual((m) => (m.kind === 'saved' ? { kind: 'idle' } : m)),
        2500
      )
    } catch (err) {
      setManual({
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
    <div
      ref={cardRootRef}
      id="digest-preferences-card"
      data-digest-card="true"
      className={
        highlighted
          ? 'rounded-2xl ring-2 ring-[#1D4ED8] ring-offset-2 ring-offset-[#F4F7FB] transition-shadow duration-300'
          : 'rounded-2xl transition-shadow duration-300'
      }
    >
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Revenue OS digest</CardTitle>
          <CardSubtitle>
            Get a daily or weekly summary of revenue leakage, tour
            momentum, and operator activity. Setting applies to your
            user account for this venue.
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
              <legend className="sr-only">Revenue OS digest cadence</legend>
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

            <div className="mt-4 flex items-center gap-2.5 flex-wrap">
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

              {/* Phase 8V — Send sample button. Disabled while the
                  cadence draft has unsaved changes so the operator
                  can't accidentally preview the OLD setting after
                  picking a new one. */}
              <Button
                variant="secondary"
                size="sm"
                onClick={handleSendSample}
                disabled={
                  preview.kind === 'saving' || dirty || saving
                }
                title={
                  dirty
                    ? 'Save changes before sending a sample.'
                    : 'Send a sample digest to your email now'
                }
              >
                {preview.kind === 'saving' ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : preview.kind === 'saved' ? (
                  <CheckCircle2 className="w-3.5 h-3.5" />
                ) : (
                  <Send className="w-3.5 h-3.5" />
                )}
                {preview.kind === 'saving'
                  ? 'Sending…'
                  : preview.kind === 'saved'
                    ? 'Sample sent'
                    : 'Send sample Revenue OS digest'}
              </Button>

              {/* Phase 8X → 8Y — Send manual digest. Same destination
                  as Send sample but the outbound row is tagged
                  `send_kind='manual'` so the cron's per-recipient
                  idempotency probe ignores it. Phase 8Y added the
                  recipient picker + honor-cadence toggle inline below
                  the button.

                  Distinct visual from sample so operators don't
                  confuse "test the template" with "actually send a
                  real digest to a mailbox right now". */}
              <Button
                variant="secondary"
                size="sm"
                onClick={handleSendManual}
                disabled={
                  manual.kind === 'saving' ||
                  preview.kind === 'saving' ||
                  dirty ||
                  saving ||
                  members.kind === 'loading' ||
                  !selectedRecipientId
                }
                title={
                  dirty
                    ? 'Save changes before sending a manual digest.'
                    : 'Send a manual digest to the selected recipient now (bypasses cron idempotency)'
                }
              >
                {manual.kind === 'saving' ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : manual.kind === 'saved' ? (
                  <CheckCircle2 className="w-3.5 h-3.5" />
                ) : (
                  <MailCheck className="w-3.5 h-3.5" />
                )}
                {manual.kind === 'saving'
                  ? 'Sending…'
                  : manual.kind === 'saved'
                    ? 'Manual digest sent'
                    : 'Send manual Revenue OS digest'}
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
              {preview.kind === 'saved' && (
                <span className="text-[11px] text-[#059669]">
                  Sample sent — check your inbox.
                </span>
              )}
              {preview.kind === 'error' && preview.message === 'suppressed' && (
                /* Phase 8W — friendly copy for the Resend suppression
                   branch. A hard bounce / complaint puts the address on
                   the suppression list; retrying just re-triggers the
                   same suppression. Direct the operator to support so
                   they can request a re-enable. */
                <span className="text-[11px] text-[#B45309] leading-snug">
                  This email address is currently suppressed by our email
                  provider, so we can&apos;t send a sample digest to it.
                  Contact support to re-enable delivery for this address.
                </span>
              )}
              {preview.kind === 'error' && preview.message !== 'suppressed' && (
                <span className="text-[11px] text-[#B91C1C]">
                  Couldn&apos;t send sample: {preview.message}
                </span>
              )}
              {/* Phase 8X — manual send status renderers. Same colour
                  conventions as preview: amber for the friendly
                  suppression branch, red for everything else, emerald
                  on success. */}
              {manual.kind === 'saved' && (
                <span className="text-[11px] text-[#059669]">
                  Manual digest sent — check your inbox.
                </span>
              )}
              {manual.kind === 'error' && manual.message === 'suppressed' && (
                <span className="text-[11px] text-[#B45309] leading-snug">
                  This email address is currently suppressed by our email
                  provider, so we can&apos;t send a manual digest to it.
                  Contact support to re-enable delivery for this address.
                </span>
              )}
              {/* Phase 8Y — `respect_cadence` skip branches. Amber
                  status rendering matches the suppression branch
                  conventions for "expected non-failure" outcomes. */}
              {manual.kind === 'error' && manual.message === 'skipped_off' && (
                <span className="text-[11px] text-[#B45309] leading-snug">
                  Skipped because this recipient&apos;s cadence is off.
                </span>
              )}
              {manual.kind === 'error' && manual.message === 'skipped_wrong_day' && (
                <span className="text-[11px] text-[#B45309] leading-snug">
                  Skipped because this recipient&apos;s weekly digest is not scheduled today.
                </span>
              )}
              {manual.kind === 'error' &&
                manual.message !== 'suppressed' &&
                manual.message !== 'skipped_off' &&
                manual.message !== 'skipped_wrong_day' && (
                  <span className="text-[11px] text-[#B91C1C]">
                    Couldn&apos;t send manual digest: {manual.message}
                  </span>
                )}
              {dirty && (
                <span className="text-[11px] text-[#94A3B8]">
                  Save changes before sending a sample or manual digest.
                </span>
              )}
            </div>

            {/* Phase 8Y — recipient picker + honor-cadence toggle.
                Lives below the action row so the buttons stay the
                primary call-to-action; the picker is a refinement.

                Collapses to "Sending to you" when the venue has only
                one receivable owner/admin member (no select element
                renders). Members with `can_receive_digest: false`
                appear in the select but are disabled — operator sees
                the gap instead of wondering why their colleague is
                missing. */}
            <DigestRecipientControls
              members={members}
              selectedRecipientId={selectedRecipientId}
              onSelectRecipient={setSelectedRecipientId}
              respectCadence={respectCadence}
              onChangeRespectCadence={setRespectCadence}
              disabled={
                manual.kind === 'saving' ||
                preview.kind === 'saving' ||
                dirty ||
                saving
              }
            />
          </>
        )}
      </CardContent>
    </Card>
    </div>
  )
}

// ============================================================================
// Phase 8Y — DigestRecipientControls
//
// Standalone sub-component so the picker + honor-cadence toggle don't
// bloat the main render path. Pure presentational — every state knob
// lives in the parent.
// ============================================================================

interface DigestRecipientControlsProps {
  members: MembersState
  selectedRecipientId: string | null
  onSelectRecipient: (userId: string) => void
  respectCadence: boolean
  onChangeRespectCadence: (value: boolean) => void
  disabled: boolean
}

function DigestRecipientControls(props: DigestRecipientControlsProps) {
  const { members, selectedRecipientId, onSelectRecipient, respectCadence, onChangeRespectCadence, disabled } = props

  // Loading + error states are quiet — they shouldn't block the operator
  // from clicking "Send sample" or fiddling with their cadence. The
  // parent disables the "Send manual digest" button in these states.
  if (members.kind === 'loading') {
    return (
      <div className="mt-3 text-[11px] text-[#94A3B8]">
        Loading recipients…
      </div>
    )
  }
  if (members.kind === 'error') {
    return (
      <div className="mt-3 text-[11px] text-[#B45309]">
        Couldn&apos;t load recipients: {members.message}
      </div>
    )
  }

  const receivable = members.items.filter((m) => m.can_receive_digest)
  const selfRow = members.items.find((m) => m.is_current_user)
  const onlyMember = receivable.length <= 1

  return (
    <div className="mt-3 space-y-2">
      {/* Recipient selector. If only one receivable member exists,
          collapse to a static "Sending to you" label — no select. */}
      {onlyMember ? (
        <p className="text-[11px] text-[#64748B]">
          Manual digest will be sent to{' '}
          <span className="text-[#0F172A] font-medium">
            {selfRow?.email ?? 'your account'}
          </span>
          .
        </p>
      ) : (
        <label className="inline-flex items-center gap-2 text-[12px] text-[#475569]">
          <span className="text-[#94A3B8]">Send to</span>
          <select
            value={selectedRecipientId ?? ''}
            onChange={(e) => onSelectRecipient(e.target.value)}
            disabled={disabled}
            className="rounded-lg border border-[#E2E8F0] bg-white px-2.5 py-1 text-[12px] text-[#0F172A] focus:outline-none focus:ring-2 focus:ring-[#3B82F6]/30 focus:border-[#1D4ED8] disabled:opacity-60"
          >
            {members.items.map((m) => {
              const label = m.email ?? `${m.role} · ${m.user_id.slice(0, 8)}`
              const suffix = m.is_current_user ? ' (you)' : ''
              const unsendable = !m.can_receive_digest ? ' — no email' : ''
              return (
                <option
                  key={m.user_id}
                  value={m.user_id}
                  disabled={!m.can_receive_digest}
                >
                  {label}
                  {suffix}
                  {unsendable}
                </option>
              )
            })}
          </select>
        </label>
      )}

      {/* Honor cadence toggle. Defaults to false (bypass cadence) so
          the standard "send it now" UX stays the same. Operators
          QAing weekly-day scheduling can flip it on to dry-run the
          cron's cadence decision for the selected recipient. */}
      <label className="inline-flex items-center gap-2 text-[11px] text-[#64748B] cursor-pointer">
        <input
          type="checkbox"
          checked={respectCadence}
          onChange={(e) => onChangeRespectCadence(e.target.checked)}
          disabled={disabled}
          className="accent-[#1D4ED8]"
        />
        Honor selected recipient&apos;s cadence preference
      </label>
    </div>
  )
}
