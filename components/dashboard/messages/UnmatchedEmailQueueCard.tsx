'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Mail,
  MessageSquare,
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  Loader2,
  Link2,
  X,
  Search,
  Check,
} from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * Phase 8BQ — Unmatched inbound email queue card.
 * Phase 8BR-alt — added inline conversation picker for orphans
 * without a pre-computed suggestion.
 *
 * Compact surface mounted on the inbox index page. Hidden when
 * the unresolved count is 0. When count > 0:
 *
 *   1. Collapsed chip shows "Unmatched replies: N".
 *   2. Expanded panel lists up to 20 unresolved orphans.
 *   3. Each row shows:
 *      - Sender + subject + body preview + confidence chip.
 *      - When `suggested_conversations[0]` exists → primary
 *        "Link suggestion" with a readable label
 *        (Sarah Johnson · sarah@gmail.com · Qualified) AND a
 *        secondary "Choose another" toggle.
 *      - When no suggestion exists → the picker opens by default.
 *   4. Picker = local-filter search over the inbox's already-
 *      loaded conversation list (no new API route). Recent
 *      conversations show when search is empty.
 *
 * ── HONESTY CONTRACT ──────────────────────────────────────────────────────
 * - Never auto-links anything. Operator must click Link.
 * - Never claims an unmatched reply is from a specific lead —
 *   the suggestion is a hint, not a decision. Operator can
 *   override via the picker.
 * - Never shows raw provider payloads, headers, or provider ids.
 * - Body preview is capped (280 chars).
 * - Linking inserts as `role:'lead'`; AI does NOT auto-fire.
 *   This matches the 8BO/8BQ rule.
 * - Server (link route) re-validates ownership; the client-side
 *   picker can never bypass tenant checks.
 */

interface OrphanRow {
  id: string
  // Phase 8BT — channel discriminator. Legacy rows default to
  // 'email' via the migration; the component branches on this
  // for icon + sender display.
  channel: 'email' | 'sms'
  status: 'unresolved' | 'linked' | 'dismissed' | 'ignored'
  from_email: string | null
  from_name: string | null
  from_phone: string | null
  to_phone: string | null
  subject: string | null
  body_preview: string
  received_at: string | null
  parsed_at: string
  match_confidence: number
  suggested_conversation_ids: string[]
  suggested_lead_ids: string[]
  suggested_conversations: ConversationPreview[]
  linked_conversation_id: string | null
  linked_lead_id: string | null
  linked_message_id: string | null
  dismissed_at: string | null
  dismiss_reason: string | null
}

export interface ConversationPreview {
  conversation_id: string
  lead_id: string | null
  lead_name: string | null
  lead_email: string | null
  stage: string | null
  source_channel: string | null
  last_message_at: string | null
}

interface QueueResponse {
  orphans: OrphanRow[]
  unresolved_count: number
}

type DismissReason =
  | 'spam'
  | 'wrong_venue'
  | 'duplicate'
  | 'not_relevant'
  | 'auto_responder'
  | 'other'

const REASON_LABELS: Record<DismissReason, string> = {
  spam: 'Spam',
  wrong_venue: 'Wrong venue',
  duplicate: 'Duplicate',
  not_relevant: 'Not relevant',
  auto_responder: 'Auto-responder',
  other: 'Other',
}

