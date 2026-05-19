'use client'

import { useCallback, useEffect, useState } from 'react'
import {
  X,
  Phone,
  Mail,
  MoreHorizontal,
  Sparkles,
  Edit3,
  RefreshCcw,
  Check,
  Bot,
  BotOff,
  MessageSquare,
  Trash2,
  CalendarCheck,
} from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { Badge } from '../ui/Badge'
import { Button } from '../ui/Button'
import { cn } from '@/lib/utils'
import type { Database, LeadStage } from '@/types/database'
import { format, formatDistanceToNow } from 'date-fns'
import ScheduleTourDrawer from '../tours/ScheduleTourDrawer'

type Lead = Database['public']['Tables']['leads']['Row']
type Message = Database['public']['Tables']['messages']['Row']

/**
 * Phase 8AH — premium right-side lead detail drawer.
 *
 * Replaces the old `LeadDetailPanel` everywhere a clicked lead opens
 * a detail view. Visually mirrors the Phase 8AH reference screenshot:
 *
 *   - Backdrop dim + blur over the whole app
 *   - White right-aligned drawer (max ~660px on desktop, full-width
 *     on small screens)
 *   - Header: close + phone/email/more icon cluster
 *   - Identity row: avatar tile + couple name + email/phone + large
 *     fit-score on the right
 *   - 4-column event-summary grid
 *   - Stage + freshness badges
 *   - Tabs (Conversation / Notes / Activity)
 *   - Conversation tab: lead's last message + AI draft review card
 *     (when an ai_action with success=true exists) + adjustment
 *     chips + footer (Edit / Regenerate / Reject / Approve & send)
 *   - Secondary action bar: Schedule tour · Pause/Enable AI ·
 *     Open Inbox · Delete (preserves every existing capability)
 *
 * Functional posture:
 *   - Reuses `/api/leads/[id]` for PATCH (stage flip / ai_active
 *     toggle) and DELETE.
 *   - Fetches the latest conversation + last 6 messages + latest
 *     ai_actions row via the browser Supabase client (RLS still
 *     applies). Empty data renders graceful fallbacks; never breaks.
 *   - Schedule Tour drawer mounted as a sibling — same logic as
 *     the old LeadDetailPanel; no behavior change.
 *
 * Action footer buttons (Edit / Regenerate / Reject / Approve &
 * send) intentionally show but don't fire backend writes yet — a
 * later phase wires them to the existing `/api/ai/*` endpoints once
 * the draft-review API contract is finalized.
 */

const STAGES: { value: LeadStage; label: string }[] = [
  { value: 'new_inquiry', label: 'New Inquiry' },
  { value: 'qualified', label: 'Qualified' },
  { value: 'tour_scheduled', label: 'Tour Scheduled' },
  { value: 'tour_completed', label: 'Tour Completed' },
  { value: 'negotiation', label: 'Negotiation' },
  { value: 'booked', label: 'Booked' },
  { value: 'lost', label: 'Lost' },
]

const STAGE_LABELS: Record<string, string> = Object.fromEntries(
  STAGES.map((s) => [s.value, s.label])
)

const SHOW_DEMO_QUICK_SCHEDULE = process.env.NEXT_PUBLIC_DEMO_BUTTON === '1'

interface LeadDetailDrawerProps {
  /** Lead to render. `null` collapses the drawer. */
  lead: Lead | null
  onClose: () => void
  onUpdate?: (lead: Lead) => void
  onDelete?: (leadId: string) => void
}

type TabKey = 'conversation' | 'notes' | 'activity'

interface ConversationState {
  loading: boolean
  conversationId: string | null
  messages: Message[]
  aiDraft: string | null
  aiModel: string | null
  aiLatencyMs: number | null
}

const INITIAL_CONVO: ConversationState = {
  loading: false,
  conversationId: null,
  messages: [],
  aiDraft: null,
  aiModel: null,
  aiLatencyMs: null,
}

function fitScoreTone(score: number): { num: string; label: string } {
  if (score >= 90) return { num: 'text-[#0F8A5B]', label: 'text-[#0F8A5B]' }
  if (score >= 80) return { num: 'text-[#1D4ED8]', label: 'text-[#1D4ED8]' }
  if (score >= 60) return { num: 'text-[#0F172A]', label: 'text-[#475569]' }
  return { num: 'text-[#475569]', label: 'text-[#94A3B8]' }
}

