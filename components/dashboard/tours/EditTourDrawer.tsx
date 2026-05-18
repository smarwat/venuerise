'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { CalendarCheck, Loader2, XCircle } from 'lucide-react'
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

/**
 * Phase 8E — edit/cancel/confirm an existing tour.
 *
 * Mirrors `ScheduleTourDrawer` (Phase 8D) but PATCHes the existing
 * `/api/tours/[id]` endpoint instead of POSTing.
 *
 * Lead picker is INTENTIONALLY read-only — reassigning a tour to a
 * different lead would require create+delete semantics that the API
 * doesn't expose today (and is rarely the right user action anyway).
 *
 * Status select carries the full enum the API accepts:
 *   scheduled | confirmed | completed | cancelled | no_show
 *
 * The dedicated **Cancel tour** button in the footer is a one-click
 * shortcut that PATCHes `status='cancelled'` after a window.confirm
 * prompt. Cancelled tours are soft-cancelled — the row remains in the
 * DB for audit + reschedule context.
 */

export interface EditableTour {
  id: string
  lead_id: string
  scheduled_at: string
  duration_minutes?: number | null
  location_notes?: string | null
  status?: string | null
  lead?: {
    name?: string | null
    email?: string | null
  } | null
}

interface EditTourDrawerProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  tour: EditableTour | null
  /** Caller hook — runs after a successful PATCH (any kind). */
  onUpdated?: () => void
}

type SubmitState =
  | { kind: 'idle' }
  | { kind: 'submitting' }
  | { kind: 'cancelling' }
  | { kind: 'success'; verb: 'updated' | 'cancelled' }
  | { kind: 'error'; message: string }

const STATUS_OPTIONS = [
  { value: 'scheduled', label: 'Scheduled' },
  { value: 'confirmed', label: 'Confirmed' },
  { value: 'completed', label: 'Completed' },
  { value: 'cancelled', label: 'Cancelled' },
  { value: 'no_show', label: 'No-show' },
] as const

// ---------------------------------------------------------------------------
// Date helpers — same shape as ScheduleTourDrawer so behavior stays consistent.
// ---------------------------------------------------------------------------

function splitIsoToLocal(iso: string): { date: string; time: string } {
  const d = new Date(iso)
  const pad = (n: number) => n.toString().padStart(2, '0')
  return {
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    time: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
  }
}

function combineToIso(dateStr: string, timeStr: string): string | null {
  if (!dateStr || !timeStr) return null
  const local = new Date(`${dateStr}T${timeStr}`)
  if (!Number.isFinite(local.getTime())) return null
  return local.toISOString()
}

