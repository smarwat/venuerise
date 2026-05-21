'use client'

import { useState } from 'react'
import { AlertTriangle, Copy, CheckCircle2, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  getChannelCapabilities,
} from '@/lib/integrations/channels/capabilities'
import type { ChannelType } from '@/lib/integrations/channels/types'
import ChannelSourceBadge from './ChannelSourceBadge'

/**
 * Phase 8BE — Manual reply required banner.
 *
 * Renders above (or alongside) the reply composer when the
 * current conversation lives on a channel VenueRise cannot
 * deliver back through. Surfaces:
 *
 *   - The channel + a one-line reason.
 *   - `Copy reply` — copies the draft body to the clipboard.
 *   - `Mark sent manually` — POSTs to
 *     /api/conversations/[id]/mark-sent-manually to record a
 *     human message + an `external_messages` row.
 *
 * The component is purely opt-in. Drawers + composers that
 * have a draft body to show can mount it; pages that don't
 * have channel context can skip it entirely.
 */
interface ManualChannelReplyBannerProps {
  conversationId: string
  channelType: ChannelType | string | null | undefined
  draftBody: string
  onMarkedSent?: () => void
  className?: string
}

export default function ManualChannelReplyBanner({
  conversationId,
  channelType,
  draftBody,
  onMarkedSent,
  className,
}: ManualChannelReplyBannerProps) {
  const [copied, setCopied] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [done, setDone] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!channelType) return null
  const caps = getChannelCapabilities(channelType)
  if (!caps.manualReplyRequired) return null

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(draftBody)
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    } catch {
      setError('Clipboard copy failed. Select the draft and copy manually.')
    }
  }

  const handleMarkSent = async () => {
    if (!draftBody.trim()) {
      setError('Add a reply body before marking sent.')
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      const res = await fetch(
        `/api/conversations/${encodeURIComponent(conversationId)}/mark-sent-manually`,
        {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            body: draftBody,
            channel_type: channelType,
          }),
        }
      )
      if (!res.ok) {
        const json = (await res.json().catch(() => null)) as
          | { error?: string }
          | null
        setError(json?.error ?? 'mark_sent_failed')
        return
      }
      setDone(true)
      onMarkedSent?.()
    } catch {
      setError('Network error. Try again.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div
      className={cn(
        'rounded-2xl border border-[#FCD9A1] bg-[#FFFBEB] p-3.5 space-y-2.5',
        className
      )}
    >
      <div className="flex items-start gap-2.5">
        <div className="w-7 h-7 rounded-full bg-[#FDE68A] text-[#B45309] flex items-center justify-center shrink-0">
          <AlertTriangle className="w-3.5 h-3.5" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="text-[12.5px] font-semibold text-[#7C2D12]">
              Manual reply required
            </p>
            <ChannelSourceBadge channelType={channelType} />
          </div>
          <p className="text-[11.5px] text-[#92400E] mt-1 leading-relaxed">
            VenueRise cannot deliver this reply directly through{' '}
            <span className="font-medium">{caps.displayName}</span>. Copy
            the draft and send it from the source platform, then click{' '}
            <span className="font-medium">Mark sent manually</span> so the
            inbox reflects your reply.
          </p>
        </div>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <button
          type="button"
          onClick={handleCopy}
          disabled={!draftBody.trim()}
          className={cn(
            'inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[11.5px] font-medium transition-colors',
            'border-[#FCD9A1] bg-white text-[#7C2D12] hover:bg-[#FEF3C7]',
            'disabled:opacity-50 disabled:cursor-not-allowed'
          )}
        >
          {copied ? (
            <>
              <CheckCircle2 className="w-3.5 h-3.5 text-[#15803D]" />
              Copied
            </>
          ) : (
            <>
              <Copy className="w-3.5 h-3.5" />
              Copy reply
            </>
          )}
        </button>

        <button
          type="button"
          onClick={handleMarkSent}
          disabled={submitting || done || !draftBody.trim()}
          className={cn(
            'inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[11.5px] font-semibold transition-colors',
            'bg-[#0F172A] text-white hover:bg-[#1E293B]',
            'disabled:opacity-50 disabled:cursor-not-allowed'
          )}
        >
          {submitting && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
          {!submitting && done && (
            <CheckCircle2 className="w-3.5 h-3.5" />
          )}
          {done ? 'Marked sent' : 'Mark sent manually'}
        </button>

        {error && (
          <p className="text-[11px] text-[#B91C1C] font-medium">{error}</p>
        )}
      </div>

      <p className="text-[10.5px] text-[#92400E]/80 leading-relaxed">
        Autonomous sending is disabled platform-wide. This banner reflects
        the connector posture today; direct send support ships in a future
        connector phase.
      </p>
    </div>
  )
}
