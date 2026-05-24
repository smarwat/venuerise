'use client'

import { Mail, Clock, AlertTriangle, Inbox, Hand, CheckCircle2 } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * Phase 8BN — Delivery status pill for operator (`role: 'human'`)
 * messages.
 *
 * ── HONESTY CONTRACT ──────────────────────────────────────────────────────
 * The pill renders ONLY when message metadata carries enough
 * signal to make a truthful claim. Specifically:
 *
 *   - `delivery_status: 'sent'`     → "Sent via Email" (provider accepted).
 *   - `delivery_status: 'pending'`  → "Sending…" (mid-flight).
 *   - `delivery_status: 'failed'`   → "Email failed" + safe reason on hover.
 *   - `delivery_status: 'skipped'`  → "Saved in VenueRise only"
 *     (kill-switch off / suppression / no delivery attempted).
 *   - `reply_delivery_mode: 'manual'` (no delivery_status) → "Manual reply
 *     required" — operator must copy externally.
 *   - `source: 'manual_channel_reply'` (existing 8BE flag) → "Marked sent
 *     manually" (handled by the bubble metadata row, not here).
 *
 * No pill renders for legacy messages without metadata — historical
 * rows stay visually clean and we don't synthesize a status we
 * can't justify.
 *
 * The pill never shows provider message IDs or raw API errors.
 * `safe_error` is shown only on hover (title attribute) and is
 * already sanitized server-side.
 */

export interface DeliveryPillProps {
  deliveryStatus?: 'pending' | 'sent' | 'failed' | 'skipped' | null
  replyMethod?: string | null
  replyDeliveryMode?: 'direct' | 'manual' | 'internal_only' | 'unavailable' | null
  safeError?: string | null
  /** Render against a dark bubble (AI/human navy). Inverts the swatch. */
  onDark?: boolean
  className?: string
}

interface Spec {
  Icon: typeof Mail
  label: string
  tone: { light: string; dark: string }
  title?: string
}

function buildSpec(props: DeliveryPillProps): Spec | null {
  const { deliveryStatus, replyDeliveryMode, replyMethod, safeError } = props

  // Direct-email outcomes — most informative; render first.
  if (deliveryStatus === 'sent') {
    return {
      Icon: Mail,
      label: 'Sent via Email',
      tone: {
        light: 'bg-[#ECFDF5] text-[#047857] border-[#A7F3D0]',
        dark: 'bg-emerald-500/15 text-emerald-200 border-emerald-300/30',
      },
    }
  }
  if (deliveryStatus === 'pending') {
    return {
      Icon: Clock,
      label: 'Sending…',
      tone: {
        light: 'bg-[#EFF6FF] text-[#1D4ED8] border-[#BFDBFE]',
        dark: 'bg-blue-400/15 text-blue-200 border-blue-300/30',
      },
    }
  }
  if (deliveryStatus === 'failed') {
    return {
      Icon: AlertTriangle,
      label: 'Email failed',
      tone: {
        light: 'bg-[#FEF2F2] text-[#B91C1C] border-[#FECACA]',
        dark: 'bg-red-400/20 text-red-200 border-red-300/30',
      },
      title: safeError ?? 'Delivery failed — check email settings.',
    }
  }
  if (deliveryStatus === 'skipped') {
    return {
      Icon: Inbox,
      label: 'Saved in VenueRise',
      tone: {
        light: 'bg-[#F1F5F9] text-[#475569] border-[#E2E8F0]',
        dark: 'bg-white/10 text-white/80 border-white/15',
      },
      title:
        safeError ??
        (replyMethod === 'email'
          ? 'Email sending is not connected — reply was saved in VenueRise only.'
          : 'Reply saved in VenueRise only.'),
    }
  }

  // No delivery_status — fall back to reply_delivery_mode for
  // manual-channel intent. Avoids cluttering bubbles that never
  // had a chance at direct send.
  if (replyDeliveryMode === 'manual') {
    return {
      Icon: Hand,
      label: 'Manual reply required',
      tone: {
        light: 'bg-[#FAF7F0] text-[#92763C] border-[#E8DCC4]',
        dark: 'bg-amber-300/15 text-amber-100 border-amber-300/30',
      },
      title: 'Copy this response into the source channel to deliver.',
    }
  }
  if (replyDeliveryMode === 'unavailable') {
    return {
      Icon: AlertTriangle,
      label: 'No delivery path',
      tone: {
        light: 'bg-[#FEF2F2] text-[#B91C1C] border-[#FECACA]',
        dark: 'bg-red-400/20 text-red-200 border-red-300/30',
      },
      title: 'No working delivery path for this channel.',
    }
  }
  if (replyDeliveryMode === 'internal_only') {
    return {
      Icon: Inbox,
      label: 'Saved in VenueRise',
      tone: {
        light: 'bg-[#F1F5F9] text-[#475569] border-[#E2E8F0]',
        dark: 'bg-white/10 text-white/80 border-white/15',
      },
    }
  }

  return null
}

export default function DeliveryStatusPill(props: DeliveryPillProps) {
  const spec = buildSpec(props)
  if (!spec) return null
  const { Icon, label, tone, title } = spec
  return (
    <span
      title={title}
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-1.5 py-[1px] text-[10px] font-medium',
        props.onDark ? tone.dark : tone.light,
        props.className
      )}
    >
      <Icon className="w-2.5 h-2.5" />
      {label}
      {props.deliveryStatus === 'sent' && (
        <CheckCircle2 className="w-2.5 h-2.5 opacity-70" />
      )}
    </span>
  )
}
