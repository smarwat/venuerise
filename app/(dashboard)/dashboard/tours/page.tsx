import { createClient } from '@/lib/supabase/server'
import PageHeader from '@/components/dashboard/PageHeader'
import { Card, CardContent, CardHeader, CardTitle, CardSubtitle } from '@/components/dashboard/ui/Card'
import { Badge } from '@/components/dashboard/ui/Badge'
// Phase 8D — `Button` + `Plus` previously rendered the header CTA, now
// owned by TourSchedulingClient (which mounts the drawer).
import {
  format,
  startOfMonth,
  endOfMonth,
  eachDayOfInterval,
  isSameDay,
  parse,
  isValid,
} from 'date-fns'
import RealtimeToursLayer from '@/components/dashboard/tours/RealtimeToursLayer'
import RealtimeTourStatusLayer from '@/components/dashboard/tours/RealtimeTourStatusLayer'
import TourSchedulingClient from '@/components/dashboard/tours/TourSchedulingClient'
import MonthNavClient from '@/components/dashboard/tours/MonthNavClient'
import TourInteractionClient from '@/components/dashboard/tours/TourInteractionClient'
import TourPausedBanner from '@/components/dashboard/tours/TourPausedBanner'

type TourStatus = 'scheduled' | 'confirmed' | 'completed' | 'cancelled' | 'no_show'

const STATUS_CONFIG: Record<TourStatus, { label: string; variant: Parameters<typeof Badge>[0]['variant']; chip: string }> = {
  scheduled: { label: 'Scheduled', variant: 'blue',    chip: 'bg-[#EFF6FF] text-[#1D4ED8] border border-[#BFDBFE]' },
  confirmed: { label: 'Confirmed', variant: 'navy',    chip: 'bg-[#F1F5F9] text-[#0F172A] border border-[#E2E8F0]' },
  completed: { label: 'Completed', variant: 'green',   chip: 'bg-[#ECFDF5] text-[#047857] border border-[#A7F3D0]' },
  cancelled: { label: 'Cancelled', variant: 'default', chip: 'bg-[#F1F5F9] text-[#64748B] border border-[#E2E8F0]' },
  no_show:   { label: 'No Show',   variant: 'red',     chip: 'bg-[#FEF2F2] text-[#B91C1C] border border-[#FECACA]' },
}

/**
 * Phase 8E — server-resolved month from `?month=YYYY-MM`.
 *
 * Invalid or absent values default to the current month. We always pass
 * a STABLE 1st-of-month Date downstream so date-fns helpers behave
 * deterministically regardless of when the page was rendered relative
 * to today.
 */
function resolveMonth(raw: string | undefined): { displayMonth: Date; monthSlug: string } {
  if (raw) {
    const parsed = parse(raw, 'yyyy-MM', new Date())
    if (isValid(parsed)) {
      return {
        displayMonth: startOfMonth(parsed),
        monthSlug: format(parsed, 'yyyy-MM'),
      }
    }
  }
  const today = new Date()
  return {
    displayMonth: startOfMonth(today),
    monthSlug: format(today, 'yyyy-MM'),
  }
}

