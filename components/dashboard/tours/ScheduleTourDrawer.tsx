'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { CalendarCheck, Loader2 } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/dashboard/ui/Dialog'
import { Button } from '@/components/dashboard/ui/Button'
import { Input } from '@/components/dashboard/ui/Input'
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/dashboard/ui/Select'
import { nextTuesdayAtTenAm } from '@/lib/demo/demo-tour'

/**
 * Phase 8D — full schedule-tour drawer (Radix Dialog).
 *
 * Used from two call sites:
 *   1. /dashboard/tours header — operator picks any lead (full list passed in).
 *   2. LeadDetailPanel — opens with a single-lead list pre-selected.
 *
 * POSTs the existing /api/tours payload (Phase 6B / 7D):
 *   {
 *     lead_id: <uuid>,
 *     scheduled_at: <ISO datetime>,
 *     duration_minutes: <int 15–240>,
 *     location_notes?: <string|null>
 *   }
 *
 * Date + time inputs are kept SEPARATE to dodge the `<input type="datetime-local">`
 * timezone quirk (some browsers report local-without-TZ, others apply offsets).
 * We combine them into a single local Date in JS, then serialize via
 * `toISOString()` so the wire format is unambiguous UTC.
 *
 * Defaults: next Tuesday at 10:00 local, 60-minute duration. Same defaults
 * as the Phase 8C `QuickScheduleTourButton` so behavior is consistent
 * whether the operator uses the quick demo button or the full drawer.
 */

export interface ScheduleTourDrawerLead {
  id: string
  name: string
  email?: string | null
  stage?: string | null
}

interface ScheduleTourDrawerProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  leads: ScheduleTourDrawerLead[]
  /** Optional lead id to preselect in the picker. */
  defaultLeadId?: string | null
  /** Optional default body for the location notes textarea. */
  defaultNotes?: string
  /**
   * Phase 8I — optional ISO datetime to seed the date + time inputs
   * with. Useful for "re-schedule cancelled tour" flows where we want
   * the operator to land on the OLD tour's slot as a starting point.
   * Falls back to `nextTuesdayAtTenAm()` when omitted.
   */
  defaultScheduledAt?: string
  /**
   * Phase 8I — optional duration override (15–240). Falls back to 60.
   */
  defaultDurationMinutes?: number
  /**
   * Called after a successful POST. Caller decides what to do — typically
   * `router.refresh()`. The drawer ALSO calls `router.refresh()` internally
   * so the realtime tours layer + the calendar both pick up the new row.
   */
  onScheduled?: () => void
}

type SubmitState =
  | { kind: 'idle' }
  | { kind: 'submitting' }
  | { kind: 'success' }
  | { kind: 'error'; message: string }

// ---------------------------------------------------------------------------
// Helpers — keep date/time wrangling out of the component body.
// ---------------------------------------------------------------------------

/** Split an ISO string into YYYY-MM-DD + HH:MM for the input defaults. */
function splitIsoToLocal(iso: string): { date: string; time: string } {
  const d = new Date(iso)
  // Format in LOCAL time so the inputs show what the operator expects.
  const pad = (n: number) => n.toString().padStart(2, '0')
  return {
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    time: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
  }
}

function combineToIso(dateStr: string, timeStr: string): string | null {
  if (!dateStr || !timeStr) return null
  // Parsing `2026-06-15T10:00` (no Z) yields LOCAL time per the spec.
  const local = new Date(`${dateStr}T${timeStr}`)
  if (!Number.isFinite(local.getTime())) return null
  return local.toISOString()
}

