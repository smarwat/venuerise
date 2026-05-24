'use client'

import { useState } from 'react'
import { Send, Paperclip, Mic, Sparkles, User, Bot, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'

interface Props {
  conversationId: string
  leadId: string
  aiActive: boolean
}

export default function MessageComposer({ conversationId, leadId, aiActive }: Props) {
  // P0 fix — composer mode now drives actual send behavior, not just
  // visual styling. The previous implementation always routed through
  // /api/ai/chat (handleIncomingMessage), which inserted the
  // operator's text as `role: 'lead'` AND triggered an AI reply as if
  // the lead had spoken. Two bugs in one. Now:
  //   - `you` mode  → POST /api/conversations/[id]/messages
  //                   (inserts role: 'human', venue-side, no AI
  //                   auto-response)
  //   - `ai`  mode  → POST /api/ai/draft (returns a draft variant for
  //                   review; never auto-sends. The operator clicks
  //                   "Approve & send" in the LeadDetailDrawer to
  //                   emit a `human` row with the AI text.)
  const [mode, setMode] = useState<'ai' | 'human'>(aiActive ? 'ai' : 'human')
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [aiDraft, setAiDraft] = useState<string | null>(null)

  const send = async () => {
    const trimmed = text.trim()
    if (!trimmed) return
    setError(null)
    setSending(true)
    try {
      if (mode === 'human') {
        // P0 fix — operator reply path. Inserts as role:'human' via
        // the operator-message route. Does NOT call the AI
        // orchestrator. Renders on the right of the thread.
        const res = await fetch(
          `/api/conversations/${encodeURIComponent(conversationId)}/messages`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              body: trimmed,
              sender_type: 'operator',
              metadata: { source: 'operator_composer' },
            }),
          }
        )
        if (!res.ok) {
          const err = await res.json().catch(() => null)
          setError(err?.error || 'Failed to send. Please try again.')
          return
        }
        setText('')
        return
      }

      // AI mode — ask the regenerate endpoint to refine the
      // operator's typed text into a polished venue-side draft. The
      // typed text is the seed (current_draft) — it is NEVER
      // inserted as a lead message. The route returns variants;
      // we surface the first one inline for one-click approval.
      const res = await fetch('/api/ai/draft', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          lead_id: leadId,
          current_draft: trimmed.slice(0, 8000),
          instruction: 'Polish into a warm, on-brand venue reply.',
          variant_count: 1,
        }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => null)
        setError(err?.error || 'Failed to generate draft. Please try again.')
        return
      }
      const json = (await res.json().catch(() => null)) as
        | { drafts?: Array<{ text?: string }>; draft?: string }
        | null
      const text0 =
        (Array.isArray(json?.drafts) && json.drafts[0]?.text) ||
        (typeof json?.draft === 'string' ? json.draft : null)
      if (text0) {
        setAiDraft(text0)
        // Don't clear `text` — the operator may want to tweak the
        // hint and regenerate.
      } else {
        setError("AI didn't return a draft. Try again or switch to You mode.")
      }
    } finally {
      setSending(false)
    }
  }

  const useDraft = () => {
    if (!aiDraft) return
    setText(aiDraft)
    setMode('human')
    setAiDraft(null)
  }

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send()
    }
  }

  return (
    // Phase 8BL-Hotfix-2 — `shrink-0` pins the composer to its
    // natural height. Without it, flex contention in the inbox
    // column could compress the textarea + footer hint when long
    // threads + a busy strip competed for vertical space.
    <div className="shrink-0 border-t border-[#F1F5F9] bg-white px-6 py-4 space-y-2.5">
      <div className="flex items-center gap-2 mb-1">
        <div className="flex bg-[#F1F5F9] border border-[#E2E8F0] rounded-full p-0.5">
          <button
            onClick={() => setMode('human')}
            className={cn(
              'flex items-center gap-1.5 px-3 py-1 rounded-full text-[11px] font-semibold transition-all',
              mode === 'human' ? 'bg-white text-[#0F172A] shadow-[0_1px_3px_rgba(15,23,42,0.08)]' : 'text-[#475569]'
            )}
          >
            <User className="w-3 h-3" /> You
          </button>
          <button
            onClick={() => setMode('ai')}
            className={cn(
              'flex items-center gap-1.5 px-3 py-1 rounded-full text-[11px] font-semibold transition-all',
              mode === 'ai' ? 'bg-white text-[#1D4ED8] shadow-[0_1px_3px_rgba(15,23,42,0.08)]' : 'text-[#475569]'
            )}
          >
            <Bot className="w-3 h-3" /> AI
          </button>
        </div>
        {error && (
          <span className="text-[11px] text-[#DC2626]">{error}</span>
        )}
      </div>

      <div className="flex items-end gap-2">
        <div className="flex-1 flex items-center bg-[#F8FAFC] border border-[#E2E8F0] rounded-2xl pl-3 pr-2 py-1 focus-within:border-[#1D4ED8] focus-within:ring-[3px] focus-within:ring-[#3B82F6]/15 transition-all">
          {/* Phase 9S — Attach + Voice are not yet wired. Honest fix:
              disable + tooltip so the affordance doesn't look live.
              When the upload + transcription paths ship, replace
              `disabled` with the real `onClick`. */}
          <button
            type="button"
            disabled
            className="text-[#CBD5E1] cursor-not-allowed shrink-0 mr-2"
            title="Attachments are not yet enabled"
            aria-label="Attachments are not yet enabled"
          >
            <Paperclip className="w-4 h-4" />
          </button>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKey}
            placeholder="Send message…"
            rows={1}
            className="flex-1 bg-transparent outline-none text-[13px] text-[#0F172A] placeholder:text-[#94A3B8] resize-none py-2 max-h-[120px]"
          />
          <button
            type="button"
            disabled
            className="text-[#CBD5E1] cursor-not-allowed shrink-0 mx-1"
            title="Voice input is not yet enabled"
            aria-label="Voice input is not yet enabled"
          >
            <Mic className="w-4 h-4" />
          </button>
          <button
            onClick={send}
            disabled={sending || !text.trim()}
            className="w-9 h-9 rounded-full bg-[#0F172A] hover:bg-[#1E293B] text-white flex items-center justify-center shadow-[0_4px_12px_rgba(15,23,42,0.25)] hover:shadow-[0_6px_18px_rgba(15,23,42,0.30)] transition-all disabled:opacity-50 shrink-0"
          >
            {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
          </button>
        </div>
      </div>

      {/* P0 fix — AI draft preview. When the operator generates a
          draft (mode='ai'), the result appears here with a one-click
          "Use this draft" button that loads it into the textarea +
          flips to You mode for a manual send. The operator can also
          edit the textarea first, then click Use. The draft is never
          auto-sent. */}
      {aiDraft && (
        <div className="rounded-xl border border-[#BFDBFE] bg-[#EFF6FF] px-3 py-2.5 flex items-start gap-2.5">
          <Sparkles className="w-3.5 h-3.5 text-[#1D4ED8] mt-0.5 shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="text-[10px] uppercase tracking-[0.14em] text-[#1D4ED8] font-semibold mb-1">
              AI draft
            </div>
            <p className="text-[12.5px] text-[#0F172A] leading-snug whitespace-pre-wrap break-words">
              {aiDraft}
            </p>
            <div className="flex items-center gap-2 mt-2">
              <button
                type="button"
                onClick={useDraft}
                className="text-[11.5px] font-semibold px-2.5 py-1 rounded-md bg-[#0F172A] text-white hover:bg-[#1E293B]"
              >
                Use this draft
              </button>
              <button
                type="button"
                onClick={() => setAiDraft(null)}
                className="text-[11.5px] font-medium text-[#475569] hover:text-[#0F172A]"
              >
                Dismiss
              </button>
            </div>
          </div>
        </div>
      )}

      <p className="text-[10px] text-center text-[#94A3B8]">
        <Sparkles className="w-2.5 h-2.5 inline mr-1" />
        {mode === 'human'
          ? 'Your reply will be saved as a venue-side message.'
          : 'AI drafts are for your review — nothing is sent automatically.'}
      </p>
    </div>
  )
}
