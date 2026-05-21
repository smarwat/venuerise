import { Check, Sparkles } from 'lucide-react'
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardSubtitle,
} from '@/components/dashboard/ui/Card'
import {
  BILLING_PLANS,
  BILLING_PLAN_ORDER,
  type BillingPlan,
  type BillingPlanId,
  type BillingPlanInterval,
} from '@/lib/billing/plans'
import { FEATURE_LABEL } from '@/lib/billing/plan-gates'
import type { VenueSubscriptionStatus } from '@/lib/billing/subscription-status'
import SubscriptionPlanSelector from './SubscriptionPlanSelector'

/**
 * Phase 9R — SubscriptionPlansCard.
 *
 * Server component shell. Renders the 4 catalog plans + a per-plan CTA
 * delegated to the `<SubscriptionPlanSelector>` client component which
 * POSTs to `/api/billing/checkout` with `{ plan_id, interval, source:
 * 'subscription_plans_card' }`. Enterprise has no Stripe price — its
 * CTA is contact-sales (mailto:) by design.
 *
 * CURRENT PLAN
 *   Caller resolves the current plan via `getCurrentPlanForVenue` and
 *   passes it in. Falls through to "Current plan: Not set" + a soft
 *   prompt to choose one when neither metadata nor price-id lookup
 *   resolves a plan. We never guess.
 *
 * HONESTY
 *   Plan bullets describe shipped product surfaces. We do NOT claim
 *   SOC 2, GDPR, HIPAA, PCI, real SSO, SCIM, or 24/7 monitoring. Limits
 *   are PRODUCT controls (not legal/compliance guarantees) and are NOT
 *   enforced globally yet — see `lib/billing/plan-gates.ts`.
 */

interface Props {
  status: VenueSubscriptionStatus
  isAdmin: boolean
  /** Resolved by the caller via `getCurrentPlanForVenue(venueId)`.
   *  `null` when neither subscription metadata nor a price-id lookup
   *  produced a known plan. */
  currentPlanId: BillingPlanId | null
  currentInterval: BillingPlanInterval | null
}

const STATUS_LABEL: Record<VenueSubscriptionStatus['kind'], string> = {
  none: 'No subscription',
  trialing: 'Trialing',
  active: 'Active',
  past_due: 'Past due',
  canceled: 'Canceled',
  incomplete: 'Incomplete',
  unknown: 'Unknown',
}

/** Pick the CTA verb based on the venue's current plan position
 *  relative to the plan we're rendering. Switch when same plan but
 *  different interval; Upgrade for higher tiers; Start when nothing
 *  is set. Used for paid plans only — Enterprise is contact-sales. */
function ctaLabelFor(
  thisPlan: BillingPlanId,
  current: BillingPlanId | null,
  status: VenueSubscriptionStatus['kind']
): string {
  if (!current) {
    return status === 'active' || status === 'trialing'
      ? 'Switch plan'
      : 'Start plan'
  }
  if (current === thisPlan) return 'Current plan'
  const order = BILLING_PLAN_ORDER
  const ci = order.indexOf(current)
  const ti = order.indexOf(thisPlan)
  if (ti > ci) return 'Upgrade'
  return 'Switch plan'
}

function formatLimit(value: number | 'custom' | undefined): string {
  if (value === undefined) return '—'
  if (value === 'custom') return 'Custom'
  return value.toLocaleString()
}

export default function SubscriptionPlansCard({
  status,
  isAdmin,
  currentPlanId,
  currentInterval,
}: Props) {
  return (
    <Card>
      <CardHeader>
        <div className="min-w-0">
          <CardTitle>Subscription plans</CardTitle>
          <CardSubtitle>
            Choose the plan that matches how you operate. Card details
            stay in Stripe — VenueRise never stores full payment data.
          </CardSubtitle>
        </div>
        <div className="text-right">
          <p className="text-[10.5px] uppercase tracking-wider text-[#94A3B8] font-semibold">
            Current plan
          </p>
          <p className="text-[14px] font-semibold text-[#0F172A]">
            {currentPlanId ? BILLING_PLANS[currentPlanId].name : 'Not set'}
          </p>
          <p className="text-[11px] text-[#475569]">
            {STATUS_LABEL[status.kind]}
            {currentInterval ? ` · ${currentInterval}` : ''}
          </p>
        </div>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
          {BILLING_PLAN_ORDER.map((id) => {
            const plan = BILLING_PLANS[id]
            const isCurrent = currentPlanId === id
            return (
              <PlanCell
                key={id}
                plan={plan}
                isCurrent={isCurrent}
                isAdmin={isAdmin}
                ctaLabel={
                  plan.custom
                    ? 'Contact sales'
                    : ctaLabelFor(id, currentPlanId, status.kind)
                }
              />
            )
          })}
        </div>

        <p className="mt-5 text-[11px] text-[#94A3B8] italic leading-relaxed">
          Plan limits are product controls for the in-app workflows.
          They are not legal or compliance guarantees and are not
          enforced globally in this release. Trust / SSO / privacy
          surfaces describe readiness scaffolding shipped today — we
          do not claim SOC 2, GDPR, HIPAA, PCI, or 24/7 monitoring
          attestations.
        </p>
      </CardContent>
    </Card>
  )
}

