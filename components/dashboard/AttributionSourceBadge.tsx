'use client'

import { cn } from '@/lib/utils'
import type { SourceLabel } from '@/lib/enterprise/attribution/types'

/**
 * Phase 8BH — compact attribution badge used inside KanbanCard,
 * ConversationList, and Revenue OS rows. Pure display. Hides
 * when the label is `Unknown` so unbadged legacy leads stay
 * visually clean.
 */

interface AttributionSourceBadgeProps {
  sourceLabel: SourceLabel | null | undefined
  size?: 'sm' | 'md'
  className?: string
}

const TONE: Record<SourceLabel, string> = {
  'Google Ads':    'bg-[#EFF6FF] text-[#1D4ED8] border-[#DBEAFE]',
  'Meta Ads':      'bg-[#EEF2FF] text-[#4338CA] border-[#E0E7FF]',
  'Instagram':     'bg-[#FDF4FF] text-[#A21CAF] border-[#F5D0FE]',
  'Facebook':      'bg-[#EFF6FF] text-[#1D4ED8] border-[#DBEAFE]',
  'WeddingWire':   'bg-[#FFFBEB] text-[#B45309] border-[#FDE68A]',
  'The Knot':      'bg-[#FEF2F2] text-[#B91C1C] border-[#FECACA]',
  'Bing Ads':      'bg-[#ECFDF5] text-[#047857] border-[#A7F3D0]',
  'TikTok Ads':    'bg-[#F0FDFA] text-[#0F766E] border-[#99F6E4]',
  'Website':       'bg-[#F1F5F9] text-[#475569] border-[#E2E8F0]',
  'Email':         'bg-[#F8FAFC] text-[#475569] border-[#E2E8F0]',
  'Referral':      'bg-[#FDF2F8] text-[#9D174D] border-[#FBCFE8]',
  'Direct':        'bg-[#F1F5F9] text-[#475569] border-[#E2E8F0]',
  'Manual entry':  'bg-[#F1F5F9] text-[#475569] border-[#E2E8F0]',
  'Unknown':       'bg-[#F1F5F9] text-[#94A3B8] border-[#E2E8F0]',
}

export default function AttributionSourceBadge({
  sourceLabel,
  size = 'sm',
  className,
}: AttributionSourceBadgeProps) {
  if (!sourceLabel || sourceLabel === 'Unknown') return null
  const tone = TONE[sourceLabel] ?? TONE.Website
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border font-medium',
        size === 'sm'
          ? 'px-1.5 py-[1px] text-[10px]'
          : 'px-2 py-0.5 text-[11px]',
        tone,
        className
      )}
      title={`Attribution: ${sourceLabel}`}
    >
      {sourceLabel}
    </span>
  )
}
