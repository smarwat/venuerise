import type { LucideIcon } from 'lucide-react'
import { ArrowUpRight, ArrowDownRight } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * Phase 8AG — premium KPI card.
 *
 * Two modes:
 *   - Compact (default): icon tile + value + delta pill — same shape
 *     used across the app since Phase 7.
 *   - Sparkline ("eyebrow"): drops the icon tile and renders an
 *     uppercase eyebrow label, a large number, a tag line, and a
 *     trailing sparkline. Matches the reference Overview layout.
 *
 * Mode picks itself: pass `spark` for the new look, omit it for the
 * legacy compact look. All call sites stay source-compatible.
 */

interface MetricCardProps {
  title: string
  value: string | number
  delta?: string
  positive?: boolean
  icon?: LucideIcon
  accent?: 'navy' | 'blue' | 'green' | 'amber'
  /** Phase 8AG — optional sparkline points. When present, the card
   *  renders the editorial eyebrow layout. */
  spark?: number[]
  /** Optional micro-tag rendered below the value (e.g. "forecast 30d"). */
  tag?: string
  /** Optional sparkline stroke color. Defaults to navy `--text`. */
  sparkColor?: string
}

const accentMap: Record<string, { bg: string; text: string }> = {
  navy:  { bg: 'bg-[#F1F5F9]', text: 'text-[#0F172A]' },
  blue:  { bg: 'bg-[#EFF6FF]', text: 'text-[#1D4ED8]' },
  green: { bg: 'bg-[#ECFDF5]', text: 'text-[#047857]' },
  amber: { bg: 'bg-[#FFFBEB]', text: 'text-[#B45309]' },
}

export default function MetricCard({
  title,
  value,
  delta,
  positive = true,
  icon: Icon,
  accent = 'navy',
  spark,
  tag,
  sparkColor,
}: MetricCardProps) {
  const a = accentMap[accent] ?? accentMap.navy
  // Sparkline path — only computed when data is present, so the
  // simple icon-tile mode pays no rendering cost.
  const sparklineNode = spark && spark.length > 1 ? (
    <Sparkline data={spark} color={sparkColor ?? '#0F172A'} />
  ) : null

  // Editorial mode — when caller provided a sparkline. Mirrors the
  // reference KPI strip exactly: eyebrow label top-left, delta pill
  // top-right, large value, then tag + sparkline footer row.
  if (sparklineNode) {
    return (
      <div className="bg-white border border-[#E6E8EF] rounded-[18px] p-5 shadow-card hover:shadow-card-hover transition-all duration-200 flex flex-col gap-3 min-w-0">
        <div className="flex items-center justify-between">
          <div className="text-[10.5px] uppercase tracking-[0.14em] text-[#64748B] font-semibold">
            {title}
          </div>
          {delta && <DeltaPill positive={positive}>{delta}</DeltaPill>}
        </div>
        <div className="text-[32px] sm:text-[36px] font-semibold text-[#0F172A] leading-none tracking-[-0.025em] tabular-nums">
          {value}
        </div>
        <div className="flex items-end justify-between gap-3">
          <span className="font-mono text-[10.5px] text-[#94A3B8] uppercase tracking-[0.04em] truncate">
            {tag ?? ''}
          </span>
          {sparklineNode}
        </div>
      </div>
    )
  }

  // Legacy compact mode — preserved exactly for any call site that
  // hasn't migrated to the sparkline variant.
  return (
    <div className="bg-white border border-[#E6E8EF] rounded-[18px] p-5 shadow-card hover:shadow-card-hover transition-all duration-200">
      <div className="flex items-start justify-between mb-3">
        {Icon && (
          <div className={cn('w-9 h-9 rounded-xl flex items-center justify-center', a.bg)}>
            <Icon className={cn('w-4 h-4', a.text)} />
          </div>
        )}
        {delta && <DeltaPill positive={positive}>{delta}</DeltaPill>}
      </div>
      <div className="text-[28px] font-semibold text-[#0F172A] leading-none tracking-[-0.02em] mb-1.5 tabular-nums">
        {value}
      </div>
      <div className="text-[12px] text-[#64748B]">{title}</div>
    </div>
  )
}

function DeltaPill({
  children,
  positive,
}: {
  children: React.ReactNode
  positive: boolean
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-0.5 text-[11px] font-semibold rounded-full px-2 py-0.5',
        positive ? 'bg-[#ECFDF5] text-[#047857]' : 'bg-[#FEF2F2] text-[#B91C1C]'
      )}
    >
      {positive ? <ArrowUpRight className="w-3 h-3" /> : <ArrowDownRight className="w-3 h-3" />}
      {children}
    </span>
  )
}

/**
 * Phase 8AG — pure-SVG sparkline. No chart library; ports the
 * reference's editorial polyline + soft gradient fill + dot at the
 * latest point. Width is fixed (88x24) so the card layout doesn't
 * shift between values.
 */
function Sparkline({
  data,
  color,
  width = 88,
  height = 24,
}: {
  data: number[]
  color: string
  width?: number
  height?: number
}) {
  if (data.length < 2) return null
  const min = Math.min(...data)
  const max = Math.max(...data)
  const range = max - min || 1
  const step = width / (data.length - 1)
  const points = data.map((v, i) => {
    const y = (height - 2) - ((v - min) / range) * (height - 4)
    return [i * step, y] as const
  })
  const pathLine = points
    .map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`)
    .join(' ')
  const pathArea =
    pathLine +
    ` L${(width).toFixed(1)},${height} L0,${height} Z`
  const last = points[points.length - 1]
  // Stable gradient id per data signature so SSR + client output match
  // without using Math.random.
  const seed = data.length.toString(16) + Math.round(data[0] * 7).toString(16)
  const gradId = `sg-${seed}`
  return (
    <svg width={width} height={height} aria-hidden="true">
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.18" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={pathArea} fill={`url(#${gradId})`} />
      <path
        d={pathLine}
        fill="none"
        stroke={color}
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx={last[0]} cy={last[1]} r={2.25} fill={color} />
    </svg>
  )
}
