'use client'

import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { Calendar, Users } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { Database } from '@/types/database'
import { format } from 'date-fns'

type Lead = Database['public']['Tables']['leads']['Row']

interface KanbanCardProps {
  lead: Lead
  onClick: (lead: Lead) => void
}

/**
 * Phase 8AI — Kanban card visual polish.
 *
 * Same drag/drop wiring as before — only the visual surface changed
 * to match the LeadDetailDrawer identity block:
 *   - Avatar tone keyed by lead score (matches drawer)
 *   - Couple/name primary text, email subline
 *   - Compact info row: score chip + guests + event date
 *   - Budget on its own row when present
 *   - Slate hover state + border darken
 */

function avatarTone(score: number): string {
  if (score >= 90) return 'bg-[#0F8A5B]'
  if (score >= 80) return 'bg-[#1D4ED8]'
  if (score >= 60) return 'bg-[#334155]'
  return 'bg-[#475569]'
}

function scoreChip(score: number): { fg: string; bg: string } {
  if (score >= 90) return { fg: 'text-[#0F8A5B]', bg: 'bg-[#E7F7EE] border-[#A7F3D0]' }
  if (score >= 80) return { fg: 'text-[#1D4ED8]', bg: 'bg-[#EFF4FF] border-[#BFDBFE]' }
  if (score >= 60) return { fg: 'text-[#475569]', bg: 'bg-[#F1F5F9] border-[#E2E8F0]' }
  return { fg: 'text-[#94A3B8]', bg: 'bg-[#F8FAFC] border-[#E2E8F0]' }
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
  const sc = scoreChip(lead.lead_score)
  const initials = (() => {
    const parts = lead.name.split(/\s+/).slice(0, 2)
    return parts.map((p) => p.charAt(0).toUpperCase()).join('') || 'L'
  })()

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        'group bg-white border border-[#E6E8EF] rounded-2xl p-3 cursor-pointer',
        'hover:border-[#CBD5E1] hover:bg-[#FAFBFD] hover:shadow-card-hover transition-all duration-200',
        isDragging && 'opacity-50 shadow-[0_20px_40px_rgba(15,23,42,0.25)] rotate-1 scale-[1.02]'
      )}
      onClick={() => onClick(lead)}
      {...attributes}
      {...listeners}
    >
      {/* Identity row */}
      <div className="flex items-start gap-2.5">
        <div
          className={cn(
            'w-9 h-9 rounded-[10px] flex items-center justify-center text-white text-[11px] font-semibold shrink-0',
            avatarTone(lead.lead_score)
          )}
        >
          {initials}
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-[13px] font-semibold text-[#0F172A] truncate leading-tight">
            {lead.name}
          </p>
          <p className="text-[11px] text-[#64748B] truncate mt-0.5">{lead.email}</p>
        </div>
        <span
          className={cn(
            'shrink-0 text-[10.5px] font-semibold px-1.5 py-0.5 rounded-md border tabular-nums',
            sc.fg,
            sc.bg
          )}
          title={`Lead score ${lead.lead_score}`}
        >
          {lead.lead_score}
        </span>
      </div>

      {/* Meta row */}
      {(lead.guest_count || lead.event_date) && (
        <div className="mt-2.5 flex items-center gap-2 flex-wrap text-[11px] text-[#475569]">
          {lead.guest_count != null && (
            <span className="inline-flex items-center gap-1">
              <Users className="w-3 h-3 text-[#94A3B8]" />
              <span className="tabular-nums">{lead.guest_count}</span>
            </span>
          )}
          {lead.event_date && (
            <span className="inline-flex items-center gap-1">
              <Calendar className="w-3 h-3 text-[#94A3B8]" />
              {format(new Date(lead.event_date), 'MMM d')}
            </span>
          )}
          {lead.ai_active && (
            <span className="inline-flex items-center gap-1 text-[10.5px] font-semibold text-[#1D4ED8] bg-[#EFF6FF] rounded-full px-1.5 py-0.5 border border-[#BFDBFE]">
              <span className="w-1.5 h-1.5 rounded-full bg-[#1D4ED8] animate-pulse" />
              AI
            </span>
          )}
        </div>
      )}

      {/* Budget row — separated by a divider for editorial calm */}
      {lead.budget != null && lead.budget > 0 && (
        <div className="mt-2.5 pt-2.5 border-t border-[#F1F5F9] flex items-center justify-between text-[11px]">
          <span className="text-[#94A3B8] uppercase tracking-[0.12em] font-semibold">
            Budget
          </span>
          <span className="text-[#0F172A] font-semibold tabular-nums">
            ${(lead.budget / 1000).toFixed(0)}k
          </span>
        </div>
      )}
    </div>
  )
}
