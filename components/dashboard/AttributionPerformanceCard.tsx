import Link from 'next/link'
import { ArrowUpRight, BarChart3, ExternalLink } from 'lucide-react'
import AttributionSourceBadge from './AttributionSourceBadge'
import {
  type AttributionSummary,
} from '@/lib/enterprise/attribution/summary'

/**
 * Phase 8BH — Attribution performance card.
 *
 * Pure display. Caller (dashboard page) does the DB read +
 * `buildAttributionSummary` so the card stays a presentational
 * shell. Renders the top-N source rows with lead count, tours
 * scheduled, booked count, and estimated pipeline. Honest
 * empty state when no attribution exists yet.
 */

interface Props {
  summary: AttributionSummary
}

function formatCurrency(n: number): string {
  if (n <= 0) return '—'
  if (n >= 1_000_000)
    return `$${(n / 1_000_000).toFixed(1)}M`
  if (n >= 10_000) return `$${Math.round(n / 1000)}k`
  return `$${n.toLocaleString()}`
}

export default function AttributionPerformanceCard({ summary }: Props) {
  const hasRows = summary.rows.length > 0
  const empty = summary.totalAttributed === 0 && summary.totalUnknown === 0

  return (
    <section className="bg-white border border-[#E2E8F0] rounded-2xl shadow-card p-6 space-y-5">
      <header className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-xl bg-[#EFF6FF] text-[#1D4ED8] flex items-center justify-center">
              <BarChart3 className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-[15px] font-semibold text-[#0F172A]">
                Attribution performance
              </h2>
              <p className="text-[11.5px] text-[#475569] mt-0.5">
                Where new inquiries are coming from — leads, tours,
                and estimated pipeline by source.
              </p>
            </div>
          </div>
        </div>
        <div className="text-right text-[10.5px] text-[#94A3B8] uppercase tracking-wider font-semibold">
          Top {summary.rows.length}
          {summary.totalSources > summary.rows.length
            ? ` / ${summary.totalSources}`
            : ''}
        </div>
      </header>

      {empty && (
        <div className="rounded-xl border border-dashed border-[#E2E8F0] bg-[#F8FAFC] p-6 text-center">
          <p className="text-[12.5px] text-[#475569]">
            Attribution will appear once new inquiries include
            source data (UTM parameters, click IDs, or omnichannel
            inbound).
          </p>
        </div>
      )}

      {hasRows && (
        <div className="overflow-x-auto -mx-1">
          <table className="w-full text-[12.5px]">
            <thead>
              <tr className="text-left text-[10.5px] uppercase tracking-wider text-[#94A3B8] border-b border-[#F1F5F9]">
                <th className="font-semibold py-2 pl-1">Source</th>
                <th className="font-semibold py-2 text-right">Leads</th>
                <th className="font-semibold py-2 text-right">Tours</th>
                <th className="font-semibold py-2 text-right">Booked</th>
                <th className="font-semibold py-2 text-right">
                  Est. pipeline
                </th>
                <th className="font-semibold py-2 text-right pr-1">CTA</th>
              </tr>
            </thead>
            <tbody>
              {summary.rows.map((r) => (
                <tr
                  key={r.sourceLabel}
                  className="border-b border-[#F1F5F9] last:border-b-0"
                >
                  <td className="py-2 pl-1">
                    {r.sourceLabel === 'Unknown' ? (
                      <span className="text-[#94A3B8]">Unattributed</span>
                    ) : (
                      <span className="inline-flex items-center gap-1.5">
                        <AttributionSourceBadge
                          sourceLabel={r.sourceLabel}
                          size="md"
                        />
                      </span>
                    )}
                  </td>
                  <td className="py-2 text-right font-semibold text-[#0F172A]">
                    {r.leadsCount}
                  </td>
                  <td className="py-2 text-right text-[#475569]">
                    {r.toursScheduledCount}
                  </td>
                  <td className="py-2 text-right">
                    {r.bookedCount > 0 ? (
                      <span className="font-semibold text-[#047857]">
                        {r.bookedCount}
                      </span>
                    ) : (
                      <span className="text-[#CBD5E1]">—</span>
                    )}
                  </td>
                  <td className="py-2 text-right font-semibold text-[#0F172A]">
                    {formatCurrency(r.estimatedPipeline)}
                  </td>
                  {/* Phase 8BJ — drilldown into leads board filtered by
                      this source. Additive only; doesn't change the row's
                      meaning, just gives the operator a one-click path
                      from "Google Ads = 12 leads" to the actual list. */}
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

      <footer className="border-t border-[#F1F5F9] pt-3 flex items-start gap-2">
        <ExternalLink className="w-3 h-3 text-[#94A3B8] mt-0.5 shrink-0" />
        <p className="text-[10.5px] text-[#94A3B8] italic leading-relaxed">
          {summary.disclaimer}
        </p>
      </footer>
    </section>
  )
}
