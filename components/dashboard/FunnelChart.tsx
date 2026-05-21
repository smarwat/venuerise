'use client'

interface FunnelStage {
  stage: string
  label: string
  count: number
  color: string
}

export default function FunnelChart({ stages }: { stages: FunnelStage[] }) {
  const maxCount = Math.max(...stages.map((s) => s.count), 1)

  // Phase 8AK — empty-state copy. A funnel of all zeros renders as a
  // wall of "0" rows; replace with a clear "no data" panel that matches
  // the LeadsOverTimeChart empty state's voice.
  const totalCount = stages.reduce((s, st) => s + st.count, 0)
  if (totalCount === 0) {
    return (
      <div className="h-48 flex flex-col items-center justify-center text-center px-4 gap-1">
        <p className="text-[13px] font-semibold text-[#0F172A]">Not enough data yet.</p>
        <p className="text-[11.5px] text-[#64748B] max-w-[260px]">
          New lead activity will appear here once inquiries come in.
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {stages.map((stage, i) => {
        const pct = (stage.count / maxCount) * 100
        const dropOff = i > 0 && stages[i - 1].count > 0
          ? Math.round(((stages[i - 1].count - stage.count) / stages[i - 1].count) * 100)
          : 0

        return (
          <div key={stage.stage}>
            <div className="flex justify-between text-[12px] mb-1.5">
              <span className="text-[#475569]">{stage.label}</span>
              <span className="flex items-center gap-2">
                {i > 0 && dropOff > 0 && (
                  <span className="text-[#DC2626] text-[11px]">-{dropOff}%</span>
                )}
                <span className="text-[#0F172A] font-semibold">{stage.count}</span>
              </span>
            </div>
            <div className="h-7 bg-[#F1F5F9] rounded-lg overflow-hidden">
              <div
                className="h-full rounded-lg transition-all duration-700"
                style={{
                  width: `${Math.max(pct, 4)}%`,
                  background: `linear-gradient(90deg, ${stage.color}E6, ${stage.color})`,
                }}
              />
            </div>
          </div>
        )
      })}
    </div>
  )
}
