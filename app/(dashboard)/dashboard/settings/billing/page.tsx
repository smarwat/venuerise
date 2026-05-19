import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getCurrentVenueForUser } from '@/lib/auth/tenant-access'
import { ADMIN_ROLES } from '@/lib/auth/roles'
import { getVenueSubscriptionStatus } from '@/lib/billing/subscription-status'
import PageHeader from '@/components/dashboard/PageHeader'
import BillingStatusCard from '@/components/dashboard/billing/BillingStatusCard'
import PauseHistoryTable, {
  type PauseHistoryCurrent,
  type PauseHistoryItem,
} from '@/components/dashboard/settings/PauseHistoryTable'
import TourStatusActivityFeed from '@/components/dashboard/settings/TourStatusActivityFeed'
import DigestPreferencesCard from '@/components/dashboard/settings/DigestPreferencesCard'
import RealtimeTourStatusLayer from '@/components/dashboard/tours/RealtimeTourStatusLayer'
import type {
  TourStatusActorKind,
  TourStatusEvent,
} from '@/components/dashboard/tours/tour-audit-types'

export const dynamic = 'force-dynamic'

/**
 * Phase 7D — /dashboard/settings/billing
 *
 * Server-rendered. Reads the venue's subscription status via the helper
 * (service-role internally, request-memoized) and renders a single status
 * card with the right action set. The card is pure UI — all server →
 * Stripe round-trips happen via BillingActions → /api/billing/{checkout,portal}.
 */
