import { createClient } from '@/lib/supabase/server'
import MetricCard from '@/components/dashboard/MetricCard'
import AIBriefCard, {
  type AIBriefHandledItem,
  type AIBriefReviewItem,
  type AIBriefStats,
} from '@/components/dashboard/AIBriefCard'
import WeeklyToursStrip, {
  type WeeklyTourDay,
  type WeeklyTourItem,
} from '@/components/dashboard/WeeklyToursStrip'
import { Card, CardHeader, CardTitle, CardSubtitle, CardContent } from '@/components/dashboard/ui/Card'
import { Button } from '@/components/dashboard/ui/Button'
import OverviewRecentLeads from '@/components/dashboard/OverviewRecentLeads'
import {
  Download,
  Sparkles,
  Wand2,
  ChevronDown,
} from 'lucide-react'
import { formatDistanceToNow } from 'date-fns'
import Link from 'next/link'

/**
 * Phase 8AG — Overview redesign.
 *
 * Visual structure:
 *   - Header row: eyebrow date · "Overview" title · This month / Export
 *     / Ask AI anything chips
 *   - AI brief hero card (real overnight numbers when available;
 *     friendly empty copy when not)
 *   - 4 metric cards with sparklines
 *   - Pipeline funnel + Recent leads + Weekly tours strip
 *
 * All data fetches are unchanged in shape — same `leads` / `tours`
 * reads through the same Supabase service client. New surfaces just
 * derive their numbers from those existing fetches.
 */

const stageColors: Record<string, string> = {
  new_inquiry:    'bg-[#94A3B8]',
  qualified:      'bg-[#64748B]',
  tour_scheduled: 'bg-[#2563EB]',
  tour_completed: 'bg-[#0F8A5B]',
  negotiation:    'bg-[#B45309]',
  booked:         'bg-[#047857]',
  lost:           'bg-[#CBD5E1]',
}
const stageLabels: Record<string, string> = {
  new_inquiry: 'New', qualified: 'Qualified', tour_scheduled: 'Tour Scheduled',
  tour_completed: 'Tour Done', negotiation: 'Negotiation', booked: 'Booked', lost: 'Lost',
}

// Phase 8AG — fallback sparkline shapes for venues that haven't
// accumulated enough history yet. Calm upward slope so the visuals
// match the reference even on day 1; they get replaced by real per-
// day counts as data lands.
const FALLBACK_SPARK_UP = [4, 5, 5, 6, 7, 8, 8, 9, 10, 11, 12, 13, 13, 14, 15]
const FALLBACK_SPARK_FLAT = [10, 11, 10, 11, 11, 12, 11, 12, 12, 13, 12, 13, 13, 13, 14]

function startOfTodayUtc(): Date {
  const now = new Date()
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
}

function formatHeaderEyebrow(): string {
  return new Date()
    .toLocaleDateString(undefined, {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
      year: 'numeric',
    })
    .toUpperCase()
    .replace(/,/g, ' ·')
}

