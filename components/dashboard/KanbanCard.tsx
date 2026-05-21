'use client'

import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { Calendar, Users } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { Database } from '@/types/database'
import { format } from 'date-fns'
import { DEFAULT_REVENUE_OS_SETTINGS } from '@/lib/revenue-os/settings'
// Phase 8BH — compact attribution badge on the card. Hides
// gracefully for legacy leads with no attribution metadata.
import AttributionSourceBadge from './AttributionSourceBadge'
import { getLeadAttributionLabel } from '@/lib/enterprise/attribution/parse'

type Lead = Database['public']['Tables']['leads']['Row']

interface KanbanCardProps {
  lead: Lead
  onClick: (lead: Lead) => void
  /** Phase 8AR — Optional per-venue SLA in minutes. Threaded down
   *  from KanbanBoard. Defaults to DEFAULT_REVENUE_OS_SETTINGS so the
   *  card can render the chip even when the board hasn't fetched
   *  custom settings yet. */
  slaMinutes?: number
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

export default function KanbanCard({
  lead,
  onClick,
  slaMinutes = DEFAULT_REVENUE_OS_SETTINGS.firstReplySlaMinutes,
}: KanbanCardProps) {
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

  // Phase 8AR — lightweight Speed-to-Lead chip. We deliberately do
  // NOT fetch per-card outbound message data; the chip only renders
  // for `new_inquiry` leads where age vs SLA is sufficient to call
  // pending vs overdue. The drawer's chip (which DOES fetch outbound)
  // is the precise version; this card chip is the at-a-glance prompt.
  const newInquiryChip = (() => {
    if (lead.stage !== 'new_inquiry') return null
    const createdMs = new Date(lead.created_at).getTime()
    if (!Number.isFinite(createdMs)) return null
    const ageMinutes = Math.max(0, Math.round((Date.now() - createdMs) / 60000))
    const overdue = ageMinutes > slaMinutes
    return {
      label: overdue ? 'Reply overdue' : 'Reply pending',
      tone: overdue
        ? 'text-[#B45309] bg-[#FFFBEB] border-[#FCD9A1]'
        : 'text-[#1D4ED8] bg-[#EFF6FF] border-[#BFDBFE]',
    }
  })()

  return (
    <div
      ref={setNodeRef}
      data-testid="kanban-card"
      data-lead-id={lead.id}
      data-lead-email={lead.email}
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
          <div className="flex items-center gap-1.5 min-w-0 mt-0.5">
            <p className="text-[11px] text-[#64748B] truncate flex-1 min-w-0">{lead.email}</p>
            {/* Phase 8BH — attribution source badge. Hidden for
                Unknown / legacy leads via the helper's
                early-return. */}
            <AttributionSourceBadge
              sourceLabel={getLeadAttributionLabel((lead as { metadata?: unknown }).metadata)}
            />
          </div>
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
      {(lead.guest_count || lead.event_date || newInquiryChip || lead.ai_active) && (
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
          {/* Phase 8AR — at-a-glance Speed-to-Lead prompt. Only for
              new_inquiry leads; the drawer's precise chip kicks in
              once the operator opens the lead. */}
          {newInquiryChip && (
            <span
              className={cn(
                'inline-flex items-center text-[10px] font-semibold uppercase tracking-[0.1em] px-1.5 py-0.5 rounded-full border',
                newInquiryChip.tone
              )}
              title={`SLA ${slaMinutes}m`}
            >
              {newInquiryChip.label}
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
            {/* Phase 8BI — relabel for booked leads so the
                value reads as "Est. booked" rather than just
                "Budget". Keeps card density unchanged. */}
            {lead.stage === 'booked' ? 'Est. booked' : 'Budget'}
          </span>
          <span className={cn(
            'font-semibold tabular-nums',
            lead.stage === 'booked' ? 'text-[#047857]' : 'text-[#0F172A]'
          )}>
            ${(lead.budget / 1000).toFixed(0)}k
          </span>
        </div>
      )}
    </div>
  )
}