function timeAgo(iso: string | null): string {
  if (!iso) return ''
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return ''
  const diff = Date.now() - t
  const min = Math.floor(diff / 60_000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  const day = Math.floor(hr / 24)
  return `${day}d ago`
}

function senderDisplay(o: OrphanRow): string {
  if (o.channel === 'sms') {
    return o.from_phone ?? 'Unknown number'
  }
  if (o.from_name && o.from_email) return `${o.from_name} <${o.from_email}>`
  return o.from_name ?? o.from_email ?? 'Unknown sender'
}

/** Channel-appropriate row label shown above the sender line. */
function channelLabel(channel: OrphanRow['channel']): string {
  return channel === 'sms' ? 'SMS reply' : 'Email reply'
}

function previewLabel(c: ConversationPreview): string {
  const parts: string[] = []
  if (c.lead_name) parts.push(c.lead_name)
  if (c.lead_email) parts.push(c.lead_email)
  if (c.source_channel) parts.push(prettyChannel(c.source_channel))
  if (c.stage) parts.push(prettyStage(c.stage))
  if (parts.length > 0) return parts.join(' · ')
  return `Conversation · Last active ${timeAgo(c.last_message_at) || 'unknown'}`
}

function prettyChannel(s: string): string {
  switch (s) {
    case 'website':
      return 'Website'
    case 'instagram':
      return 'Instagram'
    case 'facebook':
      return 'Facebook'
    case 'meta_lead_ads':
      return 'Meta lead ad'
    case 'email':
      return 'Email'
    case 'sms':
      return 'SMS'
    case 'the_knot':
      return 'The Knot'
    case 'weddingwire':
      return 'WeddingWire'
    case 'manual':
      return 'Manual'
    default:
      return s
  }
}

function prettyStage(s: string): string {
  return s
    .split('_')
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join(' ')
}

export interface UnmatchedEmailQueueCardProps {
  /**
   * Conversations already loaded by the inbox server page. Used
   * as the local-filter pool for the picker — no new API route.
   * Pass an empty array when not on the inbox page (the picker
   * then shows "No conversations available").
   */
  venueConversations?: ConversationPreview[]
}

export default function UnmatchedEmailQueueCard({
  venueConversations = [],
}: UnmatchedEmailQueueCardProps) {
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [orphans, setOrphans] = useState<OrphanRow[]>([])
  const [unresolvedCount, setUnresolvedCount] = useState(0)
  const [acting, setActing] = useState<Record<string, 'link' | 'dismiss' | null>>({})

  const fetchQueue = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/inbound-email-orphans?status=unresolved&limit=20', {
        method: 'GET',
        cache: 'no-store',
      })
      if (!res.ok) {
        setError('Could not load unmatched replies.')
        return
      }
      const json = (await res.json().catch(() => null)) as QueueResponse | null
      if (!json) {
        setError('Could not load unmatched replies.')
        return
      }
      setOrphans(json.orphans ?? [])
      setUnresolvedCount(json.unresolved_count ?? 0)
    } catch {
      setError('Could not load unmatched replies.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void fetchQueue()
  }, [fetchQueue])

  const handleLink = useCallback(
    async (orphanId: string, conversationId: string): Promise<boolean> => {
      setActing((prev) => ({ ...prev, [orphanId]: 'link' }))
      try {
        const res = await fetch(
          `/api/inbound-email-orphans/${encodeURIComponent(orphanId)}/link`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ conversation_id: conversationId }),
          }
        )
        if (!res.ok) {
          const json = await res.json().catch(() => null)
          // 409 already_resolved → remove from list (another tab won).
          if (res.status === 409) {
            setOrphans((prev) => prev.filter((o) => o.id !== orphanId))
            setUnresolvedCount((n) => Math.max(0, n - 1))
            return false
          }
          setError(
            (json && (json.error as string)) ||
              'Could not link this reply. Refresh and try again.'
          )
          return false
        }
        setOrphans((prev) => prev.filter((o) => o.id !== orphanId))
        setUnresolvedCount((n) => Math.max(0, n - 1))
        return true
      } catch {
        setError('Could not link this reply.')
        return false
      } finally {
        setActing((prev) => ({ ...prev, [orphanId]: null }))
      }
    },
    []
  )

  const handleDismiss = useCallback(
    async (orphanId: string, reason: DismissReason) => {
      setActing((prev) => ({ ...prev, [orphanId]: 'dismiss' }))
      try {
        const res = await fetch(
          `/api/inbound-email-orphans/${encodeURIComponent(orphanId)}/dismiss`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ reason }),
          }
        )
        if (!res.ok) {
          const json = await res.json().catch(() => null)
          if (res.status === 409) {
            setOrphans((prev) => prev.filter((o) => o.id !== orphanId))
            setUnresolvedCount((n) => Math.max(0, n - 1))
            return
          }
          setError(
            (json && (json.error as string)) ||
              'Could not dismiss this reply.'
          )
          return
        }
        setOrphans((prev) => prev.filter((o) => o.id !== orphanId))
        setUnresolvedCount((n) => Math.max(0, n - 1))
      } catch {
        setError('Could not dismiss this reply.')
      } finally {
        setActing((prev) => ({ ...prev, [orphanId]: null }))
      }
    },
    []
  )

  const visibleCount = orphans.length

  if (!loading && unresolvedCount === 0 && !error) {
    return null
  }

  return (
    <div className="mx-4 mt-3 rounded-2xl border border-[#FDE68A] bg-[#FFFBEB] overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between gap-2 px-4 py-2.5 text-left hover:bg-[#FEF3C7]/40 transition-colors"
        aria-expanded={open}
      >
        <span className="inline-flex items-center gap-2 text-[12.5px] font-semibold text-[#92400E]">
          <AlertTriangle className="w-3.5 h-3.5" />
          {loading && unresolvedCount === 0
            ? 'Checking for unmatched replies…'
            : `Unmatched replies: ${unresolvedCount}`}
          {visibleCount > 0 && visibleCount < unresolvedCount && (
            <span className="text-[10.5px] font-normal text-[#92400E]/70">
              showing {visibleCount}
            </span>
          )}
        </span>
        {open ? (
          <ChevronUp className="w-3.5 h-3.5 text-[#92400E]" />
        ) : (
          <ChevronDown className="w-3.5 h-3.5 text-[#92400E]" />
        )}
      </button>

      {open && (
        <div className="border-t border-[#FDE68A] bg-white">
          {error && (
            <div className="px-4 py-2 text-[11.5px] text-[#B91C1C] bg-[#FEF2F2] border-b border-[#FECACA]">
              {error}
            </div>
          )}
          {loading && orphans.length === 0 ? (
            <div className="px-4 py-6 text-center text-[12px] text-[#64748B]">
              <Loader2 className="w-3.5 h-3.5 inline animate-spin mr-1.5" />
              Loading…
            </div>
          ) : orphans.length === 0 ? (
            // Phase 8BW — channel-neutral empty state. Operators
            // reach this view after dismissing/linking everything
            // in the queue; explain what would land here next.
            <div className="px-4 py-6 text-center">
              <p className="text-[12.5px] font-semibold text-[#0F172A]">
                No unmatched replies
              </p>
              <p className="mt-1 text-[11px] text-[#64748B]">
                Email and SMS replies that need review will appear here.
              </p>
            </div>
          ) : (
            <ul className="divide-y divide-[#F1F5F9]">
              {orphans.map((o) => (
                <OrphanRowItem
                  key={o.id}
                  orphan={o}
                  acting={acting[o.id] ?? null}
                  venueConversations={venueConversations}
                  onLink={handleLink}
                  onDismiss={handleDismiss}
                />
              ))}
            </ul>
          )}
          {/* Phase 8BW — channel-neutral footer copy. Explicitly
              names both surfaces and reaffirms the no-auto-AI
              guarantee operators rely on. */}
          <div className="px-4 py-2 text-[10.5px] text-[#64748B] border-t border-[#F1F5F9] bg-[#F8FAFC]">
            <MessageSquare className="w-2.5 h-2.5 inline mr-1" />
            Linked replies appear in the selected conversation as lead messages.
            AI does not auto-respond.
          </div>
        </div>
      )}
    </div>
  )
}

