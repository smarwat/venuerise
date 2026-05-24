'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Mail,
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  Loader2,
  Link2,
  X,
  CheckCircle2,
} from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * Phase 8BQ — Unmatched inbound email queue card.
 *
 * Compact surface mounted on the inbox index page. Hidden when
 * the unresolved count is 0. When count > 0:
 *
 *   1. Collapsed chip shows "Unmatched replies: N" with a small
 *      alert tone.
 *   2. Expanded panel lists up to 20 unresolved orphans (sender,
 *      subject, time, body preview, suggested conversation when
 *      available).
 *   3. Each row has Link + Dismiss actions.
 *
 * ── HONESTY CONTRACT ──────────────────────────────────────────────────────
 * - Never auto-links anything. Operator must click Link.
 * - Never claims an unmatched reply is from a specific lead — it
 *   shows the raw From address + subject + body preview and lets
 *   the operator decide.
 * - Never shows raw provider payloads, headers, or provider ids.
 * - Body preview is capped (280 chars) — the full stripped body
 *   appears on the linked message bubble after the operator
 *   commits.
 * - Linking inserts as `role: 'lead'`; AI does NOT auto-fire.
 *   This matches the 8BO inbound capture rule and 8BQ's explicit
 *   "no auto AI on linked orphan" guarantee.
 */

interface OrphanRow {
  id: string
  status: 'unresolved' | 'linked' | 'dismissed' | 'ignored'
  from_email: string | null
  from_name: string | null
  subject: string | null
  body_preview: string
  received_at: string | null
  parsed_at: string
  match_confidence: number
  suggested_conversation_ids: string[]
  suggested_lead_ids: string[]
  linked_conversation_id: string | null
  linked_lead_id: string | null
  linked_message_id: string | null
  dismissed_at: string | null
  dismiss_reason: string | null
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
  if (o.from_name && o.from_email) return `${o.from_name} <${o.from_email}>`
  return o.from_name ?? o.from_email ?? 'Unknown sender'
}

export default function UnmatchedEmailQueueCard() {
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
    async (orphanId: string, conversationId: string) => {
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
          setError(
            (json && (json.error as string)) ||
              'Could not link this reply. Refresh and try again.'
          )
          return
        }
        // Optimistically remove from local list.
        setOrphans((prev) => prev.filter((o) => o.id !== orphanId))
        setUnresolvedCount((n) => Math.max(0, n - 1))
      } catch {
        setError('Could not link this reply.')
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

  // Don't render anything when there's no queue AND we're not in
  // an error state — keeps the inbox clean.
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
            <div className="px-4 py-6 text-center text-[12px] text-[#64748B]">
              No unmatched replies right now.
            </div>
          ) : (
            <ul className="divide-y divide-[#F1F5F9]">
              {orphans.map((o) => (
                <OrphanRowItem
                  key={o.id}
                  orphan={o}
                  acting={acting[o.id] ?? null}
                  onLink={handleLink}
                  onDismiss={handleDismiss}
                />
              ))}
            </ul>
          )}
          <div className="px-4 py-2 text-[10.5px] text-[#64748B] border-t border-[#F1F5F9] bg-[#F8FAFC]">
            <Mail className="w-2.5 h-2.5 inline mr-1" />
            Linked replies appear in the conversation as a lead message. AI does not auto-respond.
          </div>
        </div>
      )}
    </div>
  )
}

function OrphanRowItem(props: {
  orphan: OrphanRow
  acting: 'link' | 'dismiss' | null
  onLink: (orphanId: string, conversationId: string) => Promise<void>
  onDismiss: (orphanId: string, reason: DismissReason) => Promise<void>
}) {
  const { orphan, acting, onLink, onDismiss } = props
  const [dismissOpen, setDismissOpen] = useState(false)
  const primarySuggestion = useMemo(
    () => orphan.suggested_conversation_ids[0] ?? null,
    [orphan]
  )
  return (
    <li className="px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 mb-0.5">
            <span className="text-[12.5px] font-semibold text-[#0F172A] truncate">
              {senderDisplay(orphan)}
            </span>
            <span className="text-[10.5px] text-[#94A3B8] shrink-0">
              · {timeAgo(orphan.received_at ?? orphan.parsed_at)}
            </span>
          </div>
          {orphan.subject && (
            <div className="text-[11.5px] text-[#475569] truncate mb-1">
              {orphan.subject}
            </div>
          )}
          <p className="text-[11.5px] text-[#64748B] leading-snug line-clamp-2">
            {orphan.body_preview}
          </p>
          <div className="flex items-center gap-1.5 mt-1.5">
            <span className="inline-flex items-center gap-1 rounded-full border border-[#E2E8F0] bg-[#F8FAFC] px-1.5 py-[1px] text-[10px] text-[#475569]">
              confidence {orphan.match_confidence}
            </span>
            {primarySuggestion && (
              <span className="inline-flex items-center gap-1 rounded-full border border-[#BFDBFE] bg-[#EFF6FF] px-1.5 py-[1px] text-[10px] font-medium text-[#1D4ED8]">
                Suggested conversation
              </span>
            )}
            {!primarySuggestion && orphan.suggested_lead_ids.length === 0 && (
              <span className="inline-flex items-center gap-1 rounded-full border border-[#E2E8F0] bg-[#F8FAFC] px-1.5 py-[1px] text-[10px] text-[#64748B]">
                No suggestion
              </span>
            )}
          </div>
        </div>
        <div className="shrink-0 flex flex-col items-end gap-1.5">
          {primarySuggestion ? (
            <button
              type="button"
              disabled={!!acting}
              onClick={() => onLink(orphan.id, primarySuggestion)}
              className={cn(
                'inline-flex items-center gap-1 rounded-md border border-[#1D4ED8] bg-[#1D4ED8] px-2 py-1 text-[11px] font-semibold text-white hover:bg-[#1E40AF] transition-colors',
                acting && 'opacity-60 cursor-wait'
              )}
            >
              {acting === 'link' ? (
                <Loader2 className="w-3 h-3 animate-spin" />
              ) : (
                <Link2 className="w-3 h-3" />
              )}
              Link
            </button>
          ) : (
            <span className="text-[10px] text-[#94A3B8] italic">
              Link via inbox
            </span>
          )}
          <div className="relative">
            <button
              type="button"
              disabled={!!acting}
              onClick={() => setDismissOpen((v) => !v)}
              className={cn(
                'inline-flex items-center gap-1 rounded-md border border-[#E2E8F0] bg-white px-2 py-1 text-[11px] font-medium text-[#475569] hover:bg-[#F8FAFC] hover:border-[#CBD5E1] transition-colors',
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
    </li>
  )
}

// Note: imported but unused so the linter doesn't flag the bundle.
void CheckCircle2
