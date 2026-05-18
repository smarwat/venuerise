import { createClient } from '@/lib/supabase/server'
import PageHeader from '@/components/dashboard/PageHeader'
import MetricCard from '@/components/dashboard/MetricCard'
import { Card, CardHeader, CardTitle, CardSubtitle, CardContent } from '@/components/dashboard/ui/Card'
import { Button } from '@/components/dashboard/ui/Button'
import { Badge } from '@/components/dashboard/ui/Badge'
import { Users, Clock, CalendarCheck, DollarSign, Download, Bot, Sparkles, Send, Wand2 } from 'lucide-react'
import { formatDistanceToNow } from 'date-fns'
import Link from 'next/link'

const stageColors: Record<string, string> = {
  new_inquiry:    'bg-[#94A3B8]',
  qualified:      'bg-[#64748B]',
  tour_scheduled: 'bg-[#1D4ED8]',
  tour_completed: 'bg-[#059669]',
  negotiation:    'bg-[#D97706]',
  booked:         'bg-[#047857]',
  lost:           'bg-[#CBD5E1]',
}
const stageLabels: Record<string, string> = {
  new_inquiry: 'New', qualified: 'Qualified', tour_scheduled: 'Tour Scheduled',
  tour_completed: 'Tour Done', negotiation: 'Negotiation', booked: 'Booked', lost: 'Lost',
}

