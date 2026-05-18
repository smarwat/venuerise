import { createClient } from '@/lib/supabase/server'
import { notFound } from 'next/navigation'
import ConversationList from '@/components/dashboard/ConversationList'
import ConversationThread from '@/components/dashboard/ConversationThread'
import MessageComposer from '@/components/dashboard/MessageComposer'
import { Badge } from '@/components/dashboard/ui/Badge'
import { MoreHorizontal, Star, Share2 } from 'lucide-react'

function scoreBadge(score: number) {
  if (score >= 80) return 'score_high' as const
  if (score >= 60) return 'score_mid' as const
  if (score >= 40) return 'score_low' as const
  return 'score_poor' as const
}

export default async function InboxThreadPage({ params }: { params: Promise<{ leadId: string }> }) {
  const { leadId } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  const { data: venueRaw } = await supabase
    .from('venues').select('id').eq('owner_user_id', user!.id)
    .order('created_at').limit(1).maybeSingle()
  const venueId = (venueRaw as { id?: string } | null)?.id ?? null

  const [conversationsRes, leadRes] = await Promise.all([
    venueId
      ? supabase
          .from('conversations')
          .select('*, leads(id, name, email, lead_score)')
          .eq('venue_id', venueId)
          .order('last_message_at', { ascending: false })
      : Promise.resolve({ data: [] }),
    supabase.from('leads').select('*').eq('id', leadId).maybeSingle(),
  ])

  const conversations = conversationsRes.data ?? []
  const lead = leadRes.data as Record<string, unknown> | null
  if (!lead) notFound()

  const conv = conversations.find((c) => {
    const cl = c as Record<string, unknown>
    const leads = cl.leads as { id?: string } | null
    return leads?.id === leadId
  }) as Record<string, unknown> | undefined

  const messages = conv
    ? (await supabase.from('messages').select('*').eq('conversation_id', conv.id as string).order('created_at')).data ?? []
    : []

  return (
    <div className="flex h-[calc(100vh-72px)] min-h-[640px] animate-fade-in">
      <div className="flex-1 flex flex-col bg-white">
        <div className="flex items-center gap-3 px-6 py-4 border-b border-[#F1F5F9]">
          <div className="relative shrink-0">
            <div className="w-10 h-10 rounded-full bg-gradient-to-br from-[#1E293B] to-[#0F172A] flex items-center justify-center text-white text-[13px] font-bold">
              {(lead.name as string).charAt(0)}
            </div>
            <div className="absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full bg-[#059669] border-2 border-white" />
          </div>
          <div className="flex-1 min-w-0">
            <h2 className="text-[14px] font-semibold text-[#0F172A]">{lead.name as string}</h2>
            <p className="text-[11px] text-[#64748B]">
              {lead.email as string}
              {lead.event_date ? ` • Event: ${new Date(lead.event_date as string).toLocaleDateString()}` : ''}
              {lead.guest_count ? ` • ${lead.guest_count} guests` : ''}
            </p>
          </div>

          <div className="flex items-center gap-1.5">
            <Badge variant={scoreBadge(lead.lead_score as number)}>Score {lead.lead_score as number}</Badge>
            {!!lead.ai_active && <Badge variant="navy">🤖 AI</Badge>}
            <button className="w-8 h-8 rounded-full flex items-center justify-center text-[#94A3B8] hover:text-[#1D4ED8] hover:bg-[#F1F5F9] transition-colors ml-1">
              <Share2 className="w-4 h-4" />
            </button>
            <button className="w-8 h-8 rounded-full flex items-center justify-center text-[#94A3B8] hover:text-[#1D4ED8] hover:bg-[#F1F5F9] transition-colors">
              <Star className="w-4 h-4" />
            </button>
            <button className="w-8 h-8 rounded-full flex items-center justify-center text-[#94A3B8] hover:text-[#1D4ED8] hover:bg-[#F1F5F9] transition-colors">
              <MoreHorizontal className="w-4 h-4" />
            </button>
          </div>
        </div>

        {conv ? (
          <>
            <ConversationThread
              conversationId={conv.id as string}
              initialMessages={messages as Parameters<typeof ConversationThread>[0]['initialMessages']}
              leadName={lead.name as string}
            />
            <MessageComposer
              conversationId={conv.id as string}
              leadId={leadId}
              aiActive={lead.ai_active as boolean}
            />
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center text-[13px] text-[#64748B]">
            No conversation started yet. AI will initiate once the lead is qualified.
          </div>
        )}
      </div>

      <ConversationList
        conversations={conversations as Parameters<typeof ConversationList>[0]['conversations']}
        activeLeadId={leadId}
      />
    </div>
  )
}
