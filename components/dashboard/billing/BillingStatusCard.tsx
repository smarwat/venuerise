import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardSubtitle,
} from '@/components/dashboard/ui/Card'
import { Badge } from '@/components/dashboard/ui/Badge'
import {
  billingGateEnabled,
  type VenueSubscriptionStatus,
} from '@/lib/billing/subscription-status'
import BillingActions from './BillingActions'

/**
 * Phase 7D — billing summary card used on /dashboard/settings/billing.
 *
 * Pure UI — never queries. Pass the already-resolved subscription status in.
 * Renders status badge, key dates, and the primary action (checkout when
 * inactive, portal when there's a customer to manage).
 */

interface BillingStatusCardProps {
  status: VenueSubscriptionStatus
}

const KIND_LABEL: Record<VenueSubscriptionStatus['kind'], string> = {
  none: 'No subscription',
  trialing: 'Trialing',
  active: 'Active',
  past_due: 'Past due',
  canceled: 'Canceled',
  incomplete: 'Incomplete',
  unknown: 'Unknown',
}

const KIND_VARIANT: Record<
  VenueSubscriptionStatus['kind'],
  React.ComponentProps<typeof Badge>['variant']
> = {
  none: 'default',
  trialing: 'blue',
  active: 'green',
  past_due: 'red',
  canceled: 'default',
  incomplete: 'amber',
  unknown: 'default',
}

export default function BillingStatusCard({ status }: BillingStatusCardProps) {
  const gate = billingGateEnabled()
  const hasCustomer = status.kind === 'active' || status.kind === 'past_due' || status.kind === 'canceled'
  return (
    <Card>
      <CardHeader>
        <div className="min-w-0">
          <CardTitle>Subscription</CardTitle>
          <CardSubtitle>
            Stripe holds your payment method and invoice history — we never see card numbers.
            {!gate && ' Billing is in preview mode: access is not yet enforced by subscription state.'}
          </CardSubtitle>
        </div>
        <Badge variant={KIND_VARIANT[status.kind]}>{KIND_LABEL[status.kind]}</Badge>
      </CardHeader>
      <CardContent>
        <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3 text-sm">
          {renderDates(status).map(([label, value]) => (
            <div key={label}>
              <dt className="text-[11px] font-semibold uppercase tracking-wider text-[#94A3B8]">
                {label}
              </dt>
              <dd className="text-[#0F172A] mt-1">{value}</dd>
            </div>
          ))}
        </dl>
        <div className="mt-5 flex flex-wrap items-center gap-3">
          {hasCustomer ? (
            <>
              <BillingActions mode="portal" label="Manage billing" variant="primary" />
              {status.kind !== 'active' && (
                <BillingActions
                  mode="checkout"
                  label="Resume subscription"
                  variant="secondary"
                />
              )}
            </>
          ) : (
            <BillingActions mode="checkout" label="Start subscription" variant="primary" />
          )}
        </div>
      </CardContent>
    </Card>
  )
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—'
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    })
  } catch {
    return '—'
  }
}

function renderDates(status: VenueSubscriptionStatus): Array<[string, string]> {
  switch (status.kind) {
    case 'trialing':
      return [
        ['Trial ends', fmtDate(status.trial_end)],
        ['Next renewal', fmtDate(status.current_period_end)],
      ]
    case 'active':
      return [
        ['Renews', fmtDate(status.current_period_end)],
        [
          'Auto-renew',
          status.cancel_at_period_end ? 'Off — ends at period end' : 'On',
        ],
      ]
    case 'past_due':
      return [['Current period ends', fmtDate(status.current_period_end)]]
    case 'canceled':
      return [['Canceled', fmtDate(status.canceled_at)]]
    case 'incomplete':
      return [['Status', 'Awaiting first payment']]
    case 'none':
      return [['Status', 'No subscription on file yet']]
    case 'unknown':
      return [['Raw status', status.raw_status]]
  }
}
