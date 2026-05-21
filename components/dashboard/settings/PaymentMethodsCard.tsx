import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardSubtitle,
} from '@/components/dashboard/ui/Card'
import { CreditCard, Lock } from 'lucide-react'
import PaymentMethodActions from './PaymentMethodActions'
import type { VenueSubscriptionStatus } from '@/lib/billing/subscription-status'

/**
 * Phase 9Q — Payment Methods card on /dashboard/settings/billing.
 *
 * Stripe-hosted. VenueRise never stores full payment details — the card
 * brand + last4 + expiry live exclusively inside Stripe, and operators
 * manage them via the Stripe Billing Portal. We deliberately do NOT add
 * a Stripe API fetch here: there's no local cache of the default payment
 * method, and the existing billing pattern (BillingStatusCard) is also
 * portal-only. Reading via the Stripe API would expand the route surface
 * and force a service-side Stripe key into another path for marginal
 * value over a one-click portal.
 *
 * Honesty contract enforced in the copy:
 *   - "Cards and bank details are managed securely by Stripe."
 *   - "VenueRise never stores full payment details."
 *   - "Billing actions are audited."
 *   - We do NOT say "PCI compliant", "Stripe certified", "fully secure",
 *     or "no risk" — those are over-claims we cannot back.
 *
 * The card is read-only data + two delegated CTAs:
 *   1. "Manage payment method" → POST /api/billing/portal (when a
 *      Stripe customer already exists — i.e. subscription is or has been
 *      active / past_due / canceled).
 *   2. "Set up billing"        → POST /api/billing/checkout (when there
 *      is no Stripe customer yet).
 *
 * The portal route enforces ADMIN_ROLES; non-admins see the inline
 * 'forbidden' error from PaymentMethodActions when they click.
 */

interface Props {
  status: VenueSubscriptionStatus
  /** Whether the caller has owner/admin privileges. Drives the CTA
   *  state — non-admins see disabled buttons + an inline notice
   *  instead of clicking through to a 403. */
  isAdmin: boolean
}

const STATUS_DESCRIPTION: Record<
  VenueSubscriptionStatus['kind'],
  { label: string; tone: 'green' | 'amber' | 'red' | 'slate' }
> = {
  active: { label: 'Active subscription', tone: 'green' },
  trialing: { label: 'In trial', tone: 'green' },
  past_due: { label: 'Payment past due', tone: 'red' },
  canceled: { label: 'Subscription canceled', tone: 'amber' },
  incomplete: { label: 'Awaiting first payment', tone: 'amber' },
  none: { label: 'No subscription on file', tone: 'slate' },
  unknown: { label: 'Status unavailable', tone: 'slate' },
}

const TONE_CLASSES: Record<'green' | 'amber' | 'red' | 'slate', string> = {
  green: 'bg-[#ECFDF5] text-[#047857] border-[#A7F3D0]',
  amber: 'bg-[#FFFBEB] text-[#B45309] border-[#FDE68A]',
  red: 'bg-[#FEF2F2] text-[#B91C1C] border-[#FECACA]',
  slate: 'bg-[#F1F5F9] text-[#475569] border-[#E2E8F0]',
}

/**
 * Phase 9Q — same heuristic as `BillingStatusCard.hasCustomer`. A venue
 * has a Stripe customer if it has ever transitioned past `incomplete` —
 * `none` / `incomplete` / `trialing` all skip the check because trialing
 * may be the in-app onboarding trial that exists before any Stripe row,
 * and `none` / `incomplete` mean we haven't completed checkout yet.
 *
 * The portal route is the source of truth: it returns 404
 * `billing_customer_not_found` when no customer exists, and the inline
 * error in PaymentMethodActions surfaces a friendly retry path.
 */
function hasStripeCustomer(status: VenueSubscriptionStatus): boolean {
  return (
    status.kind === 'active' ||
    status.kind === 'past_due' ||
    status.kind === 'canceled'
  )
}

export default function PaymentMethodsCard({ status, isAdmin }: Props) {
  const customerPresent = hasStripeCustomer(status)
  const desc = STATUS_DESCRIPTION[status.kind]
  return (
    <Card>
      <CardHeader>
        <div className="flex items-start gap-3 min-w-0">
          <div className="w-9 h-9 rounded-xl bg-[#EFF6FF] text-[#1D4ED8] flex items-center justify-center shrink-0">
            <CreditCard className="w-4 h-4" />
          </div>
          <div className="min-w-0">
            <CardTitle>Payment methods</CardTitle>
            <CardSubtitle>
              Cards and bank details are managed securely by Stripe.
              VenueRise never stores full payment details.
            </CardSubtitle>
          </div>
        </div>
        <span
          className={`inline-flex items-center rounded-full border px-2.5 py-[2px] text-[11px] font-semibold ${TONE_CLASSES[desc.tone]}`}
        >
          {desc.label}
        </span>
      </CardHeader>
      <CardContent>
        <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3 text-sm">
          <div>
            <dt className="text-[11px] font-semibold uppercase tracking-wider text-[#94A3B8]">
              Stripe customer
            </dt>
            <dd className="text-[#0F172A] mt-1">
              {customerPresent ? (
                <span className="text-[#047857] font-medium">Connected</span>
              ) : (
                <span className="text-[#64748B]">Not yet — start checkout first</span>
              )}
            </dd>
          </div>
          <div>
            <dt className="text-[11px] font-semibold uppercase tracking-wider text-[#94A3B8]">
              Default payment method
            </dt>
            <dd className="text-[#0F172A] mt-1 text-[12.5px]">
              {customerPresent ? (
                <span className="text-[#475569]">
                  Open Stripe portal to view or update payment methods.
                </span>
              ) : (
                <span className="text-[#CBD5E1]">—</span>
              )}
            </dd>
          </div>
        </dl>

        <div className="mt-5 flex flex-wrap items-center gap-3">
          <PaymentMethodActions
            mode={customerPresent ? 'portal' : 'checkout'}
            disabled={!isAdmin}
          />
          {!isAdmin && (
            <span className="text-[12px] text-[#B45309]">
              Only venue owners and admins can manage billing.
            </span>
          )}
        </div>

        <div className="mt-5 flex items-start gap-2 rounded-lg border border-[#E2E8F0] bg-[#F8FAFC] px-3 py-2.5">
          <Lock className="w-3.5 h-3.5 text-[#64748B] mt-0.5 shrink-0" />
          <p className="text-[11.5px] text-[#475569] leading-relaxed">
            Payment details are processed by Stripe. VenueRise stores
            billing status and audit records, not full card data. Billing
            actions (opening the portal, starting checkout) are recorded
            in the enterprise audit log.
          </p>
        </div>
      </CardContent>
    </Card>
  )
}
