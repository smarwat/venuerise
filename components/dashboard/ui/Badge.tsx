import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

const badgeVariants = cva(
  'inline-flex items-center rounded-md px-2 py-0.5 text-[11px] font-semibold transition-colors',
  {
    variants: {
      variant: {
        default:              'bg-[#F1F5F9] text-[#475569] border border-[#E2E8F0]',
        navy:                 'bg-[#F1F5F9] text-[#0F172A] border border-[#E2E8F0]',
        score_high:           'bg-[#ECFDF5] text-[#047857] border border-[#A7F3D0]',
        score_mid:            'bg-[#EFF6FF] text-[#1D4ED8] border border-[#BFDBFE]',
        score_low:            'bg-[#FFFBEB] text-[#B45309] border border-[#FCD9A1]',
        score_poor:           'bg-[#FEF2F2] text-[#B91C1C] border border-[#FECACA]',
        urgent:               'bg-[#FEF2F2] text-[#B91C1C] border border-[#FCA5A5] animate-pulse',
        stage_new:            'bg-[#F1F5F9] text-[#0F172A] border border-[#E2E8F0]',
        stage_qualified:      'bg-[#F1F5F9] text-[#1E293B] border border-[#CBD5E1]',
        stage_tour_scheduled: 'bg-[#EFF6FF] text-[#1D4ED8] border border-[#BFDBFE]',
        stage_tour_completed: 'bg-[#ECFDF5] text-[#047857] border border-[#A7F3D0]',
        stage_negotiation:    'bg-[#FFFBEB] text-[#B45309] border border-[#FCD9A1]',
        stage_booked:         'bg-[#ECFDF5] text-[#047857] border border-[#86EFAC]',
        stage_lost:           'bg-[#F1F5F9] text-[#64748B] border border-[#E2E8F0]',
        blue:                 'bg-[#EFF6FF] text-[#1D4ED8] border border-[#BFDBFE]',
        green:                'bg-[#ECFDF5] text-[#047857] border border-[#A7F3D0]',
        amber:                'bg-[#FFFBEB] text-[#B45309] border border-[#FCD9A1]',
        red:                  'bg-[#FEF2F2] text-[#B91C1C] border border-[#FECACA]',
        // Legacy alias — 'purple' usages remap to navy for back-compat
        purple:               'bg-[#F1F5F9] text-[#0F172A] border border-[#E2E8F0]',
      },
    },
    defaultVariants: { variant: 'default' },
  }
)

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />
}

export { Badge, badgeVariants }
