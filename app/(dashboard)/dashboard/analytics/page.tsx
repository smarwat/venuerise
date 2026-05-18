import { createClient } from '@/lib/supabase/server'
import PageHeader from '@/components/dashboard/PageHeader'
import { Card, CardContent, CardHeader, CardTitle, CardSubtitle } from '@/components/dashboard/ui/Card'
import { Button } from '@/components/dashboard/ui/Button'
import LeadsOverTimeChart from '@/components/dashboard/LeadsOverTimeChart'
import FunnelChart from '@/components/dashboard/FunnelChart'
import { subDays, format, eachDayOfInterval } from 'date-fns'
import { Sparkles, TrendingUp } from 'lucide-react'

type Lead = { stage: string; lead_score: number; budget: number | null; created_at: string }

export default async function AnalyticsPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  const { data: venueRaw } = await supabase
    .from('venues').select('id').eq('owner_user_id', user!.id)
    .order('created_at').limit(1).maybeSingle()
  const venueId = (venueRaw as { id?: string } | null)?.id ?? null

  const thirtyDaysAgo = subDays(new Date(), 30).toISOString()

  const [leadsRes, toursRes, aiActionsRes, allLeadsRes] = await Promise.all([
    venueId ? supabase.from('leads').select('stage, lead_score, budget, created_at').eq('venue_id', venueId).gte('created_at', thirtyDaysAgo) : Promise.resolve({ data: [] as Lead[] }),
    venueId ? supabase.from('tours').select('status').eq('venue_id', venueId) : Promise.resolve({ data: [] }),
    venueId ? supabase.from('ai_actions').select('latency_ms').eq('venue_id', venueId).eq('success', true) : Promise.resolve({ data: [] }),
    venueId ? supabase.from('leads').select('stage').eq('venue_id', venueId) : Promise.resolve({ data: [] }),
  ])

  const leads = (leadsRes.data ?? []) as Lead[]
  const tours = (toursRes.data ?? []) as { status: string }[]
  const aiActions = (aiActionsRes.data ?? []) as { latency_ms: number | null }[]
  const allLeads = (allLeadsRes.data ?? []) as { stage: string }[]

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
  // Desaturated, restrained palette
  const stageColors: Record<string, string> = {
    new_inquiry:    '#94A3B8',
    qualified:      '#64748B',
    tour_scheduled: '#1D4ED8',
    tour_completed: '#059669',
    negotiation:    '#D97706',
    booked:         '#047857',
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

      <div className="grid grid-cols-3 lg:grid-cols-6 gap-3 mb-6">
        {kpis.map((kpi) => (
          <div key={kpi.label} className="bg-white border border-[#E2E8F0] rounded-2xl p-4 shadow-card">
            <div className="text-[20px] font-semibold text-[#0F172A] tracking-[-0.01em] leading-none">{kpi.value}</div>
            <div className="text-[11px] text-[#94A3B8] mt-1.5">{kpi.label}</div>
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

      {/* AI insights card — restrained, no gradient */}
      <Card>
        <CardContent className="pt-5">
          <div className="flex items-start gap-3">
            <div className="w-10 h-10 rounded-2xl bg-navy-blue flex items-center justify-center shrink-0 shadow-[0_4px_12px_rgba(15,23,42,0.20)]">
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