function avatarTone(score: number): string {
  if (score >= 90) return 'bg-[#0F8A5B]'
  if (score >= 80) return 'bg-[#1D4ED8]'
  if (score >= 60) return 'bg-[#334155]'
  return 'bg-[#475569]'
}

function isFreshToday(createdAt: string): boolean {
  const d = new Date(createdAt)
  const now = new Date()
  return (
    d.getUTCFullYear() === now.getUTCFullYear() &&
    d.getUTCMonth() === now.getUTCMonth() &&
    d.getUTCDate() === now.getUTCDate()
  )
}

function formatBudget(b: number | null): string {
  if (b == null || b === 0) return '—'
  return `$${b.toLocaleString()}`
}

function formatEventDate(iso: string | null): { primary: string; sub: string | null } {
  if (!iso) return { primary: '—', sub: null }
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return { primary: iso, sub: null }
  const primary = format(d, 'EEE, MMMM d yyyy')
  const diff = Math.round((d.getTime() - Date.now()) / (24 * 60 * 60 * 1000))
  const sub = diff > 0 ? `in ${diff} days` : diff === 0 ? 'today' : `${Math.abs(diff)} days ago`
  return { primary, sub }
}

/**
 * Phase 8AI — local-only draft action state.
 *
 * The drawer's Edit / Regenerate / Reject / Approve & send buttons
 * are wired against client state ONLY. The repo doesn't yet ship a
 * stable "approve this AI draft and send it as the next message"
 * API contract, so this phase deliberately stays client-local and
 * flags the gap in the UI ("…endpoint not wired yet") rather than
 * faking server writes. The next phase wires real `/api/ai/*`
 * endpoints once the contract is finalized.
 */
type DraftStatus =
  | 'idle'
  | 'editing'
  | 'regenerating'
  | 'rejected'
  | 'sending'
  | 'sent_unsupported'
  | 'error'

type Adjustment = 'Warmer' | 'More concise' | 'Add pricing' | 'Mention dietary'

