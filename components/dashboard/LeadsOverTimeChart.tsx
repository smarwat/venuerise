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
  if (data.length === 0) {
    return <div className="h-48 flex items-center justify-center text-sm text-[#94A3B8]">No data yet</div>
  }
  return (
    <ResponsiveContainer width="100%" height={220}>
      <AreaChart data={data} margin={{ top: 5, right: 10, left: -20, bottom: 0 }}>
        <defs>
          <linearGradient id="blueGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%"  stopColor="#1D4ED8" stopOpacity={0.25} />
            <stop offset="95%" stopColor="#1D4ED8" stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" vertical={false} />
        <XAxis dataKey="date" tick={{ fill: '#94A3B8', fontSize: 10 }} axisLine={false} tickLine={false} />
        <YAxis tick={{ fill: '#94A3B8', fontSize: 10 }} axisLine={false} tickLine={false} allowDecimals={false} />
        <Tooltip content={<CustomTooltip />} cursor={{ stroke: '#E2E8F0' }} />
        <Area
          type="monotone"
          dataKey="leads"
          stroke="#1D4ED8"
          strokeWidth={2.5}
          fill="url(#blueGrad)"
          dot={false}
          activeDot={{ r: 5, fill: '#1D4ED8', stroke: '#FFFFFF', strokeWidth: 3 }}
        />
      </AreaChart>
    </ResponsiveContainer>
  )
}
