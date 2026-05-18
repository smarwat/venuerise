import { createClient } from '@/lib/supabase/server'
import PageHeader from '@/components/dashboard/PageHeader'
import { Card, CardContent, CardHeader, CardTitle, CardSubtitle } from '@/components/dashboard/ui/Card'
import { Button } from '@/components/dashboard/ui/Button'
import { Badge } from '@/components/dashboard/ui/Badge'
import { CalendarCheck, Clock, Plus, MapPin } from 'lucide-react'
import { format, startOfMonth, endOfMonth, eachDayOfInterval, isSameDay } from 'date-fns'
import RealtimeToursLayer from '@/components/dashboard/tours/RealtimeToursLayer'

type TourStatus = 'scheduled' | 'confirmed' | 'completed' | 'cancelled' | 'no_show'

const STATUS_CONFIG: Record<TourStatus, { label: string; variant: Parameters<typeof Badge>[0]['variant']; chip: string }> = {
  scheduled: { label: 'Scheduled', variant: 'blue',    chip: 'bg-[#EFF6FF] text-[#1D4ED8] border border-[#BFDBFE]' },
  confirmed: { label: 'Confirmed', variant: 'navy',    chip: 'bg-[#F1F5F9] text-[#0F172A] border border-[#E2E8F0]' },
  completed: { label: 'Completed', variant: 'green',   chip: 'bg-[#ECFDF5] text-[#047857] border border-[#A7F3D0]' },
  cancelled: { label: 'Cancelled', variant: 'default', chip: 'bg-[#F1F5F9] text-[#64748B] border border-[#E2E8F0]' },
  no_show:   { label: 'No Show',   variant: 'red',     chip: 'bg-[#FEF2F2] text-[#B91C1C] border border-[#FECACA]' },
}

export default async function ToursPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  const { data: venueRaw } = await supabase
    .from('venues').select('id').eq('owner_user_id', user!.id)
    .order('created_at').limit(1).maybeSingle()
  const venueId = (venueRaw as { id?: string } | null)?.id ?? null

  const now = new Date()
  const monthStart = startOfMonth(now)
  const monthEnd = endOfMonth(now)

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

  const daysInMonth = eachDayOfInterval({ start: monthStart, end: monthEnd })

  const countByStatus = (s: TourStatus) => tours.filter((t) => (t as Record<string, unknown>).status === s).length

  return (
    <div className="p-6 lg:p-8 animate-slide-up">
      <PageHeader
        title="Tours"
        subtitle="Schedule, confirm, and track every venue tour"
        actions={
          <Button size="sm">
            <Plus className="w-3.5 h-3.5" />
            Schedule Tour
          </Button>
        }
      />

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
        {/* Calendar */}
        <Card className="lg:col-span-2">
          <CardHeader>
            <div>
              <CardTitle>{format(now, 'MMMM yyyy')}</CardTitle>
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

        {/* Upcoming */}
        <Card>
          <CardHeader>
            <div>
              <CardTitle>Upcoming Tours</CardTitle>
              <CardSubtitle>Next on your calendar</CardSubtitle>
            </div>
          </CardHeader>
          <CardContent>
            {tours.length === 0 ? (
              <div className="text-center py-10">
                <div className="w-11 h-11 rounded-xl bg-[#F1F5F9] flex items-center justify-center mx-auto mb-2.5">
                  <CalendarCheck className="w-5 h-5 text-[#0F172A]" />
                </div>
                <p className="text-[13px] text-[#475569]">No tours scheduled this month.</p>
              </div>
            ) : (
              <div className="space-y-2.5">
                {tours
                  .filter((t) => ['scheduled', 'confirmed'].includes((t as Record<string, unknown>).status as string))
                  .slice(0, 5)
                  .map((tour) => {
                    const t = tour as Record<string, unknown>
                    const lead = t.leads as { name?: string } | null
                    const cfg = STATUS_CONFIG[t.status as TourStatus]
                    return (
                      <div key={t.id as string} className="bg-[#F8FAFC] border border-[#E2E8F0] rounded-2xl p-3.5 hover:border-[#CBD5E1] hover:bg-white transition-colors">
                        <div className="flex items-start gap-2.5">
                          <div className="w-9 h-9 rounded-full bg-gradient-to-br from-[#1E293B] to-[#0F172A] flex items-center justify-center text-white text-[12px] font-bold shrink-0">
                            {lead?.name?.charAt(0) ?? '?'}
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="text-[13px] font-semibold text-[#0F172A] truncate">{lead?.name ?? 'Unknown'}</p>
                            <div className="flex items-center gap-2 text-[11px] text-[#475569] mt-0.5">
                              <span className="inline-flex items-center gap-1"><Clock className="w-3 h-3" />{format(new Date(t.scheduled_at as string), 'MMM d • h:mm a')}</span>
                            </div>
                            {t.location_notes ? (
                              <div className="flex items-center gap-1 text-[11px] text-[#94A3B8] mt-1">
                                <MapPin className="w-3 h-3" />
                                {t.location_notes as string}
                              </div>
                            ) : null}
                          </div>
                          <Badge variant={cfg.variant}>{cfg.label}</Badge>
                        </div>
                      </div>
                    )
                  })}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
      {/* Phase 8C — non-rendering client component (except for a toast).
          Subscribes to public.tours postgres_changes filtered by venue_id
          and refreshes the page on any event. */}
      {venueId && <RealtimeToursLayer venueId={venueId} />}
    </div>
  )
}
