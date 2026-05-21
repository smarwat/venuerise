import { createClient } from '@/lib/supabase/server'
import PageHeader from '@/components/dashboard/PageHeader'
import { Card, CardContent, CardHeader, CardTitle, CardSubtitle } from '@/components/dashboard/ui/Card'
import { Button } from '@/components/dashboard/ui/Button'
import LeadsOverTimeChart from '@/components/dashboard/LeadsOverTimeChart'
import FunnelChart from '@/components/dashboard/FunnelChart'
import { subDays, format, eachDayOfInterval } from 'date-fns'
import { Sparkles, TrendingUp } from 'lucide-react'
// Phase 8BH — attribution breakdown on /dashboard/analytics.
// Same summary helper as the Overview card; rendered as a
// table here for an at-a-glance per-source view.
import { buildAttributionSummary } from '@/lib/enterprise/attribution/summary'
import AttributionSourceBadge from '@/components/dashboard/AttributionSourceBadge'
// Phase 8BI — booked revenue by source. Same leads + tours
// input as the 8BH summary; pure helper.
import {
  buildAttributionRevenueSummary,
  formatBookedValueShort,
} from '@/lib/enterprise/attribution/revenue'
// Phase 8BJ — source-level revenue leakage breakdown for the
// analytics page. Pure helper, composes existing Revenue OS
// signals + attribution labels.
import {
  buildSourceLeakageSummary,
  SOURCE_LEAKAGE_LABEL,
  type SourceLeakageSummary,
} from '@/lib/enterprise/attribution/leakage'
import { parseRevenueOsSettings } from '@/lib/revenue-os/settings'
import Link from 'next/link'
import { ArrowUpRight } from 'lucide-react'

type Lead = { stage: string; lead_score: number; budget: number | null; created_at: string }

