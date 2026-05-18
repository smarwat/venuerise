import { createClient } from '@/lib/supabase/server'
import PageHeader from '@/components/dashboard/PageHeader'
import KanbanBoard from '@/components/dashboard/KanbanBoard'

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

  return (
    <div className="p-6 lg:p-8 animate-slide-up">
      <PageHeader
        title="Leads"
        subtitle="Manage every wedding inquiry from first touch to booked tour"
      />
      <KanbanBoard initialLeads={leads} />
    </div>
  )
}
