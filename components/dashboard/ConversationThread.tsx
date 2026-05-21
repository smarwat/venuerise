'use client'

import { useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { Sparkles } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { format } from 'date-fns'
import { cn } from '@/lib/utils'
import VariantReplayDrawer from './messages/VariantReplayDrawer'
import ChannelSourceBadge from './messages/ChannelSourceBadge'
import ParseReviewBadge from './messages/ParseReviewBadge'

interface Message {
  id: string
  role: 'lead' | 'ai' | 'human' | 'system'
  content: string
  created_at: string
  // Phase 8AM extended message metadata with allowlisted variant
  // context fields. They're optional — non-variant sends + lead/AI
  // messages omit them, and the audit affordance only shows when
  // all three are present.
  metadata?: {
    tokens_used?: number
    latency_ms?: number
    ai_action_id?: string
    selected_variant_index?: number
    variant_count?: number
    // Phase 8BE — channel source + manual-send markers stamped by
    // the normalization helper / mark-sent-manually route.
    channel_type?: string | null
    source?: string | null
    manual_reply_marked_at?: string | null
    // Phase 8BG — parse review markers stamped by the
    // lead-forwarding parser when confidence < 75.
    parse_needs_review?: boolean | null
    parse_confidence?: number | null
    parse_confidence_reasons?: ReadonlyArray<string> | null
    parser_version?: string | null
  } | null
}

interface VariantContext {
  messageId: string
  content: string
  createdAt: string
  aiActionId: string
  selectedVariantIndex: number
  variantCount: number
}

interface Props {
  conversationId: string
  initialMessages: Message[]
  leadName: string
}

export default function ConversationThread({ conversationId, initialMessages, leadName }: Props) {
  const [messages, setMessages] = useState<Message[]>(initialMessages)
  const bottomRef = useRef<HTMLDivElement>(null)
  // Phase 8AM — per-message refs so the inbox `?message=<id>` deep-
  // link (from a CommandPalette message search result) can scroll
  // the matching bubble into view + flash a brief highlight ring.
  const rowRefs = useRef<Map<string, HTMLDivElement | null>>(new Map())
  const searchParams = useSearchParams()
  const targetMessageId = searchParams.get('message')
  const [highlightedId, setHighlightedId] = useState<string | null>(null)
  const consumedDeepLinkRef = useRef<string | null>(null)

  // Phase 8AN — variant replay drawer state. Mounted once at the
  // bottom; the click handler on each eligible bubble sets the
  // context object and the drawer reads from there.
  const [variantContext, setVariantContext] = useState<VariantContext | null>(
    null
  )

  // Default scroll-to-bottom — suppressed when a deep-link target is
  // present so the user lands on the requested message instead of
  // being shoved to the latest reply.
  useEffect(() => {
    if (targetMessageId) return
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, targetMessageId])

  // Phase 8AM — deep-link scroll + highlight. Runs whenever messages
  // change (in case the target arrives via realtime AFTER initial
  // render) but each unique target is consumed exactly once so a
  // realtime message after scroll-to-target doesn't yank focus.
  useEffect(() => {
    if (!targetMessageId) return
    if (consumedDeepLinkRef.current === targetMessageId) return
    const el = rowRefs.current.get(targetMessageId)
    if (!el) return
    consumedDeepLinkRef.current = targetMessageId
    // Defer to next paint so the layout settles before we measure.
    const t1 = setTimeout(() => {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' })
      setHighlightedId(targetMessageId)
    }, 60)
    // Strip the param from the URL after consuming so a refresh
    // doesn't re-trigger the scroll/highlight + the operator's
    // browser back stack stays clean. We use history.replaceState
    // rather than router.replace because the latter would force a
    // server re-render and we want the highlight to persist.
    try {
      const url = new URL(window.location.href)
      url.searchParams.delete('message')
      window.history.replaceState({}, '', url.toString())
    } catch {
      // sandboxed iframe edge case — highlight still fires.
    }
    const t2 = setTimeout(() => setHighlightedId(null), 2600)
    return () => {
      clearTimeout(t1)
      clearTimeout(t2)
    }
  }, [targetMessageId, messages])

  useEffect(() => {
    const supabase = createClient()
    const channel = supabase
      .channel(`messages:${conversationId}`)
      .on('postgres_changes', {
        event: 'INSERT',
        schema: 'public',
        table: 'messages',
        filter: `conversation_id=eq.${conversationId}`,
      }, (payload) => {
        setMessages((prev) => {
          if (prev.some((m) => m.id === (payload.new as Message).id)) return prev
          return [...prev, payload.new as Message]
        })
      })
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [conversationId])

  const grouped: { timestamp: string; messages: Message[] }[] = []
  let lastBucket = ''
  messages.forEach((m) => {
    const bucket = format(new Date(m.created_at), 'MMM d, yyyy, h:mm a')
    if (bucket !== lastBucket) {
      grouped.push({ timestamp: bucket, messages: [m] })
      lastBucket = bucket
    } else {
      grouped[grouped.length - 1].messages.push(m)
    }
  })

  return (
    <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5">
      {messages.length === 0 && (
        <div className="text-center py-16">
          <p className="text-[13px] text-[#64748B]">No messages yet. The AI will reply once the lead sends something.</p>
        </div>
      )}

      {grouped.map((group, gi) => (
        <div key={gi} className="space-y-2">
          <p className="text-[11px] text-[#94A3B8] text-center font-medium">{group.timestamp}</p>
          {group.messages.map((msg) => {
            const isLead = msg.role === 'lead'
            const isAI = msg.role === 'ai' || msg.role === 'human'
            const isSystem = msg.role === 'system'

            if (isSystem) {
              return (
                <div key={msg.id} className="flex justify-center">
                  <div className="bg-[#F8FAFC] border border-[#E6E8EF] rounded-full px-3 py-1 text-[11px] text-[#64748B]">
                    {msg.content}
                  </div>
                </div>
              )
            }

            const isHighlighted = highlightedId === msg.id
            // Phase 8AN — show the audit affordance only when the
            // message metadata carries the full variant context
            // (ai_action_id + selected_variant_index + variant_count).
            // Bubbles from before Phase 8AM, AI auto-replies, and
            // operator sends that weren't variant-driven all skip.
            const meta = msg.metadata ?? null
            const canReplayVariants =
              msg.role === 'human' &&
              !!meta &&
              typeof meta.ai_action_id === 'string' &&
              typeof meta.selected_variant_index === 'number' &&
              typeof meta.variant_count === 'number' &&
              meta.variant_count > 0
            return (
              <div
                key={msg.id}
                ref={(el) => {
                  if (el) rowRefs.current.set(msg.id, el)
                  else rowRefs.current.delete(msg.id)
                }}
                className={cn(
                  'flex transition-shadow rounded-2xl',
                  isAI && 'justify-end',
                  // Phase 8AM — transient deep-link highlight. Pale
                  // blue ring around the matched message; clears after
                  // ~2.6s via the useEffect cleanup. The wrapping div
                  // (not the bubble) gets the ring so left- and right-
                  // aligned messages get a consistent visual treatment.
                  isHighlighted && 'ring-2 ring-[#3B82F6] ring-offset-2 ring-offset-[#F4F7FB]'
                )}
              >
                <div className={cn(
                  'group/bubble relative max-w-[68%] rounded-[18px] px-4 py-2.5 text-[13px] leading-relaxed',
                  isLead && 'bg-white border border-[#E6E8EF] text-[#0F172A] rounded-tl-md shadow-[0_1px_2px_rgba(15,23,42,0.04)]',
                  isAI && 'bg-[#0F172A] text-white rounded-tr-md shadow-[0_2px_8px_rgba(15,23,42,0.15)]',
                )}>
                  {msg.content}
                  {/* Phase 8BE — source badge inside the bubble. AI
                      bubbles render a lighter variant for contrast. */}
                  {meta?.channel_type && (
                    <span className={cn(
                      'block mt-1.5',
                      isAI && 'opacity-90'
                    )}>
                      <ChannelSourceBadge channelType={meta.channel_type} />
                      {meta.source === 'manual_channel_reply' && (
                        <span className={cn(
                          'ml-1 inline-flex items-center rounded-full px-1.5 py-[1px] text-[10px] font-medium',
                          isAI
                            ? 'bg-white/15 text-white border border-white/20'
                            : 'bg-[#FFFBEB] text-[#B45309] border border-[#FDE68A]'
                        )}>
                          Sent manually
                        </span>
                      )}
                      {/* Phase 8BG — parse review badge for
                          forwarding-parser low-confidence inbound
                          messages. Renders nothing when
                          parse_needs_review is null/false. */}
                      {isLead && meta.parse_needs_review && (
                        <ParseReviewBadge
                          needsReview={meta.parse_needs_review}
                          confidence={meta.parse_confidence ?? null}
                          reasons={meta.parse_confidence_reasons ?? null}
                          className="ml-1"
                        />
                      )}
                    </span>
                  )}
                  {msg.metadata?.latency_ms && (
                    <span className="block mt-1 text-[10px] text-white/60">{msg.metadata.latency_ms}ms</span>
                  )}
                  {/* Phase 8AN — variant audit affordance. Sits
                      bottom-right of the bubble, faint until hover so
                      it doesn't compete with the message content. */}
                  {canReplayVariants && (
                    <button
                      type="button"
                      aria-label="Show AI draft selection audit"
                      title={`Sent option ${(meta!.selected_variant_index as number) + 1} of ${meta!.variant_count}`}
                      onClick={() =>
                        setVariantContext({
                          messageId: msg.id,
                          content: msg.content,
                          createdAt: msg.created_at,
                          aiActionId: meta!.ai_action_id as string,
                          selectedVariantIndex: meta!
                            .selected_variant_index as number,
                          variantCount: meta!.variant_count as number,
                        })
                      }
                      className="absolute -bottom-1 -right-1 w-6 h-6 rounded-full bg-white border border-[#E6E8EF] text-[#1D4ED8] flex items-center justify-center opacity-60 hover:opacity-100 hover:bg-[#EFF6FF] hover:border-[#BFDBFE] transition-opacity shadow-[0_1px_2px_rgba(15,23,42,0.10)]"
                    >
                      <Sparkles className="w-3 h-3" />
                    </button>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      ))}

      <div className="sr-only">Conversation with {leadName}</div>
      <div ref={bottomRef} />

      {/* Phase 8AN — variant replay drawer. Mounted once; the bubble
          buttons set `variantContext` to open it. */}
      <VariantReplayDrawer
        open={variantContext !== null}
        context={variantContext}
        onClose={() => setVariantContext(null)}
      />
    </div>
  )
}
