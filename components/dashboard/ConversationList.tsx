'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { formatDistanceToNow, format } from 'date-fns'
import { Search, Star, MessageSquare, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import ChannelSourceBadge from './messages/ChannelSourceBadge'
import ParseReviewBadge from './messages/ParseReviewBadge'

interface Conversation {
  id: string
  lead_id: string
  sentiment: string
  unread_count: number
  last_message_at: string | null
  /** Phase 8BE — when available, the most-recent external_messages
   * mapping channel for this conversation. Hidden when null. */
  channel_type?: string | null
  /** Phase 8BG — true when the latest inbound message for the
   * conversation carries parse_needs_review. Drives the small
   * amber warning dot next to the channel badge. */
  parse_needs_review?: boolean | null
}
interface Lead {
  id: string
  name: string
  email: string
  lead_score: number
}

interface MessageHit {
  /** `message:<uuid>` from /api/dashboard/search */
  id: string
  lead_id: string
  lead_name: string
  role_tag: string
  snippet: string
  created_at_label: string
  message_id: string
}

const sentimentColor: Record<string, string> = {
  positive: 'bg-[#059669]',
  neutral:  'bg-[#94A3B8]',
  negative: 'bg-[#D97706]',
  urgent:   'bg-[#DC2626]',
}

interface Props {
  conversations: (Conversation & { leads: Lead | null })[]
  activeLeadId?: string
}

const SEARCH_DEBOUNCE_MS = 240

/**
 * Phase 8AO — interactive ConversationList search.
 *
 * Before this phase the input was decorative — typing didn't filter
 * anything. Now:
 *   - typing filters the in-memory `conversations[]` by lead name +
 *     email (substring) so the existing rows narrow live;
 *   - when q.length >= 2, we ALSO fetch
 *     /api/dashboard/search?q=... and surface only the `kind:'message'`
 *     items under a small "MESSAGES" eyebrow at the bottom of the list.
 *
 * Reuses the Phase 8AN similarity-ranked RPC indirectly (the global
 * search route calls the RPC; we just consume the message slice). We
 * don't duplicate the lead/conversation rendering — those are already
 * the local filter target.
 *
 * Each message hit deep-links to
 *   /dashboard/inbox/<lead_id>?message=<message_id>
 * and the existing Phase 8AM ConversationThread highlight kicks in.
 */
export default function ConversationList({ conversations, activeLeadId }: Props) {
  const router = useRouter()
  const [query, setQuery] = useState('')
  const [messageHits, setMessageHits] = useState<MessageHit[]>([])
  const [searchState, setSearchState] = useState<
    'idle' | 'loading' | 'ready' | 'error'
  >('idle')

  // In-memory filter for the existing conversation rows.
  const filteredConversations = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return conversations
    return conversations.filter((c) => {
      const lead = c.leads
      const name = lead?.name?.toLowerCase() ?? ''
      const email = lead?.email?.toLowerCase() ?? ''
      return name.includes(q) || email.includes(q)
    })
  }, [conversations, query])

  // Debounced backend fetch for message-body matches. Mirrors the
  // CommandPalette debounce shape so the rate-limit budget composes
  // cleanly with palette traffic.
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const inflightRef = useRef<AbortController | null>(null)
  useEffect(() => {
    const trimmed = query.trim()
    if (trimmed.length < 2) {
      if (debounceRef.current) clearTimeout(debounceRef.current)
      if (inflightRef.current) inflightRef.current.abort()
      setMessageHits([])
      setSearchState('idle')
      return
    }
    if (debounceRef.current) clearTimeout(debounceRef.current)
    setSearchState('loading')
    debounceRef.current = setTimeout(async () => {
      if (inflightRef.current) inflightRef.current.abort()
      const controller = new AbortController()
      inflightRef.current = controller
      try {
        const res = await fetch(
          `/api/dashboard/search?q=${encodeURIComponent(trimmed)}`,
          {
            method: 'GET',
            signal: controller.signal,
            credentials: 'same-origin',
          }
        )
        if (!res.ok) {
          setMessageHits([])
          setSearchState('error')
          return
        }
        const body = (await res.json().catch(() => null)) as
          | { items?: Array<{ id: string; kind: string; title: string; subtitle: string; href: string }> }
          | null
        const items = Array.isArray(body?.items) ? body!.items! : []
        // Keep only the message branch; the inbox already covers
        // leads/conversations via the local filter above and the
        // tours/route hits aren't relevant here.
        const hits: MessageHit[] = []
        for (const it of items) {
          if (it.kind !== 'message') continue
          // Parse the message id + lead_id back out of the well-known
          // shape the search route emits:
          //   id     = `message:<uuid>`
          //   href   = `/dashboard/inbox/<lead_id>?message=<uuid>`
          //   title  = `<leadName> · <Role>`
          //   subtitle = `<MMM d> · <snippet>`
          const messageId = it.id.startsWith('message:')
            ? it.id.slice('message:'.length)
            : ''
          const m = it.href.match(
            /^\/dashboard\/inbox\/([^?]+)\?message=([^&]+)/
          )
          const leadId = m ? decodeURIComponent(m[1]) : ''
          if (!leadId || !messageId) continue
          const [titleLead, titleRole] = it.title.split(' · ')
          const [subStamp, ...subRest] = it.subtitle.split(' · ')
          hits.push({
            id: it.id,
            message_id: messageId,
            lead_id: leadId,
            lead_name: titleLead ?? 'Unknown',
            role_tag: titleRole ?? '',
            snippet: subRest.join(' · '),
            created_at_label: subStamp ?? '',
          })
        }
        setMessageHits(hits)
        setSearchState('ready')
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return
        setMessageHits([])
        setSearchState('error')
      } finally {
        if (inflightRef.current === controller) inflightRef.current = null
      }
    }, SEARCH_DEBOUNCE_MS)
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [query])

  const trimmed = query.trim()
  const showMessageBlock = trimmed.length >= 2

  return (
    <aside className="w-[320px] shrink-0 bg-white border-r border-[#E6E8EF] flex flex-col">
      <div className="px-4 py-3.5 border-b border-[#F1F5F9]">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-[14px] font-semibold text-[#0F172A]">All messages</h2>
          <button className="text-[11px] font-medium text-[#1D4ED8] hover:underline">All Platforms ▾</button>
        </div>
        <div className="flex items-center gap-2 bg-[#F8FAFC] border border-[#E6E8EF] rounded-full pl-3 pr-2 h-9">
          <Search className="w-3.5 h-3.5 text-[#94A3B8]" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search names, emails, or message text…"
            aria-label="Search inbox"
            className="flex-1 bg-transparent text-[12px] outline-none text-[#0F172A] placeholder:text-[#94A3B8]"
          />
          {searchState === 'loading' && (
            <Loader2 className="w-3 h-3 text-[#64748B] animate-spin shrink-0" />
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {/* Conversation rows — locally filtered. */}
        {conversations.length === 0 && (
          <div className="p-6 text-center text-[13px] text-[#64748B]">No conversations yet.</div>
        )}

        {conversations.length > 0 && filteredConversations.length === 0 && !showMessageBlock && (
          <div className="p-6 text-center text-[12.5px] text-[#94A3B8]">
            No conversations match &ldquo;{trimmed}&rdquo;.
          </div>
        )}

        {filteredConversations.map((conv) => {
          const lead = conv.leads
          const isActive = lead?.id === activeLeadId
          const initials = lead?.name?.charAt(0) ?? '?'

          return (
            <Link
              key={conv.id}
              href={`/dashboard/inbox/${lead?.id ?? conv.lead_id}`}
              className={cn(
                'flex items-start gap-3 px-4 py-3.5 border-b border-[#F1F5F9] transition-colors',
                isActive ? 'bg-[#F1F5F9]' : 'hover:bg-[#F8FAFC]'
              )}
            >
              <div className="relative shrink-0">
                <div className="w-9 h-9 rounded-full bg-gradient-to-br from-[#1E293B] to-[#0F172A] flex items-center justify-center text-white text-[12px] font-bold">
                  {initials}
                </div>
                <div className={cn('absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full border-2 border-white', sentimentColor[conv.sentiment] ?? 'bg-[#94A3B8]')} />
              </div>

              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between gap-2 mb-0.5">
                  <p className="text-[13px] font-semibold text-[#0F172A] truncate">{lead?.name ?? 'Unknown'}</p>
                  <span className="text-[10px] text-[#94A3B8] shrink-0">
                    {conv.last_message_at ? formatDistanceToNow(new Date(conv.last_message_at)) : '—'}
                  </span>
                </div>
                <div className="flex items-center gap-1.5 min-w-0">
                  <p className="text-[12px] text-[#64748B] truncate flex-1 min-w-0">{lead?.email}</p>
                  {/* Phase 8BE — channel badge only renders when the
                      conversation has a recorded channel mapping. */}
                  <ChannelSourceBadge channelType={conv.channel_type ?? null} />
                  {/* Phase 8BG — amber warning dot when the latest
                      inbound message needs parse review. Hidden
                      otherwise. */}
                  <ParseReviewBadge
                    needsReview={conv.parse_needs_review ?? false}
                    dotOnly
                  />
                </div>
              </div>

              <div className="flex flex-col items-end gap-1 shrink-0">
                {conv.unread_count > 0 ? (
                  <span className="bg-[#1D4ED8] text-white text-[10px] font-bold rounded-full min-w-[18px] h-[18px] px-1.5 flex items-center justify-center">
                    {conv.unread_count}
                  </span>
                ) : (
                  <Star className="w-3.5 h-3.5 text-[#CBD5E1]" />
                )}
              </div>
            </Link>
          )
        })}

        {/* Phase 8AO — MESSAGES block. Only when the operator typed
            something searchable; the conversation rows above already
            cover lead identity. */}
        {showMessageBlock && (
          <div className="border-t border-[#EEF2F7]">
            <div className="px-4 pt-3 pb-1.5 text-[10px] uppercase tracking-[0.16em] text-[#94A3B8] font-semibold flex items-center justify-between">
              <span>Messages</span>
              {searchState === 'loading' && (
                <span className="inline-flex items-center gap-1 text-[10px] text-[#94A3B8] normal-case tracking-normal">
                  <Loader2 className="w-3 h-3 animate-spin" />
                  searching…
                </span>
              )}
            </div>
            {searchState === 'error' && (
              <div className="px-4 py-3 text-[12px] text-[#B91C1C]">
                Couldn&apos;t search messages. Try again.
              </div>
            )}
            {searchState === 'ready' && messageHits.length === 0 && (
              <div className="px-4 py-3 text-[12px] text-[#94A3B8]">
                No message bodies match &ldquo;{trimmed}&rdquo;.
              </div>
            )}
            {messageHits.map((hit) => (
              <button
                key={hit.id}
                type="button"
                onClick={() =>
                  router.push(
                    `/dashboard/inbox/${encodeURIComponent(hit.lead_id)}?message=${encodeURIComponent(hit.message_id)}`
                  )
                }
                className="w-full text-left flex items-start gap-3 px-4 py-3 border-b border-[#F1F5F9] hover:bg-[#F8FAFC] transition-colors"
              >
                <div className="w-8 h-8 rounded-[10px] bg-[#EFF6FF] text-[#1D4ED8] flex items-center justify-center shrink-0">
                  <MessageSquare className="w-3.5 h-3.5" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between gap-2 mb-0.5">
                    <p className="text-[12.5px] font-semibold text-[#0F172A] truncate">
                      {hit.lead_name}
                      {hit.role_tag ? (
                        <span className="ml-1.5 text-[10px] uppercase tracking-[0.12em] text-[#64748B] font-medium">
                          {hit.role_tag}
                        </span>
                      ) : null}
                    </p>
                    <span className="text-[10px] text-[#94A3B8] shrink-0">
                      {hit.created_at_label}
                    </span>
                  </div>
                  <p className="text-[11.5px] text-[#475569] line-clamp-2">
                    {hit.snippet}
                  </p>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    </aside>
  )
}

// Eslint helper — `format` import preserved for future date-only
// renders. Drop when the next ConversationList feature consumes it.
void format
