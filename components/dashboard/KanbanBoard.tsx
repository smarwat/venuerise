'use client'

import { useState, useCallback, useEffect } from 'react'
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
import LeadDetailDrawer from './leads/LeadDetailDrawer'
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

  // Phase 8B — sync local state when the server-rendered `initialLeads`
  // changes (e.g. RealtimeLeadsLayer calls router.refresh() after a
  // postgres_changes event). Without this `useState(initialLeads)` only
  // seeds on first mount and live updates would be invisible.
  //
  // Trade-off: any in-flight optimistic stage change (the second between
  // the user dropping a card and the PATCH /api/leads/[id] response
  // landing) gets reset by an incoming server-refresh. In practice the
  // PATCH completes in <300ms and Realtime debounces at the supabase
  // layer, so the race is small + recoverable. If it ever becomes
  // visible, switch to a merge strategy that prefers in-flight optimistic
  // rows over server-fetched ones for ~1s after a local mutation.
  useEffect(() => {
    setLeads(initialLeads)
  }, [initialLeads])

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

      {/* Phase 8AH — premium right-side drawer replaces the legacy
          LeadDetailPanel. Same callback contract; visual upgrade
          plus conversation/AI-draft surface. */}
      <LeadDetailDrawer
        lead={selectedLead}
        onClose={() => setSelectedLead(null)}
        onUpdate={handleUpdate}
        onDelete={handleDelete}
      />


      <AddLeadModal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onCreated={handleCreated}
      />
    </div>
  )
}