export default async function AnalyticsPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  const { data: venueRaw } = await supabase
    .from('venues').select('id, metadata').eq('owner_user_id', user!.id)
    .order('created_at').limit(1).maybeSingle()
  const venueId = (venueRaw as { id?: string } | null)?.id ?? null
  // Phase 8BJ — venue Revenue OS settings drive the leakage
  // thresholds. `parseRevenueOsSettings` always returns a
  // fully-populated config (defaults when metadata is empty),
  // so the breakdown still renders for venues that never opened
  // /dashboard/settings.
  const revenueOsSettings = parseRevenueOsSettings(
    (venueRaw as { metadata?: unknown } | null)?.metadata
  )

  const thirtyDaysAgo = subDays(new Date(), 30).toISOString()

  const [leadsRes, toursRes, aiActionsRes, allLeadsRes, attributionLeadsRes, attributionToursRes] = await Promise.all([
    venueId ? supabase.from('leads').select('stage, lead_score, budget, created_at').eq('venue_id', venueId).gte('created_at', thirtyDaysAgo) : Promise.resolve({ data: [] as Lead[] }),
    venueId ? supabase.from('tours').select('status').eq('venue_id', venueId) : Promise.resolve({ data: [] }),
    venueId ? supabase.from('ai_actions').select('latency_ms').eq('venue_id', venueId).eq('success', true) : Promise.resolve({ data: [] }),
    venueId ? supabase.from('leads').select('stage').eq('venue_id', venueId) : Promise.resolve({ data: [] }),
    // Phase 8BH — wider read for the attribution breakdown.
    // Capped at 1000 most-recent rows so analytics stays fast
    // for venues with deep history.
    venueId
      ? supabase
          .from('leads')
          .select('id, stage, lead_score, budget, created_at, updated_at, metadata')
          .eq('venue_id', venueId)
          .order('created_at', { ascending: false })
          .limit(1000)
      : Promise.resolve({ data: [] }),
    venueId
      ? supabase
          .from('tours')
          .select('id, lead_id, status, scheduled_at')
          .eq('venue_id', venueId)
          .limit(1000)
      : Promise.resolve({ data: [] }),
  ])

  // Phase 8BJ — pull recent messages so the source-leakage helper
  // can compute slow-first-reply / cold-recovery / reactivation
  // signals. Capped at 5000 rows to keep the analytics page snappy
  // for venues with deep history. Mirrors the dashboard-page cap.
  const messagesRes = venueId
    ? await supabase
        .from('messages')
        .select('lead_id, role, content, created_at')
        .eq('venue_id', venueId)
        .order('created_at', { ascending: true })
        .limit(5000)
    : { data: [] as Array<{
        lead_id: string
        role: string
        content: string | null
        created_at: string
      }> }
  const messages = (messagesRes.data ?? []) as Array<{
    lead_id: string
    role: string
    content: string | null
    created_at: string
  }>

  const leads = (leadsRes.data ?? []) as Lead[]
  const tours = (toursRes.data ?? []) as { status: string }[]
  const aiActions = (aiActionsRes.data ?? []) as { latency_ms: number | null }[]
  const allLeads = (allLeadsRes.data ?? []) as { stage: string }[]
  const attributionLeads = (attributionLeadsRes.data ?? []) as Array<{
    id?: string
    stage?: string | null
    lead_score?: number | null
    budget?: number | null
    created_at?: string | null
    updated_at?: string | null
    metadata?: unknown
  }>
  const attributionTours = (attributionToursRes.data ?? []) as Array<{
    id?: string | null
    lead_id?: string | null
    status?: string | null
    scheduled_at?: string | null
  }>
  const attributionSummary = buildAttributionSummary({
    leads: attributionLeads,
    tours: attributionTours,
    topN: 10,
  })
  // Phase 8BI — booked revenue summary off the same input.
  const bookedRevenueSummary = buildAttributionRevenueSummary({
    leads: attributionLeads as Array<{
      id?: string | null
      stage?: string | null
      budget?: number | null
      updated_at?: string | null
      created_at?: string | null
      metadata?: unknown
    }>,
    tours: attributionTours,
  })

  // Phase 8BJ — source-level leakage breakdown. Reuses the same
  // (leads, tours, messages) read; bucketed by attribution source.
  // Empty-summary fallback keeps the analytics page rendering even
  // when the venue has no leads yet.
  let sourceLeakageSummary: SourceLeakageSummary = {
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
  if (venueId && attributionLeads.length > 0) {
    // Build outbound + inbound + lastInbound maps from the
    // ascending-time message stream — single pass, deterministic.
    const outboundMap = new Map<string, string | null>()
    const inboundMap = new Map<string, string | null>()
    const lastInboundMap: Record<string, string | null> = {}
    for (const m of messages) {
      const isOutbound = m.role === 'ai' || m.role === 'human'
      if (isOutbound) {
        if (!outboundMap.has(m.lead_id)) outboundMap.set(m.lead_id, m.created_at)
      } else if (m.role === 'lead') {
        inboundMap.set(m.lead_id, m.created_at)
        lastInboundMap[m.lead_id] = m.created_at
      }
    }
    const outbound = Array.from(outboundMap.entries()).map(
      ([lead_id, first_outbound_at]) => ({ lead_id, first_outbound_at })
    )
    const inbound = Array.from(inboundMap.entries()).map(
      ([lead_id, last_inbound_at]) => ({ lead_id, last_inbound_at })
    )
    // Helpers need `LeakageLead` shape — id/stage/lead_score/
    // created_at/updated_at must all be present. Fill with safe
    // defaults so the type-checker is satisfied without changing
    // the source data semantics.
    const leakageLeads = attributionLeads
      .filter((l) => typeof l.id === 'string')
      .map((l) => ({
        id: l.id as string,
        stage: l.stage ?? 'new_inquiry',
        lead_score: typeof l.lead_score === 'number' ? l.lead_score : 0,
        created_at: l.created_at ?? new Date().toISOString(),
        updated_at: l.updated_at ?? l.created_at ?? new Date().toISOString(),
        budget: l.budget ?? null,
        metadata: l.metadata,
      }))
    const leakageTours = attributionTours
      .filter((t) => typeof t.id === 'string' && typeof t.lead_id === 'string')
      .map((t) => ({
        id: t.id as string,
        lead_id: t.lead_id as string,
        status: t.status ?? 'pending',
        scheduled_at: t.scheduled_at ?? null,
      }))
    sourceLeakageSummary = buildSourceLeakageSummary({
      leads: leakageLeads,
      tours: leakageTours,
      outbound,
      inbound,
      lastMessages: lastInboundMap,
      settings: revenueOsSettings,
    })
  }

  const days = eachDayOfInterval({ start: subDays(new Date(), 29), end: new Date() })
  const leadsOverTime = days.map((day) => ({
    date: format(day, 'MMM d'),
    leads: leads.filter((l) => format(new Date(l.created_at), 'yyyy-MM-dd') === format(day, 'yyyy-MM-dd')).length,
  }))

  const stagesInOrder = ['new_inquiry', 'qualified', 'tour_scheduled', 'tour_completed', 'negotiation', 'booked']
  const stageLabels: Record<string, string> = {
    new_inquiry: 'New Inquiry', qualified: 'Qualified', tour_scheduled: 'Tour Scheduled',
    tour_completed: 'Tour Completed', negotiation: 'Negotiation', booked: 'Booked',
  }
  // Phase 8AK — restrained slate / blue / emerald palette only. Drops
  // amber for `negotiation` (replaced with a deeper slate) so the funnel
  // reads as a clean "cold → warm → won" gradient without warning-
  // adjacent tones competing for the operator's eye.
  const stageColors: Record<string, string> = {
    new_inquiry:    '#94A3B8',
    qualified:      '#64748B',
    tour_scheduled: '#1D4ED8',
    tour_completed: '#10B981',
    negotiation:    '#334155',
    booked:         '#059669',
  }
  const funnelStages = stagesInOrder.map((stage) => ({
    stage,
    label: stageLabels[stage],
    count: allLeads.filter((l) => stagesInOrder.indexOf(l.stage) >= stagesInOrder.indexOf(stage)).length,
    color: stageColors[stage],
  }))

  const totalLeads30d = leads.length
  const avgScore = leads.length > 0 ? Math.round(leads.reduce((s, l) => s + l.lead_score, 0) / leads.length) : 0
  const conversionRate = allLeads.length > 0 ? Math.round((allLeads.filter((l) => l.stage === 'booked').length / allLeads.length) * 100) : 0
  const pipelineValue = allLeads.filter((l) => !['lost', 'booked'].includes(l.stage)).length * 15000
  const toursCompleted = tours.filter((t) => t.status === 'completed').length
  const avgResponseMs = aiActions.length > 0 ? Math.round(aiActions.reduce((s, a) => s + (a.latency_ms ?? 0), 0) / aiActions.length) : 0

  const kpis = [
    { label: 'Leads (30d)', value: totalLeads30d },
    { label: 'Avg Score', value: avgScore },
    { label: 'Conversion', value: `${conversionRate}%` },
    { label: 'Pipeline', value: `$${(pipelineValue / 1000).toFixed(0)}k` },
    { label: 'Tours Done', value: toursCompleted },
    { label: 'AI Latency', value: avgResponseMs > 0 ? `${(avgResponseMs / 1000).toFixed(1)}s` : '—' },
  ]

  return (
    <div className="p-6 lg:p-8 animate-slide-up">
      <PageHeader
        title="Analytics"
        subtitle="30-day performance and conversion funnel"
        actions={<Button variant="outline" size="sm" className="rounded-full">Last 30 days</Button>}
      />

      {/* Phase 8AI — editorial KPI tiles: uppercase eyebrow above
          tabular number, soft border, no icon clutter. Matches the
          Overview metric strip's rhythm. */}
      <div className="grid grid-cols-3 lg:grid-cols-6 gap-3 mb-6">
        {kpis.map((kpi) => (
          <div
            key={kpi.label}
            className="bg-white border border-[#E6E8EF] rounded-2xl p-4 shadow-card"
          >
            <div className="text-[10.5px] uppercase tracking-[0.14em] text-[#64748B] font-semibold">
              {kpi.label}
            </div>
            <div className="text-[22px] sm:text-[24px] font-semibold text-[#0F172A] tracking-[-0.02em] leading-none tabular-nums mt-2">
              {kpi.value}
            </div>
          </div>
        ))}
      </div>

      {/* Phase 8A — soft empty-state hint when nothing has been intaked yet.
          Renders ABOVE the charts so an empty graph doesn't look broken. */}
      {allLeads.length === 0 && (
        <div className="mb-6 rounded-2xl border border-[#E2E8F0] bg-white px-5 py-4 flex items-start gap-3">
          <div className="w-9 h-9 rounded-xl bg-[#F1F5F9] text-[#0F172A] flex items-center justify-center shrink-0">
            <TrendingUp className="w-4 h-4" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-semibold text-[#0F172A]">
              Analytics will appear after leads and tours are created
            </div>
            <p className="text-[12px] text-[#64748B] mt-0.5">
              Submit a test inquiry through your widget, or use{' '}
              <code className="text-[11px] text-[#0F172A] bg-[#F1F5F9] px-1.5 py-0.5 rounded">
                npm run demo:seed
              </code>{' '}
              for a populated walk-through. See <span className="text-[#0F172A]">docs/DEMO-RUNBOOK.md</span>.
            </p>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-6">
        <Card className="lg:col-span-2">
          <CardHeader>
            <div>
              <CardTitle>Leads Over Time</CardTitle>
              <CardSubtitle>Last 30 days</CardSubtitle>
            </div>
          </CardHeader>
          <CardContent>
            <LeadsOverTimeChart data={leadsOverTime} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div>
              <CardTitle>Conversion Funnel</CardTitle>
              <CardSubtitle>All-time stage flow</CardSubtitle>
            </div>
          </CardHeader>
          <CardContent>
            <FunnelChart stages={funnelStages} />
          </CardContent>
        </Card>
      </div>

      {/* Phase 8BH — Attribution breakdown table. Same data
          shape as the Overview AttributionPerformanceCard but
          rendered as a wider table because analytics has the
          room. Honest "Unknown" row preserved. */}
      <Card>
        <CardHeader>
          <div>
            <CardTitle>Attribution breakdown</CardTitle>
            <CardSubtitle>
              Leads, tours, and estimated pipeline by source · Top {attributionSummary.rows.length}
              {attributionSummary.totalSources > attributionSummary.rows.length
                ? ` / ${attributionSummary.totalSources}`
                : ''}
            </CardSubtitle>
          </div>
        </CardHeader>
        <CardContent>
          {attributionSummary.rows.length === 0 ? (
            <div className="rounded-xl border border-dashed border-[#E2E8F0] bg-[#F8FAFC] p-5 text-center text-[12.5px] text-[#475569]">
              Attribution will appear once new inquiries include source data.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-[12.5px]">
                <thead>
                  <tr className="text-left text-[10.5px] uppercase tracking-wider text-[#94A3B8] border-b border-[#F1F5F9]">
                    <th className="font-semibold py-2 pl-1">Source</th>
                    <th className="font-semibold py-2 text-right">Leads</th>
                    <th className="font-semibold py-2 text-right">Tours</th>
                    <th className="font-semibold py-2 text-right">Booked</th>
                    <th className="font-semibold py-2 text-right pr-1">Est. pipeline</th>
                  </tr>
                </thead>
                <tbody>
                  {attributionSummary.rows.map((r) => (
                    <tr key={r.sourceLabel} className="border-b border-[#F1F5F9] last:border-b-0">
                      <td className="py-2 pl-1">
                        {r.sourceLabel === 'Unknown' ? (
                          <span className="text-[#94A3B8]">Unattributed</span>
                        ) : (
                          <AttributionSourceBadge sourceLabel={r.sourceLabel} size="md" />
                        )}
                      </td>
                      <td className="py-2 text-right font-semibold text-[#0F172A]">{r.leadsCount}</td>
                      <td className="py-2 text-right text-[#475569]">{r.toursScheduledCount}</td>
                      <td className="py-2 text-right">
                        {r.bookedCount > 0 ? (
                          <span className="font-semibold text-[#047857]">{r.bookedCount}</span>
                        ) : (
                          <span className="text-[#CBD5E1]">—</span>
                        )}
                      </td>
                      <td className="py-2 text-right pr-1 font-semibold text-[#0F172A]">
                        {r.estimatedPipeline > 0
                          ? r.estimatedPipeline >= 10_000
                            ? `$${Math.round(r.estimatedPipeline / 1000)}k`
                            : `$${r.estimatedPipeline.toLocaleString()}`
                          : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="mt-3 text-[10.5px] text-[#94A3B8] italic leading-relaxed">
                {attributionSummary.disclaimer}
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Phase 8BI — Booked revenue by source. Same source
          buckets as the breakdown above, but adds tour and
          booked counts, conversion rates, and estimated
          booked value. Disclaimer is explicit: NOT ROAS. */}
      <Card>
        <CardHeader>
          <div>
            <CardTitle>Booked revenue by source</CardTitle>
            <CardSubtitle>
              Which channels convert to booked weddings · Top {bookedRevenueSummary.rows.length}
            </CardSubtitle>
          </div>
        </CardHeader>
        <CardContent>
          {bookedRevenueSummary.totals.bookedCount === 0 ? (
            <div className="rounded-xl border border-dashed border-[#E2E8F0] bg-[#F8FAFC] p-5 text-center text-[12.5px] text-[#475569]">
              Booked revenue attribution will appear once attributed leads reach
              <span className="font-semibold text-[#0F172A]"> booked</span>.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-[12.5px]">
                <thead>
                  <tr className="text-left text-[10.5px] uppercase tracking-wider text-[#94A3B8] border-b border-[#F1F5F9]">
                    <th className="font-semibold py-2 pl-1">Source</th>
                    <th className="font-semibold py-2 text-right">Leads</th>
                    <th className="font-semibold py-2 text-right">Tours</th>
                    <th className="font-semibold py-2 text-right">Booked</th>
                    <th className="font-semibold py-2 text-right">Est. pipeline</th>
                    <th className="font-semibold py-2 text-right">Est. booked</th>
                    <th className="font-semibold py-2 text-right">L → Tour</th>
                    <th className="font-semibold py-2 text-right pr-1">L → Booked</th>
                  </tr>
                </thead>
                <tbody>
                  {bookedRevenueSummary.rows.map((r) => (
                    <tr key={r.sourceLabel} className="border-b border-[#F1F5F9] last:border-b-0">
                      <td className="py-2 pl-1">
                        {r.sourceLabel === 'Unknown' ? (
                          <span className="text-[#94A3B8]">Unattributed</span>
                        ) : (
                          <AttributionSourceBadge sourceLabel={r.sourceLabel} size="md" />
                        )}
                      </td>
                      <td className="py-2 text-right text-[#475569] tabular-nums">{r.leadCount}</td>
                      <td className="py-2 text-right text-[#475569] tabular-nums">{r.tourCount}</td>
                      <td className="py-2 text-right tabular-nums">
                        {r.bookedCount > 0 ? (
                          <span className="font-semibold text-[#047857]">{r.bookedCount}</span>
                        ) : (
                          <span className="text-[#CBD5E1]">—</span>
                        )}
                      </td>
                      <td className="py-2 text-right text-[#475569] tabular-nums">
                        {r.estimatedPipelineValue > 0
                          ? formatBookedValueShort(r.estimatedPipelineValue)
                          : '—'}
                      </td>
                      <td className="py-2 text-right font-semibold text-[#0F172A] tabular-nums">
                        {r.estimatedBookedValue > 0
                          ? formatBookedValueShort(r.estimatedBookedValue)
                          : '—'}
                      </td>
                      <td className="py-2 text-right text-[#475569] tabular-nums">
                        {r.leadToTourRate === null
                          ? '—'
                          : `${Math.round(r.leadToTourRate * 100)}%`}
                      </td>
                      <td className="py-2 text-right pr-1 text-[#475569] tabular-nums">
                        {r.leadToBookedRate === null
                          ? '—'
                          : `${Math.round(r.leadToBookedRate * 100)}%`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="mt-3 text-[10.5px] text-[#94A3B8] italic leading-relaxed">
                {bookedRevenueSummary.disclaimer}
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Phase 8BJ — Source leakage breakdown. Composes existing
          Revenue OS signals (slow first reply / no tour / recovery
          / reactivation / lost) bucketed by the lead's attribution
          source label. Operators get a one-line per-source view
          of "where the leak is + how many leads + a click into
          the leads board pre-filtered to that source". */}
      <Card>
        <CardHeader>
          <div>
            <CardTitle>Source leakage breakdown</CardTitle>
            <CardSubtitle>
              Top leak + at-risk count per source · operator
              prioritization lens, not an accounting report
            </CardSubtitle>
          </div>
        </CardHeader>
        <CardContent>
          {sourceLeakageSummary.totals.leadCount === 0 ? (
            <div className="rounded-xl border border-dashed border-[#E2E8F0] bg-[#F8FAFC] p-5 text-center text-[12.5px] text-[#475569]">
              Source leakage will appear once attributed leads enter the pipeline.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-[12.5px]">
                <thead>
                  <tr className="text-left text-[10.5px] uppercase tracking-wider text-[#94A3B8] border-b border-[#F1F5F9]">
                    <th className="font-semibold py-2 pl-1">Source</th>
                    <th className="font-semibold py-2 text-right">Leads</th>
                    <th className="font-semibold py-2 text-right">Booked</th>
                    <th className="font-semibold py-2 text-right">Slow reply</th>
                    <th className="font-semibold py-2 text-right">No tour</th>
                    <th className="font-semibold py-2 text-right">Recovery</th>
                    <th className="font-semibold py-2 text-right">Reactivation</th>
                    <th className="font-semibold py-2">Top leak</th>
                    <th className="font-semibold py-2 text-right">At-risk</th>
                    <th className="font-semibold py-2 text-right pr-1">CTA</th>
                  </tr>
                </thead>
                <tbody>
                  {sourceLeakageSummary.rows.map((r) => (
                    <tr key={r.sourceLabel} className="border-b border-[#F1F5F9] last:border-b-0">
                      <td className="py-2 pl-1">
                        {r.sourceLabel === 'Unknown' ? (
                          <span className="text-[#94A3B8]">Unattributed</span>
                        ) : (
                          <AttributionSourceBadge sourceLabel={r.sourceLabel} size="md" />
                        )}
                      </td>
                      <td className="py-2 text-right text-[#475569] tabular-nums">{r.leadCount}</td>
                      <td className="py-2 text-right tabular-nums">
                        {r.bookedCount > 0 ? (
                          <span className="font-semibold text-[#047857]">{r.bookedCount}</span>
                        ) : (
                          <span className="text-[#CBD5E1]">—</span>
                        )}
                      </td>
                      <td className="py-2 text-right text-[#475569] tabular-nums">
                        {r.leakage.slowFirstReply || <span className="text-[#CBD5E1]">—</span>}
                      </td>
                      <td className="py-2 text-right text-[#475569] tabular-nums">
                        {r.leakage.noTourBooked || <span className="text-[#CBD5E1]">—</span>}
                      </td>
                      <td className="py-2 text-right text-[#475569] tabular-nums">
                        {(r.leakage.followUpRecovery + r.leakage.coldLeadRecovery) || (
                          <span className="text-[#CBD5E1]">—</span>
                        )}
                      </td>
                      <td className="py-2 text-right text-[#475569] tabular-nums">
                        {r.leakage.reactivation || <span className="text-[#CBD5E1]">—</span>}
                      </td>
                      <td className="py-2">
                        {r.topLeakageReason ? (
                          <span className="inline-flex items-center rounded-full bg-[#FFFBEB] border border-[#FDE68A] text-[#B45309] px-2 py-[1px] text-[10.5px] font-semibold">
                            {SOURCE_LEAKAGE_LABEL[r.topLeakageReason]}
                          </span>
                        ) : (
                          <span className="text-[#94A3B8]">No active leak</span>
                        )}
                      </td>
                      <td className="py-2 text-right tabular-nums">
                        {r.atRiskCount > 0 ? (
                          <span className="font-semibold text-[#B45309]">{r.atRiskCount}</span>
                        ) : (
                          <span className="text-[#CBD5E1]">—</span>
                        )}
                      </td>
                      <td className="py-2 text-right pr-1">
                        <Link
                          href={`/dashboard/leads?source=${encodeURIComponent(r.sourceLabel)}`}
                          className="inline-flex items-center gap-1 text-[11.5px] font-medium text-[#1D4ED8] hover:underline"
                        >
                          View leads
                          <ArrowUpRight className="w-3 h-3" />
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="mt-3 text-[10.5px] text-[#94A3B8] italic leading-relaxed">
                {sourceLeakageSummary.disclaimer}
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* AI insights card — restrained, no gradient */}
      <Card>
        <CardContent className="pt-5">
          <div className="flex items-start gap-3">
            <div className="w-10 h-10 rounded-2xl bg-[#0F172A] flex items-center justify-center shrink-0 shadow-[0_4px_12px_rgba(15,23,42,0.20)]">
              <Sparkles className="w-5 h-5 text-white" />
            </div>
            <div className="flex-1">
              <h3 className="text-[14px] font-semibold text-[#0F172A] mb-1">AI Performance Insight</h3>
              <p className="text-[13px] text-[#475569] leading-relaxed">
                Your average AI response time is <strong className="text-[#0F172A]">{avgResponseMs > 0 ? `${(avgResponseMs / 1000).toFixed(1)}s` : '—'}</strong>.
                Better client communication can boost tips and repeat work — try faster responses and more follow-ups.
              </p>
              <div className="flex items-center gap-2 mt-3">
                <Button size="sm" variant="primary">
                  <TrendingUp className="w-3.5 h-3.5" />
                  Run Analysis
                </Button>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
