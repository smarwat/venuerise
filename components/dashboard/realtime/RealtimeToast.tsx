'use client'

import { useEffect } from 'react'
import { Sparkles, X } from 'lucide-react'

/**
 * Phase 8B — minimal auto-dismiss toast for realtime nudges
 * ("New lead just landed", etc.). Not a full notification system — just
 * one slot at the bottom-right. Parent owns the visibility state.
 *
 * Auto-dismiss after `autoDismissMs` (default 4s) by calling `onClose`.
 * Hover doesn't pause the timer — toast is informational, not critical.
 */

interface RealtimeToastProps {
  message: string
  onClose: () => void
  /** Default 4000ms. Set to 0 to disable auto-dismiss. */
  autoDismissMs?: number
  /** Optional CTA. Click also closes the toast. */
  action?: {
    label: string
    onClick: () => void
  }
}

export default function RealtimeToast({
  message,
  onClose,
  autoDismissMs = 4000,
  action,
}: RealtimeToastProps) {
  useEffect(() => {
    if (autoDismissMs <= 0) return
    const t = setTimeout(onClose, autoDismissMs)
    return () => clearTimeout(t)
  }, [autoDismissMs, onClose])

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed bottom-6 right-6 z-50 max-w-sm animate-slide-up"
    >
      <div className="flex items-center gap-3 bg-white border border-[#E2E8F0] rounded-2xl shadow-[0_10px_30px_rgba(15,23,42,0.12)] pl-3 pr-2 py-2.5">
        <div className="w-8 h-8 rounded-lg bg-[#EFF6FF] text-[#1D4ED8] flex items-center justify-center shrink-0">
          <Sparkles className="w-4 h-4" />
        </div>
        <div className="text-[13px] text-[#0F172A] flex-1 min-w-0">{message}</div>
        {action && (
          <button
            type="button"
            onClick={() => {
              action.onClick()
              onClose()
            }}
            className="text-[12px] font-medium text-[#1D4ED8] hover:text-[#1E40AF] px-2 py-1 rounded-md hover:bg-[#EFF6FF] transition-colors"
          >
            {action.label}
          </button>
        )}
        <button
          type="button"
          onClick={onClose}
          aria-label="Dismiss"
          className="w-7 h-7 rounded-md flex items-center justify-center text-[#94A3B8] hover:text-[#0F172A] hover:bg-[#F1F5F9] transition-colors"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  )
}
