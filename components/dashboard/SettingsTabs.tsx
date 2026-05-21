'use client'

import { useState, useCallback } from 'react'
import { Tabs, TabsList, TabsTrigger, TabsContent } from './ui/Tabs'
import { Button } from './ui/Button'
import { Input } from './ui/Input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/Select'
import { Card, CardContent, CardHeader, CardTitle } from './ui/Card'
import { Save, Plus, Trash2, Check, Loader2, Users, ArrowRight, CreditCard, AlertTriangle } from 'lucide-react'
import Link from 'next/link'

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const KB_CATEGORIES = ['Pricing', 'Policies', 'FAQ', 'Amenities', 'Catering', 'Other']

interface SettingsTabsProps {
  venue: Record<string, unknown> | null
  knowledgeBase: Record<string, unknown>[]
  tourAvailability: Record<string, unknown>[]
  // Phase 8BC — blackout dates surface inside the Availability
  // tab. Defaults to empty so a server build that pre-dates 8BC
  // (or a venue with no blackouts) renders normally.
  tourBlackouts?: Record<string, unknown>[]
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
interface KnowledgeEntry {
  id: string
  venue_id: string
  category: string
  title: string
  content: string
  priority: number
  is_active: boolean
  created_at: string
  updated_at: string
}

interface RowState {
  saving: boolean
  toggling: boolean
  deleting: boolean
  error: string | null
  editing: boolean
}

const EMPTY_ROW_STATE: RowState = {
  saving: false,
  toggling: false,
  deleting: false,
  error: null,
  editing: false,
}

function humanizeKBError(code: string): string {
  switch (code) {
    case 'unauthorized':
      return 'Please sign in again.'
    case 'forbidden':
      return 'Only owners, admins, sales managers, or coordinators can edit knowledge.'
    case 'not_found':
      return 'Entry no longer exists. Refresh the page.'
    case 'validation_failed':
      return 'Invalid input. Check title (1–160) and content (1–8,000).'
    case 'rate_limited':
      return 'Too many edits in a short window. Pause for a moment and try again.'
    case 'unexpected_error':
      return 'Server error. Try again.'
    default:
      return code
  }
}

function normalizeKBRow(row: Record<string, unknown>): KnowledgeEntry {
  return {
    id: String(row.id ?? ''),
    venue_id: String(row.venue_id ?? ''),
    category: typeof row.category === 'string' ? row.category : 'FAQ',
    title: typeof row.title === 'string' ? row.title : '',
    content: typeof row.content === 'string' ? row.content : '',
    priority: typeof row.priority === 'number' ? row.priority : 5,
    is_active: row.is_active !== false,
    created_at:
      typeof row.created_at === 'string'
        ? row.created_at
        : new Date().toISOString(),
    updated_at:
      typeof row.updated_at === 'string'
        ? row.updated_at
        : new Date().toISOString(),
  }
}

function KnowledgeBaseTab({
  venueId,
  initialKB,
}: {
  venueId: string | null
  initialKB: Record<string, unknown>[]
}) {
  // Phase 9T-alt — Knowledge Base CRUD is now wired to the real
  // `/api/venues/[id]/knowledge[/[id]]` routes. RLS already gates
  // SELECT to venue members and writes to SALES_ROLES (migration
  // 005); the route also calls `requireVenueRole(SALES_ROLES)` so
  // forbidden cleanly collapses to 4xx without the row insert. Audit
  // + rate-limit are instrumented per route. UI states (idle /
  // saving / toggling / deleting / error / editing) are tracked per
  // row so concurrent edits to different rows don't stomp each other.
  const [kb, setKB] = useState<KnowledgeEntry[]>(() =>
    initialKB.map(normalizeKBRow)
  )
  const [rowState, setRowState] = useState<Record<string, RowState>>({})
  const [addOpen, setAddOpen] = useState(false)
  const [draft, setDraft] = useState({
    title: '',
    content: '',
    category: 'FAQ',
  })
  const [addSaving, setAddSaving] = useState(false)
  const [addError, setAddError] = useState<string | null>(null)
  const [editDraft, setEditDraft] = useState<
    Record<string, { title: string; content: string; category: string }>
  >({})

  const setRow = (id: string, partial: Partial<RowState>) => {
    setRowState((prev) => ({
      ...prev,
      [id]: { ...EMPTY_ROW_STATE, ...(prev[id] ?? {}), ...partial },
    }))
  }

  const draftValid =
    draft.title.trim().length > 0 &&
    draft.title.trim().length <= 160 &&
    draft.content.trim().length > 0 &&
    draft.content.trim().length <= 8000

  async function handleAdd() {
    if (!venueId || !draftValid || addSaving) return
    setAddSaving(true)
    setAddError(null)
    try {
      const res = await fetch(`/api/venues/${venueId}/knowledge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: draft.title.trim(),
          content: draft.content.trim(),
          category: draft.category,
          is_active: true,
          priority: 5,
        }),
      })
      const json = (await res.json().catch(() => null)) as
        | { item?: Record<string, unknown>; error?: string }
        | null
      if (!res.ok || !json || !json.item) {
        setAddError(humanizeKBError(json?.error ?? `request_failed_${res.status}`))
        return
      }
      const item = normalizeKBRow(json.item)
      setKB((prev) => [item, ...prev])
      setDraft({ title: '', content: '', category: 'FAQ' })
      setAddOpen(false)
    } catch (e) {
      setAddError(e instanceof Error ? e.message : 'Network error')
    } finally {
      setAddSaving(false)
    }
  }

  async function handleToggle(item: KnowledgeEntry) {
    if (!venueId) return
    const id = item.id
    setRow(id, { toggling: true, error: null })
    const nextActive = !item.is_active
    try {
      const res = await fetch(
        `/api/venues/${venueId}/knowledge/${id}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ is_active: nextActive }),
        }
      )
      const json = (await res.json().catch(() => null)) as
        | { item?: Record<string, unknown>; error?: string }
        | null
      if (!res.ok || !json || !json.item) {
        setRow(id, {
          toggling: false,
          error: humanizeKBError(json?.error ?? `request_failed_${res.status}`),
        })
        return
      }
      const updated = normalizeKBRow(json.item)
      setKB((prev) => prev.map((k) => (k.id === id ? updated : k)))
      setRow(id, { toggling: false, error: null })
    } catch (e) {
      setRow(id, {
        toggling: false,
        error: e instanceof Error ? e.message : 'Network error',
      })
    }
  }

  function handleStartEdit(item: KnowledgeEntry) {
    setEditDraft((prev) => ({
      ...prev,
      [item.id]: {
        title: item.title,
        content: item.content,
        category: item.category,
      },
    }))
    setRow(item.id, { editing: true, error: null })
  }

  function handleCancelEdit(id: string) {
    setEditDraft((prev) => {
      const next = { ...prev }
      delete next[id]
      return next
    })
    setRow(id, { editing: false, error: null })
  }

  async function handleSaveEdit(item: KnowledgeEntry) {
    if (!venueId) return
    const id = item.id
    const next = editDraft[id]
    if (!next) return
    const titleOk =
      next.title.trim().length > 0 && next.title.trim().length <= 160
    const contentOk =
      next.content.trim().length > 0 && next.content.trim().length <= 8000
    if (!titleOk || !contentOk) {
      setRow(id, {
        saving: false,
        error: 'Title must be 1–160 chars and content 1–8,000 chars.',
      })
      return
    }
    setRow(id, { saving: true, error: null })
    try {
      const patch: Record<string, unknown> = {}
      if (next.title.trim() !== item.title) patch.title = next.title.trim()
      if (next.content.trim() !== item.content)
        patch.content = next.content.trim()
      if (next.category !== item.category) patch.category = next.category
      if (Object.keys(patch).length === 0) {
        handleCancelEdit(id)
        return
      }
      const res = await fetch(
        `/api/venues/${venueId}/knowledge/${id}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(patch),
        }
      )
      const json = (await res.json().catch(() => null)) as
        | { item?: Record<string, unknown>; error?: string }
        | null
      if (!res.ok || !json || !json.item) {
        setRow(id, {
          saving: false,
          error: humanizeKBError(json?.error ?? `request_failed_${res.status}`),
        })
        return
      }
      const updated = normalizeKBRow(json.item)
      setKB((prev) => prev.map((k) => (k.id === id ? updated : k)))
      handleCancelEdit(id)
    } catch (e) {
      setRow(id, {
        saving: false,
        error: e instanceof Error ? e.message : 'Network error',
      })
    }
  }

  async function handleDelete(item: KnowledgeEntry) {
    if (!venueId) return
    if (
      typeof window !== 'undefined' &&
      // UI_INTERACTION_EXEMPT: admin-only knowledge delete — native confirm is intentional friction.
      !window.confirm(`Delete knowledge entry "${item.title}"? This cannot be undone.`)
    )
      return
    const id = item.id
    setRow(id, { deleting: true, error: null })
    try {
      const res = await fetch(
        `/api/venues/${venueId}/knowledge/${id}`,
        { method: 'DELETE' }
      )
      if (!res.ok) {
        const json = (await res.json().catch(() => null)) as
          | { error?: string }
          | null
        setRow(id, {
          deleting: false,
          error: humanizeKBError(json?.error ?? `request_failed_${res.status}`),
        })
        return
      }
      setKB((prev) => prev.filter((k) => k.id !== id))
      setRowState((prev) => {
        const next = { ...prev }
        delete next[id]
        return next
      })
    } catch (e) {
      setRow(id, {
        deleting: false,
        error: e instanceof Error ? e.message : 'Network error',
      })
    }
  }

  return (
    <div className="max-w-3xl space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-[#475569]">
          {kb.length} entries · AI uses this to answer lead questions accurately
        </p>
        <Button
          data-testid="kb-add-button"
          size="sm"
          onClick={() => setAddOpen(true)}
          disabled={addOpen || !venueId}
        >
          <Plus className="w-4 h-4" /> Add entry
        </Button>
      </div>

      <div className="rounded-xl border border-[#FDE68A] bg-[#FFFBEB] px-4 py-3">
        <p className="text-[12.5px] text-[#92400E] leading-relaxed">
          <span className="font-semibold">Heads up.</span>{' '}
          These entries guide AI replies. Avoid pasting secrets,
          credentials, or anything you wouldn&rsquo;t want surfaced in
          a reply. Edits are audited.
        </p>
      </div>

      {addOpen && (
        <Card>
          <CardContent className="pt-4 space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Select
                value={draft.category}
                onValueChange={(v) => setDraft((d) => ({ ...d, category: v }))}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {KB_CATEGORIES.map((c) => (
                    <SelectItem key={c} value={c}>
                      {c}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Input
                data-testid="kb-draft-title-input"
                value={draft.title}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, title: e.target.value }))
                }
                placeholder="Entry title"
                maxLength={160}
              />
            </div>
            <textarea
              data-testid="kb-draft-content-input"
              value={draft.content}
              onChange={(e) =>
                setDraft((d) => ({ ...d, content: e.target.value }))
              }
              rows={4}
              maxLength={8000}
              placeholder="Content the AI will use to answer questions…"
              className="w-full bg-white border border-[#E2E8F0] rounded-xl px-3.5 py-2.5 text-sm text-[#0F172A] placeholder:text-[#94A3B8] focus:outline-none focus:border-[#1D4ED8] focus:ring-[3px] focus:ring-[#3B82F6]/15 resize-y"
            />
            <div className="flex items-center justify-between gap-3">
              <div className="text-[11px] text-[#94A3B8]">
                {draft.title.trim().length}/160 · {draft.content.trim().length}/8,000
              </div>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setAddOpen(false)
                    setAddError(null)
                    setDraft({ title: '', content: '', category: 'FAQ' })
                  }}
                  disabled={addSaving}
                >
                  Cancel
                </Button>
                <Button
                  data-testid="kb-draft-save-button"
                  size="sm"
                  onClick={handleAdd}
                  disabled={!draftValid || addSaving}
                >
                  {addSaving ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" /> Saving…
                    </>
                  ) : (
                    'Save'
                  )}
                </Button>
              </div>
            </div>
            {addError && (
              <p className="text-[12px] text-[#B91C1C]">{addError}</p>
            )}
          </CardContent>
        </Card>
      )}

      {kb.length === 0 && !addOpen && (
        <div className="text-center py-12 text-sm text-[#475569]">
          No knowledge entries yet. Add pricing, policies, FAQs, and
          amenities so your AI can respond accurately.
        </div>
      )}

      {kb.map((item) => {
        const rs = rowState[item.id] ?? EMPTY_ROW_STATE
        const ed = editDraft[item.id]
        const editTitleLen = (ed?.title ?? '').trim().length
        const editContentLen = (ed?.content ?? '').trim().length
        const editValid =
          rs.editing &&
          ed != null &&
          editTitleLen > 0 &&
          editTitleLen <= 160 &&
          editContentLen > 0 &&
          editContentLen <= 8000
        const busy = rs.saving || rs.toggling || rs.deleting
        return (
          <div
            key={item.id}
            data-testid="kb-row"
            data-kb-id={item.id}
            data-kb-title={item.title}
            data-kb-active={item.is_active ? 'true' : 'false'}
            className={`p-4 rounded-2xl border transition-all ${
              item.is_active
                ? 'bg-white border-[#E2E8F0] shadow-card'
                : 'bg-[#F8FAFC] border-[#F1F5F9] opacity-70'
            }`}
          >
            {rs.editing && ed ? (
              <div className="space-y-3">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <Select
                    value={ed.category}
                    onValueChange={(v) =>
                      setEditDraft((p) => ({
                        ...p,
                        [item.id]: { ...ed, category: v },
                      }))
                    }
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {KB_CATEGORIES.map((c) => (
                        <SelectItem key={c} value={c}>
                          {c}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Input
                    value={ed.title}
                    onChange={(e) =>
                      setEditDraft((p) => ({
                        ...p,
                        [item.id]: { ...ed, title: e.target.value },
                      }))
                    }
                    placeholder="Entry title"
                    maxLength={160}
                  />
                </div>
                <textarea
                  value={ed.content}
                  onChange={(e) =>
                    setEditDraft((p) => ({
                      ...p,
                      [item.id]: { ...ed, content: e.target.value },
                    }))
                  }
                  rows={4}
                  maxLength={8000}
                  className="w-full bg-white border border-[#E2E8F0] rounded-xl px-3.5 py-2.5 text-sm text-[#0F172A] focus:outline-none focus:border-[#1D4ED8] focus:ring-[3px] focus:ring-[#3B82F6]/15 resize-y"
                />
                <div className="flex items-center justify-between gap-3">
                  <div className="text-[11px] text-[#94A3B8]">
                    {editTitleLen}/160 · {editContentLen}/8,000
                  </div>
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => handleCancelEdit(item.id)}
                      disabled={busy}
                    >
                      Cancel
                    </Button>
                    <Button
                      data-testid="kb-row-save-edit-button"
                      size="sm"
                      onClick={() => handleSaveEdit(item)}
                      disabled={!editValid || busy}
                    >
                      {rs.saving ? (
                        <>
                          <Loader2 className="w-4 h-4 animate-spin" /> Saving…
                        </>
                      ) : (
                        <>
                          <Save className="w-4 h-4" /> Save
                        </>
                      )}
                    </Button>
                  </div>
                </div>
                {rs.error && (
                  <p className="text-[12px] text-[#B91C1C]">{rs.error}</p>
                )}
              </div>
            ) : (
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1 flex-wrap">
                    <span className="text-[10px] font-semibold text-[#1D4ED8] bg-[#EFF6FF] border border-[#BFDBFE] rounded-md px-2 py-0.5">
                      {item.category}
                    </span>
                    <span className="text-sm font-medium text-[#0F172A]">
                      {item.title}
                    </span>
                    {!item.is_active && (
                      <span className="text-[10px] font-semibold text-[#64748B] bg-[#F1F5F9] border border-[#E2E8F0] rounded-md px-2 py-0.5">
                        Disabled
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-[#475569] leading-relaxed line-clamp-3">
                    {item.content}
                  </p>
                  {rs.error && (
                    <p className="text-[12px] text-[#B91C1C] mt-2">{rs.error}</p>
                  )}
                </div>
                <div className="flex gap-1.5 shrink-0">
                  <Button
                    data-testid="kb-row-edit-button"
                    size="icon"
                    variant="ghost"
                    onClick={() => handleStartEdit(item)}
                    disabled={busy}
                    title="Edit"
                    aria-label="Edit entry"
                  >
                    <Save className="w-3.5 h-3.5 text-[#475569]" />
                  </Button>
                  <Button
                    data-testid="kb-row-toggle-button"
                    size="icon"
                    variant="ghost"
                    onClick={() => handleToggle(item)}
                    disabled={busy}
                    title={item.is_active ? 'Disable' : 'Enable'}
                    aria-label={item.is_active ? 'Disable entry' : 'Enable entry'}
                  >
                    {rs.toggling ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <Check
                        className={`w-3.5 h-3.5 ${item.is_active ? 'text-[#059669]' : 'text-[#94A3B8]'}`}
                      />
                    )}
                  </Button>
                  <Button
                    data-testid="kb-row-delete-button"
                    size="icon"
                    variant="destructive"
                    onClick={() => handleDelete(item)}
                    disabled={busy}
                    title="Delete"
                    aria-label="Delete entry"
                  >
                    {rs.deleting ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <Trash2 className="w-3.5 h-3.5" />
                    )}
                  </Button>
                </div>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

// ---- Availability Tab ----
// Revenue OS: these windows are the source for future tour-slot suggestions.

/**
 * Single tour-availability slot. Mirrors the row shape returned
 * by `/api/venues/[id]/availability` (snake_case to match the
 * DB). We keep the type local so the tab doesn't pull the full
 * Database type for one usage.
 */
interface AvailabilitySlot {
  id: string
  venue_id: string
  day_of_week: number
  start_time: string
  end_time: string
  is_active: boolean
  created_at: string
}

/**
 * Per-row UI buffer. Tracks the in-flight edit alongside the
 * persisted slot so we can show explicit Save buttons + revert
 * cleanly on failure. `pending` covers both initial saves of a
 * just-added row and PATCH retries.
 */
interface SlotDraft {
  id: string
  start_time: string
  end_time: string
  is_active: boolean
  dirty: boolean
  pending: boolean
  error: string | null
}

/** Strip seconds — DB sometimes returns `HH:MM:SS`. */
function trimSeconds(t: string): string {
  return t.length > 5 ? t.slice(0, 5) : t
}

function buildInitialDrafts(
  rows: ReadonlyArray<Record<string, unknown>>
): Record<string, SlotDraft> {
  const out: Record<string, SlotDraft> = {}
  for (const r of rows) {
    const id = r.id as string | undefined
    if (!id) continue
    out[id] = {
      id,
      start_time: trimSeconds((r.start_time as string) ?? '09:00'),
      end_time: trimSeconds((r.end_time as string) ?? '17:00'),
      is_active: (r.is_active as boolean | undefined) ?? true,
      dirty: false,
      pending: false,
      error: null,
    }
  }
  return out
}

function normalizeRow(r: Record<string, unknown>): AvailabilitySlot {
  return {
    id: r.id as string,
    venue_id: r.venue_id as string,
    day_of_week: r.day_of_week as number,
    start_time: trimSeconds(r.start_time as string),
    end_time: trimSeconds(r.end_time as string),
    is_active: (r.is_active as boolean | undefined) ?? true,
    created_at: r.created_at as string,
  }
}

/**
 * Phase 8BC — tour blackout row shape. Mirrors the
 * `tour_blackouts` schema (migration 025). `blackout_date` is a
 * `YYYY-MM-DD` string — never a full ISO timestamp.
 */
interface TourBlackout {
  id: string
  venue_id: string
  blackout_date: string
  reason: string | null
  created_at: string
}

function normalizeBlackoutRow(r: Record<string, unknown>): TourBlackout {
  // The DB returns `blackout_date` as `YYYY-MM-DD`, but if a future
  // path returns a full ISO we trim defensively to the date prefix.
  const raw = (r.blackout_date as string | undefined) ?? ''
  const date = raw.length >= 10 ? raw.slice(0, 10) : raw
  return {
    id: r.id as string,
    venue_id: r.venue_id as string,
    blackout_date: date,
    reason: (r.reason as string | null | undefined) ?? null,
    created_at: r.created_at as string,
  }
}

/**
 * Format `YYYY-MM-DD` into the operator-readable label used in the
 * blackout list ("Mon, May 26"). We deliberately render in the
 * BROWSER's locale + timezone here — the date is a calendar date,
 * not a wall-clock instant, so anchoring at noon UTC keeps the
 * label stable across timezones.
 */
function formatBlackoutDate(date: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return date
  const d = new Date(`${date}T12:00:00Z`)
  if (!Number.isFinite(d.getTime())) return date
  return new Intl.DateTimeFormat(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(d)
}

function AvailabilityTab({
  venueId,
  initialSlots,
  initialBlackouts,
}: {
  venueId: string | null
  initialSlots: Record<string, unknown>[]
  initialBlackouts: Record<string, unknown>[]
}) {
  const initialNormalized = initialSlots
    .filter((r) => typeof r.id === 'string')
    .map(normalizeRow)
  const [slots, setSlots] = useState<AvailabilitySlot[]>(initialNormalized)
  const [drafts, setDrafts] = useState<Record<string, SlotDraft>>(
    buildInitialDrafts(initialSlots)
  )
  // Pending "add" per day so the user gets per-day feedback when
  // multiple inserts race.
  const [addingByDay, setAddingByDay] = useState<Record<number, boolean>>({})
  const [topLevelError, setTopLevelError] = useState<string | null>(null)

  // Phase 8BC — blackout dates state. Hydrated from the server-
  // side fetch in /dashboard/settings/page.tsx; subsequent mutations
  // are optimistic against the API routes at
  // /api/venues/[id]/tour-blackouts{,/[blackoutId]}. Per-row pending
  // tracking keeps a slow delete from queuing two clicks.
  const initialBlackoutRows = initialBlackouts
    .filter((r) => typeof r.id === 'string')
    .map(normalizeBlackoutRow)
  const [blackouts, setBlackouts] =
    useState<TourBlackout[]>(initialBlackoutRows)
  const [pendingBlackoutIds, setPendingBlackoutIds] = useState<
    Record<string, boolean>
  >({})
  const [newBlackoutDate, setNewBlackoutDate] = useState<string>('')
  const [newBlackoutReason, setNewBlackoutReason] = useState<string>('')
  const [addingBlackout, setAddingBlackout] = useState(false)
  const [blackoutError, setBlackoutError] = useState<string | null>(null)

  // The settings page server-side hydrates with the initial
  // slot set; we never refetch on mount. If a future surface
  // wants to refresh (e.g. realtime) it can call this helper.
  const refetch = useCallback(async () => {
    if (!venueId) return
    try {
      const res = await fetch(`/api/venues/${venueId}/availability`, {
        credentials: 'same-origin',
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as
          | { error?: string }
          | null
        setTopLevelError(body?.error ?? `HTTP ${res.status}`)
        return
      }
      const body = (await res.json()) as { items?: Record<string, unknown>[] }
      const items = Array.isArray(body.items) ? body.items : []
      setSlots(items.filter((r) => typeof r.id === 'string').map(normalizeRow))
      setDrafts(buildInitialDrafts(items))
      setTopLevelError(null)
    } catch (err) {
      setTopLevelError(
        err instanceof Error ? err.message : 'Network error'
      )
    }
  }, [venueId])

  const handleAdd = useCallback(
    async (dayOfWeek: number) => {
      if (!venueId || addingByDay[dayOfWeek]) return
      setTopLevelError(null)
      setAddingByDay((m) => ({ ...m, [dayOfWeek]: true }))
      try {
        const res = await fetch(`/api/venues/${venueId}/availability`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({
            day_of_week: dayOfWeek,
            start_time: '09:00',
            end_time: '17:00',
            is_active: true,
          }),
        })
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as
            | { error?: string }
            | null
          setTopLevelError(body?.error ?? `HTTP ${res.status}`)
          return
        }
        const body = (await res.json()) as { item?: Record<string, unknown> }
        if (!body.item) {
          setTopLevelError('Server returned an empty row.')
          return
        }
        const row = normalizeRow(body.item)
        setSlots((prev) => [...prev, row])
        setDrafts((prev) => ({
          ...prev,
          [row.id]: {
            id: row.id,
            start_time: row.start_time,
            end_time: row.end_time,
            is_active: row.is_active,
            dirty: false,
            pending: false,
            error: null,
          },
        }))
      } catch (err) {
        setTopLevelError(
          err instanceof Error ? err.message : 'Network error'
        )
      } finally {
        setAddingByDay((m) => ({ ...m, [dayOfWeek]: false }))
      }
    },
    [venueId, addingByDay]
  )

  const setDraftField = useCallback(
    (slotId: string, patch: Partial<SlotDraft>) => {
      setDrafts((prev) => {
        const cur = prev[slotId]
        if (!cur) return prev
        return {
          ...prev,
          [slotId]: {
            ...cur,
            ...patch,
            dirty: true,
            error: null,
          },
        }
      })
    },
    []
  )

  const handleSave = useCallback(
    async (slotId: string) => {
      if (!venueId) return
      const draft = drafts[slotId]
      if (!draft) return
      if (!draft.dirty) return
      if (draft.pending) return
      // Client-side validation — explicit error in the row, no
      // network call.
      if (draft.start_time >= draft.end_time) {
        setDrafts((prev) => ({
          ...prev,
          [slotId]: {
            ...draft,
            pending: false,
            error: 'Start time must be before end time.',
          },
        }))
        return
      }
      setDrafts((prev) => ({
        ...prev,
        [slotId]: { ...draft, pending: true, error: null },
      }))
      try {
        const res = await fetch(
          `/api/venues/${venueId}/availability/${slotId}`,
          {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({
              start_time: draft.start_time,
              end_time: draft.end_time,
              is_active: draft.is_active,
            }),
          }
        )
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as
            | { error?: string }
            | null
          setDrafts((prev) => ({
            ...prev,
            [slotId]: {
              ...draft,
              pending: false,
              error: body?.error ?? `HTTP ${res.status}`,
            },
          }))
          return
        }
        const body = (await res.json()) as { item?: Record<string, unknown> }
        const row = body.item ? normalizeRow(body.item) : null
        if (row) {
          setSlots((prev) =>
            prev.map((s) => (s.id === row.id ? row : s))
          )
          setDrafts((prev) => ({
            ...prev,
            [slotId]: {
              id: row.id,
              start_time: row.start_time,
              end_time: row.end_time,
              is_active: row.is_active,
              dirty: false,
              pending: false,
              error: null,
            },
          }))
        } else {
          setDrafts((prev) => ({
            ...prev,
            [slotId]: { ...draft, dirty: false, pending: false, error: null },
          }))
        }
      } catch (err) {
        setDrafts((prev) => ({
          ...prev,
          [slotId]: {
            ...draft,
            pending: false,
            error: err instanceof Error ? err.message : 'Network error',
          },
        }))
      }
    },
    [venueId, drafts]
  )

  const handleDelete = useCallback(
    async (slotId: string) => {
      if (!venueId) return
      const draft = drafts[slotId]
      if (!draft) return
      setDrafts((prev) => ({
        ...prev,
        [slotId]: { ...draft, pending: true, error: null },
      }))
      try {
        const res = await fetch(
          `/api/venues/${venueId}/availability/${slotId}`,
          { method: 'DELETE', credentials: 'same-origin' }
        )
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as
            | { error?: string }
            | null
          setDrafts((prev) => ({
            ...prev,
            [slotId]: {
              ...draft,
              pending: false,
              error: body?.error ?? `HTTP ${res.status}`,
            },
          }))
          return
        }
        setSlots((prev) => prev.filter((s) => s.id !== slotId))
        setDrafts((prev) => {
          const next = { ...prev }
          delete next[slotId]
          return next
        })
      } catch (err) {
        setDrafts((prev) => ({
          ...prev,
          [slotId]: {
            ...draft,
            pending: false,
            error: err instanceof Error ? err.message : 'Network error',
          },
        }))
      }
    },
    [venueId, drafts]
  )

  // Phase 8BC — blackout handlers. Optimistic update on add;
  // revert + inline error on failure. Per-row pending flag covers
  // the slow-delete case.
  const handleAddBlackout = useCallback(async () => {
    if (!venueId || addingBlackout) return
    const trimmedDate = newBlackoutDate.trim()
    const trimmedReason = newBlackoutReason.trim()
    if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmedDate)) {
      setBlackoutError('Pick a valid YYYY-MM-DD date.')
      return
    }
    setAddingBlackout(true)
    setBlackoutError(null)
    try {
      const res = await fetch(`/api/venues/${venueId}/tour-blackouts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          blackout_date: trimmedDate,
          ...(trimmedReason.length > 0 ? { reason: trimmedReason } : {}),
        }),
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as
          | { error?: string; detail?: string }
          | null
        // 409 (conflict) — already blacked out. Surface a friendly
        // copy instead of the raw `conflict` code.
        if (res.status === 409) {
          setBlackoutError('That date is already blocked.')
          return
        }
        setBlackoutError(body?.error ?? `HTTP ${res.status}`)
        return
      }
      const body = (await res.json()) as { item?: Record<string, unknown> }
      if (!body.item) {
        setBlackoutError('Server returned an empty row.')
        return
      }
      const row = normalizeBlackoutRow(body.item)
      setBlackouts((prev) =>
        [...prev, row].sort((a, b) =>
          a.blackout_date.localeCompare(b.blackout_date)
        )
      )
      setNewBlackoutDate('')
      setNewBlackoutReason('')
    } catch (err) {
      setBlackoutError(err instanceof Error ? err.message : 'Network error')
    } finally {
      setAddingBlackout(false)
    }
  }, [venueId, addingBlackout, newBlackoutDate, newBlackoutReason])

  const handleDeleteBlackout = useCallback(
    async (blackoutId: string) => {
      if (!venueId) return
      setPendingBlackoutIds((m) => ({ ...m, [blackoutId]: true }))
      setBlackoutError(null)
      try {
        const res = await fetch(
          `/api/venues/${venueId}/tour-blackouts/${blackoutId}`,
          { method: 'DELETE', credentials: 'same-origin' }
        )
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as
            | { error?: string }
            | null
          setBlackoutError(body?.error ?? `HTTP ${res.status}`)
          return
        }
        setBlackouts((prev) => prev.filter((b) => b.id !== blackoutId))
      } catch (err) {
        setBlackoutError(
          err instanceof Error ? err.message : 'Network error'
        )
      } finally {
        setPendingBlackoutIds((m) => {
          const next = { ...m }
          delete next[blackoutId]
          return next
        })
      }
    },
    [venueId]
  )

  if (!venueId) {
    return <NoVenueState />
  }

  return (
    <div className="max-w-3xl space-y-4">
      <div>
        <h3 className="text-[15px] font-semibold text-[#0F172A]">
          Tour availability
        </h3>
        <p className="text-[13px] text-[#475569] mt-0.5">
          Set the days and hours when tours can be scheduled.
        </p>
      </div>

      {topLevelError && (
        <div className="rounded-xl border border-[#FECACA] bg-[#FEF2F2] px-3 py-2.5 flex items-start gap-2 text-[12.5px] text-[#B91C1C]">
          <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
          <div className="flex-1 min-w-0">
            <p>Couldn&apos;t save availability: {topLevelError}</p>
            <button
              type="button"
              onClick={refetch}
              className="mt-1 text-[#B91C1C] underline hover:no-underline"
            >
              Reload
            </button>
          </div>
        </div>
      )}

      <div className="rounded-2xl border border-[#E6E8EF] bg-white divide-y divide-[#F1F5F9]">
        {DAYS.map((day, dow) => {
          const daySlots = slots
            .filter((s) => s.day_of_week === dow)
            .sort((a, b) => a.start_time.localeCompare(b.start_time))
          const adding = Boolean(addingByDay[dow])
          return (
            <div key={day} className="px-4 py-3">
              <div className="flex items-center justify-between gap-3">
                <span className="text-[10.5px] font-semibold uppercase tracking-[0.12em] text-[#64748B]">
                  {day}
                </span>
                <button
                  type="button"
                  onClick={() => handleAdd(dow)}
                  disabled={adding}
                  className="inline-flex items-center gap-1 text-[11.5px] font-semibold px-2 py-1 rounded-md border border-[#E2E8F0] text-[#475569] hover:text-[#0F172A] hover:bg-[#F8FAFC] disabled:opacity-50"
                >
                  {adding ? (
                    <Loader2 className="w-3 h-3 animate-spin" />
                  ) : (
                    <Plus className="w-3 h-3" />
                  )}
                  Add
                </button>
              </div>

              {daySlots.length === 0 ? (
                <p className="mt-1 text-[11.5px] text-[#94A3B8]">
                  No tour windows on {day}.
                </p>
              ) : (
                <ul className="mt-2 space-y-2">
                  {daySlots.map((slot) => {
                    const draft = drafts[slot.id]
                    if (!draft) return null
                    return (
                      <li
                        key={slot.id}
                        className="rounded-xl border border-[#E6E8EF] bg-[#F8FAFC] px-3 py-2 flex flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-2.5"
                      >
                        <div className="flex items-center gap-1.5">
                          <input
                            type="time"
                            value={draft.start_time}
                            onChange={(e) =>
                              setDraftField(slot.id, {
                                start_time: e.target.value,
                              })
                            }
                            disabled={draft.pending}
                            className="text-[12.5px] bg-white border border-[#E2E8F0] rounded-md px-2 py-1 outline-none text-[#0F172A] focus:border-[#1D4ED8]"
                          />
                          <span className="text-[11.5px] text-[#94A3B8]">to</span>
                          <input
                            type="time"
                            value={draft.end_time}
                            onChange={(e) =>
                              setDraftField(slot.id, {
                                end_time: e.target.value,
                              })
                            }
                            disabled={draft.pending}
                            className="text-[12.5px] bg-white border border-[#E2E8F0] rounded-md px-2 py-1 outline-none text-[#0F172A] focus:border-[#1D4ED8]"
                          />
                        </div>
                        <label className="inline-flex items-center gap-1.5 text-[11.5px] text-[#475569] cursor-pointer select-none">
                          <input
                            type="checkbox"
                            checked={draft.is_active}
                            onChange={(e) =>
                              setDraftField(slot.id, {
                                is_active: e.target.checked,
                              })
                            }
                            disabled={draft.pending}
                            className="accent-[#0F172A]"
                          />
                          Active
                        </label>
                        <div className="flex-1" />
                        <div className="flex items-center gap-1.5">
                          <button
                            type="button"
                            onClick={() => handleSave(slot.id)}
                            disabled={!draft.dirty || draft.pending}
                            className="inline-flex items-center gap-1 text-[11.5px] font-semibold px-2.5 py-1 rounded-md bg-[#0F172A] text-white hover:bg-[#1E293B] disabled:opacity-40"
                          >
                            {draft.pending ? (
                              <Loader2 className="w-3 h-3 animate-spin" />
                            ) : !draft.dirty ? (
                              <Check className="w-3 h-3" />
                            ) : (
                              <Save className="w-3 h-3" />
                            )}
                            {draft.pending
                              ? 'Saving…'
                              : !draft.dirty
                                ? 'Saved'
                                : 'Save'}
                          </button>
                          <button
                            type="button"
                            onClick={() => handleDelete(slot.id)}
                            disabled={draft.pending}
                            title="Delete slot"
                            className="inline-flex items-center text-[#94A3B8] hover:text-[#DC2626] disabled:opacity-40 px-1.5 py-1 rounded-md hover:bg-[#FEF2F2]"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                        {draft.error && (
                          <div className="sm:basis-full text-[11px] text-[#B91C1C] flex items-center gap-1">
                            <AlertTriangle className="w-3 h-3" />
                            {draft.error}
                          </div>
                        )}
                      </li>
                    )
                  })}
                </ul>
              )}
            </div>
          )
        })}
      </div>

      {/* Phase 8BC — Blackout dates. Operator adds full-day
          blocks (holidays, private events, closures); the
          slot-suggestion helper drops candidates that fall on a
          blackout date. Blackouts DO NOT cancel existing tours
          or block manual scheduling — they only affect what the
          system SUGGESTS. */}
      <div>
        <h3 className="text-[15px] font-semibold text-[#0F172A]">
          Blackout dates
        </h3>
        <p className="text-[13px] text-[#475569] mt-0.5">
          Block days when tours should not be suggested.
        </p>
      </div>

      <div className="rounded-2xl border border-[#E6E8EF] bg-white divide-y divide-[#F1F5F9]">
        <div className="px-4 py-3 flex flex-col gap-2 sm:flex-row sm:items-end sm:gap-2.5">
          <label className="flex-1 min-w-[160px]">
            <span className="block text-[10.5px] font-semibold uppercase tracking-[0.12em] text-[#64748B]">
              Date
            </span>
            <input
              type="date"
              value={newBlackoutDate}
              onChange={(e) => setNewBlackoutDate(e.target.value)}
              disabled={addingBlackout}
              className="mt-1 w-full text-[12.5px] bg-white border border-[#E2E8F0] rounded-md px-2.5 py-1.5 outline-none text-[#0F172A] focus:border-[#1D4ED8]"
            />
          </label>
          <label className="flex-[2] min-w-[200px]">
            <span className="block text-[10.5px] font-semibold uppercase tracking-[0.12em] text-[#64748B]">
              Reason (optional)
            </span>
            <input
              type="text"
              value={newBlackoutReason}
              onChange={(e) => setNewBlackoutReason(e.target.value)}
              disabled={addingBlackout}
              maxLength={240}
              placeholder="Memorial Day, private event…"
              className="mt-1 w-full text-[12.5px] bg-white border border-[#E2E8F0] rounded-md px-2.5 py-1.5 outline-none text-[#0F172A] placeholder:text-[#94A3B8] focus:border-[#1D4ED8]"
            />
          </label>
          <button
            type="button"
            onClick={handleAddBlackout}
            disabled={addingBlackout || newBlackoutDate.trim().length === 0}
            className="shrink-0 inline-flex items-center gap-1.5 text-[11.5px] font-semibold px-3 py-1.5 rounded-md bg-[#0F172A] text-white hover:bg-[#1E293B] disabled:opacity-40"
          >
            {addingBlackout ? (
              <Loader2 className="w-3 h-3 animate-spin" />
            ) : (
              <Plus className="w-3 h-3" />
            )}
            Add blackout
          </button>
        </div>

        {blackoutError && (
          <div className="px-4 py-2 text-[11.5px] text-[#B91C1C] flex items-center gap-1 bg-[#FEF2F2]">
            <AlertTriangle className="w-3 h-3" />
            {blackoutError}
          </div>
        )}

        {blackouts.length === 0 ? (
          <div className="px-4 py-3 text-[11.5px] text-[#94A3B8]">
            No blackout dates yet. Add one above to block a day from tour suggestions.
          </div>
        ) : (
          <ul>
            {blackouts.map((b) => {
              const pending = Boolean(pendingBlackoutIds[b.id])
              return (
                <li
                  key={b.id}
                  className="px-4 py-2.5 flex items-center gap-3"
                >
                  <div className="min-w-0 flex-1">
                    <div className="text-[12.5px] font-semibold text-[#0F172A]">
                      {formatBlackoutDate(b.blackout_date)}
                    </div>
                    {b.reason && (
                      <div className="text-[11.5px] text-[#475569] truncate">
                        {b.reason}
                      </div>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => handleDeleteBlackout(b.id)}
                    disabled={pending}
                    title="Delete blackout"
                    className="shrink-0 inline-flex items-center text-[#94A3B8] hover:text-[#DC2626] disabled:opacity-40 px-1.5 py-1 rounded-md hover:bg-[#FEF2F2]"
                  >
                    {pending ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <Trash2 className="w-3.5 h-3.5" />
                    )}
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </div>

      <p className="text-[11px] text-[#94A3B8]">
        Tour windows are stored per venue. The Tour Booking
        surfaces will eventually use these as suggestions when
        scheduling new tours.
      </p>
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
export default function SettingsTabs({ venue, knowledgeBase, tourAvailability, tourBlackouts }: SettingsTabsProps) {
  const venueId = (venue?.id as string) ?? null

  return (
    <Tabs defaultValue="profile">
      <TabsList className="mb-6" data-testid="settings-tabs-list">
        <TabsTrigger value="profile" data-testid="settings-tab-profile">Venue Profile</TabsTrigger>
        <TabsTrigger value="ai" data-testid="settings-tab-ai">AI Configuration</TabsTrigger>
        <TabsTrigger value="kb" data-testid="settings-tab-kb">Knowledge Base</TabsTrigger>
        <TabsTrigger value="availability" data-testid="settings-tab-availability">Availability</TabsTrigger>
        <TabsTrigger value="team" data-testid="settings-tab-team">Team</TabsTrigger>
        <TabsTrigger value="billing" data-testid="settings-tab-billing">Billing</TabsTrigger>
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
        <AvailabilityTab
          venueId={venueId}
          initialSlots={tourAvailability}
          initialBlackouts={tourBlackouts ?? []}
        />
      </TabsContent>

      <TabsContent value="team">
        <TeamTabLink />
      </TabsContent>

      <TabsContent value="billing">
        <BillingTabLink />
      </TabsContent>
    </Tabs>
  )
}

// ---- Billing tab ----
// Phase 7D — the billing surface lives at /dashboard/settings/billing so
// the subscription read + Stripe round-trips stay server-side. This tab
// is a pointer card to keep SettingsTabs.tsx (a client component) free
// of server-only billing imports.
function BillingTabLink() {
  return (
    <div className="max-w-2xl">
      <Link
        href="/dashboard/settings/billing"
        className="group flex items-center gap-4 rounded-2xl border border-[#E2E8F0] bg-white px-5 py-4 hover:border-[#CBD5E1] hover:bg-[#F8FAFC] transition-colors"
      >
        <div className="w-10 h-10 rounded-xl bg-[#ECFDF5] text-[#047857] flex items-center justify-center shrink-0">
          <CreditCard className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[14px] font-semibold text-[#0F172A]">
            Subscription & billing
          </div>
          <div className="text-[12px] text-[#64748B] mt-0.5">
            View your plan, manage payment method, download invoices.
          </div>
        </div>
        <ArrowRight className="h-4 w-4 text-[#94A3B8] group-hover:text-[#0F172A] transition-colors" />
      </Link>
    </div>
  )
}

// ---- Team tab ----
// Phase 6E — the team surface lives at its own route so it can be linked
// directly (and so future RBAC checks render server-side). The tab body
// here is just a pointer card.
function TeamTabLink() {
  return (
    <div className="max-w-2xl">
      <Link
        href="/dashboard/settings/team"
        className="group flex items-center gap-4 rounded-2xl border border-[#E2E8F0] bg-white px-5 py-4 hover:border-[#CBD5E1] hover:bg-[#F8FAFC] transition-colors"
      >
        <div className="w-10 h-10 rounded-xl bg-[#EFF6FF] text-[#1D4ED8] flex items-center justify-center shrink-0">
          <Users className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[14px] font-semibold text-[#0F172A]">
            Manage team & invitations
          </div>
          <div className="text-[12px] text-[#64748B] mt-0.5">
            Invite teammates, change roles, and revoke access.
          </div>
        </div>
        <ArrowRight className="h-4 w-4 text-[#94A3B8] group-hover:text-[#0F172A] transition-colors" />
      </Link>
    </div>
  )
}