export default async function ToursPage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string }>
}) {
  const { month: monthParam } = await searchParams
  const { displayMonth, monthSlug } = resolveMonth(monthParam)

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  const { data: venueRaw } = await supabase
    .from('venues').select('id').eq('owner_user_id', user!.id)
    .order('created_at').limit(1).maybeSingle()
  const venueId = (venueRaw as { id?: string } | null)?.id ?? null

  const monthStart = displayMonth
  const monthEnd = endOfMonth(displayMonth)
  const now = new Date()

  const tours = venueId
    ? (await supabase
        .from('tours')
        .select('*, leads(name, email)')
        .eq('venue_id', venueId)
        .gte('scheduled_at', monthStart.toISOString())
        .lte('scheduled_at', monthEnd.toISOString())
        .order('scheduled_at')
      ).data ?? []
    : []

  // Phase 8D — fetch leads for the schedule drawer's picker. Limited to
  // the 100 most recently created so the dropdown stays manageable; if a
  // venue ever has >100 active leads we'll add a typeahead.
  const drawerLeads = venueId
    ? (await supabase
        .from('leads')
        .select('id, name, email, stage')
        .eq('venue_id', venueId)
        .order('created_at', { ascending: false })
        .limit(100)
      ).data ?? []
    : []

  // Phase 8G — read subscription metadata to decide whether to render
  // the auto-pause banner. We pick the most recently-created subscription
  // row for the venue (matches the priority order used by the dashboard
  // billing banner). RLS on subscriptions is ADMIN_ROLES-only for SELECT;
  // if the current user is sales/coordinator/viewer, the read returns
  // null and the banner stays hidden — which is the right behavior
  // (only admins/owners see billing prompts).
  const subscriptionRaw = venueId
    ? (await supabase
        .from('subscriptions')
        .select('metadata')
        .eq('venue_id', venueId)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()
      ).data
    : null
  const subscriptionMetadata =
    (subscriptionRaw as { metadata?: Record<string, unknown> | null } | null)?.metadata ?? null
  const toursPausedAt =
    typeof subscriptionMetadata?.tours_paused_at === 'string'
      ? (subscriptionMetadata.tours_paused_at as string)
      : null
  const toursResumedAt =
    typeof subscriptionMetadata?.tours_resumed_at === 'string'
      ? (subscriptionMetadata.tours_resumed_at as string)
      : null
  const toursPausedCount =
    typeof subscriptionMetadata?.tours_paused_count === 'number'
      ? (subscriptionMetadata.tours_paused_count as number)
      : null
  const showPausedBanner = Boolean(toursPausedAt) && !toursResumedAt

  const daysInMonth = eachDayOfInterval({ start: monthStart, end: monthEnd })

  const countByStatus = (s: TourStatus) => tours.filter((t) => (t as Record<string, unknown>).status === s).length

  // Phase 8E — narrow + serialize for the client interaction wrapper.
  // We pass only the fields TourInteractionClient + EditTourDrawer need
  // so the client bundle stays lean.
  const upcomingTours = (tours as Array<Record<string, unknown>>)
    .filter((t) => ['scheduled', 'confirmed'].includes(t.status as string))
    .slice(0, 5)
    .map((t) => {
      const leadRel = t.leads as { name?: string | null; email?: string | null } | null
      return {
        id: t.id as string,
        lead_id: t.lead_id as string,
        scheduled_at: t.scheduled_at as string,
        duration_minutes: (t.duration_minutes as number | null) ?? null,
        location_notes: (t.location_notes as string | null) ?? null,
        status: t.status as TourStatus,
        lead: leadRel
          ? { name: leadRel.name ?? null, email: leadRel.email ?? null }
          : null,
      }
    })

  return (
    <div className="p-6 lg:p-8 animate-slide-up">
      <PageHeader
        title="Tours"
        subtitle="Schedule, confirm, and track every venue tour"
        actions={
          <div className="flex items-center gap-2">
            {/* Phase 8E — URL-based month nav. Clicking chevrons or "Today"
                pushes ?month=YYYY-MM and the server re-fetches. */}
            <MonthNavClient
              currentMonth={monthSlug}
              currentMonthLabel={format(displayMonth, 'MMMM yyyy')}
            />
            <TourSchedulingClient
              leads={drawerLeads as Parameters<typeof TourSchedulingClient>[0]['leads']}
            />
          </div>
        }
      />

      {/* Phase 8G — auto-paused banner. Renders only when the
          subscription metadata indicates Phase 8F cancelled tours and
          billing hasn't recovered yet. Sales/coordinator/viewer roles
          can't read subscriptions (RLS), so this stays invisible for
          them — only admins/owners see billing prompts. */}
      {showPausedBanner && toursPausedAt && (
        <TourPausedBanner pausedAt={toursPausedAt} pausedCount={toursPausedCount} />
      )}

      {/* Stats */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        {(['scheduled', 'confirmed', 'completed', 'no_show'] as TourStatus[]).map((s) => {
          const cfg = STATUS_CONFIG[s]
          return (
            <div key={s} className="bg-white border border-[#E2E8F0] rounded-[20px] p-5 shadow-card">
              <div className="text-[28px] font-semibold text-[#0F172A] tracking-[-0.02em] leading-none mb-2">{countByStatus(s)}</div>
              <Badge variant={cfg.variant}>{cfg.label}</Badge>
            </div>
          )
        })}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Calendar — server-rendered. Per Phase 8E spec, click-to-edit
            is only on the Upcoming Tours rows for the surgical pass. */}
        <Card className="lg:col-span-2">
          <CardHeader>
            <div>
              <CardTitle>{format(displayMonth, 'MMMM yyyy')}</CardTitle>
              <CardSubtitle>Visual overview of this month</CardSubtitle>
            </div>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-7 mb-2">
              {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => (
                <div key={d} className="text-[10px] font-semibold text-[#94A3B8] uppercase tracking-wider text-center py-1.5">{d}</div>
              ))}
            </div>
            <div className="grid grid-cols-7 gap-1.5">
              {Array.from({ length: monthStart.getDay() }).map((_, i) => (
                <div key={`empty-${i}`} className="aspect-square" />
              ))}
              {daysInMonth.map((day) => {
                const dayTours = tours.filter((t) => isSameDay(new Date((t as Record<string, unknown>).scheduled_at as string), day))
                const isToday = isSameDay(day, now)
                return (
                  <div
                    key={day.toISOString()}
                    className={`aspect-square p-1.5 rounded-xl border text-xs flex flex-col gap-0.5 ${
                      isToday
                        ? 'border-[#1D4ED8] bg-[#EFF6FF]'
                        : dayTours.length > 0
                          ? 'border-[#E2E8F0] bg-white'
                          : 'border-[#F1F5F9] bg-[#F8FAFC]'
                    }`}
                  >
                    <span className={`text-[11px] font-semibold ${isToday ? 'text-[#1D4ED8]' : 'text-[#475569]'}`}>
                      {format(day, 'd')}
                    </span>
                    {dayTours.slice(0, 2).map((tour) => {
                      const t = tour as Record<string, unknown>
                      const cfg = STATUS_CONFIG[t.status as TourStatus]
                      return (
                        <div key={t.id as string} className={`rounded-md px-1.5 py-0.5 text-[9px] font-medium truncate ${cfg.chip}`}>
                          {format(new Date(t.scheduled_at as string), 'h:mma')}
                        </div>
                      )
                    })}
                    {dayTours.length > 2 && (
                      <span className="text-[9px] text-[#94A3B8]">+{dayTours.length - 2}</span>
                    )}
                  </div>
                )
              })}
            </div>
          </CardContent>
        </Card>

        {/* Upcoming — now interactive via Phase 8E client wrapper.
            Renders the same shape as before but click → opens EditTourDrawer,
            and scheduled rows get an inline "Mark confirmed" action. */}
        <Card>
          <CardHeader>
            <div>
              <CardTitle>Upcoming Tours</CardTitle>
              <CardSubtitle>Next on your calendar</CardSubtitle>
            </div>
          </CardHeader>
          <CardContent>
            <TourInteractionClient tours={upcomingTours} />
          </CardContent>
        </Card>
      </div>
      {/* Phase 8C — non-rendering client component (except for a toast).
          Subscribes to public.tours postgres_changes filtered by venue_id
          and refreshes the page on any event. `router.refresh()` preserves
          the current ?month=YYYY-MM search param so we stay on the same view. */}
      {venueId && <RealtimeToursLayer venueId={venueId} />}
      {/* Phase 8O — independent realtime subscription on the
          tour_status_events audit feed. When any audit row is inserted
          for this venue (lead-token click, operator PATCH, admin
          bulk-cancel, auto-pause cron), the layer fires a soft
          "Tour activity recorded" toast and calls router.refresh()
          so the audit drawer and Upcoming Tours list reflect the
          latest state without manual reload. */}
      {venueId && <RealtimeTourStatusLayer venueId={venueId} />}
    </div>
  )
}
