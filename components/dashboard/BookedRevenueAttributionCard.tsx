import Link from 'next/link'
import { ArrowUpRight, TrendingUp } from 'lucide-react'
import AttributionSourceBadge from './AttributionSourceBadge'
import {
  formatBookedValueShort,
  type AttributionRevenueSummary,
} from '@/lib/enterprise/attribution/revenue'

/**
 * Phase 8BI — Booked revenue attribution card.
 *
 * Pure presentational shell. Caller (dashboard page) does the
 * DB read + `buildAttributionRevenueSummary`. Shows the top 5
 * sources by estimated booked value with leads / tours / booked
 * / lead → booked rate. Empty state is honest — most venues will
 * have zero booked rows on day 1.
 */

interface Props {
  summary: AttributionRevenueSummary
}

function formatRate(rate: number | null): string {
  if (rate === null) return '—'
  if (rate === 0) return '0%'
  if (rate < 0.01) return '<1%'
  return `${Math.round(rate * 100)}%`
}

export default function BookedRevenueAttributionCard({ summary }: Props) {
  const top = summary.rows.slice(0, 5)
  const empty = summary.totals.bookedCount === 0

  return (
    <section className="bg-white border border-[#E2E8F0] rounded-2xl shadow-card p-6 space-y-5">
      <header className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-xl bg-[#ECFDF5] text-[#047857] flex items-center justify-center">
            <TrendingUp className="w-4 h-4" />
          </div>
          <div>
            <h2 className="text-[15px] font-semibold text-[#0F172A]">
              Booked revenue by source
            </h2>
            <p className="text-[11.5px] text-[#475569] mt-0.5">
              Which channels are turning into booked weddings — leads,
              tours, and estimated booked value by source.
            </p>
          </div>
        </div>
        {!empty && (
          <div className="text-right">
            <p className="text-[10.5px] uppercase tracking-wider text-[#94A3B8] font-semibold">
              Total booked
            </p>
            <p className="text-[15px] font-semibold text-[#0F172A] tabular-nums">
              {summary.totals.bookedCount}
            </p>
            {summary.totals.estimatedBookedValue > 0 && (
              <p className="text-[10.5px] text-[#047857] font-medium tabular-nums">
                ~{formatBookedValueShort(summary.totals.estimatedBookedValue)}
              </p>
            )}
          </div>
        )}
      </header>

      {empty && (
        <div className="rounded-xl border border-dashed border-[#E2E8F0] bg-[#F8FAFC] p-6 text-center">
          <p className="text-[12.5px] text-[#475569]">
            Booked revenue attribution will appear once attributed leads
            reach <span className="font-semibold text-[#0F172A]">booked</span>.
          </p>
          <p className="text-[11px] text-[#94A3B8] mt-1.5">
            New inquiries land with attribution; this card lights up as
            soon as one of them converts.
          </p>
        </div>
      )}

      {!empty && (
        <div className="overflow-x-auto -mx-1">
          <table className="w-full text-[12.5px]">
            <thead>
              <tr className="text-left text-[10.5px] uppercase tracking-wider text-[#94A3B8] border-b border-[#F1F5F9]">
                <th className="font-semibold py-2 pl-1">Source</th>
                <th className="font-semibold py-2 text-right">Leads</th>
                <th className="font-semibold py-2 text-right">Tours</th>
                <th className="font-semibold py-2 text-right">Booked</th>
                <th className="font-semibold py-2 text-right">Est. booked</th>
                <th className="font-semibold py-2 text-right">L → Booked</th>
                <th className="font-semibold py-2 text-right pr-1">CTA</th>
              </tr>
            </thead>
            <tbody>
              {top.map((r) => (
                <tr
                  key={r.sourceLabel}
                  className="border-b border-[#F1F5F9] last:border-b-0"
                >
                  <td className="py-2 pl-1">
                    {r.sourceLabel === 'Unknown' ? (
                      <span className="text-[#94A3B8]">Unattributed</span>
                    ) : (
                      <AttributionSourceBadge
                        sourceLabel={r.sourceLabel}
                        size="md"
                      />
                    )}
                  </td>
                  <td className="py-2 text-right text-[#475569] tabular-nums">
                    {r.leadCount}
                  </td>
                  <td className="py-2 text-right text-[#475569] tabular-nums">
                    {r.tourCount}
                  </td>
                  <td className="py-2 text-right">
                    {r.bookedCount > 0 ? (
                      <span className="font-semibold text-[#047857] tabular-nums">
                        {r.bookedCount}
                      </span>
                    ) : (
                      <span className="text-[#CBD5E1]">—</span>
                    )}
                  </td>
                  <td className="py-2 text-right font-semibold text-[#0F172A] tabular-nums">
                    {r.estimatedBookedValue > 0
                      ? formatBookedValueShort(r.estimatedBookedValue)
                      : '—'}
                  </td>
                  <td className="py-2 text-right tabular-nums">
                    {r.leadToBookedRate === null ? (
                      <span className="text-[#CBD5E1]">—</span>
                    ) : (
                      <span className="text-[#475569]">
                        {formatRate(r.leadToBookedRate)}
                      </span>
                    )}
                  </td>
                  {/* Phase 8BJ — drilldown into the leads board for
                      this source. Leads board doesn't yet support
                      `?exclude_stage=` so we link to the full source
                      slice; the SourceRevenueLeakageCard handles the
                      actionable "non-booked at-risk" cut. */}
                  <td className="py-2 text-right pr-1">
                    <Link
                      href={`/dashboard/leads?source=${encodeURIComponent(r.sourceLabel)}`}
                      className="inline-flex items-center gap-1 text-[11.5px] font-medium text-[#1D4ED8] hover:underline"
                    >
                      View leads
                      <ArrowUpRight className="w-3 h-3" />
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <footer className="border-t border-[#F1F5F9] pt-3">
        <p className="text-[10.5px] text-[#94A3B8] italic leading-relaxed">
          {summary.disclaimer}
        </p>
      </footer>
    </section>
  )
}
