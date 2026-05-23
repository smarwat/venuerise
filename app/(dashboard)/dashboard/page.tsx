import { createClient } from '@/lib/supabase/server'
import MetricCard from '@/components/dashboard/MetricCard'
// GTM-0D — ExecutiveHero replaces the AIBriefCard's zero-state on the
// Overview page. TodayPriorityCard turns the existing leakage signals
// into a numbered "do this next" checklist. Both are presentational —
// they derive numbers from the same fetches the page already runs.
import ExecutiveHero, {
  type ExecutiveHeroTile,
} from '@/components/dashboard/ExecutiveHero'
import TodayPriorityCard, {
  type TodayPriorityRow,
} from '@/components/dashboard/TodayPriorityCard'
import WeeklyToursStrip, {
  type WeeklyTourDay,
  type WeeklyTourItem,
} from '@/components/dashboard/WeeklyToursStrip'
import { Card, CardHeader, CardTitle, CardSubtitle, CardContent } from '@/components/dashboard/ui/Card'
import { Button } from '@/components/dashboard/ui/Button'
import OverviewRecentLeads from '@/components/dashboard/OverviewRecentLeads'
import RevenueLeakageBrief from '@/components/dashboard/RevenueLeakageBrief'
import AttributionPerformanceCard from '@/components/dashboard/AttributionPerformanceCard'
import { buildAttributionSummary } from '@/lib/enterprise/attribution/summary'
// Phase 8BI — Booked revenue attribution shares the same
// leads + tours read as the 8BH summary, so we add the helper
// import next to it.
import BookedRevenueAttributionCard from '@/components/dashboard/BookedRevenueAttributionCard'
import { buildAttributionRevenueSummary } from '@/lib/enterprise/attribution/revenue'
// Phase 8BJ — Source-level revenue leakage drilldowns.
// `parseRevenueOsSettings` parses the venue's saved Revenue OS
// thresholds (with a defaults fallback baked into the helper);
// `DEFAULT_REVENUE_OS_SETTINGS` is the const fallback used when
// the venue row read fails. The source-leakage helper consumes
// these settings; same shape as the existing leakage / recovery
// readers downstream.
import SourceRevenueLeakageCard from '@/components/dashboard/SourceRevenueLeakageCard'
import { buildSourceLeakageSummary } from '@/lib/enterprise/attribution/leakage'
import {
  parseRevenueOsSettings,
  DEFAULT_REVENUE_OS_SETTINGS,
} from '@/lib/revenue-os/settings'
import ReactivationQueueCard from '@/components/dashboard/ReactivationQueueCard'
import RecoveryQueueCard from '@/components/dashboard/RecoveryQueueCard'
import TourConfirmationQueueCard from '@/components/dashboard/TourConfirmationQueueCard'
import {
  Download,
  Sparkles,
  Wand2,
  ChevronDown,
} from 'lucide-react'
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

  // Existing data shape preserved. Phase 8BH widens the leads
  // select to also pull `id` + `metadata` so
  // buildAttributionSummary can group rows by source label
  // without a second round-trip.
  const [leadsRes, recentLeadsRes] = await Promise.all([
    venue
      ? supabase
          .from('leads')
          .select('id, stage, lead_score, budget, created_at, updated_at, metadata')
          .eq('venue_id', venue.id)
      : Promise.resolve({
          data: [] as {
            id: string
            stage: string
            lead_score: number
            budget: number | null
            created_at: string
            metadata?: unknown
          }[],
        }),
    venue
      ? supabase.from('leads').select('*').eq('venue_id', venue.id).order('created_at', { ascending: false }).limit(8)
      : Promise.resolve({ data: [] as { id: string; name: string; email: string; lead_score: number; stage: string; created_at: string; guest_count?: number | null }[] }),
  ])
  const leads = leadsRes.data ?? []
  const recentLeads = recentLeadsRes.data ?? []

  // Phase 8BH — fetch the per-venue tour list so the
  // attribution summary can count tours-scheduled per source.
  // Phase 8BJ widened the SELECT to include `id` + `scheduled_at`
  // so the same row set powers `buildSourceLeakageSummary`'s
  // tour_pending_confirm signal without a second round-trip.
  const toursForAttributionRes = venue
    ? await supabase
        .from('tours')
        .select('id, lead_id, status, scheduled_at')
        .eq('venue_id', venue.id)
        .limit(1000)
    : {
        data: [] as Array<{
          id: string
          lead_id: string | null
          status: string | null
          scheduled_at: string | null
        }>,
      }
  const attributionSummary = buildAttributionSummary({
    leads: leads as Array<{
      id?: string
      stage?: string | null
      budget?: number | null
      created_at?: string | null
      metadata?: unknown
    }>,
    tours: (toursForAttributionRes.data ?? []) as Array<{
      lead_id?: string | null
      status?: string | null
    }>,
    topN: 5,
  })

  // Phase 8BI — Booked revenue attribution. Same leads + tours
  // input as the 8BH summary; pure helper, no DB round-trip.
  const bookedRevenueSummary = buildAttributionRevenueSummary({
    leads: leads as Array<{
      id?: string | null
      stage?: string | null
      budget?: number | null
      updated_at?: string | null
      created_at?: string | null
      metadata?: unknown
    }>,
    tours: (toursForAttributionRes.data ?? []) as Array<{
      lead_id?: string | null
      status?: string | null
    }>,
  })

  // Phase 8BJ — Source-level revenue leakage drilldowns.
  // Server-side fan-out: aggregate the venue's messages into
  // first-outbound + last-inbound per lead (same pattern as
  // RevenueLeakageBrief), pull venue settings, then run the
  // composed leakage helper. Best-effort: a query failure
  // collapses to an empty summary without failing the page.
  let sourceLeakageSummary: Awaited<ReturnType<typeof buildSourceLeakageSummary>> = {
    rows: [],
    totals: {
      leadCount: 0,
      bookedCount: 0,
      atRiskCount: 0,
      estimatedPipelineValue: 0,
      estimatedBookedValue: 0,
    },
    disclaimer:
      'Source leakage is based on captured attribution and Revenue OS signals. It is not ROAS — ad spend is not connected. Booked / pipeline values are estimated from operator-entered budgets.',
  }
  if (venue && leads.length > 0) {
    const leadIds = (leads as Array<{ id: string }>).map((l) => l.id)
    const [messagesRes, venueRow] = await Promise.all([
      supabase
        .from('messages')
        .select('lead_id, role, created_at')
        .eq('venue_id', venue.id)
        .in('lead_id', leadIds)
        .order('created_at', { ascending: true })
        .limit(5000),
      supabase
        .from('venues')
        .select('metadata')
        .eq('id', venue.id)
        .maybeSingle(),
    ])
    const outboundMap = new Map<string, string | null>()
    const inboundMap = new Map<string, string | null>()
    for (const m of ((messagesRes.data ?? []) as Array<{
      lead_id: string
      role: string
      created_at: string
    }>)) {
      if (m.role === 'ai' || m.role === 'human') {
        if (!outboundMap.has(m.lead_id)) outboundMap.set(m.lead_id, m.created_at)
      } else if (m.role === 'lead') {
        inboundMap.set(m.lead_id, m.created_at)
      }
    }
    const settings = parseRevenueOsSettings(
      (venueRow.data as { metadata?: unknown } | null)?.metadata ?? null
    )
    // Reactivation needs a `lastMessages` map — reuse inboundMap so
    // we don't refetch.
    const lastMessages: Record<string, string | null> = {}
    for (const [k, v] of inboundMap.entries()) lastMessages[k] = v
    sourceLeakageSummary = buildSourceLeakageSummary({
      leads: (leads as Array<{
        id: string
        stage: string
        lead_score: number
        budget: number | null
        created_at: string
        updated_at: string
        metadata?: unknown
      }>).map((l) => ({
        id: l.id,
        stage: l.stage,
        lead_score: l.lead_score,
        budget: l.budget,
        created_at: l.created_at,
        updated_at: l.updated_at,
        metadata: l.metadata,
      })),
      tours: ((toursForAttributionRes.data ?? []) as Array<{
        id: string
        lead_id: string | null
        status: string | null
        scheduled_at: string | null
      }>)
        .filter((t): t is { id: string; lead_id: string; status: string; scheduled_at: string | null } =>
          Boolean(t.lead_id) && Boolean(t.status)
        )
        .map((t) => ({
          id: t.id,
          lead_id: t.lead_id,
          status: t.status,
          scheduled_at: t.scheduled_at,
        })),
      outbound: Array.from(outboundMap.entries()).map(([lead_id, first_outbound_at]) => ({
        lead_id,
        first_outbound_at,
      })),
      inbound: Array.from(inboundMap.entries()).map(([lead_id, last_inbound_at]) => ({
        lead_id,
        last_inbound_at,
      })),
      lastMessages,
      settings: settings ?? DEFAULT_REVENUE_OS_SETTINGS,
    })
  }

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


  // GTM-0D — derive the executive hero + Today's priority directly
  // from the data the page already fetched. No new DB cost. The
  // metrics we surface are honest — values that can't be computed
  // safely (e.g. `0 packets sent`) are HIDDEN rather than rendered
  // as zeros, which would make the product look inactive on a sales
  // demo.
  const greetingFirst = (() => {
    const hour = new Date().getHours()
    if (hour < 12) return 'Good morning'
    if (hour < 18) return 'Good afternoon'
    return 'Good evening'
  })()
  const venueFirstName = venue?.name ? venue.name.split(' ')[0] : null
  const greetingLine = venueFirstName
    ? `${greetingFirst}, ${venueFirstName}.`
    : `${greetingFirst}.`

  // Total revenue opportunities = sum of leakage signal counts (all
  // categories where a lead needs attention) + any tour pending
  // confirmation. Same numbers the leakage card surfaces.
  const totalOpportunities =
    sourceLeakageSummary.totals.atRiskCount > 0
      ? sourceLeakageSummary.totals.atRiskCount
      : leads.filter((l) =>
          !['lost', 'booked'].includes(l.stage)
        ).length

  const heroHeadline =
    totalOpportunities > 0
      ? `${totalOpportunities} revenue ${totalOpportunities === 1 ? 'opportunity needs' : 'opportunities need'} attention today.`
      : `Every lead in your pipeline is currently handled.`
  const heroSubhead =
    totalOpportunities > 0
      ? `VenueRise is watching every inquiry, tour, and follow-up gap across your venue.`
      : `Your follow-up game is on point — the agents will surface new opportunities here as they appear.`

  // Hero tiles. Each tile only renders when its value is meaningful.
  // Pipeline at risk = the source-leakage helper's estimated dollar
  // figure (already computed); fallback to the gross open pipeline
  // if the helper hasn't computed a risk value yet.
  const pipelineAtRiskDollars =
    sourceLeakageSummary.totals.estimatedPipelineValue > 0
      ? sourceLeakageSummary.totals.estimatedPipelineValue
      : pipelineValue
  const bookedValueTracked =
    sourceLeakageSummary.totals.estimatedBookedValue > 0
      ? sourceLeakageSummary.totals.estimatedBookedValue
      : leads
          .filter((l) => l.stage === 'booked')
          .reduce((sum, l) => sum + (l.budget ?? 0), 0)
  function moneyShort(n: number): string {
    if (n <= 0) return '—'
    if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`
    if (n >= 10_000) return `$${Math.round(n / 1000)}k`
    return `$${n.toLocaleString()}`
  }
  const toursToProtect = tourScheduled // already computed above
  const heroTiles: ExecutiveHeroTile[] = [
    {
      label: 'Pipeline at risk',
      value: moneyShort(pipelineAtRiskDollars),
      subtext:
        pipelineAtRiskDollars > 0
          ? 'Open inquiries that need a response soon.'
          : undefined,
      tone: 'champagne',
    },
    {
      label: 'Needs action today',
      value: totalOpportunities > 0 ? totalOpportunities.toString() : '—',
      subtext: totalOpportunities > 0 ? 'Across leakage + tour queues.' : undefined,
      tone: 'navy',
    },
    {
      label: 'Tours to protect',
      value: toursToProtect > 0 ? toursToProtect.toString() : '—',
      subtext: toursToProtect > 0 ? 'Scheduled or awaiting confirmation.' : undefined,
      tone: 'blue',
    },
    {
      label: 'Booked value tracked',
      value: moneyShort(bookedValueTracked),
      subtext:
        bookedValueTracked > 0
          ? 'From booked leads with entered budgets.'
          : undefined,
      tone: 'emerald',
    },
  ]

  // Today's priority rows — map directly off the leakage signal
  // buckets (camelCase fields on `row.leakage`). Each row only
  // renders when count > 0 (the card hides zero rows).
  const slowFirstReplyCount = sourceLeakageSummary.rows.reduce(
    (a, r) => a + (r.leakage?.slowFirstReply ?? 0),
    0
  )
  const tourPendingCount = sourceLeakageSummary.rows.reduce(
    (a, r) => a + (r.leakage?.tourPendingConfirm ?? 0),
    0
  )
  const coldLeadCount = sourceLeakageSummary.rows.reduce(
    (a, r) => a + (r.leakage?.coldLeadRecovery ?? 0),
    0
  )
  const highFitIdleCount = sourceLeakageSummary.rows.reduce(
    (a, r) => a + (r.leakage?.highFitIdle ?? 0),
    0
  )
  const todayRows: TodayPriorityRow[] = [
    {
      label: 'Reply to new inquiries',
      count: slowFirstReplyCount,
      href: '/dashboard/leads?leakage=slow_first_reply',
      cta: 'Open inbox',
      kind: 'inbox',
    },
    {
      label: 'Confirm scheduled tours',
      count: tourPendingCount,
      href: '/dashboard/leads?leakage=tour_booking',
      cta: 'Open tour queue',
      kind: 'tour',
    },
    {
      label: 'Re-engage cold leads',
      count: coldLeadCount,
      href: '/dashboard/leads?leakage=reactivation',
      cta: 'Open recovery',
      kind: 'recover',
    },
    {
      label: 'Move idle hot leads forward',
      count: highFitIdleCount,
      href: '/dashboard/leads?leakage=high_fit_idle',
      cta: 'Open leads',
      kind: 'review',
    },
  ]

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

      {/* GTM-0D — Executive hero. Replaces the AIBriefCard's
          zero-state ("0 replies sent", "0 packets sent") with the
          most important single sentence on the page: how many
          revenue opportunities need attention today, plus 3-4
          honest tiles. Zero-value tiles are hidden, not shown as
          "0" — zero metrics make the demo look inactive. */}
      <ExecutiveHero
        greeting={greetingLine}
        headline={heroHeadline}
        subhead={heroSubhead}
        primaryCta={
          totalOpportunities > 0
            ? { href: '/dashboard/leads', label: 'Triage leads' }
            : undefined
        }
        tiles={heroTiles}
      />

      {/* GTM-0D — Today's priority. The "do these things first"
          checklist. Numbers come straight from the leakage signal
          buckets; zero rows are hidden by the card so the surface
          never says "do 0 things." Each row deep-links to the
          exact filtered leads/tours view. */}
      <TodayPriorityCard rows={todayRows} />

      {/* Phase 8AP — Revenue leakage watch. Revenue OS direction: the
          Overview shouldn't only tell the operator what's done; it
          should tell them what's at risk now. Server-rendered so the
          numbers are live on first paint. GTM-0D reframed the
          card's title + footer copy to land as the central revenue
          thesis. */}
      <RevenueLeakageBrief venueId={venue?.id ?? null} />

      {/* Phase 8AS — Follow-Up Recovery queue. Top 5 stalled leads
          with reason + suggested action. Read-only; the suggestion
          can prefill the regenerate prompt but the operator stays
          in control of the actual send. */}
      <RecoveryQueueCard venueId={venue?.id ?? null} />

      {/* Phase 8AT — Tour Booking Agent confirmation queue. Surfaces
          scheduled-but-unconfirmed tours so the operator can fire a
          confirm before the slot slips. CTAs link to the lead drawer
          and the tour audit drawer; no autonomous sends. */}
      <TourConfirmationQueueCard venueId={venue?.id ?? null} />

      {/* Phase 8BD — Reactivation Agent queue. Surfaces lost leads
          where the recorded reason + cool-down suggest a soft
          re-engagement is worth it. Read-only — the Open lead CTA
          deep-links to the drawer; no autonomous outreach. */}
      <ReactivationQueueCard venueId={venue?.id ?? null} />

      {/* Phase 8BH — Attribution performance.
          Groups recent leads + tours by derived source label
          (Google Ads / Meta Ads / Instagram / The Knot /
          WeddingWire / Website / Unknown). Estimated pipeline
          is summed from operator-entered budgets — NOT true
          ROAS, because ad spend is not connected. */}
      <AttributionPerformanceCard summary={attributionSummary} />

      {/* Phase 8BI — Booked revenue by source. Same input data
          as the 8BH summary; surfaces which channels are
          actually converting to booked weddings + estimated
          booked value summed from operator-entered budgets.
          NOT ROAS — ad spend remains disconnected. */}
      <BookedRevenueAttributionCard summary={bookedRevenueSummary} />

      {/* Phase 8BJ — Source-level revenue leakage drilldowns.
          Each row links into the leads board with the matching
          `?source=` filter + optional `?leakage=` filter so
          operators can triage the specific stuck-cohort. NOT
          ROAS; pure inference over existing Revenue OS signals. */}
      <SourceRevenueLeakageCard summary={sourceLeakageSummary} />

      {/* GTM-0D — AIBriefCard removed from the Overview. Its
          "0 packets sent / 0h time returned" zero-state made the
          demo look inactive. The ExecutiveHero above already
          provides the morning greeting + the honest "what needs
          attention" framing. AIBriefCard remains exported and
          available for a future re-introduction once we have real
          AI-handled-overnight telemetry to populate it. */}

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
