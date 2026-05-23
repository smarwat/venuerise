'use client'

import { useState } from 'react'
import { Send, Paperclip, Mic, Sparkles, User, Bot, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'

interface Props {
  conversationId: string
  leadId: string
  aiActive: boolean
}

export default function MessageComposer({ conversationId, aiActive }: Props) {
  const [mode, setMode] = useState<'ai' | 'human'>(aiActive ? 'ai' : 'human')
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const send = async () => {
    if (!text.trim()) return
    setError(null)
    setSending(true)
    try {
      const res = await fetch('/api/ai/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversation_id: conversationId, message: text }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => null)
        setError(err?.error || 'Failed to send. Please try again.')
        return
      }
      setText('')
    } finally {
      setSending(false)
    }
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

      <p className="text-[10px] text-center text-[#94A3B8]">
        <Sparkles className="w-2.5 h-2.5 inline mr-1" />
        VenueRise AI can make mistakes. Consider checking important information.
      </p>
    </div>
  )
}
