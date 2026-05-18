'use client'

import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { Calendar, Users } from 'lucide-react'
import { Badge } from './ui/Badge'
import { cn } from '@/lib/utils'
import type { Database } from '@/types/database'
import { format } from 'date-fns'

type Lead = Database['public']['Tables']['leads']['Row']

interface KanbanCardProps {
  lead: Lead
  onClick: (lead: Lead) => void
}

function scoreVariant(score: number) {
  if (score >= 80) return 'score_high' as const
  if (score >= 60) return 'score_mid' as const
  if (score >= 40) return 'score_low' as const
  return 'score_poor' as const
}

export default function KanbanCard({ lead, onClick }: KanbanCardProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: lead.id })

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        'group bg-white border border-[#E2E8F0] rounded-2xl p-3.5 cursor-pointer',
        'hover:border-[#CBD5E1] hover:shadow-card-hover transition-all duration-200',
        isDragging && 'opacity-50 shadow-[0_20px_40px_rgba(15,23,42,0.25)] rotate-1 scale-[1.02]'
      )}
      onClick={() => onClick(lead)}
      {...attributes}
      {...listeners}
    >
      <div className="flex items-start gap-2.5 mb-2.5">
        <div className="w-8 h-8 rounded-full bg-gradient-to-br from-[#1E293B] to-[#0F172A] flex items-center justify-center text-white text-[11px] font-bold shrink-0">
          {lead.name.charAt(0)}
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-[13px] font-semibold text-[#0F172A] truncate leading-tight">{lead.name}</p>
          <p className="text-[11px] text-[#64748B] truncate">{lead.email}</p>
        </div>
        {lead.ai_active && (
          <span title="AI active" className="shrink-0 mt-1 inline-flex items-center gap-1 text-[10px] font-semibold text-[#1D4ED8] bg-[#EFF6FF] rounded-full px-1.5 py-0.5 border border-[#BFDBFE]">
            <span className="w-1.5 h-1.5 rounded-full bg-[#1D4ED8] animate-pulse" />
            AI
          </span>
        )}
      </div>

      <div className="flex items-center gap-1.5 flex-wrap">
        <Badge variant={scoreVariant(lead.lead_score)}>{lead.lead_score}</Badge>

        {(lead.urgency === 'critical' || lead.urgency === 'high') && (
          <Badge variant="urgent">{lead.urgency}</Badge>
        )}

        {lead.guest_count && (
          <span className="inline-flex items-center gap-1 text-[11px] text-[#475569] bg-[#F8FAFC] border border-[#E2E8F0] rounded-full px-2 py-0.5">
            <Users className="w-2.5 h-2.5" />
            {lead.guest_count}
          </span>
        )}

        {lead.event_date && (
          <span className="inline-flex items-center gap-1 text-[11px] text-[#475569] bg-[#F8FAFC] border border-[#E2E8F0] rounded-full px-2 py-0.5">
            <Calendar className="w-2.5 h-2.5" />
            {format(new Date(lead.event_date), 'MMM d')}
          </span>
        )}
      </div>

      {lead.budget && (
        <div className="mt-2.5 pt-2.5 border-t border-[#F1F5F9] text-[11px] text-[#64748B]">
          Budget <span className="text-[#0F172A] font-semibold ml-1">${lead.budget.toLocaleString()}</span>
        </div>
      )}
    </div>
  )
}
