import { Eye } from 'lucide-react'

/**
 * Phase 9J — Demo mode banner.
 *
 * Renders inline below the dashboard topbar when the current
 * venue's `demo_mode_enabled` is true. Server-side render via
 * the dashboard layout — no client fetch.
 *
 * Visual marker only: the banner does NOT change behavior or
 * anonymize any data. Operators screen-sharing during a sales
 * demo flip demo mode on so the audience knows they're looking
 * at a marked surface.
 */

interface DemoModeBannerProps {
  enabled: boolean
  label: string | null
}

export default function DemoModeBanner({ enabled, label }: DemoModeBannerProps) {
  if (!enabled) return null
  return (
    <div
      role="status"
      aria-live="polite"
      className="border-y border-amber-300 bg-amber-50 px-4 py-2 text-xs font-medium text-amber-900"
    >
      <div className="mx-auto flex max-w-7xl items-center gap-2">
        <Eye className="h-3.5 w-3.5 flex-shrink-0" aria-hidden />
        <span className="uppercase tracking-wide">Demo mode</span>
        {label && (
          <>
            <span className="text-amber-700" aria-hidden>
              —
            </span>
            <span className="font-normal text-amber-900/80">{label}</span>
          </>
        )}
      </div>
    </div>
  )
}
