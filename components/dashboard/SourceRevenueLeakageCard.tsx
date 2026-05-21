import Link from 'next/link'
import { Activity, ArrowUpRight } from 'lucide-react'
import AttributionSourceBadge from './AttributionSourceBadge'
import {
  SOURCE_LEAKAGE_LABEL,
  type SourceLeakageSummary,
  type SourceLeakageKey,
} from '@/lib/enterprise/attribution/leakage'
import { formatBookedValueShort } from '@/lib/enterprise/attribution/revenue'

/**
 * Phase 8BJ — Source revenue leakage card.
 *
 * Pure presentational shell. Caller (dashboard page) reads
 * leads + tours + outbound + inbound + settings and calls
 * `buildSourceLeakageSummary`. Renders top 5 sources sorted by
 * at-risk lead count + CTA that deep-links into the leads
 * board with the matching `?source=` + optional `&leakage=`
 * filter.
 */

interface Props {
  summary: SourceLeakageSummary
}

/** Leakage-bucket → leads-board `?leakage=` value mapping.
 *  Falls back to no leakage filter for buckets that don't
 *  exist on the leads board (e.g. lost). */
const LEAKAGE_TO_BOARD_PARAM: Partial<Record<SourceLeakageKey, string>> = {
  slow_first_reply: 'slow_first_reply',
  high_fit_idle: 'high_fit_idle',
  no_tour_booked: 'no_tour_booked',
  tour_pending_confirm: 'tour_pending_confirm',
  cold_lead_recovery: 'cold_lead_recovery',
  follow_up_recovery: 'follow_up_recovery',
  tour_booking: 'tour_booking',
  reactivation: 'reactivation',
}

function buildLeadsHref(
  sourceLabel: string,
  topLeak: SourceLeakageKey | null
): string {
  const params = new URLSearchParams()
  params.set('source', sourceLabel)
  const leakageParam = topLeak ? LEAKAGE_TO_BOARD_PARAM[topLeak] : null
  if (leakageParam) params.set('leakage', leakageParam)
  return `/dashboard/leads?${params.toString()}`
}

export default function SourceRevenueLeakageCard({ summary }: Props) {
  const top = summary.rows.slice(0, 5)
  const empty = summary.totals.leadCount === 0

  return (
    <section className="bg-white border border-[#E2E8F0] rounded-2xl shadow-card p-6 space-y-5">
      <header className="flex items-start justify-between gap-3">
        <div>
          <p className="text-[10.5px] uppercase tracking-[0.16em] text-[#94A3B8] font-semibold">
            Source intelligence
          </p>
          <div className="flex items-center gap-2 mt-0.5">
            <div className="w-8 h-8 rounded-xl bg-[#FFFBEB] text-[#B45309] flex items-center justify-center">
              <Activity className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-[15px] font-semibold text-[#0F172A]">
                Where each source is leaking revenue
              </h2>
              <p className="text-[11.5px] text-[#475569] mt-0.5">
                Top leak per source + a direct link into the leads board.
              </p>
            </div>
          </div>
        </div>
        {!empty && (
          <div className="text-right">
            <p className="text-[10.5px] uppercase tracking-wider text-[#94A3B8] font-semibold">
              At-risk leads
            </p>
            <p className="text-[15px] font-semibold text-[#B45309] tabular-nums">
              {summary.totals.atRiskCount}
            </p>
          </div>
        )}
      </header>

      {empty && (
        <div className="rounded-xl border border-dashed border-[#E2E8F0] bg-[#F8FAFC] p-6 text-center">
          <p className="text-[12.5px] text-[#475569]">
            Source leakage will appear once attributed leads enter the
            pipeline.
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
                <th className="font-semibold py-2 text-right">Booked</th>
                <th className="font-semibold py-2 text-right">Est. booked</th>
                <th className="font-semibold py-2">Top leak</th>
                <th className="font-semibold py-2 text-right">At-risk</th>
                <th className="font-semibold py-2 text-right pr-1">CTA</th>
              </tr>
            </thead>
            <tbody>
              {top.map((r) => {
                const sourceParam = r.sourceLabel
                const href = buildLeadsHref(sourceParam, r.topLeakageReason)
                return (
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
                    <td className="py-2 text-right tabular-nums">
                      {r.bookedCount > 0 ? (
                        <span className="font-semibold text-[#047857]">
                          {r.bookedCount}
                        </span>
                      ) : (
                        <span className="text-[#CBD5E1]">—</span>
                      )}
                    </td>
                    <td className="py-2 text-right text-[#475569] tabular-nums">
                      {r.estimatedBookedValue > 0
                        ? formatBookedValueShort(r.estimatedBookedValue)
                        : '—'}
                    </td>
                    <td className="py-2 text-[#0F172A]">
                      {r.topLeakageReason ? (
                        <span className="inline-flex items-center rounded-full bg-[#FFFBEB] border border-[#FDE68A] text-[#B45309] px-2 py-[1px] text-[10.5px] font-semibold">
                          {SOURCE_LEAKAGE_LABEL[r.topLeakageReason]}
                        </span>
                      ) : (
                        <span className="text-[#94A3B8]">No active leak</span>
                      )}
                    </td>
                    <td className="py-2 text-right tabular-nums">
                      {r.atRiskCount > 0 ? (
                        <span className="font-semibold text-[#B45309]">
                          {r.atRiskCount}
                        </span>
                      ) : (
                        <span className="text-[#CBD5E1]">—</span>
                      )}
                    </td>
                    <td className="py-2 text-right pr-1">
                      <Link
                        href={href}
                        className="inline-flex items-center gap-1 text-[11.5px] font-medium text-[#1D4ED8] hover:underline"
                      >
                        Open source
                        <ArrowUpRight className="w-3 h-3" />
                      </Link>
                    </td>
                  </tr>
                )
              })}
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
