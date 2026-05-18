'use client'

import { useState } from 'react'
import { X, Mail, Phone, Calendar, Users, DollarSign, Bot, BotOff, Trash2, MessageSquare } from 'lucide-react'
import { Button } from './ui/Button'
import { Badge } from './ui/Badge'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/Select'
import { cn } from '@/lib/utils'
import type { Database, LeadStage } from '@/types/database'
import { format } from 'date-fns'

type Lead = Database['public']['Tables']['leads']['Row']

const STAGES: { value: LeadStage; label: string }[] = [
  { value: 'new_inquiry', label: 'New Inquiry' },
  { value: 'qualified', label: 'Qualified' },
  { value: 'tour_scheduled', label: 'Tour Scheduled' },
  { value: 'tour_completed', label: 'Tour Completed' },
  { value: 'negotiation', label: 'Negotiation' },
  { value: 'booked', label: 'Booked' },
  { value: 'lost', label: 'Lost' },
]

function scoreVariant(score: number) {
  if (score >= 80) return 'score_high' as const
  if (score >= 60) return 'score_mid' as const
  if (score >= 40) return 'score_low' as const
  return 'score_poor' as const
}

interface LeadDetailPanelProps {
  lead: Lead | null
  onClose: () => void
  onUpdate: (lead: Lead) => void
  onDelete: (leadId: string) => void
}

