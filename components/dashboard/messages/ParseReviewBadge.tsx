'use client'

import { AlertCircle } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * Phase 8BG — small badge rendered next to a message bubble or
 * conversation row when the deterministic forwarding parser
 * flagged it for operator review (parse_confidence < 75).
 *
 * Pure display — no fetches, no side effects. Renders nothing
 * when `needsReview` is false so it can be sprinkled into any
 * row without an outer wrapper check.
 */

interface ParseReviewBadgeProps {
  needsReview: boolean | null | undefined
  confidence?: number | null
  reasons?: ReadonlyArray<string> | null
  size?: 'sm' | 'md'
  className?: string
  /** Render only the dot, e.g. for ConversationList rows. */
  dotOnly?: boolean
}

export default function ParseReviewBadge({
  needsReview,
  confidence,
  reasons,
  size = 'sm',
  className,
  dotOnly,
}: ParseReviewBadgeProps) {
  if (!needsReview) return null
  const tooltip = [
    confidence != null ? `Parse confidence: ${confidence}/100` : null,
    reasons && reasons.length > 0
      ? `Signals: ${reasons.join(', ')}`
      : null,
  ]
    .filter(Boolean)
    .join(' · ')

  if (dotOnly) {
    return (
      <span
        title={tooltip || 'Parse review recommended'}
        aria-label="Parse review recommended"
        className={cn(
          'inline-block w-2 h-2 rounded-full bg-[#D97706] ring-2 ring-white',
          className
        )}
      />
    )
  }

  return (
    <span
      title={tooltip || 'Parse review recommended'}
      className={cn(
        'inline-flex items-center gap-1 rounded-full border font-medium',
        'border-[#FDE68A] bg-[#FFFBEB] text-[#B45309]',
        size === 'sm'
          ? 'px-1.5 py-[1px] text-[10px]'
          : 'px-2 py-0.5 text-[11px]',
        className
      )}
    >
      <AlertCircle className={size === 'sm' ? 'w-2.5 h-2.5' : 'w-3 h-3'} />
      Needs parse review
    </span>
  )
}
