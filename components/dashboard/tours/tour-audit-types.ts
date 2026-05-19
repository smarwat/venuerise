/**
 * Phase 8N — shared types + label helpers for the tour status-event
 * audit UI surfaces.
 *
 * Used by:
 *   - components/dashboard/tours/TourAuditDrawer.tsx          (per-tour drawer)
 *   - components/dashboard/inbox/TourLifecycleStrip.tsx       (inbox recent activity)
 *   - components/dashboard/settings/TourStatusActivityFeed.tsx (billing settings feed)
 *   - app/(dashboard)/dashboard/settings/billing/page.tsx     (server-side fetch)
 *
 * Mirrors the shape returned by `GET /api/admin/tours/status-events`
 * (Phase 8M), which itself selects directly from `public.tour_status_events`.
 *
 * KEEP THIS FILE PURE
 *   No browser-only APIs other than `Intl.DateTimeFormat` (which exists
 *   in both Node and modern browsers). No React imports, no
 *   `server-only`, no `'use client'` — this module is consumed by both
 *   server components (billing page server-side fetch) and client
 *   components (drawer + strip).
 */

export type TourStatusActorKind = 'lead_token' | 'operator' | 'cron' | 'system'

export interface TourStatusEvent {
  id: string
  venue_id: string
  tour_id: string
  lead_id: string | null
  actor_kind: TourStatusActorKind
  actor_id: string | null
  action: string
  previous_status: string | null
  new_status: string
  source_ip: string | null
  user_agent: string | null
  reason: string | null
  metadata: Record<string, unknown>
  occurred_at: string
}

/**
 * Friendly chip label for an `actor_kind` discriminator. Designed for a
 * single short word that fits in a Badge — "Lead" / "Operator" / "Cron" /
 * "System". Falls back to the raw string if a future actor kind shows up
 * before the UI is updated (defensive — the table CHECK constraint enforces
 * the four current values, but a non-exhaustive switch keeps us forward-
 * compatible).
 */
export function actorLabel(kind: TourStatusActorKind | string): string {
  switch (kind) {
    case 'lead_token':
      return 'Lead'
    case 'operator':
      return 'Operator'
    case 'cron':
      return 'Cron'
    case 'system':
      return 'System'
    default:
      return kind
  }
}

/**
 * Friendly label for the free-form `action` verb. The set is open — Phase
 * 8M write paths use `confirm | cancel | status_change | reschedule |
 * bulk_cancel | auto_pause_cancel`, but future paths can add new verbs
 * without a schema migration. Unknown verbs are humanized (snake_case →
 * Title Case With Spaces) so they still read reasonably in the UI.
 */
export function actionLabel(action: string): string {
  switch (action) {
    case 'confirm':
      return 'Confirmed'
    case 'cancel':
      return 'Cancelled'
    case 'status_change':
      return 'Status changed'
    case 'reschedule':
      return 'Rescheduled'
    case 'bulk_cancel':
      return 'Bulk cancelled'
    case 'auto_pause_cancel':
      return 'Auto-paused'
    case 'legacy_status_snapshot':
      return 'Legacy snapshot'
    default:
      // snake_case → Title Case With Spaces.
      return action
        .split('_')
        .map((w) => (w.length === 0 ? '' : w[0].toUpperCase() + w.slice(1)))
        .join(' ')
  }
}

/**
 * Friendly label for a tour status string. Mirrors the vocabulary used
 * by the Phase 8F TourLifecycleStrip + Phase 8E EditTourDrawer so the
 * audit UI doesn't introduce a competing dictionary. Nulls and unknown
 * statuses return a short fallback so an audit row with a legacy or
 * malformed status doesn't render blank.
 */
export function statusLabel(status: string | null): string {
  if (!status) return '—'
  switch (status) {
    case 'scheduled':
      return 'Scheduled'
    case 'confirmed':
      return 'Confirmed'
    case 'completed':
      return 'Completed'
    case 'cancelled':
      return 'Cancelled'
    case 'no_show':
      return 'No-show'
    case 'unknown':
      return 'Unknown'
    default:
      return status
  }
}

// Cached formatter — `Intl.DateTimeFormat` construction is expensive and
// the locale/options don't change between calls.
const auditFormatter = new Intl.DateTimeFormat('en-US', {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  hour12: true,
  timeZoneName: 'short',
})

/**
 * Format an ISO timestamp for a single-line audit row. Example:
 *   "May 18, 2026, 2:21 PM UTC"
 *
 * Falls back to the raw ISO when the input can't be parsed so a malformed
 * row never breaks the table layout.
 */
export function formatAuditTime(iso: string): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  try {
    return auditFormatter.format(d)
  } catch {
    return iso
  }
}
