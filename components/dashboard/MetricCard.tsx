import type { LucideIcon } from 'lucide-react'
import { ArrowUpRight, ArrowDownRight } from 'lucide-react'
import { cn } from '@/lib/utils'

interface MetricCardProps {
  title: string
  value: string | number
  delta?: string
  positive?: boolean
  icon: LucideIcon
  accent?: 'navy' | 'blue' | 'green' | 'amber'
}

const accentMap: Record<string, { bg: string; text: string }> = {
  navy:  { bg: 'bg-[#F1F5F9]', text: 'text-[#0F172A]' },
  blue:  { bg: 'bg-[#EFF6FF]', text: 'text-[#1D4ED8]' },
  green: { bg: 'bg-[#ECFDF5]', text: 'text-[#047857]' },
  amber: { bg: 'bg-[#FFFBEB]', text: 'text-[#B45309]' },
}

export default function MetricCard({ title, value, delta, positive = true, icon: Icon, accent = 'navy' }: MetricCardProps) {
  const a = accentMap[accent] ?? accentMap.navy
  return (
    <div className="bg-white border border-[#E2E8F0] rounded-[20px] p-5 shadow-card hover:shadow-card-hover transition-all duration-200">
      <div className="flex items-start justify-between mb-3">
        <div className={cn('w-9 h-9 rounded-xl flex items-center justify-center', a.bg)}>
          <Icon className={cn('w-4 h-4', a.text)} />
        </div>
        {delta && (
          <span className={cn(
            'flex items-center gap-0.5 text-[11px] font-semibold rounded-full px-2 py-0.5',
            positive ? 'bg-[#ECFDF5] text-[#047857]' : 'bg-[#FEF2F2] text-[#B91C1C]'
          )}>
            {positive ? <ArrowUpRight className="w-3 h-3" /> : <ArrowDownRight className="w-3 h-3" />}
            {delta}
          </span>
        )}
      </div>
      <div className="text-[28px] font-semibold text-[#0F172A] leading-none tracking-[-0.02em] mb-1.5">
        {value}
      </div>
      <div className="text-[12px] text-[#64748B]">{title}</div>
    </div>
  )
}
