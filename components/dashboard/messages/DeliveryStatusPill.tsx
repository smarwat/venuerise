'use client'

import { useState } from 'react'
import {
  Mail,
  Clock,
  AlertTriangle,
  Inbox,
  Hand,
  CheckCircle2,
  RotateCcw,
  Loader2,
  Ban,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  getEmailDeliveryDisplay,
  isStalePending,
  normalizeEmailDeliveryStatus,
  STALE_PENDING_AFTER_MS,
  type EmailDeliveryStatus,
  type StatusTone,
} from '@/lib/integrations/delivery/email-status'

/**
 * Phase 8BP — Delivery status pill (rewrite).
 *
 * ── HONESTY CONTRACT ──────────────────────────────────────────────────────
 * The pill only renders when message metadata can DEFEND the
 * claim. All copy comes from `getEmailDeliveryDisplay` so a
 * single source of truth lives in `lib/integrations/delivery/
 * email-status.ts`. Server (retry route, webhook patcher) and
 * client UI read the same dictionary — no parallel copy lists.
 *
 * Key honesty rules enforced here:
 *   - "Accepted by Email" is what we say for the `accepted` /
 *     `sent` status. We never say "Delivered" until the
 *     `email.delivered` Resend webhook fires and the webhook
 *     patcher flips the status.
 *   - "Sending…" escalates to "Status delayed" after 5 min so
 *     the spinner never runs forever.
 *   - Retry is shown only for failed / bounced / skipped
 *     (the server re-validates).
 *   - Retry NEVER appears for `complained` — recipient marked
 *     spam; resending would be abuse.
 *   - "Mark handled manually" only appears for terminal failure
 *     statuses; success states don't get a "manual fallback"
 *     option to avoid encouraging false ownership claims.
 *   - We never show provider message ids. We never show raw
 *     provider errors; `safeError` is already sanitized server-
 *     side and renders only in the tooltip.
 */

export interface DeliveryPillProps {
  messageId?: string | null
  /**
   * 8BM `reply_method` ('email' / 'sms' / 'instagram' / ...).
   * Used to decide which retry/fallback actions make sense.
   */
  replyMethod?: string | null
  /** 8BM intent — what the operator's UI said at write time. */
  replyDeliveryMode?: 'direct' | 'manual' | 'internal_only' | 'unavailable' | null
  /** 8BN/8BP truth signal — what actually happened. */
  deliveryStatus?: string | null
  /** Server-sanitized short error string. Tooltip only. */
  safeError?: string | null
  /** Timestamp of the last pending → ? transition (or send_at). */
  pendingSinceIso?: string | null
  /** Retry count from metadata. Used to dim the button after N. */
  retryCount?: number | null
  /** Render against a dark bubble (AI/human navy). Inverts swatches. */
  onDark?: boolean
  className?: string
  /**
   * Disable the action buttons (e.g. while the parent is
   * already firing a request). The pill stays visible.
   */
  disabled?: boolean
}

interface ToneSwatch {
  light: string
  dark: string
}

const TONES: Record<StatusTone, ToneSwatch> = {
  success: {
    light: 'bg-[#ECFDF5] text-[#047857] border-[#A7F3D0]',
    dark: 'bg-emerald-500/15 text-emerald-200 border-emerald-300/30',
  },
  info: {
    light: 'bg-[#EFF6FF] text-[#1D4ED8] border-[#BFDBFE]',
    dark: 'bg-blue-400/15 text-blue-200 border-blue-300/30',
  },
  warning: {
    light: 'bg-[#FAF7F0] text-[#92763C] border-[#E8DCC4]',
    dark: 'bg-amber-300/15 text-amber-100 border-amber-300/30',
  },
  danger: {
    light: 'bg-[#FEF2F2] text-[#B91C1C] border-[#FECACA]',
    dark: 'bg-red-400/20 text-red-200 border-red-300/30',
  },
  neutral: {
    light: 'bg-[#F1F5F9] text-[#475569] border-[#E2E8F0]',
    dark: 'bg-white/10 text-white/80 border-white/15',
  },
}