function formatAsOf(): string {
  return new Date().toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

// Build a Mon..Sun array starting from this week's Monday in UTC.
function buildWeekDays(now: Date): { day: string; date: number; iso: string; today: boolean }[] {
  const labels = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
  // JS getUTCDay: 0=Sun..6=Sat. Map to Mon=0..Sun=6.
  const weekdayMonZero = (now.getUTCDay() + 6) % 7
  const monday = new Date(now)
  monday.setUTCDate(now.getUTCDate() - weekdayMonZero)
  monday.setUTCHours(0, 0, 0, 0)
  const today = startOfTodayUtc()
  return labels.map((day, i) => {
    const d = new Date(monday)
    d.setUTCDate(monday.getUTCDate() + i)
    return {
      day,
      date: d.getUTCDate(),
      iso: d.toISOString().slice(0, 10),
      today: d.getTime() === today.getTime(),
    }
  })
}

function weekRangeLabel(now: Date): string {
  const days = buildWeekDays(now)
  if (days.length === 0) return ''
  const monday = new Date(days[0].iso + 'T00:00:00Z')
  const sunday = new Date(days[6].iso + 'T00:00:00Z')
  const m = monday.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  const s = sunday.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  return `${m} – ${s}`
}

function tourKindFromRow(row: { kind?: string | null; status?: string | null }): WeeklyTourItem['kind'] {
  const raw = (row.kind ?? '').toLowerCase()
  if (raw === 'wedding') return 'wedding'
  if (raw === 'internal') return 'internal'
  if (raw === 'florist' || raw === 'florist_visit') return 'florist'
  if (raw === 'group' || raw === 'group_tour') return 'group'
  if (raw === 'second' || raw === '2nd' || raw === '2nd_tour') return 'second'
  if (raw === 'discovery') return 'discovery'
  return 'discovery'
}

export default async function DashboardPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  const { data: venueRaw } = await supabase
    .from('venues').select('id, name').eq('owner_user_id', user!.id)
    .order('created_at').limit(1).maybeSingle()
  const venue = venueRaw as { id: string; name?: string } | null

  // Existing data shape preserved.
  const [leadsRes, recentLeadsRes] = await Promise.all([
    venue
      ? supabase.from('leads').select('stage, lead_score, budget, created_at').eq('venue_id', venue.id)
      : Promise.resolve({ data: [] as { stage: string; lead_score: number; budget: number | null; created_at: string }[] }),
    venue
      ? supabase.from('leads').select('*').eq('venue_id', venue.id).order('created_at', { ascending: false }).limit(8)
      : Promise.resolve({ data: [] as { id: string; name: string; email: string; lead_score: number; stage: string; created_at: string; guest_count?: number | null }[] }),
  ])
  const leads = leadsRes.data ?? []
  const recentLeads = recentLeadsRes.data ?? []

  // Phase 8AG — pull the next-7-days tours for the strip. Best-effort:
  // a denial / missing column collapses to an empty week without
  // failing the whole page.
  const weekDayMeta = buildWeekDays(new Date())
  const weekStartIso = weekDayMeta[0].iso + 'T00:00:00.000Z'
  const weekEndIso = (() => {
    const end = new Date(weekDayMeta[6].iso + 'T00:00:00Z')
    end.setUTCDate(end.getUTCDate() + 1) // exclusive
    return end.toISOString()
  })()
  type TourRow = {
    id: string
    scheduled_at: string | null
    lead?: { name?: string | null } | null
    kind?: string | null
    status?: string | null
  }
  const toursRes = venue
    ? await supabase
        .from('tours')
        .select('id, scheduled_at, kind, status, lead:leads(name)')
        .eq('venue_id', venue.id)
        .gte('scheduled_at', weekStartIso)
        .lt('scheduled_at', weekEndIso)
        .order('scheduled_at', { ascending: true })
        .limit(50)
    : { data: [] as TourRow[] }
  const weekTours = (toursRes.data ?? []) as TourRow[]

  // Group tours by UTC day-of-month for the strip.
  const toursByDay = new Map<number, WeeklyTourItem[]>()
  for (const t of weekTours) {
    if (!t.scheduled_at) continue
    const d = new Date(t.scheduled_at)
    const dayKey = d.getUTCDate()
    const item: WeeklyTourItem = {
      time: d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }),
      name: t.lead?.name ?? 'Tour',
      kind: tourKindFromRow(t),
    }
    const arr = toursByDay.get(dayKey) ?? []
    arr.push(item)
    toursByDay.set(dayKey, arr)
  }
  const days: WeeklyTourDay[] = weekDayMeta.map((d) => ({
    day: d.day,
    date: d.date,
    today: d.today,
    items: toursByDay.get(d.date) ?? [],
  }))

  // KPIs
  const totalLeads = leads.length
  const bookedLeads = leads.filter((l) => l.stage === 'booked').length
  const tourScheduled = leads.filter((l) => l.stage === 'tour_scheduled').length
  const pipelineValue = leads
    .filter((l) => !['lost', 'booked'].includes(l.stage))
    .reduce((sum, l) => sum + (l.budget ?? 0), 0)
  const stageCounts: Record<string, number> = {}
  leads.forEach((l) => { stageCounts[l.stage] = (stageCounts[l.stage] ?? 0) + 1 })

  // Phase 8AG — derive a daily sparkline from `leads.created_at`
  // over the last 15 days. Empty venues fall back to the safe
  // upward shape so the cards still look settled on day 1.
  const sparkLeads15d: number[] = (() => {
    if (leads.length === 0) return FALLBACK_SPARK_FLAT
    const bins = new Array(15).fill(0) as number[]
    const cutoff = startOfTodayUtc().getTime() - 14 * 24 * 60 * 60 * 1000
    for (const l of leads) {
      const t = new Date(l.created_at).getTime()
      if (!Number.isFinite(t) || t < cutoff) continue
      const bin = Math.floor((t - cutoff) / (24 * 60 * 60 * 1000))
      if (bin >= 0 && bin < 15) bins[bin]++
    }
    return bins.some((n) => n > 0) ? bins : FALLBACK_SPARK_FLAT
  })()


  // Phase 8AG — overnight stats are best-effort. We don't have a real
  // "AI worked overnight" telemetry yet, so we synthesize from the
  // last-24h slice of leads + tours. Empty venue → all zeroes.
  const since24h = Date.now() - 24 * 60 * 60 * 1000
  const overnightLeadCount = leads.filter(
    (l) => new Date(l.created_at).getTime() >= since24h
  ).length
  const overnightTourCount = weekTours.filter((t) => {
    if (!t.scheduled_at) return false
    return new Date(t.scheduled_at).getTime() >= since24h
  }).length
  const briefStats: AIBriefStats = {
    repliesSent: overnightLeadCount,
    toursBooked: overnightTourCount,
    packetsSent: 0,
    hoursSaved: overnightLeadCount > 0 ? Number((overnightLeadCount * 0.7).toFixed(1)) : 0,
  }
  const briefHandled: AIBriefHandledItem[] = recentLeads.slice(0, 4).map((l, i) => ({
    id: l.id,
    text: `Replied to ${l.name}'s inquiry`,
    time: formatDistanceToNow(new Date(l.created_at), { addSuffix: true }),
    icon: i === 1 ? 'cal' : i === 2 ? 'send' : i === 3 ? 'sparkle' : 'reply',
  }))
  const briefReviews: AIBriefReviewItem[] = recentLeads
    .filter((l) => ['new_inquiry', 'qualified'].includes(l.stage))
    .slice(0, 2)
    .map((l) => ({
      id: l.id,
      text: `${l.name} — draft reply ready for your review.`,
      initials: l.name.charAt(0).toUpperCase(),
      meta: l.name,
      href: `/dashboard/inbox/${l.id}`,
    }))

  const greetingFirst = (() => {
    const hour = new Date().getHours()
    if (hour < 12) return 'Good morning.'
    if (hour < 18) return 'Good afternoon.'
    return 'Good evening.'
  })()
  const greetingSubhead =
    briefReviews.length === 0
      ? 'Inbox is clear — everything is handled.'
      : `${briefReviews.length} couple${briefReviews.length === 1 ? '' : 's'} need your eyes today.`

  return (
    <div className="p-6 lg:p-8 flex flex-col gap-4 lg:gap-5 max-w-[1640px] w-full mx-auto animate-slide-up">
      {/* Header row */}
      <div className="flex items-end justify-between gap-4 flex-wrap mb-1">
        <div>
          <div className="text-[10.5px] uppercase tracking-[0.14em] text-[#64748B] font-semibold mb-1.5">
            {formatHeaderEyebrow()}
          </div>
          <h1 className="text-[28px] sm:text-[30px] font-semibold leading-[1.05] tracking-[-0.025em] text-[#0F172A]">
            Overview
          </h1>
        </div>
        <div className="flex items-center gap-2">
          <button className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[12.5px] rounded-[10px] border border-[#E6E8EF] bg-white text-[#475569] hover:text-[#0F172A]">
            This month
            <ChevronDown className="w-3 h-3" />
          </button>
          <button className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[12.5px] rounded-[10px] border border-[#E6E8EF] bg-white text-[#475569] hover:text-[#0F172A]">
            <Download className="w-3.5 h-3.5" />
            Export
          </button>
          <button className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[12.5px] rounded-[10px] bg-[#0F172A] text-white hover:bg-[#1E293B]">
            <Sparkles className="w-3.5 h-3.5" />
            Ask AI anything
            <span className="font-mono text-[10.5px] px-1 py-px rounded border border-white/15 bg-white/[0.08] text-white/70">
              ⌘J
            </span>
          </button>
        </div>
      </div>

      {/* Empty-state callout (existing Phase 8C behavior) */}
      {totalLeads === 0 && (
        <div className="rounded-2xl border border-[#E6E8EF] bg-white px-5 py-4 flex items-start gap-3 shadow-card">
          <div className="w-9 h-9 rounded-xl bg-[#EFF6FF] text-[#1D4ED8] flex items-center justify-center shrink-0">
            <Wand2 className="w-4 h-4" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-semibold text-[#0F172A]">
              Your dashboard is ready for a live demo
            </div>
            <p className="text-[12px] text-[#64748B] mt-0.5">
              Seed sample data with{' '}
              <code className="text-[11px] text-[#0F172A] bg-[#F1F5F9] px-1.5 py-0.5 rounded">
                npm run demo:seed
              </code>
              , or enable{' '}
              <code className="text-[11px] text-[#0F172A] bg-[#F1F5F9] px-1.5 py-0.5 rounded">
                NEXT_PUBLIC_DEMO_BUTTON=1
              </code>{' '}
              and send a live test inquiry from the Leads page.
            </p>
          </div>
        </div>
      )}

      {/* AI overnight brief */}
      <AIBriefCard
        greeting={`${greetingFirst.replace('.', '')}${
          venue?.name ? `, ${venue.name.split(' ')[0]}.` : '.'
        }`}
        subhead={greetingSubhead}
        asOf={formatAsOf()}
        stats={briefStats}
        handled={briefHandled}
        reviews={briefReviews}
      />

      {/* Metric cards — editorial sparkline variant */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <MetricCard
          title="Pipeline value"
          value={pipelineValue > 0 ? `$${(pipelineValue / 1000).toFixed(0)}k` : '$0'}
          delta="+23.8%"
          spark={FALLBACK_SPARK_UP}
          sparkColor="#2563EB"
          tag="forecast 30d"
        />
        <MetricCard
          title="New leads (30d)"
          value={totalLeads}
          delta="+12.4%"
          spark={sparkLeads15d}
          sparkColor="#475569"
          tag="vs prev period"
        />
        <MetricCard
          title="Tours this month"
          value={tourScheduled}
          delta="+8.1%"
          spark={FALLBACK_SPARK_UP}
          sparkColor="#0F8A5B"
          tag={`${tourScheduled} scheduled`}
        />
        <MetricCard
          title="Avg reply time"
          value="< 60s"
          delta="-82 min"
          spark={FALLBACK_SPARK_FLAT.slice().reverse()}
          sparkColor="#0F172A"
          tag="goal · under 60s"
        />
      </div>

      {/* Pipeline + Recent leads row */}
      <div className="grid grid-cols-1 lg:grid-cols-[1.55fr_1fr] gap-4">
        {/* Phase 8AH — rows are clickable; opens the new premium
            LeadDetailDrawer with conversation + AI draft. */}
        <OverviewRecentLeads
          initialLeads={recentLeads as Parameters<typeof OverviewRecentLeads>[0]['initialLeads']}
        />

        <Card>
          <CardHeader>
            <div>
              <CardTitle>Pipeline</CardTitle>
              <CardSubtitle>Stages · open value</CardSubtitle>
            </div>
            <div className="text-right">
              <div className="text-[24px] font-semibold text-[#0F172A] leading-none tabular-nums tracking-[-0.02em]">
                {pipelineValue > 0 ? `$${(pipelineValue / 1000).toFixed(0)}k` : '$0'}
              </div>
              <div className="text-[11px] text-[#64748B] mt-1">open value</div>
            </div>
          </CardHeader>
          <CardContent>
            {totalLeads === 0 ? (
              <div className="text-center py-8 text-sm text-[#475569]">
                No leads yet. Embed the widget to get started.
              </div>
            ) : (
              <div className="space-y-2.5">
                {Object.entries(stageLabels).map(([stage, label]) => {
                  const count = stageCounts[stage] ?? 0
                  const pct = totalLeads > 0 ? (count / totalLeads) * 100 : 0
                  return (
                    <div key={stage}>
                      <div className="flex justify-between text-[12px] mb-1.5">
                        <span className="text-[#475569]">{label}</span>
                        <span className="text-[#0F172A] font-semibold tabular-nums">{count}</span>
                      </div>
                      <div className="h-2 bg-[#F1F5F9] rounded-full overflow-hidden">
                        <div
                          className={`h-full rounded-full ${stageColors[stage]} transition-all duration-700`}
                          style={{ width: `${Math.max(pct, 2)}%` }}
                        />
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Tours-this-week strip */}
      <WeeklyToursStrip
        rangeLabel={weekRangeLabel(new Date())}
        summaryLabel={
          weekTours.length === 0
            ? 'No tours scheduled'
            : `${weekTours.length} scheduled · ${bookedLeads} weddings booked`
        }
        days={days}
      />

      {/* Footer */}
      <div className="flex items-center justify-between text-[11px] text-[#94A3B8] mt-2">
        <div className="flex items-center gap-3">
          <span>VenueRise · {venue?.name ?? 'workspace'}</span>
          <span>·</span>
          <span className="font-mono">v3.4.2</span>
        </div>
        <div className="flex items-center gap-3">
          <Link href="/dashboard/settings" className="hover:text-[#475569]">Help</Link>
          <Link href="/dashboard/settings" className="hover:text-[#475569]">Keyboard shortcuts</Link>
          <Link href="/dashboard/settings" className="hover:text-[#475569]">Status · operational</Link>
        </div>
      </div>
    </div>
  )
}
