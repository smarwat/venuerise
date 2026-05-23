'use client'

import { useDroppable } from '@dnd-kit/core'
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable'
import KanbanCard from './KanbanCard'
import { cn } from '@/lib/utils'
import type { Database, LeadStage } from '@/types/database'

type Lead = Database['public']['Tables']['leads']['Row']

// GTM-0E — column labels reworded to owner-friendly language. Each
// label describes the stage as a business state, not a CRM internal:
//   "New Inquiry" → "New inquiries" (plural, what the operator sees)
//   "Qualified" → "Qualified, needs next step" (what to do)
//   "Lost" → "Lost / recovery" (signals the column is still actionable)
const STAGE_CONFIG: Record<LeadStage, { label: string; dot: string }> = {
  new_inquiry:    { label: 'New inquiries',             dot: 'bg-[#94A3B8]' },
  qualified:      { label: 'Qualified, needs next step', dot: 'bg-[#64748B]' },
  tour_scheduled: { label: 'Tours scheduled',           dot: 'bg-[#1D4ED8]' },
  tour_completed: { label: 'Tours completed',           dot: 'bg-[#059669]' },
  negotiation:    { label: 'Proposal / negotiation',    dot: 'bg-[#D97706]' },
  booked:         { label: 'Booked weddings',           dot: 'bg-[#047857]' },
  lost:           { label: 'Lost / recovery',           dot: 'bg-[#CBD5E1]' },
}

interface KanbanColumnProps {
  stage: LeadStage
  leads: Lead[]
  onCardClick: (lead: Lead) => void
  /** Phase 8AR — passed through to KanbanCard for the at-a-glance
   *  Speed-to-Lead chip. Optional; defaults applied inside the card. */
  slaMinutes?: number
}

export default function KanbanColumn({
  stage,
  leads,
  onCardClick,
  slaMinutes,
}: KanbanColumnProps) {
  const { setNodeRef, isOver } = useDroppable({ id: stage })
  const cfg = STAGE_CONFIG[stage]

  return (
    <div className="flex flex-col w-[285px] shrink-0">
      {/* Phase 8AI — editorial column header: uppercase stage
          eyebrow + small dot + count pill, on a soft slate surface
          that matches the new dashboard card vocabulary. */}
      <div className="flex items-center justify-between px-3.5 py-2.5 rounded-t-[16px] bg-[#F8FAFC] border border-b-0 border-[#E6E8EF]">
        <div className="flex items-center gap-2">
          <span className={cn('w-1.5 h-1.5 rounded-full', cfg.dot)} />
          <span className="text-[10.5px] uppercase tracking-[0.14em] text-[#475569] font-semibold">
            {cfg.label}
          </span>
        </div>
        <span className="text-[10.5px] font-semibold text-[#475569] rounded-full px-2 py-0.5 bg-white border border-[#E6E8EF] tabular-nums">
          {leads.length}
        </span>
      </div>

      <div
        ref={setNodeRef}
        className={cn(
          'flex-1 min-h-[140px] rounded-b-[16px] border border-t-0 border-[#E6E8EF] p-2 space-y-2 transition-colors duration-150',
          isOver ? 'bg-[#EFF4FF]' : 'bg-[#F4F7FB]'
        )}
      >
        <SortableContext items={leads.map((l) => l.id)} strategy={verticalListSortingStrategy}>
          {leads.map((lead) => (
            <KanbanCard
              key={lead.id}
              lead={lead}
              onClick={onCardClick}
              slaMinutes={slaMinutes}
            />
          ))}
        </SortableContext>

        {leads.length === 0 && (
          <div className="flex items-center justify-center h-20 text-[11px] text-[#94A3B8] border border-dashed border-[#E2E8F0] rounded-xl bg-white/50">
            Drop here
          </div>
        )}
      </div>
    </div>
  )
}