function humanize(code: string): string {
  switch (code) {
    case 'unauthorized':
      return 'Please sign in again.'
    case 'forbidden':
      return 'Sales / coordinator role required to schedule tours.'
    case 'subscription_required':
      return 'Subscription required — the billing gate is enabled.'
    case 'rate_limited':
      return 'Slow down — too many tour creates in a short window.'
    case 'no_venue':
    case 'Venue not found':
      return 'No active venue context.'
    case 'lead_not_found':
    case 'Lead not found':
      return 'The selected lead is no longer accessible.'
    case 'validation_failed':
      return 'Some of the fields look off — double-check date, time, and duration.'
    default:
      return 'Could not schedule tour.'
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function ScheduleTourDrawer({
  open,
  onOpenChange,
  leads,
  defaultLeadId,
  defaultNotes = '',
  defaultScheduledAt,
  defaultDurationMinutes,
  onScheduled,
}: ScheduleTourDrawerProps) {
  const router = useRouter()
  // Phase 8I — accept optional defaults to seed the form for re-schedule
  // flows. The fallback chain mirrors how the form re-seeds on re-open
  // (see useEffect below) so initial render + re-open behavior agree.
  const seedIso = defaultScheduledAt ?? nextTuesdayAtTenAm()
  const seedDefaults = splitIsoToLocal(seedIso)
  const seedDuration =
    typeof defaultDurationMinutes === 'number' &&
    defaultDurationMinutes >= 15 &&
    defaultDurationMinutes <= 240
      ? defaultDurationMinutes
      : 60
  const [leadId, setLeadId] = useState<string>(defaultLeadId ?? leads[0]?.id ?? '')
  const [date, setDate] = useState<string>(seedDefaults.date)
  const [time, setTime] = useState<string>(seedDefaults.time)
  const [duration, setDuration] = useState<number>(seedDuration)
  const [notes, setNotes] = useState<string>(defaultNotes)
  const [status, setStatus] = useState<SubmitState>({ kind: 'idle' })

  // Re-seed when the drawer re-opens (so a closed-and-re-opened drawer
  // doesn't show stale state from the last submit). Phase 8I — same
  // fallback chain as the initial render so a parent that toggles the
  // drawer between "fresh tour" and "re-schedule cancelled" gets the
  // right slot/duration each time it opens.
  useEffect(() => {
    if (!open) return
    const seedIsoOnOpen = defaultScheduledAt ?? nextTuesdayAtTenAm()
    const seed = splitIsoToLocal(seedIsoOnOpen)
    const durationOnOpen =
      typeof defaultDurationMinutes === 'number' &&
      defaultDurationMinutes >= 15 &&
      defaultDurationMinutes <= 240
        ? defaultDurationMinutes
        : 60
    setLeadId(defaultLeadId ?? leads[0]?.id ?? '')
    setDate(seed.date)
    setTime(seed.time)
    setDuration(durationOnOpen)
    setNotes(defaultNotes)
    setStatus({ kind: 'idle' })
  }, [
    open,
    defaultLeadId,
    defaultNotes,
    defaultScheduledAt,
    defaultDurationMinutes,
    leads,
  ])

  const canSubmit =
    status.kind !== 'submitting' &&
    Boolean(leadId) &&
    Boolean(date) &&
    Boolean(time) &&
    duration >= 15 &&
    duration <= 240

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!canSubmit) return
    const iso = combineToIso(date, time)
    if (!iso) {
      setStatus({ kind: 'error', message: 'Invalid date/time.' })
      return
    }
    setStatus({ kind: 'submitting' })
    try {
      const trimmedNotes = notes.trim()
      const res = await fetch('/api/tours', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          lead_id: leadId,
          scheduled_at: iso,
          duration_minutes: duration,
          location_notes: trimmedNotes ? trimmedNotes : null,
        }),
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: unknown } | null
        const code =
          body && typeof body.error === 'string' ? body.error : `HTTP ${res.status}`
        setStatus({ kind: 'error', message: humanize(code) })
        return
      }
      setStatus({ kind: 'success' })
      onScheduled?.()
      router.refresh()
      // Close the drawer after a short success flash so the operator sees confirmation.
      window.setTimeout(() => onOpenChange(false), 700)
    } catch (err) {
      setStatus({
        kind: 'error',
        message: err instanceof Error ? err.message : 'Network error',
      })
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>Schedule a tour</DialogTitle>
            <DialogDescription>
              Sales/coordinator roles only. The lead will not be auto-notified — send a
              confirmation from the inbox after scheduling.
            </DialogDescription>
          </DialogHeader>

          <div className="px-6 py-4 space-y-4">
            {/* Lead picker */}
            <div>
              <label
                htmlFor="schedule-tour-lead"
                className="block text-[11px] font-semibold text-[#94A3B8] uppercase tracking-wider mb-2"
              >
                Lead
              </label>
              {leads.length === 0 ? (
                <div className="text-[13px] text-[#B45309] bg-[#FFFBEB] border border-[#FCD9A1] rounded-lg px-3 py-2">
                  No leads available. Send a widget inquiry or run{' '}
                  <code className="text-[12px]">npm run demo:seed</code>.
                </div>
              ) : (
                <Select value={leadId} onValueChange={setLeadId}>
                  <SelectTrigger id="schedule-tour-lead">
                    <SelectValue placeholder="Select a lead…" />
                  </SelectTrigger>
                  <SelectContent>
                    {leads.map((l) => (
                      <SelectItem key={l.id} value={l.id}>
                        <span className="text-[#0F172A]">{l.name}</span>
                        {l.email && (
                          <span className="text-[#94A3B8]"> · {l.email}</span>
                        )}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>

            {/* Date + time */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label
                  htmlFor="schedule-tour-date"
                  className="block text-[11px] font-semibold text-[#94A3B8] uppercase tracking-wider mb-2"
                >
                  Date
                </label>
                <Input
                  id="schedule-tour-date"
                  type="date"
                  value={date}
                  onChange={(e) => setDate(e.target.value)}
                  required
                />
              </div>
              <div>
                <label
                  htmlFor="schedule-tour-time"
                  className="block text-[11px] font-semibold text-[#94A3B8] uppercase tracking-wider mb-2"
                >
                  Time
                </label>
                <Input
                  id="schedule-tour-time"
                  type="time"
                  value={time}
                  onChange={(e) => setTime(e.target.value)}
                  required
                />
              </div>
            </div>

            {/* Duration */}
            <div>
              <label
                htmlFor="schedule-tour-duration"
                className="block text-[11px] font-semibold text-[#94A3B8] uppercase tracking-wider mb-2"
              >
                Duration (minutes)
              </label>
              <Input
                id="schedule-tour-duration"
                type="number"
                min={15}
                max={240}
                step={15}
                value={duration}
                onChange={(e) => {
                  const n = Number(e.target.value)
                  if (Number.isFinite(n)) setDuration(n)
                }}
                required
              />
            </div>

            {/* Notes */}
            <div>
              <label
                htmlFor="schedule-tour-notes"
                className="block text-[11px] font-semibold text-[#94A3B8] uppercase tracking-wider mb-2"
              >
                Location notes <span className="text-[#94A3B8] normal-case font-normal">(optional)</span>
              </label>
              <textarea
                id="schedule-tour-notes"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                maxLength={500}
                rows={3}
                placeholder="Meet at the main gate, parking on the south lot…"
                className="w-full rounded-xl border border-[#E2E8F0] bg-white px-3.5 py-2 text-sm text-[#0F172A] placeholder:text-[#94A3B8] hover:border-[#CBD5E1] focus:outline-none focus:border-[#1D4ED8] focus:ring-[3px] focus:ring-[#3B82F6]/15 resize-none"
              />
              <div className="text-[11px] text-[#94A3B8] mt-1 text-right">
                {notes.length}/500
              </div>
            </div>

            {status.kind === 'error' && (
              <div className="rounded-lg bg-[#FEF2F2] border border-[#FECACA] px-3 py-2 text-sm text-[#B91C1C]">
                {status.message}
              </div>
            )}
            {status.kind === 'success' && (
              <div className="rounded-lg bg-[#ECFDF5] border border-[#A7F3D0] px-3 py-2 text-sm text-[#047857] flex items-center gap-2">
                <CalendarCheck className="w-4 h-4" />
                Tour scheduled — refreshing the calendar.
              </div>
            )}
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
              disabled={status.kind === 'submitting'}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={!canSubmit}>
              {status.kind === 'submitting' ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <CalendarCheck className="w-3.5 h-3.5" />
              )}
              {status.kind === 'submitting' ? 'Scheduling…' : 'Schedule tour'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
