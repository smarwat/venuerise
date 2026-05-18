'use client'

import { useState } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from './ui/Dialog'
import { Button } from './ui/Button'
import { Input } from './ui/Input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/Select'
import { Loader2 } from 'lucide-react'
import type { Database } from '@/types/database'

type Lead = Database['public']['Tables']['leads']['Row']

interface AddLeadModalProps {
  open: boolean
  onClose: () => void
  onCreated: (lead: Lead) => void
}

export default function AddLeadModal({ open, onClose, onCreated }: AddLeadModalProps) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [form, setForm] = useState({
    name: '', email: '', phone: '', event_date: '',
    guest_count: '', budget: '', notes: '', urgency: 'medium', source: 'dashboard',
  })

  const set = (key: string, val: string) => setForm((f) => ({ ...f, [key]: val }))

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setLoading(true)
    try {
      const res = await fetch('/api/leads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: form.name,
          email: form.email,
          phone: form.phone || null,
          event_date: form.event_date || null,
          guest_count: form.guest_count ? parseInt(form.guest_count) : null,
          budget: form.budget ? parseFloat(form.budget) : null,
          notes: form.notes || null,
          urgency: form.urgency,
          source: form.source,
        }),
      })
      if (!res.ok) {
        const err = await res.json()
        setError(err.error?.formErrors?.[0] ?? 'Failed to create lead')
        return
      }
      const lead = await res.json()
      onCreated(lead)
      onClose()
      setForm({ name: '', email: '', phone: '', event_date: '', guest_count: '', budget: '', notes: '', urgency: 'medium', source: 'dashboard' })
    } finally {
      setLoading(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Add New Lead</DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="px-6 space-y-4">
          {error && (
            <div className="rounded-xl bg-red-500/10 border border-red-500/20 px-4 py-3 text-sm text-red-400">
              {error}
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-[#8B949E] mb-1.5">Full name *</label>
              <Input value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="Jordan Bennett" required />
            </div>
            <div>
              <label className="block text-xs font-medium text-[#8B949E] mb-1.5">Email *</label>
              <Input type="email" value={form.email} onChange={(e) => set('email', e.target.value)} placeholder="jordan@email.com" required />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-[#8B949E] mb-1.5">Phone</label>
              <Input value={form.phone} onChange={(e) => set('phone', e.target.value)} placeholder="+1 (555) 000-0000" />
            </div>
            <div>
              <label className="block text-xs font-medium text-[#8B949E] mb-1.5">Event Date</label>
              <Input type="date" value={form.event_date} onChange={(e) => set('event_date', e.target.value)} />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-[#8B949E] mb-1.5">Guest Count</label>
              <Input type="number" value={form.guest_count} onChange={(e) => set('guest_count', e.target.value)} placeholder="150" min="1" />
            </div>
            <div>
              <label className="block text-xs font-medium text-[#8B949E] mb-1.5">Budget ($)</label>
              <Input type="number" value={form.budget} onChange={(e) => set('budget', e.target.value)} placeholder="25000" min="0" />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-[#8B949E] mb-1.5">Urgency</label>
              <Select value={form.urgency} onValueChange={(v) => set('urgency', v)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="low">Low</SelectItem>
                  <SelectItem value="medium">Medium</SelectItem>
                  <SelectItem value="high">High</SelectItem>
                  <SelectItem value="critical">Critical</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="block text-xs font-medium text-[#8B949E] mb-1.5">Source</label>
              <Select value={form.source} onValueChange={(v) => set('source', v)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="dashboard">Dashboard</SelectItem>
                  <SelectItem value="widget">Website Widget</SelectItem>
                  <SelectItem value="referral">Referral</SelectItem>
                  <SelectItem value="social">Social Media</SelectItem>
                  <SelectItem value="other">Other</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-[#8B949E] mb-1.5">Notes</label>
            <textarea
              value={form.notes}
              onChange={(e) => set('notes', e.target.value)}
              placeholder="Any additional context about this lead…"
              rows={3}
              className="w-full bg-white/[0.06] border border-white/[0.12] rounded-xl px-3 py-2 text-sm text-[#F0F6FC] placeholder:text-[#8B949E] focus:outline-none focus:border-[#1A7FFF] focus:ring-2 focus:ring-[#1A7FFF]/20 transition-all resize-none"
            />
          </div>
        </form>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={loading}>Cancel</Button>
          <Button onClick={handleSubmit as unknown as React.MouseEventHandler} disabled={loading}>
            {loading ? <><Loader2 className="w-4 h-4 animate-spin" /> Creating…</> : 'Add Lead'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