export default async function DashboardPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  const { data: venueRaw } = await supabase
    .from('venues').select('id, name').eq('owner_user_id', user!.id)
    .order('created_at').limit(1).maybeSingle()
  const venue = venueRaw as { id: string; name?: string } | null

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

  const totalLeads = leads.length
  const bookedLeads = leads.filter((l) => l.stage === 'booked').length
  const conversionRate = totalLeads > 0 ? Math.round((bookedLeads / totalLeads) * 100) : 0
  const pipelineValue = leads
    .filter((l) => !['lost', 'booked'].includes(l.stage))
    .reduce((sum, l) => sum + (l.budget ?? 0), 0)

  const stageCounts: Record<string, number> = {}
  leads.forEach((l) => { stageCounts[l.stage] = (stageCounts[l.stage] ?? 0) + 1 })

  const scoreBadge = (score: number) => {
    if (score >= 80) return 'score_high' as const
    if (score >= 60) return 'score_mid' as const
    if (score >= 40) return 'score_low' as const
    return 'score_poor' as const
  }

  return (
    <div className="p-6 lg:p-8 animate-slide-up">
      <PageHeader
        title="Dashboard"
        subtitle={venue?.name ? `Welcome back — here's what's happening at ${venue.name}` : 'Welcome back'}
        actions={
          <>
            <Button variant="outline" size="sm" className="rounded-full">Last 30 days</Button>
            <Button variant="secondary" size="sm" className="rounded-full">
              <Download className="w-3.5 h-3.5" />
              Export
            </Button>
          </>
        }
      />

      {/* Phase 8C — soft empty-state banner. Renders only when the venue
          has no leads at all (real OR seeded). Hidden once the first lead
          lands. Mirrors the analytics page's empty-state pattern. */}
      {totalLeads === 0 && (
        <div className="mb-6 rounded-2xl border border-[#E2E8F0] bg-white px-5 py-4 flex items-start gap-3">
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

      {/* Metric cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <MetricCard title="Total Leads" value={totalLeads} delta="+12.4%" icon={Users} accent="blue" />
        <MetricCard title="Avg Response Time" value="<60s" delta="-48min" icon={Clock} accent="navy" />
        <MetricCard title="Tours Booked" value={stageCounts.tour_scheduled ?? 0} delta="+8.1%" icon={CalendarCheck} accent="green" />
        <MetricCard title="Pipeline Value" value={pipelineValue > 0 ? `$${(pipelineValue / 1000).toFixed(1)}k` : '$0'} delta="+24%" icon={DollarSign} accent="amber" />
      </div>

      {/* Main row: pipeline + AI assistant */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-6">
        {/* Pipeline */}
        <Card className="lg:col-span-2">
          <CardHeader>
            <div>
              <CardTitle>Lead Pipeline</CardTitle>
              <CardSubtitle>Live snapshot of every stage</CardSubtitle>
            </div>
            <Button variant="ghost" size="sm" asChild>
              <Link href="/dashboard/leads">View board →</Link>
            </Button>
          </CardHeader>
          <CardContent>
            {totalLeads === 0 ? (
              <div className="text-center py-12">
                <div className="w-12 h-12 rounded-2xl bg-[#F1F5F9] flex items-center justify-center mx-auto mb-3">
                  <Users className="w-5 h-5 text-[#0F172A]" />
                </div>
                <p className="text-sm text-[#475569]">No leads yet. Embed the widget to get started.</p>
              </div>
            ) : (
              <div className="space-y-3">
                {Object.entries(stageLabels).map(([stage, label]) => {
                  const count = stageCounts[stage] ?? 0
                  const pct = totalLeads > 0 ? (count / totalLeads) * 100 : 0
                  return (
                    <div key={stage}>
                      <div className="flex justify-between text-[12px] mb-1.5">
                        <span className="text-[#475569]">{label}</span>
                        <span className="text-[#0F172A] font-semibold">{count}</span>
                      </div>
                      <div className="h-2 bg-[#F1F5F9] rounded-full overflow-hidden">
                        <div
                          className={`h-full rounded-full ${stageColors[stage]} transition-all duration-700`}
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </CardContent>
        </Card>

        {/* AI Assistant card — restrained, no gradient bg */}
        <Card>
          <CardContent className="pt-5">
            <div className="flex items-center gap-2.5 mb-3">
              <div className="w-9 h-9 rounded-xl bg-navy-blue flex items-center justify-center shadow-[0_4px_12px_rgba(15,23,42,0.20)]">
                <Sparkles className="w-4 h-4 text-white" />
              </div>
              <div>
                <p className="text-[14px] font-semibold text-[#0F172A] leading-tight">VenueRise AI</p>
                <p className="text-[11px] text-[#64748B]">How can I help today?</p>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2 mb-3">
              {[
                { Icon: Bot,           label: 'Reply to hot leads',  bg: 'bg-[#EFF6FF]', text: 'text-[#1D4ED8]' },
                { Icon: Sparkles,      label: 'Schedule tours',      bg: 'bg-[#F1F5F9]', text: 'text-[#0F172A]' },
                { Icon: CalendarCheck, label: 'Follow-up status',    bg: 'bg-[#FFFBEB]', text: 'text-[#B45309]' },
                { Icon: DollarSign,    label: 'Pipeline review',     bg: 'bg-[#ECFDF5]', text: 'text-[#047857]' },
              ].map(({ Icon, label, bg, text }) => (
                <button key={label} className="bg-[#F8FAFC] border border-[#E2E8F0] rounded-xl p-2.5 text-left hover:border-[#CBD5E1] hover:bg-white hover:shadow-card transition-all">
                  <div className={`w-6 h-6 rounded-md ${bg} flex items-center justify-center mb-1.5`}>
                    <Icon className={`w-3 h-3 ${text}`} />
                  </div>
                  <p className="text-[11px] font-medium text-[#0F172A]">{label}</p>
                </button>
              ))}
            </div>
            <div className="flex items-center gap-2 bg-[#F8FAFC] border border-[#E2E8F0] rounded-full pl-3 pr-1 py-1">
              <input
                type="text"
                placeholder="Ask something…"
                className="flex-1 text-[12px] bg-transparent outline-none text-[#0F172A] placeholder:text-[#94A3B8]"
              />
              <button className="w-7 h-7 rounded-full bg-[#0F172A] hover:bg-[#1E293B] flex items-center justify-center transition-colors">
                <Send className="w-3 h-3 text-white" />
              </button>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Recent leads */}
      <Card>
        <CardHeader>
          <div>
            <CardTitle>Recent Leads</CardTitle>
            <CardSubtitle>Latest inquiries across all sources</CardSubtitle>
          </div>
          <Button variant="ghost" size="sm" asChild>
            <Link href="/dashboard/leads">See all →</Link>
          </Button>
        </CardHeader>
        <CardContent>
          {recentLeads.length === 0 ? (
            <p className="text-sm text-[#475569] text-center py-8">No leads yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="text-[11px] font-semibold text-[#94A3B8] uppercase tracking-wider">
                    <th className="text-left py-2.5 pl-2">Lead</th>
                    <th className="text-left py-2.5">Email</th>
                    <th className="text-left py-2.5">Guests</th>
                    <th className="text-left py-2.5">Score</th>
                    <th className="text-left py-2.5">Stage</th>
                    <th className="text-right py-2.5 pr-2">Created</th>
                  </tr>
                </thead>
                <tbody>
                  {recentLeads.map((lead) => (
                    <tr key={lead.id} className="border-t border-[#F1F5F9] hover:bg-[#F8FAFC] transition-colors">
                      <td className="py-3 pl-2">
                        <div className="flex items-center gap-2.5">
                          <div className="w-8 h-8 rounded-full bg-gradient-to-br from-[#1E293B] to-[#0F172A] flex items-center justify-center text-white text-[11px] font-bold">
                            {lead.name.charAt(0)}
                          </div>
                          <span className="text-sm font-medium text-[#0F172A]">{lead.name}</span>
                        </div>
                      </td>
                      <td className="py-3 text-sm text-[#475569]">{lead.email}</td>
                      <td className="py-3 text-sm text-[#475569]">{lead.guest_count ?? '—'}</td>
                      <td className="py-3">
                        <Badge variant={scoreBadge(lead.lead_score)}>{lead.lead_score}</Badge>
                      </td>
                      <td className="py-3">
                        <Badge variant={`stage_${lead.stage}` as Parameters<typeof Badge>[0]['variant']}>
                          {stageLabels[lead.stage] ?? lead.stage}
                        </Badge>
                      </td>
                      <td className="py-3 pr-2 text-right text-xs text-[#94A3B8]">
                        {formatDistanceToNow(new Date(lead.created_at), { addSuffix: true })}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