// ──────────────────────────────────────────────────────────────────────
//  Plan cell
// ──────────────────────────────────────────────────────────────────────

interface PlanCellProps {
  plan: BillingPlan
  isCurrent: boolean
  isAdmin: boolean
  ctaLabel: string
}

function PlanCell({ plan, isCurrent, isAdmin, ctaLabel }: PlanCellProps) {
  const borderClass = plan.recommended
    ? 'border-[#1D4ED8]/40 ring-1 ring-[#1D4ED8]/15'
    : 'border-[#E2E8F0]'
  return (
    <section
      className={`rounded-2xl border bg-white p-5 flex flex-col ${borderClass}`}
    >
      <header className="flex items-start justify-between gap-2 min-w-0">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <h3 className="text-[15px] font-semibold text-[#0F172A]">
              {plan.name}
            </h3>
            {plan.recommended && (
              <span className="inline-flex items-center gap-1 rounded-full bg-[#EFF6FF] text-[#1D4ED8] border border-[#BFDBFE] px-2 py-[1px] text-[10px] font-semibold">
                <Sparkles className="w-3 h-3" />
                Recommended
              </span>
            )}
            {isCurrent && (
              <span className="inline-flex items-center rounded-full bg-[#ECFDF5] text-[#047857] border border-[#A7F3D0] px-2 py-[1px] text-[10px] font-semibold">
                Current
              </span>
            )}
          </div>
          <p className="text-[11.5px] text-[#475569] mt-1 leading-relaxed">
            {plan.tagline}
          </p>
        </div>
      </header>

      <div className="mt-3 flex items-baseline gap-1.5">
        <span className="text-[22px] font-semibold text-[#0F172A] tracking-[-0.02em] tabular-nums">
          {plan.monthlyPriceLabel}
        </span>
      </div>

      <ul className="mt-4 space-y-1.5 text-[12px] text-[#0F172A]">
        {plan.bullets.map((b) => (
          <li key={b} className="flex items-start gap-1.5">
            <Check className="w-3.5 h-3.5 text-[#059669] mt-[2px] shrink-0" />
            <span>{b}</span>
          </li>
        ))}
      </ul>

      <dl className="mt-4 grid grid-cols-2 gap-x-3 gap-y-2 text-[11px]">
        <Limit label="Venues" value={formatLimit(plan.limits.venues)} />
        <Limit
          label="Leads / mo"
          value={formatLimit(plan.limits.leadsPerMonth)}
        />
        <Limit label="Admin seats" value={formatLimit(plan.limits.adminSeats)} />
        <Limit label="Team seats" value={formatLimit(plan.limits.teamSeats)} />
      </dl>

      <details className="mt-3 group">
        <summary className="text-[11px] font-medium text-[#475569] cursor-pointer hover:text-[#0F172A]">
          Included features ({plan.features.length})
        </summary>
        <ul className="mt-2 space-y-1 text-[11px] text-[#475569]">
          {plan.features.map((f) => (
            <li key={f} className="flex items-center gap-1.5">
              <Check className="w-3 h-3 text-[#94A3B8]" />
              {FEATURE_LABEL[f]}
            </li>
          ))}
        </ul>
      </details>

      <div className="mt-5 mt-auto">
        <SubscriptionPlanSelector
          planId={plan.id}
          isCustom={Boolean(plan.custom)}
          isCurrent={isCurrent}
          disabled={!isAdmin}
          ctaLabel={ctaLabel}
        />
      </div>
    </section>
  )
}

function Limit({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[9.5px] uppercase tracking-wider text-[#94A3B8] font-semibold">
        {label}
      </dt>
      <dd className="text-[#0F172A] tabular-nums">{value}</dd>
    </div>
  )
}
