import Link from 'next/link'
import { ArrowRight, AlertCircle, CalendarCheck, TrendingUp, Activity } from 'lucide-react'

/**
 * GTM-0D — Executive hero for the Overview page.
 *
 * Replaces the AI "overnight" brief's weak zero-state. The hero
 * leads with the single sentence a venue owner needs to hear:
 *
 *   "X revenue opportunities need attention today."
 *
 * Followed by 3-4 tiles that tell the same story numerically:
 *   - Pipeline at risk (dollars at stake right now)
 *   - Needs action today (total leakage items)
 *   - Tours to protect (scheduled + unconfirmed)
 *   - Booked value tracked (already won)
 *
 * Hard rules:
 *   - Never fabricate numbers — only render tiles whose values are
 *     known and meaningful. Zero-value tiles are HIDDEN, not shown
 *     with a "0" — zero metrics make the product look inactive.
 *   - No SaaS-ese ("operator activity", "automation stack",
 *     "signals"). Owner language only.
 *   - No SOC 2 / GDPR / autonomous-booking overclaims.
 */

export interface ExecutiveHeroTile {
  label: string
  value: string
  subtext?: string
  tone?: 'navy' | 'champagne' | 'blue' | 'emerald'
}

interface Props {
  greeting: string
  headline: string
  subhead: string
  primaryCta?: { href: string; label: string }
  tiles: ExecutiveHeroTile[]
}

const TONE_CLASSES: Record<NonNullable<ExecutiveHeroTile['tone']>, {
  ring: string
  iconBg: string
  iconText: string
  valueText: string
}> = {
  navy: {
    ring: 'border-[#E2E8F0]',
    iconBg: 'bg-[#F1F5F9]',
    iconText: 'text-[#0F172A]',
    valueText: 'text-[#0F172A]',
  },
  blue: {
    ring: 'border-[#BFDBFE]',
    iconBg: 'bg-[#EFF6FF]',
    iconText: 'text-[#1D4ED8]',
    valueText: 'text-[#0F172A]',
  },
  emerald: {
    ring: 'border-[#A7F3D0]',
    iconBg: 'bg-[#ECFDF5]',
    iconText: 'text-[#047857]',
    valueText: 'text-[#047857]',
  },
  champagne: {
    // GTM-0D — soft warm/champagne tone for revenue-at-risk tiles.
    // Premium, restrained — never saturated gold.
    ring: 'border-[#E8DCC4]',
    iconBg: 'bg-[#FAF7F0]',
    iconText: 'text-[#92763C]',
    valueText: 'text-[#0F172A]',
  },
}

const TONE_ICONS: Record<NonNullable<ExecutiveHeroTile['tone']>, typeof Activity> = {
  navy: Activity,
  blue: CalendarCheck,
  emerald: TrendingUp,
  champagne: AlertCircle,
}

export default function ExecutiveHero({
  greeting,
  headline,
  subhead,
  primaryCta,
  tiles,
}: Props) {
  const visibleTiles = tiles.filter((t) => t.value && t.value !== '—')
  return (
    <section className="rounded-2xl border border-[#E6E8EF] bg-white shadow-card overflow-hidden">
      {/* Hero band — neutral white with champagne accent line on the
          left rail. The whole top reads as a luxury concierge greeting
          rather than a SaaS analytics dashboard. */}
      <div className="relative px-6 py-5 lg:px-7 lg:py-6 bg-gradient-to-br from-white via-white to-[#FAF7F0]">
        <div className="absolute left-0 top-0 bottom-0 w-1 bg-gradient-to-b from-[#C5A572] via-[#92763C] to-[#C5A572]" />
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="min-w-0 flex-1">
            <div className="text-[10.5px] uppercase tracking-[0.16em] text-[#92763C] font-semibold mb-1.5">
              {greeting}
            </div>
            <h1 className="text-[22px] lg:text-[24px] font-semibold leading-[1.15] tracking-[-0.022em] text-[#0F172A]">
              {headline}
            </h1>
            <p className="mt-1.5 text-[13px] text-[#475569] leading-relaxed max-w-2xl">
              {subhead}
            </p>
          </div>
          {primaryCta && (
            <Link
              href={primaryCta.href}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-[12.5px] font-medium rounded-[10px] bg-[#0F172A] text-white hover:bg-[#1E293B] transition-colors shrink-0"
            >
              {primaryCta.label}
              <ArrowRight className="w-3.5 h-3.5" />
            </Link>
          )}
        </div>
      </div>

      {visibleTiles.length > 0 && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-px bg-[#F1F5F9] border-t border-[#F1F5F9]">
          {visibleTiles.map((tile, i) => {
            const tone = TONE_CLASSES[tile.tone ?? 'navy']
            const Icon = TONE_ICONS[tile.tone ?? 'navy']
            return (
              <div
                key={`${tile.label}-${i}`}
                className="bg-white px-5 py-4 flex flex-col gap-2.5"
              >
                <div className="flex items-center gap-2">
                  <span
                    className={`w-7 h-7 rounded-lg ${tone.iconBg} ${tone.iconText} flex items-center justify-center shrink-0`}
                  >
                    <Icon className="w-3.5 h-3.5" />
                  </span>
                  <span className="text-[10.5px] uppercase tracking-[0.12em] text-[#64748B] font-semibold">
                    {tile.label}
                  </span>
                </div>
                <div>
                  <div
                    className={`text-[26px] leading-none font-semibold tabular-nums tracking-[-0.022em] ${tone.valueText}`}
                  >
                    {tile.value}
                  </div>
                  {tile.subtext && (
                    <div className="mt-1 text-[11px] text-[#64748B]">
                      {tile.subtext}
                    </div>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}