export default function LeadDetailPanel({ lead, onClose, onUpdate, onDelete }: LeadDetailPanelProps) {
  const [saving, setSaving] = useState(false)

  if (!lead) return null

  const patch = async (data: Record<string, unknown>) => {
    setSaving(true)
    try {
      const res = await fetch(`/api/leads/${lead.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      })
      if (res.ok) {
        const updated = await res.json()
        onUpdate(updated)
      }
    } finally { setSaving(false) }
  }

  const handleDelete = async () => {
    if (!confirm(`Delete lead for ${lead.name}? This cannot be undone.`)) return
    await fetch(`/api/leads/${lead.id}`, { method: 'DELETE' })
    onDelete(lead.id)
    onClose()
  }

  return (
    <div className="fixed inset-0 z-50 flex">
      <div className="fixed inset-0 bg-[#0F172A]/30 backdrop-blur-sm" onClick={onClose} />

      <div className="relative ml-auto w-[440px] bg-white border-l border-[#E2E8F0] flex flex-col h-full shadow-[0_-10px_40px_rgba(15,23,42,0.25)] animate-in slide-in-from-right duration-300">
        <div className="flex items-center gap-3 px-6 py-5 border-b border-[#F1F5F9]">
          <div className="w-11 h-11 rounded-full bg-gradient-to-br from-[#1E293B] to-[#0F172A] flex items-center justify-center shrink-0">
            <span className="text-[14px] font-bold text-white">{lead.name.charAt(0)}</span>
          </div>
          <div className="flex-1 min-w-0">
            <h2 className="text-[15px] font-semibold text-[#0F172A] truncate">{lead.name}</h2>
            <p className="text-[12px] text-[#64748B] truncate">{lead.email}</p>
          </div>
          <button onClick={onClose} className="w-8 h-8 rounded-full flex items-center justify-center text-[#475569] hover:text-[#0F172A] hover:bg-[#F1F5F9] transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          <div className="flex items-center gap-2">
            <Badge variant={scoreVariant(lead.lead_score)}>Score {lead.lead_score}</Badge>
            {lead.ai_active && (
              <Badge variant="navy">
                <Bot className="w-3 h-3 mr-1" /> AI Active
              </Badge>
            )}
          </div>

          <div>
            <label className="block text-[11px] font-semibold text-[#94A3B8] uppercase tracking-wider mb-2">Pipeline Stage</label>
            <Select value={lead.stage} onValueChange={(v) => patch({ stage: v })} disabled={saving}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {STAGES.map((s) => <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>

          <div>
            <h3 className="text-[11px] font-semibold text-[#94A3B8] uppercase tracking-wider mb-2.5">Contact</h3>
            <div className="space-y-2">
              <div className="flex items-center gap-2.5 text-sm">
                <Mail className="w-4 h-4 text-[#94A3B8] shrink-0" />
                <a href={`mailto:${lead.email}`} className="text-[#0F172A] hover:text-[#1D4ED8] truncate">{lead.email}</a>
              </div>
              {lead.phone && (
                <div className="flex items-center gap-2.5 text-sm">
                  <Phone className="w-4 h-4 text-[#94A3B8] shrink-0" />
                  <a href={`tel:${lead.phone}`} className="text-[#0F172A] hover:text-[#1D4ED8]">{lead.phone}</a>
                </div>
              )}
            </div>
          </div>

          <div>
            <h3 className="text-[11px] font-semibold text-[#94A3B8] uppercase tracking-wider mb-2.5">Event Details</h3>
            <div className="grid grid-cols-2 gap-2.5">
              {lead.event_date && (
                <div className="bg-[#F8FAFC] border border-[#E2E8F0] rounded-xl p-3">
                  <div className="flex items-center gap-1.5 text-[#94A3B8] mb-1">
                    <Calendar className="w-3.5 h-3.5" />
                    <span className="text-[11px]">Event Date</span>
                  </div>
                  <p className="text-sm font-semibold text-[#0F172A]">{format(new Date(lead.event_date), 'MMM d, yyyy')}</p>
                </div>
              )}
              {lead.guest_count && (
                <div className="bg-[#F8FAFC] border border-[#E2E8F0] rounded-xl p-3">
                  <div className="flex items-center gap-1.5 text-[#94A3B8] mb-1">
                    <Users className="w-3.5 h-3.5" />
                    <span className="text-[11px]">Guests</span>
                  </div>
                  <p className="text-sm font-semibold text-[#0F172A]">{lead.guest_count}</p>
                </div>
              )}
              {lead.budget && (
                <div className="bg-[#F8FAFC] border border-[#E2E8F0] rounded-xl p-3">
                  <div className="flex items-center gap-1.5 text-[#94A3B8] mb-1">
                    <DollarSign className="w-3.5 h-3.5" />
                    <span className="text-[11px]">Budget</span>
                  </div>
                  <p className="text-sm font-semibold text-[#0F172A]">${lead.budget.toLocaleString()}</p>
                </div>
              )}
              <div className="bg-[#F8FAFC] border border-[#E2E8F0] rounded-xl p-3">
                <span className="text-[11px] text-[#94A3B8]">Source</span>
                <p className="text-sm font-semibold text-[#0F172A] capitalize">{lead.source}</p>
              </div>
            </div>
          </div>

          {lead.notes && (
            <div>
              <h3 className="text-[11px] font-semibold text-[#94A3B8] uppercase tracking-wider mb-2.5">Notes</h3>
              <p className="text-sm text-[#475569] bg-[#F8FAFC] border border-[#E2E8F0] rounded-xl p-3 leading-relaxed">{lead.notes}</p>
            </div>
          )}

          <div className="text-xs text-[#94A3B8] space-y-1 border-t border-[#F1F5F9] pt-4">
            <p>Created: {format(new Date(lead.created_at), 'MMM d, yyyy h:mm a')}</p>
            <p>Updated: {format(new Date(lead.updated_at), 'MMM d, yyyy h:mm a')}</p>
          </div>
        </div>

        <div className="px-6 py-4 border-t border-[#F1F5F9] flex gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => patch({ ai_active: !lead.ai_active })}
            disabled={saving}
            className={cn('flex-1', lead.ai_active && 'text-[#B45309] border-[#FCD9A1]')}
          >
            {lead.ai_active ? <BotOff className="w-3.5 h-3.5" /> : <Bot className="w-3.5 h-3.5" />}
            {lead.ai_active ? 'Pause AI' : 'Enable AI'}
          </Button>
          <Button variant="secondary" size="sm" className="flex-1" asChild>
            <a href={`/dashboard/inbox?lead=${lead.id}`}>
              <MessageSquare className="w-3.5 h-3.5" />
              Open Inbox
            </a>
          </Button>
          <Button variant="destructive" size="icon" onClick={handleDelete} disabled={saving}>
            <Trash2 className="w-3.5 h-3.5" />
          </Button>
        </div>
      </div>
    </div>
  )
}
