'use client'

import { useState, useCallback } from 'react'
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  DragOverlay,
} from '@dnd-kit/core'
import { sortableKeyboardCoordinates } from '@dnd-kit/sortable'
import KanbanColumn from './KanbanColumn'
import KanbanCard from './KanbanCard'
import LeadDetailPanel from './LeadDetailPanel'
import AddLeadModal from './AddLeadModal'
import { Button } from './ui/Button'
import { Plus, Search } from 'lucide-react'
import type { Database, LeadStage } from '@/types/database'

type Lead = Database['public']['Tables']['leads']['Row']

const STAGES: LeadStage[] = [
  'new_inquiry', 'qualified', 'tour_scheduled',
  'tour_completed', 'negotiation', 'booked', 'lost',
]

interface KanbanBoardProps {
  initialLeads: Lead[]
}

export default function KanbanBoard({ initialLeads }: KanbanBoardProps) {
  const [leads, setLeads] = useState<Lead[]>(initialLeads)
  const [selectedLead, setSelectedLead] = useState<Lead | null>(null)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [addOpen, setAddOpen] = useState(false)
  const [search, setSearch] = useState('')

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )

  const filtered = leads.filter(
    (l) => !search || l.name.toLowerCase().includes(search.toLowerCase()) || l.email.toLowerCase().includes(search.toLowerCase())
  )
  const leadsByStage = (stage: LeadStage) => filtered.filter((l) => l.stage === stage)
  const activeLead = activeId ? leads.find((l) => l.id === activeId) ?? null : null

  const handleDragEnd = useCallback(async (event: DragEndEvent) => {
    const { active, over } = event
    setActiveId(null)
    if (!over) return

    const leadId = active.id as string
    const targetStage = over.id as LeadStage
    if (!STAGES.includes(targetStage)) return

    const lead = leads.find((l) => l.id === leadId)
    if (!lead || lead.stage === targetStage) return

    setLeads((prev) => prev.map((l) => l.id === leadId ? { ...l, stage: targetStage } : l))

    try {
      const res = await fetch(`/api/leads/${leadId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stage: targetStage }),
      })
      if (!res.ok) {
        setLeads((prev) => prev.map((l) => l.id === leadId ? { ...l, stage: lead.stage } : l))
      } else {
        const updated = await res.json()
        setLeads((prev) => prev.map((l) => l.id === leadId ? updated : l))
      }
    } catch {
      setLeads((prev) => prev.map((l) => l.id === leadId ? { ...l, stage: lead.stage } : l))
    }
  }, [leads])

  const handleUpdate = (updated: Lead) => {
    setLeads((prev) => prev.map((l) => l.id === updated.id ? updated : l))
    setSelectedLead(updated)
  }
  const handleDelete = (leadId: string) => setLeads((prev) => prev.filter((l) => l.id !== leadId))
  const handleCreated = (lead: Lead) => setLeads((prev) => [lead, ...prev])

  return (
    <div className="flex flex-col">
      <div className="flex items-center justify-between gap-3 mb-5">
        <p className="text-[13px] text-[#475569]">{filtered.length} of {leads.length} leads shown</p>
        <div className="flex items-center gap-2">
          <div className="hidden md:flex items-center gap-2 bg-white border border-[#E2E8F0] rounded-full pl-3 pr-2 h-9 w-64">
            <Search className="w-3.5 h-3.5 text-[#94A3B8]" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search leads…"
              className="flex-1 bg-transparent text-[13px] outline-none text-[#0F172A] placeholder:text-[#94A3B8]"
            />
          </div>
          <Button size="sm" onClick={() => setAddOpen(true)}>
            <Plus className="w-3.5 h-3.5" />
            Add Lead
          </Button>
        </div>
      </div>

      <div className="overflow-x-auto -mx-6 lg:-mx-8 px-6 lg:px-8 pb-4">
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragStart={(e) => setActiveId(e.active.id as string)}
          onDragEnd={handleDragEnd}
          onDragCancel={() => setActiveId(null)}
        >
          <div className="flex gap-3 min-w-max">
            {STAGES.map((stage) => (
              <KanbanColumn
                key={stage}
                stage={stage}
                leads={leadsByStage(stage)}
                onCardClick={setSelectedLead}
              />
            ))}
          </div>

          <DragOverlay>
            {activeLead && <KanbanCard lead={activeLead} onClick={() => {}} />}
          </DragOverlay>
        </DndContext>
      </div>

      {selectedLead && (
        <LeadDetailPanel
          lead={selectedLead}
          onClose={() => setSelectedLead(null)}
          onUpdate={handleUpdate}
          onDelete={handleDelete}
        />
      )}

      <AddLeadModal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onCreated={handleCreated}
      />
    </div>
  )
}
