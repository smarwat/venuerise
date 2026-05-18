'use client'

import { useState, useCallback } from 'react'
import { Tabs, TabsList, TabsTrigger, TabsContent } from './ui/Tabs'
import { Button } from './ui/Button'
import { Input } from './ui/Input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/Select'
import { Card, CardContent, CardHeader, CardTitle } from './ui/Card'
import { Save, Plus, Trash2, Check, Loader2 } from 'lucide-react'

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const KB_CATEGORIES = ['Pricing', 'Policies', 'FAQ', 'Amenities', 'Catering', 'Other']

interface SettingsTabsProps {
  venue: Record<string, unknown> | null
  knowledgeBase: Record<string, unknown>[]
  tourAvailability: Record<string, unknown>[]
}

function useDebouncedSave<T>(venueId: string | null, path: string, delay = 500) {
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  const save = useCallback(async (data: T) => {
    if (!venueId) return
    setSaving(true)
    try {
      await fetch(`/api/${path}/${venueId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      })
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } finally {
      setSaving(false)
    }
  }, [venueId, path])

  return { save, saving, saved }
}

// ---- Venue Profile Tab ----
function VenueProfileTab({ venue }: { venue: Record<string, unknown> | null }) {
  const venueId = (venue?.id as string) ?? null
  const { save, saving, saved } = useDebouncedSave<Record<string, unknown>>(venueId, 'venues')
  const [form, setForm] = useState({
    name: (venue?.name as string) ?? '',
    description: (venue?.description as string) ?? '',
    capacity_min: String(venue?.capacity_min ?? ''),
    capacity_max: String(venue?.capacity_max ?? ''),
    base_price: String(venue?.base_price ?? ''),
    timezone: (venue?.timezone as string) ?? 'America/New_York',
  })

  const set = (key: string, val: string) => setForm((f) => ({ ...f, [key]: val }))

  const handleSave = () => save({
    name: form.name,
    description: form.description || null,
    capacity_min: form.capacity_min ? parseInt(form.capacity_min) : null,
    capacity_max: form.capacity_max ? parseInt(form.capacity_max) : null,
    base_price: form.base_price ? parseFloat(form.base_price) : null,
    timezone: form.timezone,
  })

  if (!venue) return <NoVenueState />

  return (
    <div className="max-w-2xl space-y-5">
      <div>
        <label className="block text-[11px] font-semibold text-[#94A3B8] uppercase tracking-wider mb-2">Venue Name</label>
        <Input value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="The Ivy Estate" />
      </div>
      <div>
        <label className="block text-[11px] font-semibold text-[#94A3B8] uppercase tracking-wider mb-2">Description</label>
        <textarea
          value={form.description}
          onChange={(e) => set('description', e.target.value)}
          rows={4}
          placeholder="Describe your venue…"
          className="w-full bg-white border border-[#E2E8F0] rounded-xl px-3.5 py-2.5 text-sm text-[#0F172A] placeholder:text-[#94A3B8] focus:outline-none focus:border-[#1D4ED8] focus:ring-[3px] focus:ring-[#3B82F6]/15 resize-none transition-all"
        />
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-[11px] font-semibold text-[#94A3B8] uppercase tracking-wider mb-2">Min Capacity</label>
          <Input type="number" value={form.capacity_min} onChange={(e) => set('capacity_min', e.target.value)} placeholder="50" />
        </div>
        <div>
          <label className="block text-[11px] font-semibold text-[#94A3B8] uppercase tracking-wider mb-2">Max Capacity</label>
          <Input type="number" value={form.capacity_max} onChange={(e) => set('capacity_max', e.target.value)} placeholder="300" />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-[11px] font-semibold text-[#94A3B8] uppercase tracking-wider mb-2">Base Price ($)</label>
          <Input type="number" value={form.base_price} onChange={(e) => set('base_price', e.target.value)} placeholder="5000" />
        </div>
        <div>
          <label className="block text-[11px] font-semibold text-[#94A3B8] uppercase tracking-wider mb-2">Timezone</label>
          <Select value={form.timezone} onValueChange={(v) => set('timezone', v)}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="America/New_York">Eastern (ET)</SelectItem>
              <SelectItem value="America/Chicago">Central (CT)</SelectItem>
              <SelectItem value="America/Denver">Mountain (MT)</SelectItem>
              <SelectItem value="America/Los_Angeles">Pacific (PT)</SelectItem>
              <SelectItem value="America/Phoenix">Arizona (AZ)</SelectItem>
              <SelectItem value="Pacific/Honolulu">Hawaii (HI)</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
      <SaveButton onClick={handleSave} saving={saving} saved={saved} />
    </div>
  )
}

// ---- AI Config Tab ----
function AIConfigTab({ venue }: { venue: Record<string, unknown> | null }) {
  const venueId = (venue?.id as string) ?? null
  const { save, saving, saved } = useDebouncedSave<Record<string, unknown>>(venueId, 'venues')
  const [form, setForm] = useState({
    ai_persona_name: (venue?.ai_persona_name as string) ?? 'Alex',
    ai_tone: (venue?.ai_tone as string) ?? 'warm_professional',
    response_time_target: String(venue?.response_time_target ?? 5),
  })

  const set = (key: string, val: string) => setForm((f) => ({ ...f, [key]: val }))

  if (!venue) return <NoVenueState />

  return (
    <div className="max-w-2xl space-y-5">
      <Card>
        <CardContent className="pt-5 space-y-4">
          <div>
            <label className="block text-[11px] font-semibold text-[#94A3B8] uppercase tracking-wider mb-2">AI Persona Name</label>
            <Input value={form.ai_persona_name} onChange={(e) => set('ai_persona_name', e.target.value)} placeholder="Alex" />
            <p className="text-xs text-[#94A3B8] mt-1">This is the name your AI coordinator will sign with.</p>
          </div>
          <div>
            <label className="block text-[11px] font-semibold text-[#94A3B8] uppercase tracking-wider mb-2">Conversation Tone</label>
            <Select value={form.ai_tone} onValueChange={(v) => set('ai_tone', v)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="warm_professional">Warm & Professional</SelectItem>
                <SelectItem value="luxury_concierge">Luxury Concierge</SelectItem>
                <SelectItem value="casual_friendly">Casual & Friendly</SelectItem>
                <SelectItem value="formal_elegant">Formal & Elegant</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <label className="block text-[11px] font-semibold text-[#94A3B8] uppercase tracking-wider mb-2">
              Response Time Target (minutes)
            </label>
            <Input
              type="number"
              min="1"
              max="60"
              value={form.response_time_target}
              onChange={(e) => set('response_time_target', e.target.value)}
              placeholder="5"
            />
          </div>
        </CardContent>
      </Card>
      <SaveButton onClick={() => save({ ai_persona_name: form.ai_persona_name, ai_tone: form.ai_tone, response_time_target: parseInt(form.response_time_target) })} saving={saving} saved={saved} />
    </div>
  )
}

// ---- Knowledge Base Tab ----
function KnowledgeBaseTab({ venueId, initialKB }: { venueId: string | null; initialKB: Record<string, unknown>[] }) {
  const [kb, setKB] = useState(initialKB)
  const [adding, setAdding] = useState(false)
  const [newItem, setNewItem] = useState({ category: 'FAQ', title: '', content: '' })
  const [saving, setSaving] = useState(false)

  const handleAdd = async () => {
    if (!venueId || !newItem.title || !newItem.content) return
    setSaving(true)
    const res = await fetch('/api/venues/' + venueId + '/knowledge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...newItem, venue_id: venueId, priority: 5, is_active: true }),
    }).catch(() => null)
    if (res?.ok) {
      const data = await res.json()
      setKB((prev) => [data, ...prev])
      setNewItem({ category: 'FAQ', title: '', content: '' })
      setAdding(false)
    }
    setSaving(false)
  }

  const handleToggle = async (id: string, is_active: boolean) => {
    await fetch('/api/venues/' + venueId + '/knowledge/' + id, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ is_active: !is_active }),
    })
    setKB((prev) => prev.map((k) => k.id === id ? { ...k, is_active: !is_active } : k))
  }

  const handleDelete = async (id: string) => {
    await fetch('/api/venues/' + venueId + '/knowledge/' + id, { method: 'DELETE' })
    setKB((prev) => prev.filter((k) => k.id !== id))
  }

  return (
    <div className="max-w-3xl space-y-4">
      <div className="flex justify-between items-center">
        <p className="text-sm text-[#475569]">{kb.length} entries · AI uses this to answer lead questions accurately</p>
        <Button size="sm" onClick={() => setAdding(true)}>
          <Plus className="w-4 h-4" /> Add Entry
        </Button>
      </div>

      {adding && (
        <Card>
          <CardContent className="pt-4 space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <Select value={newItem.category} onValueChange={(v) => setNewItem((n) => ({ ...n, category: v }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {KB_CATEGORIES.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                </SelectContent>
              </Select>
              <Input value={newItem.title} onChange={(e) => setNewItem((n) => ({ ...n, title: e.target.value }))} placeholder="Entry title" />
            </div>
            <textarea
              value={newItem.content}
              onChange={(e) => setNewItem((n) => ({ ...n, content: e.target.value }))}
              rows={3}
              placeholder="Content the AI will use to answer questions…"
              className="w-full bg-white border border-[#E2E8F0] rounded-xl px-3.5 py-2.5 text-sm text-[#0F172A] placeholder:text-[#94A3B8] focus:outline-none focus:border-[#1D4ED8] focus:ring-[3px] focus:ring-[#3B82F6]/15 resize-none"
            />
            <div className="flex gap-2">
              <Button size="sm" onClick={handleAdd} disabled={saving}>
                {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Save'}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setAdding(false)}>Cancel</Button>
            </div>
          </CardContent>
        </Card>
      )}

      {kb.length === 0 && !adding && (
        <div className="text-center py-12 text-sm text-[#475569]">
          No entries yet. Add pricing, policies, FAQs, and amenities to help your AI respond accurately.
        </div>
      )}

      {kb.map((item) => (
        <div key={item.id as string} className={`p-4 rounded-2xl border transition-all ${item.is_active ? 'bg-white border-[#E2E8F0] shadow-card' : 'bg-[#F8FAFC] border-[#F1F5F9] opacity-60'}`}>
          <div className="flex items-start justify-between gap-3">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-1">
                <span className="text-[10px] font-semibold text-[#1D4ED8] bg-[#EFF6FF] border border-[#BFDBFE] rounded-md px-2 py-0.5">{item.category as string}</span>
                <span className="text-sm font-medium text-[#0F172A]">{item.title as string}</span>
              </div>
              <p className="text-xs text-[#475569] leading-relaxed line-clamp-2">{item.content as string}</p>
            </div>
            <div className="flex gap-1.5 shrink-0">
              <Button
                size="icon"
                variant="ghost"
                onClick={() => handleToggle(item.id as string, item.is_active as boolean)}
                title={item.is_active ? 'Disable' : 'Enable'}
              >
                <Check className={`w-3.5 h-3.5 ${item.is_active ? 'text-[#059669]' : 'text-[#94A3B8]'}`} />
              </Button>
              <Button size="icon" variant="destructive" onClick={() => handleDelete(item.id as string)}>
                <Trash2 className="w-3.5 h-3.5" />
              </Button>
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}

// ---- Availability Tab ----
function AvailabilityTab({ venueId, initialSlots }: { venueId: string | null; initialSlots: Record<string, unknown>[] }) {
  const [slots, setSlots] = useState(initialSlots)
  const [saving, setSaving] = useState(false)

  const addSlot = async (dayOfWeek: number) => {
    if (!venueId) return
    setSaving(true)
    const res = await fetch('/api/venues/' + venueId + '/availability', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ venue_id: venueId, day_of_week: dayOfWeek, start_time: '10:00', end_time: '17:00', is_active: true }),
    }).catch(() => null)
    if (res?.ok) {
      const data = await res.json()
      setSlots((prev) => [...prev, data])
    }
    setSaving(false)
  }

  const removeSlot = async (id: string) => {
    await fetch('/api/venues/' + venueId + '/availability/' + id, { method: 'DELETE' })
    setSlots((prev) => prev.filter((s) => s.id !== id))
  }

  return (
    <div className="max-w-2xl space-y-4">
      <p className="text-sm text-[#475569]">Set which days and hours tours can be scheduled.</p>
      {DAYS.map((day, dow) => {
        const daySlots = slots.filter((s) => s.day_of_week === dow)
        return (
          <div key={day} className="flex items-center gap-4 py-2.5 border-b border-[#F1EEF7]">
            <span className="w-24 text-sm font-medium text-[#0F172A]">{day}</span>
            <div className="flex-1 flex flex-wrap gap-2">
              {daySlots.map((slot) => (
                <div key={slot.id as string} className="flex items-center gap-1.5 bg-[#F1F5F9] border border-[#E2E8F0] rounded-full px-3 py-1 text-xs text-[#0F172A]">
                  {slot.start_time as string} – {slot.end_time as string}
                  <button onClick={() => removeSlot(slot.id as string)} className="text-[#94A3B8] hover:text-[#DC2626] ml-1">
                    <Trash2 className="w-3 h-3" />
                  </button>
                </div>
              ))}
              <Button size="sm" variant="ghost" onClick={() => addSlot(dow)} disabled={saving} className="text-xs h-7 px-2">
                <Plus className="w-3 h-3" /> Add
              </Button>
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ---- Helpers ----
function SaveButton({ onClick, saving, saved }: { onClick: () => void; saving: boolean; saved: boolean }) {
  return (
    <Button onClick={onClick} disabled={saving}>
      {saving ? <><Loader2 className="w-4 h-4 animate-spin" /> Saving…</>
       : saved  ? <><Check className="w-4 h-4" /> Saved!</>
       : <><Save className="w-4 h-4" /> Save Changes</>}
    </Button>
  )
}

function NoVenueState() {
  return (
    <div className="text-center py-16 text-sm text-[#475569]">
      No venue configured. Contact support to set up your venue.
    </div>
  )
}

// ---- Main Component ----
export default function SettingsTabs({ venue, knowledgeBase, tourAvailability }: SettingsTabsProps) {
  const venueId = (venue?.id as string) ?? null

  return (
    <Tabs defaultValue="profile">
      <TabsList className="mb-6">
        <TabsTrigger value="profile">Venue Profile</TabsTrigger>
        <TabsTrigger value="ai">AI Configuration</TabsTrigger>
        <TabsTrigger value="kb">Knowledge Base</TabsTrigger>
        <TabsTrigger value="availability">Availability</TabsTrigger>
      </TabsList>

      <TabsContent value="profile">
        <VenueProfileTab venue={venue} />
      </TabsContent>

      <TabsContent value="ai">
        <AIConfigTab venue={venue} />
      </TabsContent>

      <TabsContent value="kb">
        <KnowledgeBaseTab venueId={venueId} initialKB={knowledgeBase} />
      </TabsContent>

      <TabsContent value="availability">
        <AvailabilityTab venueId={venueId} initialSlots={tourAvailability} />
      </TabsContent>
    </Tabs>
  )
}
