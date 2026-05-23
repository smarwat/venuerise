import { createClient } from '@/lib/supabase/server'
import PageHeader from '@/components/dashboard/PageHeader'
import KanbanBoard from '@/components/dashboard/KanbanBoard'
import RealtimeLeadsLayer from '@/components/dashboard/leads/RealtimeLeadsLayer'
import DemoInquiryButton from '@/components/dashboard/leads/DemoInquiryButton'
// GTM-0E — pipeline summary header that reframes the page from a CRM
// list ("104 of 104 leads shown") into a revenue queue
// ("104 tracked · 71 need action · $2.49M open pipeline" + 5 clickable
// action buckets that deep-link into the existing leakage filters).
import LeadsPipelineSummary from '@/components/dashboard/leads/LeadsPipelineSummary'
import { parseRevenueOsSettings } from '@/lib/revenue-os/settings'

export default async function LeadsPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  const { data: venueRaw } = await supabase
    .from('venues').select('id, metadata').eq('owner_user_id', user!.id)
    .order('created_at').limit(1).maybeSingle()
  const venueId = (venueRaw as { id?: string } | null)?.id ?? null
  const venueMetadata = (venueRaw as { metadata?: unknown } | null)?.metadata ?? null

  const leads = venueId
    ? (await supabase.from('leads').select('*').eq('venue_id', venueId).order('created_at', { ascending: false })).data ?? []
    : []

  // GTM-0E — pull non-cancelled tours so the pipeline summary's
  // "Tours to confirm" bucket reflects actual scheduled visits, not
  // a lead-stage approximation. Best-effort: a query failure
  // collapses to the stage-based fallback inside the component.
  const tours = venueId
    ? (
        await supabase
          .from('tours')
          .select('status, scheduled_at')
          .eq('venue_id', venueId)
          .not('status', 'eq', 'cancelled')
          .limit(500)
      ).data ?? []
    : []

  const settings = parseRevenueOsSettings(venueMetadata)

  // Phase 8B — the demo button is rendered only when the env flag is
  // exactly '1'. The check happens server-side so the button's bytes
  // never ship to the client when disabled.
  const demoButtonEnabled = process.env.NEXT_PUBLIC_DEMO_BUTTON === '1'

  return (
    <div className="p-6 lg:p-8 animate-slide-up">
      {/* GTM-0E — header reframe: "Leads" → "Revenue Pipeline". The
          subtitle teaches the page's promise in one line. */}
      <PageHeader
        title="Revenue pipeline"
        subtitle="Prioritize overdue replies, hot leads without tours, scheduled visits, and recovery opportunities across every source."
        actions={
          demoButtonEnabled && venueId ? (
            <DemoInquiryButton venueId={venueId} />
          ) : undefined
        }
      />
      <LeadsPipelineSummary
        leads={leads as Parameters<typeof LeadsPipelineSummary>[0]['leads']}
        tours={tours as Parameters<typeof LeadsPipelineSummary>[0]['tours']}
        slaMinutes={settings.firstReplySlaMinutes}
      />
      <KanbanBoard initialLeads={leads} />
      {/* Phase 8B — non-rendering client component that subscribes to
          postgres_changes on `leads` and refreshes the page on any event.
          Only mounted when we have a venue context. */}
      {venueId && <RealtimeLeadsLayer venueId={venueId} />}
    </div>
  )
}