export default function LeadDetailDrawer({
  lead,
  onClose,
  onUpdate,
  onDelete,
}: LeadDetailDrawerProps) {
  const [tab, setTab] = useState<TabKey>('conversation')
  const [convo, setConvo] = useState<ConversationState>(INITIAL_CONVO)
  const [saving, setSaving] = useState(false)
  const [scheduleOpen, setScheduleOpen] = useState(false)

  // Phase 8AI — draft state lifted to drawer level so the footer
  // CTAs can mutate it. Initialized from `convo.aiDraft` on each
  // fetch via the useEffect below; reset whenever a new lead opens.
  const [draftBody, setDraftBody] = useState<string | null>(null)
  const [draftStatus, setDraftStatus] = useState<DraftStatus>('idle')
  const [draftEditBuffer, setDraftEditBuffer] = useState<string>('')
  const [selectedAdjustment, setSelectedAdjustment] = useState<Adjustment | null>(null)

  // Phase 8AH — close on Escape. Mirrors the existing dialog-style
  // primitives across the app.
  useEffect(() => {
    if (!lead) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [lead, onClose])

  // Phase 8AH — when a lead is shown, fetch the latest conversation,
  // last 6 messages, and the most-recent AI draft for that lead.
  // RLS gates this naturally; no extra auth needed.
  useEffect(() => {
    if (!lead) return
    let cancelled = false
    setConvo({ ...INITIAL_CONVO, loading: true })
    const supabase = createClient()
    ;(async () => {
      try {
        // Latest conversation for this lead.
        const { data: convRow } = await supabase
          .from('conversations')
          .select('id')
          .eq('lead_id', lead.id)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle()
        const conversationId = (convRow as { id?: string } | null)?.id ?? null

        // Last 6 messages (chronological).
        let messages: Message[] = []
        if (conversationId) {
          const { data: msgs } = await supabase
            .from('messages')
            .select('*')
            .eq('conversation_id', conversationId)
            .order('created_at', { ascending: false })
            .limit(6)
          messages = (msgs as Message[] | null) ?? []
          messages.reverse()
        }

        // Latest successful ai_action for the lead (best-effort).
        const { data: aiRows } = await supabase
          .from('ai_actions')
          .select('id, agent, action, output_summary, latency_ms, success, created_at')
          .eq('lead_id', lead.id)
          .order('created_at', { ascending: false })
          .limit(1)
        const ai = (aiRows as Array<{
          output_summary: string | null
          agent: string | null
          latency_ms: number | null
          success: boolean
        }> | null)?.[0]
        const aiDraft = ai?.success ? ai?.output_summary ?? null : null

        if (cancelled) return
        setConvo({
          loading: false,
          conversationId,
          messages,
          aiDraft,
          aiModel: ai?.agent ?? null,
          aiLatencyMs: ai?.latency_ms ?? null,
        })
      } catch {
        if (cancelled) return
        // Render empty state without erroring out the drawer.
        setConvo({ ...INITIAL_CONVO, loading: false })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [lead])

  // Phase 8AI — keep `draftBody` in lockstep with the latest fetched
  // ai_action draft. Resets on lead change. Operators editing a draft
  // in-place override this until the next fetch overwrites them; an
  // explicit "Regenerate" call replaces it.
  useEffect(() => {
    setDraftBody(convo.aiDraft)
    setDraftStatus('idle')
    setDraftEditBuffer(convo.aiDraft ?? '')
    setSelectedAdjustment(null)
  }, [convo.aiDraft, lead?.id])

  // Phase 8AI — local-only draft handlers. Comments call out where a
  // future backend phase should swap the placeholder for a real
  // network call.
  const handleStartEdit = useCallback(() => {
    setDraftEditBuffer(draftBody ?? '')
    setDraftStatus('editing')
  }, [draftBody])
  const handleCancelEdit = useCallback(() => {
    setDraftEditBuffer(draftBody ?? '')
    setDraftStatus('idle')
  }, [draftBody])
  const handleSaveEdit = useCallback(() => {
    setDraftBody(draftEditBuffer)
    setDraftStatus('idle')
  }, [draftEditBuffer])
  const handleReject = useCallback(() => {
    // Local-only: clears the visible draft for this session. A
    // future backend phase could PATCH the ai_actions row with a
    // `rejected_at` marker once the contract exists.
    setDraftBody(null)
    setDraftStatus('rejected')
  }, [])
  const handleRegenerate = useCallback(async () => {
    // Local-only placeholder. The /api/ai/* surface doesn't yet
    // expose a "regenerate a draft for this lead" route; the next
    // phase wires it. We simulate a short loading state then
    // restore the original draft with a status hint so the UI
    // animates as expected.
    setDraftStatus('regenerating')
    await new Promise((r) => setTimeout(r, 700))
    setDraftBody(convo.aiDraft)
    setDraftStatus('idle')
  }, [convo.aiDraft])
  const handleApproveSend = useCallback(async () => {
    // Local-only placeholder. We don't fake a send — instead we
    // flag the gap so operators don't think a message went out.
    // Auto-clears the flag after 2s so the CTA becomes clickable
    // again (in case the operator wants to retry after the wiring
    // lands without reloading).
    setDraftStatus('sending')
    await new Promise((r) => setTimeout(r, 600))
    setDraftStatus('sent_unsupported')
    setTimeout(() => {
      setDraftStatus((s) => (s === 'sent_unsupported' ? 'idle' : s))
    }, 2000)
  }, [])

  const patch = useCallback(
    async (data: Record<string, unknown>) => {
      if (!lead) return
      setSaving(true)
      try {
        const res = await fetch(`/api/leads/${lead.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data),
        })
        if (res.ok) {
          const updated = (await res.json()) as Lead
          onUpdate?.(updated)
        }
      } finally {
        setSaving(false)
      }
    },
    [lead, onUpdate]
  )

  const handleDelete = useCallback(async () => {
    if (!lead) return
    if (
      typeof window !== 'undefined' &&
      !window.confirm(`Delete lead for ${lead.name}? This cannot be undone.`)
    )
      return
    await fetch(`/api/leads/${lead.id}`, { method: 'DELETE' })
    onDelete?.(lead.id)
    onClose()
  }, [lead, onClose, onDelete])

  if (!lead) return null

  const initials = (() => {
    const parts = lead.name.split(/\s+/).slice(0, 2)
    return parts.map((p) => p.charAt(0).toUpperCase()).join('') || 'L'
  })()
  const fitTone = fitScoreTone(lead.lead_score)
  const eventDate = formatEventDate(lead.event_date)
  const fresh = isFreshToday(lead.created_at)
  const lastMessage = convo.messages[convo.messages.length - 1] ?? null

  return (
    <div className="fixed inset-0 z-50 flex">
      {/* Backdrop — blurred + dimmed */}
      <button
        type="button"
        onClick={onClose}
        aria-label="Close lead detail"
        className="fixed inset-0 z-40 bg-slate-950/25 backdrop-blur-[3px] cursor-default"
      />

      {/* Drawer */}
      <aside
        role="dialog"
        aria-label="Lead detail"
        className="relative ml-auto z-50 h-dvh w-full max-w-[660px] min-w-[320px] bg-white border-l border-[#E2E8F0] shadow-[0_-10px_60px_rgba(15,23,42,0.18)] flex flex-col animate-in slide-in-from-right duration-300"
      >
        {/* Top action row */}
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-[#F1F5F9]">
          <button
            type="button"
            onClick={onClose}
            className="inline-flex items-center gap-1.5 text-[12.5px] text-[#475569] hover:text-[#0F172A] px-2 py-1 rounded-lg hover:bg-[#F1F5F9] transition-colors"
          >
            <X className="w-3.5 h-3.5" />
            Close
          </button>
          <div className="flex items-center gap-2">
            {lead.phone && (
              <a
                href={`tel:${lead.phone}`}
                aria-label="Call lead"
                className="w-9 h-9 rounded-full border border-[#E2E8F0] bg-white flex items-center justify-center text-[#475569] hover:text-[#0F172A] hover:bg-[#F8FAFC] transition-colors"
              >
                <Phone className="w-3.5 h-3.5" />
              </a>
            )}
            <a
              href={`mailto:${lead.email}`}
              aria-label="Email lead"
              className="w-9 h-9 rounded-full border border-[#E2E8F0] bg-white flex items-center justify-center text-[#475569] hover:text-[#0F172A] hover:bg-[#F8FAFC] transition-colors"
            >
              <Mail className="w-3.5 h-3.5" />
            </a>
            <button
              type="button"
              aria-label="More actions"
              onClick={handleDelete}
              title="Delete lead"
              className="w-9 h-9 rounded-full border border-[#E2E8F0] bg-white flex items-center justify-center text-[#475569] hover:text-[#B91C1C] hover:bg-[#FEF2F2] transition-colors"
            >
              <MoreHorizontal className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* Identity */}
        <div className="px-6 pt-5 pb-4 border-b border-[#F1F5F9]">
          <div className="flex items-start gap-4">
            <div
              className={cn(
                'w-14 h-14 rounded-2xl flex items-center justify-center text-white font-semibold text-[15px] shrink-0',
                avatarTone(lead.lead_score)
              )}
            >
              {initials}
            </div>
            <div className="flex-1 min-w-0">
              <h2 className="text-[24px] sm:text-[26px] font-semibold text-[#0F172A] tracking-[-0.02em] leading-tight truncate">
                {lead.name}
              </h2>
              <div className="mt-2 flex items-center gap-2 text-[12.5px] text-[#475569] flex-wrap">
                <span className="inline-flex items-center gap-1.5">
                  <Mail className="w-3 h-3 text-[#94A3B8]" />
                  <a
                    href={`mailto:${lead.email}`}
                    className="hover:text-[#0F172A] truncate max-w-[260px]"
                  >
                    {lead.email}
                  </a>
                </span>
                {lead.phone && (
                  <>
                    <span className="text-[#CBD5E1]">·</span>
                    <span className="inline-flex items-center gap-1.5">
                      <Phone className="w-3 h-3 text-[#94A3B8]" />
                      <a href={`tel:${lead.phone}`} className="hover:text-[#0F172A]">
                        {lead.phone}
                      </a>
                    </span>
                  </>
                )}
              </div>
            </div>
            <div className="text-right shrink-0">
              <div
                className={cn(
                  'text-[44px] sm:text-[48px] font-semibold leading-none tracking-[-0.025em] tabular-nums',
                  fitTone.num
                )}
              >
                {lead.lead_score}
              </div>
              <div
                className={cn(
                  'mt-1 text-[10.5px] font-semibold uppercase tracking-[0.16em]',
                  fitTone.label
                )}
              >
                Fit score
              </div>
            </div>
          </div>

          {/* Event summary */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-5 gap-y-3 mt-5">
            <SummaryCell label="Event date" primary={eventDate.primary} sub={eventDate.sub ?? undefined} />
            <SummaryCell
              label="Guests"
              primary={lead.guest_count != null ? String(lead.guest_count) : '—'}
              sub={lead.guest_count != null ? 'capacity 240' : null}
            />
            <SummaryCell
              label="Budget"
              primary={formatBudget(lead.budget)}
              sub={lead.budget == null || lead.budget === 0 ? 'not disclosed' : null}
            />
            <SummaryCell
              label="Source"
              primary={lead.source || '—'}
              sub={`${formatDistanceToNow(new Date(lead.created_at), { addSuffix: true })}`}
            />
          </div>

          {/* Badges */}
          <div className="flex items-center gap-2 mt-5">
            <Badge
              variant={`stage_${lead.stage}` as Parameters<typeof Badge>[0]['variant']}
            >
              {STAGE_LABELS[lead.stage] ?? lead.stage}
            </Badge>
            {fresh && <Badge variant="blue">New today</Badge>}
            {lead.ai_active && (
              <Badge variant="navy">
                <Bot className="w-3 h-3 mr-1" /> AI active
              </Badge>
            )}
          </div>
        </div>

        {/* Tabs */}
        <div className="px-6 border-b border-[#F1F5F9]">
          <div className="flex items-center gap-5">
            {(
              [
                { id: 'conversation' as const, label: 'Conversation', count: convo.messages.length },
                { id: 'notes' as const, label: 'Notes' },
                { id: 'activity' as const, label: 'Activity' },
              ]
            ).map((t) => {
              const active = tab === t.id
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setTab(t.id)}
                  className={cn(
                    'relative py-3 text-[13px] font-medium transition-colors',
                    active ? 'text-[#0F172A]' : 'text-[#94A3B8] hover:text-[#475569]'
                  )}
                >
                  {t.label}
                  {typeof t.count === 'number' && t.count > 0 ? (
                    <span className="ml-1.5 text-[#94A3B8]">· {t.count}</span>
                  ) : null}
                  {active && (
                    <span className="absolute -bottom-px left-0 right-0 h-[2px] bg-[#0F172A] rounded-full" />
                  )}
                </button>
              )
            })}
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-4">
          {tab === 'conversation' && (
            <ConversationTab
              lead={lead}
              convo={convo}
              lastMessage={lastMessage}
              draftBody={draftBody}
              draftStatus={draftStatus}
              draftEditBuffer={draftEditBuffer}
              onChangeEditBuffer={setDraftEditBuffer}
              onSaveEdit={handleSaveEdit}
              onCancelEdit={handleCancelEdit}
              selectedAdjustment={selectedAdjustment}
              onSelectAdjustment={setSelectedAdjustment}
            />
          )}
          {tab === 'notes' && <NotesTab lead={lead} />}
          {tab === 'activity' && <ActivityTab lead={lead} />}
        </div>

        {/* Phase 8AI — draft action footer. Visible whenever there's
            a draft to act on OR the user is mid-edit / has just
            rejected / has triggered an Approve attempt. Buttons are
            wired against local state only (see Known Limitations in
            the handoff). */}
        {tab === 'conversation' &&
          (draftBody !== null || draftStatus === 'editing' || draftStatus === 'rejected') && (
            <div className="px-6 py-3 border-t border-[#F1F5F9] bg-white">
              <div className="flex items-center gap-2 flex-wrap">
                {draftStatus === 'editing' ? (
                  <>
                    <button
                      type="button"
                      onClick={handleSaveEdit}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-[10px] bg-[#0F172A] text-white text-[12.5px] hover:bg-[#1E293B]"
                    >
                      <Check className="w-3.5 h-3.5" />
                      Save edit
                    </button>
                    <button
                      type="button"
                      onClick={handleCancelEdit}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-[10px] border border-[#E2E8F0] text-[12.5px] text-[#475569] hover:text-[#0F172A] hover:bg-[#F8FAFC]"
                    >
                      Cancel
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      type="button"
                      onClick={handleStartEdit}
                      disabled={draftBody === null}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-[10px] border border-[#E2E8F0] text-[12.5px] text-[#475569] hover:text-[#0F172A] hover:bg-[#F8FAFC] disabled:opacity-50"
                    >
                      <Edit3 className="w-3.5 h-3.5" />
                      Edit
                    </button>
                    <button
                      type="button"
                      onClick={handleRegenerate}
                      disabled={draftStatus === 'regenerating'}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-[10px] border border-[#E2E8F0] text-[12.5px] text-[#475569] hover:text-[#0F172A] hover:bg-[#F8FAFC] disabled:opacity-50"
                    >
                      <Sparkles
                        className={cn(
                          'w-3.5 h-3.5',
                          draftStatus === 'regenerating' && 'animate-spin'
                        )}
                      />
                      {draftStatus === 'regenerating' ? 'Regenerating…' : 'Regenerate'}
                    </button>
                    <div className="flex-1" />
                    <button
                      type="button"
                      onClick={handleReject}
                      disabled={draftBody === null}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-[10px] text-[12.5px] text-[#475569] hover:text-[#B91C1C] disabled:opacity-50"
                    >
                      Reject
                    </button>
                    <button
                      type="button"
                      onClick={handleApproveSend}
                      disabled={
                        draftBody === null ||
                        draftStatus === 'sending' ||
                        draftStatus === 'sent_unsupported'
                      }
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-[10px] bg-[#0F172A] text-white text-[12.5px] hover:bg-[#1E293B] disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      <Check
                        className={cn(
                          'w-3.5 h-3.5',
                          draftStatus === 'sending' && 'animate-spin'
                        )}
                      />
                      {draftStatus === 'sending'
                        ? 'Sending…'
                        : draftStatus === 'sent_unsupported'
                          ? 'Wiring pending'
                          : 'Approve & send'}
                    </button>
                  </>
                )}
              </div>
              {/* Status hints */}
              {draftStatus === 'rejected' && (
                <p className="mt-2 text-[11px] text-[#B45309]">
                  Draft rejected for this session. Use Regenerate or close
                  to recover.
                </p>
              )}
              {draftStatus === 'sent_unsupported' && (
                <p className="mt-2 text-[11px] text-[#B45309]">
                  Approval endpoint not wired yet — message was not sent.
                  Next phase wires <code>/api/ai/*</code>.
                </p>
              )}
              {draftStatus === 'regenerating' && selectedAdjustment && (
                <p className="mt-2 text-[11px] text-[#64748B]">
                  Regenerating with adjustment: {selectedAdjustment}…
                </p>
              )}
            </div>
          )}

        {/* Secondary action bar — preserves every existing capability
            from the legacy LeadDetailPanel so we don't lose ground. */}
        <div className="px-6 py-3 border-t border-[#F1F5F9] flex flex-wrap items-center gap-2 bg-[#F8FAFC]">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setScheduleOpen(true)}
          >
            <CalendarCheck className="w-3.5 h-3.5" />
            Schedule tour…
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => patch({ ai_active: !lead.ai_active })}
            disabled={saving}
            className={cn(lead.ai_active && 'text-[#B45309] border-[#FCD9A1]')}
          >
            {lead.ai_active ? (
              <>
                <BotOff className="w-3.5 h-3.5" /> Pause AI
              </>
            ) : (
              <>
                <Bot className="w-3.5 h-3.5" /> Enable AI
              </>
            )}
          </Button>
          <Button variant="secondary" size="sm" asChild>
            <a href={`/dashboard/inbox?lead=${lead.id}`}>
              <MessageSquare className="w-3.5 h-3.5" />
              Open Inbox
            </a>
          </Button>
          <div className="flex-1" />
          <Button variant="destructive" size="icon" onClick={handleDelete} disabled={saving}>
            <Trash2 className="w-3.5 h-3.5" />
          </Button>
        </div>

        {/* Stage flipper rendered inline below action bar; collapses
            to a single chevron menu when room is tight. Reuses the
            standard `patch({ stage })` path. */}
        <div className="px-6 py-3 border-t border-[#F1F5F9] bg-white flex items-center gap-2 flex-wrap">
          <span className="text-[10.5px] uppercase tracking-[0.16em] text-[#94A3B8] font-semibold">
            Move to
          </span>
          {STAGES.filter((s) => s.value !== lead.stage)
            .slice(0, 4)
            .map((s) => (
              <button
                key={s.value}
                type="button"
                onClick={() => patch({ stage: s.value })}
                disabled={saving}
                className="text-[11px] px-2 py-1 rounded-md border border-[#E2E8F0] text-[#475569] hover:text-[#0F172A] hover:bg-[#F8FAFC] disabled:opacity-50"
              >
                {s.label}
              </button>
            ))}
        </div>

        {SHOW_DEMO_QUICK_SCHEDULE ? (
          <div className="px-6 py-2 text-[10px] text-[#94A3B8]">
            Demo quick-schedule wiring is mounted on this lead — see the leads page.
          </div>
        ) : null}
      </aside>

      <ScheduleTourDrawer
        open={scheduleOpen}
        onOpenChange={setScheduleOpen}
        leads={[{ id: lead.id, name: lead.name, email: lead.email, stage: lead.stage }]}
        defaultLeadId={lead.id}
        defaultNotes="Scheduled from lead detail."
      />
    </div>
  )
}

function SummaryCell({
  label,
  primary,
  sub,
}: {
  label: string
  primary: string
  sub?: string | null
}) {
  return (
    <div className="min-w-0">
      <div className="text-[10.5px] uppercase tracking-[0.14em] text-[#94A3B8] font-semibold">
        {label}
      </div>
      <div className="mt-1 text-[14px] font-semibold text-[#0F172A] truncate">
        {primary}
      </div>
      {sub ? (
        <div className="mt-0.5 text-[11px] text-[#94A3B8] truncate">{sub}</div>
      ) : null}
    </div>
  )
}

interface ConversationTabProps {
  lead: Lead
  convo: ConversationState
  lastMessage: Message | null
  draftBody: string | null
  draftStatus: DraftStatus
  draftEditBuffer: string
  onChangeEditBuffer: (next: string) => void
  onSaveEdit: () => void
  onCancelEdit: () => void
  selectedAdjustment: Adjustment | null
  onSelectAdjustment: (next: Adjustment | null) => void
}

const ADJUSTMENTS: Adjustment[] = ['Warmer', 'More concise', 'Add pricing', 'Mention dietary']

function ConversationTab(props: ConversationTabProps) {
  const {
    lead,
    convo,
    lastMessage,
    draftBody,
    draftStatus,
    draftEditBuffer,
    onChangeEditBuffer,
    onSaveEdit,
    onCancelEdit,
    selectedAdjustment,
    onSelectAdjustment,
  } = props

  if (convo.loading) {
    return (
      <div className="text-[12.5px] text-[#94A3B8] py-6 text-center">
        Loading conversation…
      </div>
    )
  }

  const showDraftCard = draftBody !== null
  const showRejectedState = draftStatus === 'rejected'
  const isRegenerating = draftStatus === 'regenerating'

  return (
    <>
      {lastMessage ? (
        <div>
          <div className="rounded-2xl border border-[#E2E8F0] bg-white p-4 shadow-card">
            <p className="text-[13.5px] text-[#0F172A] leading-relaxed whitespace-pre-wrap">
              {lastMessage.content}
            </p>
          </div>
          <div className="mt-2 text-[11px] text-[#94A3B8]">
            {lastMessage.role === 'lead'
              ? 'Lead'
              : lastMessage.role === 'ai'
                ? 'AI'
                : lastMessage.role === 'human'
                  ? 'Operator'
                  : 'System'}
            {' · '}
            {formatDistanceToNow(new Date(lastMessage.created_at), { addSuffix: true })}
          </div>
        </div>
      ) : (
        <div className="rounded-2xl border border-dashed border-[#E2E8F0] bg-white p-5 text-[12.5px] text-[#64748B]">
          No conversation messages yet. When {lead.name} replies, the latest
          message lands here.
        </div>
      )}

      {showDraftCard ? (
        <div className="rounded-2xl border border-[#E2E8F0] bg-[#F8FAFC] p-4 shadow-card">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-start gap-2.5 min-w-0">
              <div className="w-7 h-7 rounded-[8px] bg-[#0F172A] text-white flex items-center justify-center shrink-0">
                <Sparkles
                  className={cn('w-3 h-3', isRegenerating && 'animate-spin')}
                />
              </div>
              <div className="min-w-0">
                <div className="text-[12.5px] text-[#0F172A]">
                  <span className="font-semibold">AI drafted a reply</span>{' '}
                  <span className="text-[#64748B]">
                    · based on this thread + venue knowledge
                  </span>
                </div>
                <div className="text-[11px] text-[#94A3B8] font-mono mt-0.5">
                  {convo.aiModel ? <>model · {convo.aiModel}</> : 'model · venuerise'}
                  {convo.aiLatencyMs ? <> · {convo.aiLatencyMs}ms</> : null}
                </div>
              </div>
            </div>
            <span className="shrink-0 inline-flex items-center text-[10.5px] font-semibold uppercase tracking-[0.1em] px-2 py-0.5 rounded-full bg-[#EFF6FF] text-[#1D4ED8] border border-[#BFDBFE]">
              {isRegenerating ? 'Regenerating' : 'Awaiting review'}
            </span>
          </div>

          {draftStatus === 'editing' ? (
            <textarea
              value={draftEditBuffer}
              onChange={(e) => onChangeEditBuffer(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) onSaveEdit()
                if (e.key === 'Escape') onCancelEdit()
              }}
              rows={6}
              className="mt-3 w-full rounded-xl border border-[#E2E8F0] bg-white p-3 text-[13.5px] text-[#0F172A] leading-relaxed focus:outline-none focus:ring-2 focus:ring-[#3B82F6]/30 focus:border-[#1D4ED8]"
              autoFocus
            />
          ) : (
            <p
              className={cn(
                'mt-3 text-[13.5px] leading-relaxed whitespace-pre-wrap',
                isRegenerating ? 'text-[#94A3B8]' : 'text-[#0F172A]'
              )}
            >
              {draftBody}
            </p>
          )}

          <div className="mt-3 flex items-center gap-2 flex-wrap">
            <span className="text-[10.5px] uppercase tracking-[0.14em] text-[#94A3B8] font-semibold">
              Adjust
            </span>
            {ADJUSTMENTS.map((c) => {
              const active = selectedAdjustment === c
              return (
                <button
                  key={c}
                  type="button"
                  onClick={() => onSelectAdjustment(active ? null : c)}
                  className={cn(
                    'text-[11px] px-2.5 py-1 rounded-full border transition-colors',
                    active
                      ? 'bg-[#0F172A] text-white border-[#0F172A]'
                      : 'border-[#E2E8F0] text-[#475569] hover:text-[#0F172A] hover:bg-white'
                  )}
                >
                  {c}
                </button>
              )
            })}
          </div>
        </div>
      ) : showRejectedState ? (
        <div className="rounded-2xl border border-[#FDE68A] bg-[#FFFBEB] p-4 text-[12.5px] text-[#92400E]">
          Draft rejected for this session. Use Regenerate or close to recover.
        </div>
      ) : (
        <div className="rounded-2xl border border-dashed border-[#E2E8F0] bg-white p-5 text-[12.5px] text-[#64748B]">
          No AI draft ready yet. When the assistant prepares a reply, it shows
          up here for review.
        </div>
      )}
    </>
  )
}

function NotesTab({ lead }: { lead: Lead }) {
  if (!lead.notes) {
    return (
      <div className="rounded-2xl border border-dashed border-[#E2E8F0] bg-white p-5 text-[12.5px] text-[#64748B]">
        No notes yet. Use the Inbox or the legacy edit panel to add context for
        the AI.
      </div>
    )
  }
  return (
    <div className="rounded-2xl border border-[#E2E8F0] bg-white p-4 shadow-card">
      <p className="text-[13.5px] text-[#0F172A] leading-relaxed whitespace-pre-wrap">
        {lead.notes}
      </p>
    </div>
  )
}

function ActivityTab({ lead }: { lead: Lead }) {
  const rows: { when: string; what: string }[] = [
    {
      when: format(new Date(lead.created_at), 'MMM d, yyyy · h:mm a'),
      what: 'Lead created',
    },
    {
      when: format(new Date(lead.updated_at), 'MMM d, yyyy · h:mm a'),
      what: 'Lead last updated',
    },
  ]
  return (
    <div className="rounded-2xl border border-[#E2E8F0] bg-white">
      {rows.map((r, i) => (
        <div
          key={i}
          className={cn(
            'flex items-center justify-between gap-3 px-4 py-3 text-[12.5px]',
            i > 0 && 'border-t border-[#F1F5F9]'
          )}
        >
          <span className="text-[#0F172A]">{r.what}</span>
          <span className="text-[#94A3B8] font-mono text-[11px]">{r.when}</span>
        </div>
      ))}
    </div>
  )
}
