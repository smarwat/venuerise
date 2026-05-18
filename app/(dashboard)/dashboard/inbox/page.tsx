import { createClient } from '@/lib/supabase/server'
import ConversationList from '@/components/dashboard/ConversationList'
import { MessageSquare } from 'lucide-react'

export default async function InboxPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  const { data: venueRaw } = await supabase
    .from('venues').select('id').eq('owner_user_id', user!.id)
    .order('created_at').limit(1).maybeSingle()
  const venueId = (venueRaw as { id?: string } | null)?.id ?? null

  const conversations = venueId
    ? (await supabase
        .from('conversations')
        .select('*, leads(id, name, email, lead_score)')
        .eq('venue_id', venueId)
        .order('last_message_at', { ascending: false })
      ).data ?? []
    : []

  return (
    <div className="flex h-[calc(100vh-72px)] min-h-[640px] animate-fade-in">
      <div className="flex-1 flex items-center justify-center bg-white">
        <div className="text-center max-w-sm">
          <div className="w-14 h-14 rounded-2xl bg-[#F1F5F9] flex items-center justify-center mx-auto mb-4">
            <MessageSquare className="w-6 h-6 text-[#0F172A]" />
          </div>
          <h3 className="text-[16px] font-semibold text-[#0F172A] mb-1.5">Select a conversation</h3>
          <p className="text-[13px] text-[#475569]">
            Click a lead from the right panel to view their messages and reply with AI or manually.
          </p>
        </div>
      </div>

      <ConversationList
        conversations={conversations as Parameters<typeof ConversationList>[0]['conversations']}
      />
    </div>
  )
}
