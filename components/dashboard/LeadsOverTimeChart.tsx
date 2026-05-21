'use client'

import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts'

interface DataPoint { date: string; leads: number }

const CustomTooltip = ({ active, payload, label }: { active?: boolean; payload?: { value: number }[]; label?: string }) => {
  if (active && payload?.length) {
    return (
      <div className="bg-white border border-[#E2E8F0] rounded-xl px-3 py-2 text-xs shadow-[0_10px_25px_rgba(15,23,42,0.15)]">
        <p className="text-[#94A3B8] mb-0.5">{label}</p>
        <p className="text-[#0F172A] font-semibold">{payload[0].value} leads</p>
      </div>
    )
  }
  return null
}

export default function LeadsOverTimeChart({ data }: { data: DataPoint[] }) {
  // Phase 8AK — calmer empty-state copy. The chart sits in a card with a
  // subtitle that already says "Last 30 days", so the empty text doesn't
  // need to repeat the range.
  if (data.length === 0) {
    return (
      <div className="h-48 flex flex-col items-center justify-center text-center px-4 gap-1">
        <p className="text-[13px] font-semibold text-[#0F172A]">Not enough data yet.</p>
        <p className="text-[11.5px] text-[#64748B] max-w-[260px]">
          New lead activity will appear here once inquiries come in.
        </p>
      </div>
    )
  }
  // Phase 8AK — navy primary line + slate #EEF2F7 grid for an enterprise
  // look. The fill is a low-opacity navy → transparent gradient so the
  // area stays a quiet backdrop to the stroke (the prior blue gradient
  // read as a "marketing chart"; this reads as "operator chart").
  return (
    <ResponsiveContainer width="100%" height={220}>
      <AreaChart data={data} margin={{ top: 5, right: 10, left: -20, bottom: 0 }}>
        <defs>
          <linearGradient id="navyGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%"  stopColor="#0F172A" stopOpacity={0.18} />
            <stop offset="95%" stopColor="#0F172A" stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="#EEF2F7" vertical={false} />
        <XAxis dataKey="date" tick={{ fill: '#94A3B8', fontSize: 10 }} axisLine={false} tickLine={false} />
        <YAxis tick={{ fill: '#94A3B8', fontSize: 10 }} axisLine={false} tickLine={false} allowDecimals={false} />
        <Tooltip content={<CustomTooltip />} cursor={{ stroke: '#EEF2F7' }} />
        <Area
          type="monotone"
          dataKey="leads"
          stroke="#0F172A"
          strokeWidth={2.25}
          fill="url(#navyGrad)"
          dot={false}
          activeDot={{ r: 5, fill: '#0F172A', stroke: '#FFFFFF', strokeWidth: 3 }}
        />
      </AreaChart>
    </ResponsiveContainer>
  )
}
