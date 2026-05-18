import Link from 'next/link'
import { AlertTriangle, ArrowRight } from 'lucide-react'

/**
 * Phase 8G — soft-amber banner on /dashboard/tours.
 *
 * Renders ONLY when the venue's subscription has been auto-paused by
 * the Phase 8F cron AND not yet marked recovered (no `tours_resumed_at`
 * stamp). The page-level fetch in `app/(dashboard)/dashboard/tours/page.tsx`
 * decides whether to render us — this component is a pure presentation
 * layer.
 *
 * Copy is deliberately neutral about WHY billing went past due (avoid
 * implying user error) and explicit about WHAT did + did NOT happen:
 *   - Future scheduled/confirmed tours were cancelled by the system.
 *   - Already-cancelled tours stay cancelled — we never resurrect them
 *     automatically (operator escape hatch only, see DEMO-RUNBOOK §11).
 *
 * The CTA points to the existing /dashboard/settings/billing page where
 * operators can launch the Stripe Customer Portal to update payment
 * method and clear the past_due status.
 */

interface TourPausedBannerProps {
  pausedAt: string
  pausedCount: number | null
}

function formatPausedDate(iso: string): string {
  try {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return iso
    // Locale-free format so server + client agree on rendering.
    return d.toUTCString().replace(/ \d{2}:\d{2}:\d{2} GMT$/, '')
  } catch {
    return iso
  }
}

export default function TourPausedBanner({
  pausedAt,
  pausedCount,
}: TourPausedBannerProps) {
  const dateStr = formatPausedDate(pausedAt)
  const countStr =
    typeof pausedCount === 'number' && pausedCount > 0
      ? `${pausedCount} tour${pausedCount === 1 ? '' : 's'} were cancelled.`
      : null

  return (
    <div className="mb-4 rounded-2xl border border-[#FDE68A] bg-[#FFFBEB] px-5 py-4 flex items-start gap-3 shadow-card">
      <div className="w-9 h-9 rounded-xl bg-[#FEF3C7] border border-[#FDE68A] flex items-center justify-center shrink-0">
        <AlertTriangle className="w-4 h-4 text-[#B45309]" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-[13px] font-semibold text-[#92400E] mb-0.5">
          Tour scheduling was paused on {dateStr}
        </p>
        <p className="text-[12px] text-[#92400E]/85">
          Billing for this venue became past due, so future tours were
          automatically cancelled.
          {countStr ? ` ${countStr}` : ''}{' '}
          Already-cancelled tours are not restored automatically — update
          your payment method to resume scheduling new tours.
        </p>
      </div>
      <Link
        href="/dashboard/settings/billing"
        className="shrink-0 inline-flex items-center gap-1 rounded-lg bg-[#0F172A] text-white text-[12px] font-semibold px-3.5 py-2 hover:bg-[#1E293B] transition-colors shadow-[0_2px_8px_rgba(15,23,42,0.18)]"
      >
        Manage billing
        <ArrowRight className="w-3.5 h-3.5" />
      </Link>
    </div>
  )
}
