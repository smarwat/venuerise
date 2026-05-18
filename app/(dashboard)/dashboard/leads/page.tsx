import { createClient } from '@/lib/supabase/server'
import PageHeader from '@/components/dashboard/PageHeader'
import KanbanBoard from '@/components/dashboard/KanbanBoard'
import RealtimeLeadsLayer from '@/components/dashboard/leads/RealtimeLeadsLayer'
import DemoInquiryButton from '@/components/dashboard/leads/DemoInquiryButton'

export default async function LeadsPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  const { data: venueRaw } = await supabase
    .from('venues').select('id').eq('owner_user_id', user!.id)
    .order('created_at').limit(1).maybeSingle()
  const venueId = (venueRaw as { id?: string } | null)?.id ?? null

  const leads = venueId
    ? (await supabase.from('leads').select('*').eq('venue_id', venueId).order('created_at', { ascending: false })).data ?? []
    : []

  // Phase 8B — the demo button is rendered only when the env flag is
  // exactly '1'. The check happens server-side so the button's bytes
  // never ship to the client when disabled.
  const demoButtonEnabled = process.env.NEXT_PUBLIC_DEMO_BUTTON === '1'

  return (
    <div className="p-6 lg:p-8 animate-slide-up">
      <PageHeader
        title="Leads"
        subtitle="Manage every wedding inquiry from first touch to booked tour"
        actions={
          demoButtonEnabled && venueId ? (
            <DemoInquiryButton venueId={venueId} />
          ) : undefined
        }
      />
      <KanbanBoard initialLeads={leads} />
      {/* Phase 8B — non-rendering client component that subscribes to
          postgres_changes on `leads` and refreshes the page on any event.
          Only mounted when we have a venue context. */}
      {venueId && <RealtimeLeadsLayer venueId={venueId} />}
    </div>
  )
}
