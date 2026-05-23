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
// GTM-0F — tour protection polish. TourProtectionSummary sits at
// the top with 5 risk tiles. CompletedTourFollowupList surfaces
// the "toured but not booked" queue the page was missing.
import TourProtectionSummary from '@/components/dashboard/tours/TourProtectionSummary'
import CompletedTourFollowupList from '@/components/dashboard/tours/CompletedTourFollowupList'

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

  // GTM-0F — separate broader-window fetch for the protection summary
  // and completed-follow-up queue. The month-scoped `tours` query above
  // powers the calendar grid; the summary tiles + follow-up list care
  // about a wider time band (last 60 days through next 30 days) and
  // need lead.stage + lead.budget + lead.lead_score for accurate
  // counts and "Est. value" framing.
  // Best-effort: a query failure collapses both surfaces to empty.
  const SUMMARY_BACK_DAYS = 60
  const SUMMARY_FORWARD_DAYS = 30
  const summaryFrom = new Date(now)
  summaryFrom.setDate(summaryFrom.getDate() - SUMMARY_BACK_DAYS)
  const summaryTo = new Date(now)
  summaryTo.setDate(summaryTo.getDate() + SUMMARY_FORWARD_DAYS)
  const summaryTours = venueId
    ? (await supabase
        .from('tours')
        .select(
          'id, scheduled_at, status, lead_id, leads(name, stage, lead_score, budget)'
        )
        .eq('venue_id', venueId)
        .gte('scheduled_at', summaryFrom.toISOString())
        .lte('scheduled_at', summaryTo.toISOString())
        .order('scheduled_at', { ascending: false })
        .limit(500)
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
      {/* GTM-0F — header reframe. "Tours" → "Tour pipeline" with a
          revenue-protection subtitle. The page now reads as the
          place where wedding bookings are won or lost, not as a
          generic calendar view. */}
      <PageHeader
        title="Tour pipeline"
        subtitle="Confirm upcoming tours, prevent no-shows, and turn completed visits into booked weddings."
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

      {/* GTM-0F — Tour protection summary band. Sits at the top of
          the page hierarchy: header → protection summary → calendar +
          action queues → secondary stats. Tiles only render when
          their value is meaningful. */}
      <TourProtectionSummary
        tours={summaryTours as Parameters<typeof TourProtectionSummary>[0]['tours']}
        displayMonth={displayMonth}
      />

      {/* GTM-0F — reduced visual weight on the per-status counters.
          The protection summary above already carries the headline;
          these are now secondary "by-status" reference numbers with
          owner-friendly helper copy below the count. */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
        {(['scheduled', 'confirmed', 'completed', 'no_show'] as TourStatus[]).map((s) => {
          const cfg = STATUS_CONFIG[s]
          // GTM-0F — owner-friendly relabel + one-line helper.
          const ownerLabel: Record<TourStatus, string> = {
            scheduled: 'Scheduled tours',
            confirmed: 'Confirmed visits',
            completed: 'Completed tours',
            cancelled: 'Cancelled',
            no_show: 'No-shows',
          }
          const helperCopy: Record<TourStatus, string> = {
            scheduled: 'Need confirmation before the visit.',
            confirmed: 'Ready for the couple.',
            completed: 'Follow up while interest is warm.',
            cancelled: 'Out of the funnel.',
            no_show: 'Recover or reschedule quickly.',
          }
          return (
            <div
              key={s}
              className="bg-white border border-[#E6E8EF] rounded-[14px] p-4 shadow-card flex flex-col gap-2"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-[10.5px] uppercase tracking-[0.14em] text-[#64748B] font-semibold truncate">
                  {ownerLabel[s]}
                </span>
                <Badge variant={cfg.variant}>{cfg.label}</Badge>
              </div>
              <div className="text-[26px] font-semibold text-[#0F172A] tracking-[-0.022em] leading-none tabular-nums">
                {countByStatus(s)}
              </div>
              <p className="text-[11px] text-[#64748B] leading-snug">
                {helperCopy[s]}
              </p>
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
            {/* Phase 8AK — weekday strip with subtle separator + slightly
                more emphasis so the calendar reads as a proper grid (vs.
                the previous flush-to-cells weekday row). Today's column
                gets a dot affordance so the eye is drawn to the active
                column header before scanning down. */}
            <div className="grid grid-cols-7 mb-1.5 border-b border-[#EEF2F7] pb-1.5">
              {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d, idx) => {
                const isTodayCol = now.getDay() === idx &&
                  now.getMonth() === displayMonth.getMonth() &&
                  now.getFullYear() === displayMonth.getFullYear()
                return (
                  <div
                    key={d}
                    className="text-[10px] font-semibold uppercase tracking-[0.14em] text-center py-1.5 flex items-center justify-center gap-1"
                  >
                    <span className={isTodayCol ? 'text-[#0F172A]' : 'text-[#94A3B8]'}>
                      {d}
                    </span>
                    {isTodayCol && (
                      <span className="w-1 h-1 rounded-full bg-[#1D4ED8]" />
                    )}
                  </div>
                )
              })}
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
                        ? 'border-[#0F172A] bg-[#0F172A] text-white'
                        : dayTours.length > 0
                          ? 'border-[#E6E8EF] bg-white'
                          : 'border-[#EEF2F7] bg-[#F8FAFC]'
                    }`}
                  >
                    <span
                      className={`text-[11px] font-semibold ${
                        isToday ? 'text-white' : 'text-[#475569]'
                      }`}
                    >
                      {format(day, 'd')}
                    </span>
                    {/* Phase 8AK — every chip shows time + first name
                        (when available); the cell becomes scannable for
                        single-tour days too, not just multi-tour. The
                        2nd chip drops the name to stay legible at the
                        narrower column width. */}
                    {dayTours.slice(0, 2).map((tour, ti) => {
                      const t = tour as Record<string, unknown>
                      const cfg = STATUS_CONFIG[t.status as TourStatus]
                      const leadRel = t.leads as { name?: string | null } | null
                      const showName = ti === 0 && Boolean(leadRel?.name)
                      return (
                        <div
                          key={t.id as string}
                          className={`rounded-md px-1.5 py-0.5 text-[9px] font-medium truncate ${
                            isToday
                              ? 'bg-white/[0.10] text-white border border-white/[0.10]'
                              : cfg.chip
                          }`}
                          title={leadRel?.name ?? undefined}
                        >
                          {format(new Date(t.scheduled_at as string), 'h:mma')}
                          {showName && leadRel?.name ? (
                            <span className="ml-1 opacity-90">
                              {leadRel.name.split(' ')[0]}
                            </span>
                          ) : null}
                        </div>
                      )
                    })}
                    {dayTours.length > 2 && (
                      <span
                        className={`text-[9px] ${
                          isToday ? 'text-white/75' : 'text-[#94A3B8]'
                        }`}
                      >
                        +{dayTours.length - 2} more
                      </span>
                    )}
                  </div>
                )
              })}
            </div>
            {/* GTM-0F — calendar legend. Subtle row beneath the grid
                so first-time viewers can decode the chip colors at a
                glance. Tones match STATUS_CONFIG above. */}
            <div className="mt-3 pt-3 border-t border-[#F1F5F9] flex items-center gap-x-4 gap-y-1.5 flex-wrap text-[10.5px] text-[#64748B]">
              <span className="inline-flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-[#1D4ED8]" />
                Scheduled
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-[#0F172A]" />
                Confirmed
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-[#047857]" />
                Completed
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-[#92763C]" />
                Needs follow-up
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-[#B91C1C]" />
                No-show
              </span>
            </div>
          </CardContent>
        </Card>

        {/* GTM-0F — Upcoming Tours card relabeled "Tours needing
            protection." Same interactive component (drawer, mark
            confirmed, audit). The next-action framing now lives at
            the page level via the protection summary above. */}
        <Card>
          <CardHeader>
            <div>
              <CardTitle>Tours needing protection</CardTitle>
              <CardSubtitle>
                Upcoming visits that need confirmation, reminders, or a clean handoff.
              </CardSubtitle>
            </div>
          </CardHeader>
          <CardContent>
            <TourInteractionClient tours={upcomingTours} />
          </CardContent>
        </Card>
      </div>

      {/* GTM-0F — Completed-tour follow-up queue. Sits below the
          calendar row so the operator sees the "you toured them,
          now close them" workflow alongside the visual calendar.
          Reads from the broader summaryTours window so leads that
          toured last month and are still un-booked stay visible. */}
      <div className="mt-4">
        <CompletedTourFollowupList
          tours={summaryTours as Parameters<typeof CompletedTourFollowupList>[0]['tours']}
        />
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
