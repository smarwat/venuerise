'use client'

import {
  Globe,
  Instagram,
  Facebook,
  Megaphone,
  Mail,
  MessageSquare,
  Bookmark,
  Heart,
  Hand,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { CHANNEL_CAPABILITIES } from '@/lib/integrations/channels/capabilities'
import type { ChannelType } from '@/lib/integrations/channels/types'

/**
 * Phase 8BE — small source/channel badge for the inbox.
 *
 * Renders a coloured pill with the channel short label so
 * operators can tell at a glance whether a conversation came
 * from the website widget, Instagram, The Knot, etc.
 *
 * The badge is intentionally low-contrast so legacy messages
 * (no channel metadata) hide gracefully — pass
 * `channelType = null` to render nothing.
 */
interface ChannelSourceBadgeProps {
  channelType: ChannelType | string | null | undefined
  size?: 'sm' | 'md'
  className?: string
}

const ICONS: Record<ChannelType, React.ComponentType<{ className?: string }>> = {
  website: Globe,
  instagram: Instagram,
  facebook: Facebook,
  meta_lead_ads: Megaphone,
  email: Mail,
  sms: MessageSquare,
  the_knot: Bookmark,
  weddingwire: Heart,
  manual: Hand,
}

const TONE: Record<ChannelType, string> = {
  website: 'bg-[#EFF6FF] text-[#1D4ED8] border-[#DBEAFE]',
  instagram: 'bg-[#FDF4FF] text-[#A21CAF] border-[#F5D0FE]',
  facebook: 'bg-[#EFF6FF] text-[#1D4ED8] border-[#DBEAFE]',
  meta_lead_ads: 'bg-[#EEF2FF] text-[#4338CA] border-[#E0E7FF]',
  email: 'bg-[#F8FAFC] text-[#475569] border-[#E2E8F0]',
  sms: 'bg-[#F0FDF4] text-[#15803D] border-[#BBF7D0]',
  the_knot: 'bg-[#FEF2F2] text-[#B91C1C] border-[#FECACA]',
  weddingwire: 'bg-[#FFFBEB] text-[#B45309] border-[#FDE68A]',
  manual: 'bg-[#F1F5F9] text-[#475569] border-[#E2E8F0]',
}

export default function ChannelSourceBadge({
  channelType,
  size = 'sm',
  className,
}: ChannelSourceBadgeProps) {
  if (!channelType) return null
  const typed = channelType as ChannelType
  const caps = (CHANNEL_CAPABILITIES as Record<string, typeof CHANNEL_CAPABILITIES['website']>)[
    typed
  ]
  if (!caps) return null
  const Icon = ICONS[typed] ?? Globe
  const tone = TONE[typed] ?? TONE.manual
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full border font-medium',
        size === 'sm'
          ? 'px-1.5 py-[1px] text-[10px]'
          : 'px-2 py-0.5 text-[11px]',
        tone,
        className
      )}
      title={caps.operatorNote}
    >
      <Icon className={size === 'sm' ? 'w-2.5 h-2.5' : 'w-3 h-3'} />
      {caps.shortLabel}
    </span>
  )
}