function OrphanRowItem(props: {
  orphan: OrphanRow
  acting: 'link' | 'dismiss' | null
  venueConversations: ConversationPreview[]
  onLink: (orphanId: string, conversationId: string) => Promise<boolean>
  onDismiss: (orphanId: string, reason: DismissReason) => Promise<void>
}) {
  const { orphan, acting, venueConversations, onLink, onDismiss } = props
  const [dismissOpen, setDismissOpen] = useState(false)
  const primarySuggestion = orphan.suggested_conversations[0] ?? null
  // Picker opens by default when there's no suggestion; otherwise
  // collapsed behind a "Choose another" button.
  const [pickerOpen, setPickerOpen] = useState(!primarySuggestion)
  const [selected, setSelected] = useState<ConversationPreview | null>(null)
  const [query, setQuery] = useState('')

  // Debounced filter — 250ms cadence so typing feels responsive
  // without recomputing on every keystroke.
  const [debouncedQuery, setDebouncedQuery] = useState('')
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query.trim().toLowerCase()), 250)
    return () => clearTimeout(t)
  }, [query])

  // Filter pool. Empty query → recent conversations (already
  // sorted by last_message_at desc from the server). Typed
  // query → name/email/phone substring match.
  const filtered = useMemo(() => {
    if (!debouncedQuery) return venueConversations.slice(0, 10)
    const needle = debouncedQuery
    return venueConversations
      .filter((c) => {
        const name = (c.lead_name ?? '').toLowerCase()
        const email = (c.lead_email ?? '').toLowerCase()
        return name.includes(needle) || email.includes(needle)
      })
      .slice(0, 10)
  }, [venueConversations, debouncedQuery])

  // Suggestion-driven primary action.
  const handleLinkSuggestion = async () => {
    if (!primarySuggestion) return
    await onLink(orphan.id, primarySuggestion.conversation_id)
  }
  const handleLinkSelected = async () => {
    if (!selected) return
    await onLink(orphan.id, selected.conversation_id)
  }

  return (
    <li className="px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          {/* Phase 8BT — channel-aware row header. Email rows
              show Mail + sender + subject; SMS rows show
              MessageSquare + phone + a "SMS reply" label
              (subject is the SMS placeholder we set at
              orphan-creation time). */}
          <div className="flex items-center gap-1.5 mb-0.5">
            {orphan.channel === 'sms' ? (
              <MessageSquare className="w-3 h-3 text-[#1D4ED8] shrink-0" />
            ) : (
              <Mail className="w-3 h-3 text-[#475569] shrink-0" />
            )}
            <span className="text-[12.5px] font-semibold text-[#0F172A] truncate">
              {senderDisplay(orphan)}
            </span>
            <span className="text-[10.5px] text-[#94A3B8] shrink-0">
              · {timeAgo(orphan.received_at ?? orphan.parsed_at)}
            </span>
          </div>
          {orphan.channel === 'sms' ? (
            <div className="text-[11.5px] text-[#475569] mb-1 inline-flex items-center gap-1">
              <span className="inline-flex items-center rounded-full bg-[#EFF6FF] text-[#1D4ED8] px-1.5 py-[1px] text-[10px] font-medium border border-[#BFDBFE]">
                {channelLabel(orphan.channel)}
              </span>
            </div>
          ) : (
            orphan.subject && (
              <div className="text-[11.5px] text-[#475569] truncate mb-1">
                {orphan.subject}
              </div>
            )
          )}
          <p className="text-[11.5px] text-[#64748B] leading-snug line-clamp-2">
            {orphan.body_preview}
          </p>
          <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
            <span className="inline-flex items-center gap-1 rounded-full border border-[#E2E8F0] bg-[#F8FAFC] px-1.5 py-[1px] text-[10px] text-[#475569]">
              confidence {orphan.match_confidence}
            </span>
            {primarySuggestion ? (
              <span
                className="inline-flex items-center gap-1 rounded-full border border-[#BFDBFE] bg-[#EFF6FF] px-1.5 py-[1px] text-[10px] font-medium text-[#1D4ED8] max-w-[260px] truncate"
                title={`Suggested: ${previewLabel(primarySuggestion)}`}
              >
                Suggested: {previewLabel(primarySuggestion)}
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 rounded-full border border-[#E2E8F0] bg-[#F8FAFC] px-1.5 py-[1px] text-[10px] text-[#64748B]">
                No suggestion — search below
              </span>
            )}
          </div>
        </div>
        <div className="shrink-0 flex flex-col items-end gap-1.5">
          {primarySuggestion && (
            <button
              type="button"
              disabled={!!acting}
              onClick={handleLinkSuggestion}
              className={cn(
                'inline-flex items-center gap-1 rounded-md border border-[#1D4ED8] bg-[#1D4ED8] px-2 py-1 text-[11px] font-semibold text-white hover:bg-[#1E40AF] transition-colors',
                acting && 'opacity-60 cursor-wait'
              )}
            >
              {acting === 'link' && !selected ? (
                <Loader2 className="w-3 h-3 animate-spin" />
              ) : (
                <Link2 className="w-3 h-3" />
              )}
              Link suggestion
            </button>
          )}
          {primarySuggestion && (
            <button
              type="button"
              disabled={!!acting}
              onClick={() => setPickerOpen((v) => !v)}
              className="inline-flex items-center gap-1 rounded-md border border-[#E2E8F0] bg-white px-2 py-1 text-[10.5px] font-medium text-[#475569] hover:bg-[#F8FAFC] hover:border-[#CBD5E1] transition-colors"
            >
              <Search className="w-3 h-3" />
              {pickerOpen ? 'Hide search' : 'Choose another'}
            </button>
          )}
          <div className="relative">
            <button
              type="button"
              disabled={!!acting}
              onClick={() => setDismissOpen((v) => !v)}
              className={cn(
                'inline-flex items-center gap-1 rounded-md border border-[#E2E8F0] bg-white px-2 py-1 text-[10.5px] font-medium text-[#475569] hover:bg-[#F8FAFC] hover:border-[#CBD5E1] transition-colors',
                acting && 'opacity-60 cursor-wait'
              )}
            >
              {acting === 'dismiss' ? (
                <Loader2 className="w-3 h-3 animate-spin" />
              ) : (
                <X className="w-3 h-3" />
              )}
              Dismiss
            </button>
            {dismissOpen && !acting && (
              <div className="absolute right-0 top-full mt-1 z-10 w-44 rounded-md border border-[#E2E8F0] bg-white shadow-lg py-1">
                {(Object.keys(REASON_LABELS) as DismissReason[]).map((r) => (
                  <button
                    key={r}
                    type="button"
                    onClick={() => {
                      setDismissOpen(false)
                      void onDismiss(orphan.id, r)
                    }}
                    className="w-full text-left px-3 py-1.5 text-[11.5px] text-[#475569] hover:bg-[#F1F5F9] hover:text-[#0F172A]"
                  >
                    {REASON_LABELS[r]}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Picker — local filter over venueConversations. No API
          call; the inbox page already loaded these. */}
      {pickerOpen && (
        <div className="mt-2.5 rounded-lg border border-[#E2E8F0] bg-[#F8FAFC] p-2.5">
          <div className="flex items-center gap-2 mb-2">
            <div className="flex-1 flex items-center gap-1.5 rounded-md border border-[#E2E8F0] bg-white px-2 py-1">
              <Search className="w-3 h-3 text-[#94A3B8]" />
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search by lead name or email…"
                className="flex-1 bg-transparent outline-none text-[11.5px] text-[#0F172A] placeholder:text-[#94A3B8]"
                aria-label="Search conversations"
              />
            </div>
            <button
              type="button"
              disabled={!selected || !!acting}
              onClick={handleLinkSelected}
              className={cn(
                'inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] font-semibold transition-colors',
                selected && !acting
                  ? 'border-[#1D4ED8] bg-[#1D4ED8] text-white hover:bg-[#1E40AF]'
                  : 'border-[#E2E8F0] bg-white text-[#94A3B8] cursor-not-allowed'
              )}
            >
              {acting === 'link' && selected ? (
                <Loader2 className="w-3 h-3 animate-spin" />
              ) : (
                <Link2 className="w-3 h-3" />
              )}
              Link selected
            </button>
          </div>
          {filtered.length === 0 ? (
            <div className="px-2 py-3 text-[11px] text-[#64748B] text-center">
              {debouncedQuery
                ? 'No conversations found. Try name, email, or phone.'
                : 'No conversations available.'}
            </div>
          ) : (
            <ul className="max-h-48 overflow-y-auto divide-y divide-[#F1F5F9] bg-white rounded-md border border-[#E2E8F0]">
              {filtered.map((c) => {
                const isSelected =
                  selected?.conversation_id === c.conversation_id
                return (
                  <li key={c.conversation_id}>
                    <button
                      type="button"
                      onClick={() => setSelected(c)}
                      className={cn(
                        'w-full text-left px-2.5 py-1.5 hover:bg-[#F1F5F9] transition-colors flex items-start justify-between gap-2',
                        isSelected && 'bg-[#EFF6FF] hover:bg-[#EFF6FF]'
                      )}
                    >
                      <div className="min-w-0 flex-1">
                        <div className="text-[12px] font-semibold text-[#0F172A] truncate">
                          {c.lead_name ?? c.lead_email ?? 'Unknown lead'}
                        </div>
                        <div className="text-[10.5px] text-[#64748B] truncate">
                          {[
                            c.lead_email,
                            c.source_channel && prettyChannel(c.source_channel),
                            timeAgo(c.last_message_at) &&
                              `Last active ${timeAgo(c.last_message_at)}`,
                          ]
                            .filter(Boolean)
                            .join(' · ')}
                        </div>
                      </div>
                      {isSelected && (
                        <Check className="w-3.5 h-3.5 text-[#1D4ED8] mt-0.5 shrink-0" />
                      )}
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
          {selected && (
            <div className="mt-2 text-[10.5px] text-[#475569]">
              Selected: <strong>{selected.lead_name ?? selected.lead_email}</strong>
              {' '}— click <strong>Link selected</strong> to attach this reply.
            </div>
          )}
        </div>
      )}
    </li>
  )
}
