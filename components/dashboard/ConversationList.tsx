'use client'

import Link from 'next/link'
import { formatDistanceToNow } from 'date-fns'
import { Search, Star } from 'lucide-react'
import { cn } from '@/lib/utils'

interface Conversation {
  id: string
  lead_id: string
  sentiment: string
  unread_count: number
  last_message_at: string | null
}
interface Lead {
  id: string
  name: string
  email: string
  lead_score: number
}

const sentimentColor: Record<string, string> = {
  positive: 'bg-[#059669]',
  neutral:  'bg-[#94A3B8]',
  negative: 'bg-[#D97706]',
  urgent:   'bg-[#DC2626]',
}

interface Props {
  conversations: (Conversation & { leads: Lead | null })[]
  activeLeadId?: string
}

export default function ConversationList({ conversations, activeLeadId }: Props) {
  return (
    <aside className="w-[320px] shrink-0 bg-white border-l border-[#E6E8EF] flex flex-col">
      <div className="px-4 py-3.5 border-b border-[#F1F5F9]">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-[14px] font-semibold text-[#0F172A]">All messages</h2>
          <button className="text-[11px] font-medium text-[#1D4ED8] hover:underline">All Platforms ▾</button>
        </div>
        <div className="flex items-center gap-2 bg-[#F8FAFC] border border-[#E6E8EF] rounded-full pl-3 pr-2 h-9">
          <Search className="w-3.5 h-3.5 text-[#94A3B8]" />
          <input
            placeholder="Search conversations…"
            className="flex-1 bg-transparent text-[12px] outline-none text-[#0F172A] placeholder:text-[#94A3B8]"
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {conversations.length === 0 && (
          <div className="p-6 text-center text-[13px] text-[#64748B]">No conversations yet.</div>
        )}

        {conversations.map((conv) => {
          const lead = conv.leads
          const isActive = lead?.id === activeLeadId
          const initials = lead?.name?.charAt(0) ?? '?'

          return (
            <Link
              key={conv.id}
              href={`/dashboard/inbox/${lead?.id ?? conv.lead_id}`}
              className={cn(
                'flex items-start gap-3 px-4 py-3.5 border-b border-[#F1F5F9] transition-colors',
                isActive ? 'bg-[#F1F5F9]' : 'hover:bg-[#F8FAFC]'
              )}
            >
              <div className="relative shrink-0">
                <div className="w-9 h-9 rounded-full bg-gradient-to-br from-[#1E293B] to-[#0F172A] flex items-center justify-center text-white text-[12px] font-bold">
                  {initials}
                </div>
                <div className={cn('absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full border-2 border-white', sentimentColor[conv.sentiment] ?? 'bg-[#94A3B8]')} />
              </div>

              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between gap-2 mb-0.5">
                  <p className="text-[13px] font-semibold text-[#0F172A] truncate">{lead?.name ?? 'Unknown'}</p>
                  <span className="text-[10px] text-[#94A3B8] shrink-0">
                    {conv.last_message_at ? formatDistanceToNow(new Date(conv.last_message_at)) : '—'}
                  </span>
                </div>
                <p className="text-[12px] text-[#64748B] truncate">{lead?.email}</p>
              </div>

              <div className="flex flex-col items-end gap-1 shrink-0">
                {conv.unread_count > 0 ? (
                  <span className="bg-[#1D4ED8] text-white text-[10px] font-bold rounded-full min-w-[18px] h-[18px] px-1.5 flex items-center justify-center">
                    {conv.unread_count}
                  </span>
                ) : (
                  <Star className="w-3.5 h-3.5 text-[#CBD5E1]" />
                )}
              </div>
            </Link>
          )
        })}
      </div>
    </aside>
  )
}
