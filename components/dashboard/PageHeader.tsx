import type { ReactNode } from 'react'

interface PageHeaderProps {
  title: string
  subtitle?: string
  eyebrow?: string
  actions?: ReactNode
}

/**
 * Phase 8AG — consistent page header used across every dashboard
 * surface. Renders an optional uppercase eyebrow above the title so
 * pages can pick up the same editorial cadence as the Overview
 * header without each page reinventing the layout.
 *
 * `title` defaults to the existing semibold slate; `subtitle` is the
 * muted line beneath. `actions` is the right-aligned button cluster.
 */
export default function PageHeader({ title, subtitle, eyebrow, actions }: PageHeaderProps) {
  return (
    <div className="flex items-end justify-between gap-4 mb-6 flex-wrap">
      <div className="min-w-0">
        {eyebrow && (
          <div className="text-[10.5px] uppercase tracking-[0.14em] text-[#64748B] font-semibold mb-1.5">
            {eyebrow}
          </div>
        )}
        <h1 className="text-[24px] sm:text-[26px] font-semibold text-[#0F172A] tracking-[-0.02em] leading-tight">
          {title}
        </h1>
        {subtitle && (
          <p className="text-[13px] text-[#475569] mt-1.5">{subtitle}</p>
        )}
      </div>
      {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
    </div>
  )
}
