'use client'

import { useEffect, useMemo, useState } from 'react'
import { Send, Paperclip, Mic, Sparkles, User, Bot, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import ReplyMethodBar from './messages/ReplyMethodBar'
import type {
  ReplyMethod,
  ReplyMethodOption,
} from '@/lib/integrations/channels/reply-method'

interface Props {
  conversationId: string
  leadId: string
  aiActive: boolean
  /**
   * Phase 8BM — pre-resolved reply method context for this
   * conversation. Built on the server (inbox thread page) so the
   * client component stays presentational. When omitted, the bar
   * is hidden and the composer behaves as before.
   *
   * Phase 8BV — the resolver already returns `switchOptions[]`
   * inside this object. The composer now owns the per-session
   * selected method so the operator can pick Email vs SMS (or
   * any other available channel) on a per-message basis. The
   * server route always re-verifies whether the chosen channel
   * is wired before any external send.
   */
  replyMethod?: ReplyMethod | null
}

/**
 * Build a ReplyMethodOption that mirrors the resolver's default
 * pick on `replyMethod`. Used as the initial selected option when
 * the page only passed `replyMethod` (no explicit selected option).
 */
function defaultSelectedOption(reply: ReplyMethod): ReplyMethodOption {
  const fromSwitch = reply.switchOptions.find((o) => o.method === reply.method)
  if (fromSwitch) return fromSwitch
  // Defensive — the resolver always includes the active method in
  // switchOptions, but if a future refactor changes that, we still
  // render a self-consistent option built from the active fields.
  return {
    method: reply.method,
    methodLabel: reply.methodLabel,
    destinationLabel: reply.destinationLabel,
    deliveryMode: reply.deliveryMode,
    helperText: reply.helperText,
  }
}

/**
 * Project the currently-selected option back into the `ReplyMethod`
 * shape so `ReplyMethodBar` can render its pill / helper text
 * directly from `selected` without prop drilling. Source channel and
 * `switchOptions` stay pinned to the original resolver output — only
 * the active method shifts.
 */
function projectReplyMethod(
  base: ReplyMethod,
  selected: ReplyMethodOption
): ReplyMethod {
  // Warning is mode-derived; recompute here so a downgrade from
  // direct→internal flips the helper copy honestly.
  const warning = (() => {
    if (selected.deliveryMode === 'direct') return null
    if (selected.deliveryMode === 'manual') {
      return `${selected.methodLabel} does not accept direct sending. Copy your response into ${selected.methodLabel} after writing.`
    }
    if (selected.deliveryMode === 'unavailable') {
      return 'No working delivery path for this channel yet. Reply will be saved in VenueRise.'
    }
    return selected.method === 'website'
      ? 'Reply saved in the in-product widget thread.'
      : `Reply will be saved in VenueRise — ${selected.methodLabel.toLowerCase()} sending is not connected yet.`
  })()
  return {
    ...base,
    method: selected.method,
    methodLabel: selected.methodLabel,
    destinationLabel: selected.destinationLabel,
    deliveryMode: selected.deliveryMode,
    helperText: selected.helperText,
    warning,
  }
}

export default function MessageComposer({
  conversationId,
  leadId,
  aiActive,
  replyMethod,
}: Props) {
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

  // Phase 8BV — per-conversation selected reply method. Initialized
  // from the resolver's default pick; the operator can switch via
  // the dropdown in `ReplyMethodBar` when multiple options exist.
  // Resets when `conversationId` or `replyMethod` changes so
  // navigating to a different lead lands on that lead's default.
  const [selected, setSelected] = useState<ReplyMethodOption | null>(() =>
    replyMethod ? defaultSelectedOption(replyMethod) : null
  )
  useEffect(() => {
    setSelected(replyMethod ? defaultSelectedOption(replyMethod) : null)
    // Stale AI draft from the prior lead would be confusing — clear
    // it on conversation change.
    setAiDraft(null)
    setError(null)
    setText('')
    // We deliberately listen on conversationId AND replyMethod.method
    // so any server-side resolver change (e.g. lead phone added)
    // refreshes the default without forcing a hard remount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId, replyMethod?.method, replyMethod?.deliveryMode])

  // Project the currently-selected option back into a `ReplyMethod`
  // shape for the bar. Source channel + switchOptions never change
  // mid-conversation; only the active method / destination / mode
  // tracks the dropdown.
  const projectedReply = useMemo(() => {
    if (!replyMethod) return null
    if (!selected) return replyMethod
    return projectReplyMethod(replyMethod, selected)
  }, [replyMethod, selected])

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
        //
        // Phase 8BM — stamp the resolved reply method into the
        // message metadata so:
        //   1. Downstream audit / digest surfaces can tell the
        //      operator how they replied (email vs manual-on-Knot).
        //   2. We have an honest record of whether VenueRise tried
        //      to deliver externally (today: never; future phases
        //      will flip deliveryMode to 'direct' as connectors
        //      ship).
        //
        // Phase 8BV — the SELECTED option (not the resolver's
        // default) drives every metadata field below. The server
        // route still re-verifies whether the chosen channel is
        // actually wired before any external send.
        const meta: Record<string, unknown> = {
          source: 'operator_composer',
        }
        if (replyMethod) {
          const active = selected ?? defaultSelectedOption(replyMethod)
          meta.reply_method = active.method
          meta.reply_delivery_mode = active.deliveryMode
          if (replyMethod.sourceChannel) {
            meta.channel_type = replyMethod.sourceChannel
          }
          // Destination label can be PII (email/phone) — the
          // server-side audit route already sanitizes message
          // metadata via the audit-events helper. We include it
          // so the operator's own activity log shows where they
          // intended to send (and not where the platform
          // delivered, which today is nowhere external).
          if (active.destinationLabel) {
            meta.reply_destination = active.destinationLabel
          }
        }
        const res = await fetch(
          `/api/conversations/${encodeURIComponent(conversationId)}/messages`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              body: trimmed,
              sender_type: 'operator',
              metadata: meta,
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
      //
      // Phase 8BV — pass the selected reply method so SMS drafts
      // come back short + conversational and email drafts keep
      // their normal length. The route validates + clamps; an
      // unknown value just falls back to the email-shaped default.
      const draftBody: Record<string, unknown> = {
        lead_id: leadId,
        current_draft: trimmed.slice(0, 8000),
        instruction: 'Polish into a warm, on-brand venue reply.',
        variant_count: 1,
      }
      if (selected) {
        draftBody.reply_method = selected.method
        draftBody.reply_delivery_mode = selected.deliveryMode
      }
      const res = await fetch('/api/ai/draft', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(draftBody),
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
    // Phase 8BV — DO NOT touch `selected` here. The operator picked
    // a reply method before generating the draft; using the draft
    // must preserve that choice so the next send goes through the
    // same channel.
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
      {/* Phase 8BM — Reply Method Bar. Sits above the mode toggle
          so the operator sees source channel + delivery mode
          BEFORE they start typing. Renders only when the page
          resolved a method (i.e. the lead/conversation row was
          loaded server-side).
          Phase 8BV — When the resolver returned >1 option the bar
          renders a dropdown that calls back into setSelected. */}
      {projectedReply && (
        <ReplyMethodBar
          reply={projectedReply}
          switchOptions={projectedReply.switchOptions}
          onSelectReplyMethod={(opt) => setSelected(opt)}
        />
      )}
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

      {/* Phase 8BW — honest footer copy. Pre-8BN the message
          only saved internally regardless of channel; now the
          send route may actually deliver via Resend or Twilio.
          The footer reflects what the NEXT send will do based on
          mode + selected reply method. AI mode always reminds
          the operator that AI does not auto-send. */}
      <p className="text-[10px] text-center text-[#94A3B8]">
        <Sparkles className="w-2.5 h-2.5 inline mr-1" />
        {composerFooterCopy(mode, selected)}
      </p>
    </div>
  )
}

/**
 * Phase 8BW — return honest copy for the composer footer.
 * Never claims direct delivery without the resolver having
 * said `direct`; for `internal_only` / `manual` we say the
 * reply will be saved in VenueRise (the source of truth).
 * AI mode always carries the no-auto-send guarantee.
 */
function composerFooterCopy(
  mode: 'ai' | 'human',
  selected: ReplyMethodOption | null
): string {
  if (mode === 'ai') {
    return 'AI drafts are for your review — nothing is sent automatically.'
  }
  if (!selected) {
    return 'Your reply will be saved as a venue-side message.'
  }
  if (selected.deliveryMode === 'direct') {
    if (selected.method === 'email') {
      return 'Your reply will be sent via email when you click send.'
    }
    if (selected.method === 'sms') {
      return 'Your reply will be sent via SMS when you click send.'
    }
    return `Your reply will be sent via ${selected.methodLabel} when you click send.`
  }
  if (selected.deliveryMode === 'manual') {
    return `Reply in ${selected.methodLabel}, then mark sent so the inbox stays accurate.`
  }
  // internal_only / unavailable
  return 'Your reply will be saved in VenueRise only.'
}