function humanize(code: string): string {
  switch (code) {
    case 'unauthorized':
    case 'Unauthorized':
      return 'Please sign in again.'
    case 'forbidden':
      return 'Sales / coordinator role required to edit tours.'
    case 'subscription_required':
      return 'Subscription required — the billing gate is enabled.'
    case 'rate_limited':
      return 'Slow down — too many tour updates in a short window.'
    case 'not_found':
    case 'Tour not found':
      return 'Tour no longer exists.'
    case 'validation_failed':
      return 'Some of the fields look off — double-check date, time, and duration.'
    default:
      return 'Could not update tour.'
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function EditTourDrawer({
  open,
  onOpenChange,
  tour,
  onUpdated,
}: EditTourDrawerProps) {
  const router = useRouter()
  const [date, setDate] = useState<string>('')
  const [time, setTime] = useState<string>('')
  const [duration, setDuration] = useState<number>(60)
  const [notes, setNotes] = useState<string>('')
  const [status, setStatus] = useState<string>('scheduled')
  const [submitStatus, setSubmitStatus] = useState<SubmitState>({ kind: 'idle' })

  // Re-seed from the tour prop whenever the drawer opens with a new row.
  // This makes "click row A, edit, save, close, click row B" load B's values
  // instead of the post-edit-A state.
  useEffect(() => {
    if (!open || !tour) return
    const seed = splitIsoToLocal(tour.scheduled_at)
    setDate(seed.date)
    setTime(seed.time)
    setDuration(tour.duration_minutes ?? 60)
    setNotes(tour.location_notes ?? '')
    setStatus(tour.status ?? 'scheduled')
    setSubmitStatus({ kind: 'idle' })
  }, [open, tour])

  if (!tour) return null

  const canSubmit =
    submitStatus.kind === 'idle' &&
    Boolean(date) &&
    Boolean(time) &&
    duration >= 15 &&
    duration <= 240

  async function patch(body: Record<string, unknown>, verb: 'updated' | 'cancelled') {
    if (!tour) return
    setSubmitStatus({
      kind: verb === 'cancelled' ? 'cancelling' : 'submitting',
    })
    try {
      const res = await fetch(`/api/tours/${encodeURIComponent(tour.id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        const parsed = (await res.json().catch(() => null)) as
          | { error?: unknown }
          | null
        const code =
          parsed && typeof parsed.error === 'string'
            ? parsed.error
            : `HTTP ${res.status}`
        setSubmitStatus({ kind: 'error', message: humanize(code) })
        return
      }
      setSubmitStatus({ kind: 'success', verb })
      onUpdated?.()
      router.refresh()
      window.setTimeout(() => onOpenChange(false), 700)
    } catch (err) {
      setSubmitStatus({
        kind: 'error',
        message: err instanceof Error ? err.message : 'Network error',
      })
    }
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!canSubmit) return
    const iso = combineToIso(date, time)
    if (!iso) {
      setSubmitStatus({ kind: 'error', message: 'Invalid date/time.' })
      return
    }
    const trimmedNotes = notes.trim()
    await patch(
      {
        scheduled_at: iso,
        duration_minutes: duration,
        location_notes: trimmedNotes ? trimmedNotes : null,
        status,
      },
      'updated'
    )
  }

  async function handleCancelTour() {
    if (!tour) return
    if (
      !window.confirm(
        `Cancel the tour with ${tour.lead?.name ?? 'this lead'}? They won't be auto-notified.`
      )
    ) {
      return
    }
    await patch({ status: 'cancelled' }, 'cancelled')
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>Edit tour</DialogTitle>
            <DialogDescription>
              Update date, time, duration, status, or notes. Cancelled tours stay
              in the calendar history — they aren&apos;t deleted.
            </DialogDescription>
          </DialogHeader>

          <div className="px-6 py-4 space-y-4">
            {/* Lead — read-only */}
            <div>
              <div className="block text-[11px] font-semibold text-[#94A3B8] uppercase tracking-wider mb-2">
                Lead
              </div>
              <div className="rounded-xl border border-[#E2E8F0] bg-[#F8FAFC] px-3.5 py-2 text-sm text-[#0F172A]">
                <span className="font-medium">{tour.lead?.name ?? 'Unknown lead'}</span>
                {tour.lead?.email && (
                  <span className="text-[#94A3B8]"> · {tour.lead.email}</span>
                )}
              </div>
            </div>

            {/* Date + time */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label
                  htmlFor="edit-tour-date"
                  className="block text-[11px] font-semibold text-[#94A3B8] uppercase tracking-wider mb-2"
                >
                  Date
                </label>
                <Input
                  id="edit-tour-date"
                  type="date"
                  value={date}
                  onChange={(e) => setDate(e.target.value)}
                  required
                />
              </div>
              <div>
                <label
                  htmlFor="edit-tour-time"
                  className="block text-[11px] font-semibold text-[#94A3B8] uppercase tracking-wider mb-2"
                >
                  Time
                </label>
                <Input
                  id="edit-tour-time"
                  type="time"
                  value={time}
                  onChange={(e) => setTime(e.target.value)}
                  required
                />
              </div>
            </div>

            {/* Duration + status */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label
                  htmlFor="edit-tour-duration"
                  className="block text-[11px] font-semibold text-[#94A3B8] uppercase tracking-wider mb-2"
                >
                  Duration (minutes)
                </label>
                <Input
                  id="edit-tour-duration"
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
              <div>
                <label
                  htmlFor="edit-tour-status"
                  className="block text-[11px] font-semibold text-[#94A3B8] uppercase tracking-wider mb-2"
                >
                  Status
                </label>
                <Select value={status} onValueChange={setStatus}>
                  <SelectTrigger id="edit-tour-status">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {STATUS_OPTIONS.map((opt) => (
                      <SelectItem key={opt.value} value={opt.value}>
                        {opt.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            {/* Notes */}
            <div>
              <label
                htmlFor="edit-tour-notes"
                className="block text-[11px] font-semibold text-[#94A3B8] uppercase tracking-wider mb-2"
              >
                Location notes{' '}
                <span className="text-[#94A3B8] normal-case font-normal">
                  (optional)
                </span>
              </label>
              <textarea
                id="edit-tour-notes"
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

            {submitStatus.kind === 'error' && (
              <div className="rounded-lg bg-[#FEF2F2] border border-[#FECACA] px-3 py-2 text-sm text-[#B91C1C]">
                {submitStatus.message}
              </div>
            )}
            {submitStatus.kind === 'success' && (
              <div className="rounded-lg bg-[#ECFDF5] border border-[#A7F3D0] px-3 py-2 text-sm text-[#047857] flex items-center gap-2">
                <CalendarCheck className="w-4 h-4" />
                {submitStatus.verb === 'cancelled'
                  ? 'Tour cancelled — refreshing the calendar.'
                  : 'Tour updated — refreshing the calendar.'}
              </div>
            )}
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              onClick={handleCancelTour}
              disabled={
                submitStatus.kind === 'submitting' ||
                submitStatus.kind === 'cancelling'
              }
            >
              {submitStatus.kind === 'cancelling' ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <XCircle className="w-3.5 h-3.5" />
              )}
              {submitStatus.kind === 'cancelling' ? 'Cancelling…' : 'Cancel tour'}
            </Button>
            <div className="flex-1" />
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
              disabled={
                submitStatus.kind === 'submitting' ||
                submitStatus.kind === 'cancelling'
              }
            >
              Close
            </Button>
            <Button type="submit" disabled={!canSubmit}>
              {submitStatus.kind === 'submitting' ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <CalendarCheck className="w-3.5 h-3.5" />
              )}
              {submitStatus.kind === 'submitting' ? 'Saving…' : 'Save changes'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