export default async function BillingSettingsPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const venue = await getCurrentVenueForUser(user.id)
  if (!venue) redirect('/onboarding')

  // Tolerate a transient status read failure — the card falls through to
  // its "unknown" state and the user can still hit the manage-billing CTA.
  let status: Awaited<ReturnType<typeof getVenueSubscriptionStatus>>
  try {
    status = await getVenueSubscriptionStatus(venue.venueId)
  } catch {
    status = { kind: 'unknown', raw_status: 'read_failed' }
  }

  // Phase 8I — pause history audit surface. We only render the table for
  // admins/owners; sales/coordinator/viewer roles see the existing billing
  // card alone. The read uses the service client because `subscriptions`
  // SELECT is ADMIN_ROLES-only via RLS (migration 007), and parsing the
  // metadata server-side keeps the client component pure presentation.
  const isAdmin = (ADMIN_ROLES as readonly string[]).includes(venue.role)
  let pauseCurrent: PauseHistoryCurrent = {
    paused_at: null,
    paused_reason: null,
    paused_count: null,
    resumed_at: null,
    resumed_reason: null,
  }
  let pauseItems: PauseHistoryItem[] = []
  if (isAdmin) {
    const svc = createServiceClient()
    const { data: subRaw } = await svc
      .from('subscriptions')
      .select('metadata')
      .eq('venue_id', venue.venueId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    const md =
      (subRaw as { metadata?: Record<string, unknown> | null } | null)?.metadata ?? null
    if (md) {
      const readStr = (k: string): string | null => {
        const v = md[k]
        return typeof v === 'string' && v.length > 0 ? v : null
      }
      const readNum = (k: string): number | null => {
        const v = md[k]
        return typeof v === 'number' && Number.isFinite(v) ? v : null
      }
      pauseCurrent = {
        paused_at: readStr('tours_paused_at'),
        paused_reason: readStr('tours_paused_reason'),
        paused_count: readNum('tours_paused_count'),
        resumed_at: readStr('tours_resumed_at'),
        resumed_reason: readStr('tours_resumed_reason'),
      }
      const rawHistory = (md as { tour_pause_history?: unknown }).tour_pause_history
      if (Array.isArray(rawHistory)) {
        const parsed: PauseHistoryItem[] = []
        for (const entry of rawHistory) {
          if (!entry || typeof entry !== 'object') continue
          const e = entry as Record<string, unknown>
          const paused_at = typeof e.paused_at === 'string' ? e.paused_at : null
          const resumed_at = typeof e.resumed_at === 'string' ? e.resumed_at : null
          const archived_at = typeof e.archived_at === 'string' ? e.archived_at : null
          if (!paused_at || !resumed_at || !archived_at) continue
          parsed.push({
            paused_at,
            resumed_at,
            archived_at,
            paused_reason: typeof e.paused_reason === 'string' ? e.paused_reason : null,
            resumed_reason:
              typeof e.resumed_reason === 'string' ? e.resumed_reason : null,
            paused_count: typeof e.paused_count === 'number' ? e.paused_count : null,
          })
        }
        // Newest first — same display order as the admin endpoint.
        parsed.reverse()
        pauseItems = parsed.slice(0, 10)
      }
    }
  }

  // Phase 8N — server-fetched tour status activity feed. Admins/owners
  // only. Reads directly from `public.tour_status_events` via the service
  // client because this is a Server Component and forwarding cookies to
  // the admin HTTP endpoint would just add latency for the same data.
  // The Phase 8M RLS policy still applies as defense in depth — but with
  // the service client we rely on the application-level `isAdmin` gate
  // above to enforce access.
  const VALID_ACTOR_KINDS: ReadonlySet<TourStatusActorKind> = new Set([
    'lead_token',
    'operator',
    'cron',
    'system',
  ])
  let tourStatusEvents: TourStatusEvent[] = []
  if (isAdmin) {
    const svc = createServiceClient()
    const { data: eventsRaw } = await svc
      .from('tour_status_events')
      .select(
        'id, venue_id, tour_id, lead_id, actor_kind, actor_id, action, previous_status, new_status, source_ip, user_agent, reason, metadata, occurred_at'
      )
      .eq('venue_id', venue.venueId)
      .order('occurred_at', { ascending: false })
      .limit(25)
    tourStatusEvents = ((eventsRaw ?? []) as Array<Record<string, unknown>>)
      .filter((row): row is Record<string, unknown> & { actor_kind: string } => {
        return (
          typeof row.actor_kind === 'string' &&
          VALID_ACTOR_KINDS.has(row.actor_kind as TourStatusActorKind)
        )
      })
      .map((row) => ({
        id: String(row.id),
        venue_id: String(row.venue_id),
        tour_id: String(row.tour_id),
        lead_id: typeof row.lead_id === 'string' ? row.lead_id : null,
        actor_kind: row.actor_kind as TourStatusActorKind,
        actor_id: typeof row.actor_id === 'string' ? row.actor_id : null,
        action: typeof row.action === 'string' ? row.action : 'unknown',
        previous_status:
          typeof row.previous_status === 'string' ? row.previous_status : null,
        new_status: typeof row.new_status === 'string' ? row.new_status : 'unknown',
        source_ip: typeof row.source_ip === 'string' ? row.source_ip : null,
        user_agent: typeof row.user_agent === 'string' ? row.user_agent : null,
        reason: typeof row.reason === 'string' ? row.reason : null,
        metadata:
          row.metadata && typeof row.metadata === 'object'
            ? (row.metadata as Record<string, unknown>)
            : {},
        occurred_at:
          typeof row.occurred_at === 'string'
            ? row.occurred_at
            : new Date().toISOString(),
      }))
  }

  return (
    <div className="p-6 lg:p-8 animate-slide-up">
      <PageHeader
        title="Billing"
        subtitle="Manage your subscription, payment method, and invoice history."
      />
      <div className="space-y-6">
        <BillingStatusCard status={status} />
        {isAdmin && (
          <PauseHistoryTable current={pauseCurrent} items={pauseItems} />
        )}
        {isAdmin && <TourStatusActivityFeed events={tourStatusEvents} />}
        {/* Phase 8T — daily/weekly/off cadence picker (admins/owners
            only — the route + the card itself both enforce the gate). */}
        {isAdmin && <DigestPreferencesCard />}
      </div>
      {/* Phase 8O — realtime audit subscription. Admins/owners only — the
          layer's only side-effects are a toast + router.refresh(), which
          rebuilds the server-fetched events slice above and surfaces
          any newly-arrived audit rows without manual reload. */}
      {isAdmin && <RealtimeTourStatusLayer venueId={venue.venueId} />}
    </div>
  )
}