function iconForStatus(status: EmailDeliveryStatus) {
  switch (status) {
    case 'pending':
      return Clock
    case 'accepted':
    case 'sent':
      return Mail
    case 'delivered':
      return CheckCircle2
    case 'bounced':
    case 'failed':
      return AlertTriangle
    case 'complained':
      return Ban
    case 'skipped':
      return Inbox
    case 'manual_fallback':
      return Hand
    default:
      return Inbox
  }
}

function pendingSinceMs(iso: string | null | undefined): number | null {
  if (!iso) return null
  const t = Date.parse(iso)
  return Number.isFinite(t) ? t : null
}

const MAX_RETRIES = 5

export default function DeliveryStatusPill(props: DeliveryPillProps) {
  const {
    messageId,
    replyMethod,
    replyDeliveryMode,
    deliveryStatus,
    safeError,
    pendingSinceIso,
    retryCount,
    onDark,
    className,
    disabled,
  } = props

  const [acting, setActing] = useState<null | 'retry' | 'fallback'>(null)
  const [localError, setLocalError] = useState<string | null>(null)

  // Decide whether to render at all. Rules:
  //   - If we have a delivery_status, render based on it.
  //   - Else if reply_delivery_mode hints at a manual or
  //     internal-only path, show a contextual pill.
  //   - Else render nothing (legacy / non-email rows).
  const hasDeliveryStatus = !!deliveryStatus
  const hasManualHint =
    replyDeliveryMode === 'manual' ||
    replyDeliveryMode === 'unavailable' ||
    replyDeliveryMode === 'internal_only'
  if (!hasDeliveryStatus && !hasManualHint) return null

  // Resolve canonical status. When no delivery_status is set
  // but we know the mode, project the mode onto the status
  // model so we can reuse the dictionary.
  let canonical: EmailDeliveryStatus
  if (hasDeliveryStatus) {
    canonical = normalizeEmailDeliveryStatus(deliveryStatus)
  } else if (replyDeliveryMode === 'manual') {
    return (
      <ManualReplyChip
        label="Manual reply required"
        title="Copy this response into the source channel to deliver."
        onDark={onDark}
        className={className}
      />
    )
  } else if (replyDeliveryMode === 'unavailable') {
    return (
      <ManualReplyChip
        label="No delivery path"
        title="No working delivery path for this channel."
        onDark={onDark}
        tone="danger"
        className={className}
      />
    )
  } else {
    canonical = 'skipped'
  }

  const display = getEmailDeliveryDisplay(canonical)
  const tone = TONES[display.tone]
  const Icon = iconForStatus(canonical)
  const isEmail = replyMethod === 'email'

  // Pending stale-escalation. After 5 minutes the spinner
  // becomes "Status delayed".
  const stale =
    canonical === 'pending' &&
    isStalePending(canonical, pendingSinceMs(pendingSinceIso))
  const effectiveLabel = stale ? 'Status delayed' : display.label
  const effectiveHelper = stale
    ? `Email provider has not returned a status yet (over ${Math.round(
        STALE_PENDING_AFTER_MS / 60_000
      )} min). You may retry.`
    : safeError ?? display.helper

  const showRetry =
    !!messageId &&
    isEmail &&
    !disabled &&
    (display.canRetry || stale) &&
    (retryCount ?? 0) < MAX_RETRIES &&
    canonical !== 'complained'
  const showFallback =
    !!messageId && isEmail && !disabled && display.canMarkManual

  async function onRetry() {
    if (!messageId) return
    setLocalError(null)
    setActing('retry')
    try {
      const res = await fetch(
        `/api/messages/${encodeURIComponent(messageId)}/retry-email`,
        { method: 'POST' }
      )
      const json = await res.json().catch(() => null)
      if (!res.ok || (json && json.ok === false)) {
        // Surface a short safe error; the realtime layer will
        // update metadata once the patch lands.
        setLocalError(
          (json?.safe_error as string) ||
            (json?.error as string) ||
            'Retry failed.'
        )
      }
      // Success path: realtime postgres_changes pushes the
      // updated metadata into the thread; no local state to
      // mutate here.
    } catch {
      setLocalError('Retry failed.')
    } finally {
      setActing(null)
    }
  }

  async function onMarkFallback() {
    if (!messageId) return
    setLocalError(null)
    setActing('fallback')
    try {
      const res = await fetch(
        `/api/messages/${encodeURIComponent(messageId)}/mark-fallback`,
        { method: 'POST' }
      )
      const json = await res.json().catch(() => null)
      if (!res.ok || (json && json.ok === false)) {
        setLocalError(
          (json?.error as string) || 'Could not mark as manual fallback.'
        )
      }
    } catch {
      setLocalError('Could not mark as manual fallback.')
    } finally {
      setActing(null)
    }
  }

  return (
    <span className={cn('inline-flex flex-wrap items-center gap-1.5', className)}>
      <span
        title={effectiveHelper}
        className={cn(
          'inline-flex items-center gap-1 rounded-full border px-1.5 py-[1px] text-[10px] font-medium',
          onDark ? tone.dark : tone.light
        )}
      >
        {acting === 'retry' ? (
          <Loader2 className="w-2.5 h-2.5 animate-spin" />
        ) : (
          <Icon className="w-2.5 h-2.5" />
        )}
        {acting === 'retry' ? 'Retrying…' : effectiveLabel}
      </span>

      {showRetry && (
        <button
          type="button"
          onClick={onRetry}
          disabled={!!acting}
          title="Retry email delivery"
          aria-label="Retry email delivery"
          className={cn(
            'inline-flex items-center gap-0.5 rounded-full border px-1.5 py-[1px] text-[10px] font-semibold transition-colors',
            onDark
              ? 'border-white/20 text-white/80 hover:bg-white/10'
              : 'border-[#E2E8F0] text-[#1D4ED8] hover:bg-[#EFF6FF] hover:border-[#BFDBFE]',
            !!acting && 'opacity-60 cursor-wait'
          )}
        >
          <RotateCcw className="w-2.5 h-2.5" />
          Retry
        </button>
      )}

      {showFallback && (
        <button
          type="button"
          onClick={onMarkFallback}
          disabled={!!acting}
          title="Mark this reply as handled outside VenueRise"
          aria-label="Mark handled manually"
          className={cn(
            'inline-flex items-center gap-0.5 rounded-full border px-1.5 py-[1px] text-[10px] font-semibold transition-colors',
            onDark
              ? 'border-white/20 text-white/80 hover:bg-white/10'
              : 'border-[#E2E8F0] text-[#475569] hover:bg-[#F8FAFC] hover:border-[#CBD5E1]',
            !!acting && 'opacity-60 cursor-wait'
          )}
        >
          {acting === 'fallback' ? (
            <Loader2 className="w-2.5 h-2.5 animate-spin" />
          ) : (
            <Hand className="w-2.5 h-2.5" />
          )}
          Mark handled manually
        </button>
      )}

      {localError && (
        <span
          className={cn(
            'text-[10px]',
            onDark ? 'text-red-200' : 'text-[#B91C1C]'
          )}
        >
          {localError}
        </span>
      )}

      {(retryCount ?? 0) > 0 && (
        <span
          className={cn(
            'text-[9.5px]',
            onDark ? 'text-white/60' : 'text-[#94A3B8]'
          )}
          title={`Retry attempts: ${retryCount}`}
        >
          retry {retryCount}
        </span>
      )}
    </span>
  )
}

function ManualReplyChip(props: {
  label: string
  title: string
  onDark?: boolean
  tone?: StatusTone
  className?: string
}) {
  const tone = TONES[props.tone ?? 'warning']
  return (
    <span
      title={props.title}
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-1.5 py-[1px] text-[10px] font-medium',
        props.onDark ? tone.dark : tone.light,
        props.className
      )}
    >
      <Hand className="w-2.5 h-2.5" />
      {props.label}
    </span>
  )
}
