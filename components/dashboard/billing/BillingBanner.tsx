import { AlertTriangle, Clock, Sparkles } from 'lucide-react'
import {
  getVenueSubscriptionStatus,
  billingGateEnabled,
  type VenueSubscriptionStatus,
} from '@/lib/billing/subscription-status'
import BillingActions from './BillingActions'

/**
 * Phase 7D — top-of-dashboard billing banner.
 *
 * Server Component. Fetches the venue's subscription status once per
 * render (memoized via React `cache()` in the helper, so a co-located
 * billing gate doesn't re-query).
 *
 * Render rules:
 *   - kind=active and not cancel_at_period_end  → render nothing
 *   - kind=active and cancel_at_period_end       → soft notice with portal CTA
 *   - kind=trialing and trial_end > 4 days away  → render nothing
 *   - kind=trialing and trial_end <= 4 days away → countdown + checkout CTA
 *   - kind=none / incomplete                      → "Start subscription"
 *   - kind=past_due                               → red banner + portal CTA
 *   - kind=canceled                               → red banner + checkout CTA
 *   - kind=unknown                                → soft notice, no CTA
 *
 * When the billing gate is DISABLED, we still show the banner so operators
 * see it, but the copy is informational ("billing is in preview mode") so
 * users don't think their account will lock out. When the gate is enabled,
 * past_due/canceled banners read as urgent.
 *
 * Failures fail-open: if the status read throws (e.g. Supabase blip), the
 * banner renders nothing and logs are emitted upstream — never block the
 * dashboard on a billing query failure.
 */
export default async function BillingBanner({ venueId }: { venueId: string | null }) {
  if (!venueId) return null

  let status: VenueSubscriptionStatus
  try {
    status = await getVenueSubscriptionStatus(venueId)
  } catch {
    // Fail-open — dashboard loads, operator sees Sentry separately.
    return null
  }

  const gate = billingGateEnabled()
  const view = pickBanner(status, gate)
  if (!view) return null

  return (
    <div className={`w-full ${view.wrapperBg} ${view.wrapperBorder} border-b`}>
      <div className="mx-auto max-w-7xl px-6 py-3 flex items-center gap-3">
        <view.Icon className={`h-5 w-5 ${view.iconColor} shrink-0`} aria-hidden="true" />
        <div className="flex-1 min-w-0">
          <div className={`text-sm font-medium ${view.titleColor}`}>{view.title}</div>
          {view.body && (
            <div className={`text-xs mt-0.5 ${view.bodyColor}`}>{view.body}</div>
          )}
        </div>
        {view.cta && (
          <BillingActions
            mode={view.cta.mode}
            label={view.cta.label}
            variant={view.cta.variant}
            size="sm"
          />
        )}
      </div>
    </div>
  )
}

interface BannerView {
  Icon: typeof AlertTriangle
  wrapperBg: string
  wrapperBorder: string
  iconColor: string
  titleColor: string
  bodyColor: string
  title: string
  body?: string
  cta?: {
    mode: 'checkout' | 'portal'
    label: string
    variant: React.ComponentProps<typeof BillingActions>['variant']
  }
}

const MS_DAY = 24 * 60 * 60 * 1000
const TRIAL_WARN_DAYS = 4

function daysUntil(iso: string | null | undefined): number | null {
  if (!iso) return null
  const t = new Date(iso).getTime()
  if (!Number.isFinite(t)) return null
  return Math.max(0, Math.ceil((t - Date.now()) / MS_DAY))
}

function gateSuffix(gate: boolean): string {
  return gate ? '' : ' Billing is in preview — access remains unchanged.'
}

function pickBanner(status: VenueSubscriptionStatus, gate: boolean): BannerView | null {
  switch (status.kind) {
    case 'active': {
      if (!status.cancel_at_period_end) return null
      const days = daysUntil(status.current_period_end)
      return {
        Icon: Clock,
        wrapperBg: 'bg-[#FFFBEB]',
        wrapperBorder: 'border-[#FCD9A1]',
        iconColor: 'text-[#B45309]',
        titleColor: 'text-[#92400E]',
        bodyColor: 'text-[#B45309]',
        title: 'Subscription set to cancel',
        body:
          days != null
            ? `Access ends in ${days} ${days === 1 ? 'day' : 'days'}. Resume any time.`
            : 'Resume in Stripe to keep access.',
        cta: { mode: 'portal', label: 'Manage billing', variant: 'secondary' },
      }
    }

    case 'trialing': {
      const days = daysUntil(status.trial_end)
      if (days == null || days > TRIAL_WARN_DAYS) return null
      return {
        Icon: Sparkles,
        wrapperBg: 'bg-[#EFF6FF]',
        wrapperBorder: 'border-[#BFDBFE]',
        iconColor: 'text-[#1D4ED8]',
        titleColor: 'text-[#0F172A]',
        bodyColor: 'text-[#1D4ED8]',
        title: `Trial ends in ${days} ${days === 1 ? 'day' : 'days'}`,
        body: `Start a subscription to keep everything running.${gateSuffix(gate)}`,
        cta: { mode: 'checkout', label: 'Start subscription', variant: 'primary' },
      }
    }

    case 'none':
    case 'incomplete': {
      // GTM-0D — when the billing gate is OFF (pilot/demo workspaces),
      // we deliberately do NOT show the loud "Start your subscription"
      // CTA on every page. A buyer watching a sales demo shouldn't see
      // a checkout prompt — it hurts credibility ("is this real software
      // or am I being upsold mid-demo?"). Instead we show a quiet
      // "Pilot workspace active" pill with no CTA. The real Start CTA
      // remains available on /dashboard/settings/billing.
      //
      // When the gate IS on (production billing enforced), we keep the
      // original "Start your subscription" banner — a real customer
      // whose plan lapsed deserves the prompt.
      if (!gate) {
        return {
          Icon: Sparkles,
          wrapperBg: 'bg-[#FAF7F0]',
          wrapperBorder: 'border-[#E8DCC4]',
          iconColor: 'text-[#92763C]',
          titleColor: 'text-[#0F172A]',
          bodyColor: 'text-[#6B5A2E]',
          title: 'Pilot workspace active',
          body: 'Billing is disabled for this workspace. All Revenue OS workflows remain available.',
        }
      }
      return {
        Icon: Sparkles,
        wrapperBg: 'bg-[#EFF6FF]',
        wrapperBorder: 'border-[#BFDBFE]',
        iconColor: 'text-[#1D4ED8]',
        titleColor: 'text-[#0F172A]',
        bodyColor: 'text-[#475569]',
        title: 'Start your subscription',
        body: `Unlock the workflow once your trial wraps.${gateSuffix(gate)}`,
        cta: { mode: 'checkout', label: 'Start subscription', variant: 'primary' },
      }
    }

    case 'past_due': {
      return {
        Icon: AlertTriangle,
        wrapperBg: 'bg-[#FEF2F2]',
        wrapperBorder: 'border-[#FECACA]',
        iconColor: 'text-[#B91C1C]',
        titleColor: 'text-[#7F1D1D]',
        bodyColor: 'text-[#B91C1C]',
        title: 'Payment past due',
        body: `Update your payment method to keep the dashboard available.${gateSuffix(gate)}`,
        cta: { mode: 'portal', label: 'Update payment', variant: 'primary' },
      }
    }

    case 'canceled': {
      return {
        Icon: AlertTriangle,
        wrapperBg: 'bg-[#FEF2F2]',
        wrapperBorder: 'border-[#FECACA]',
        iconColor: 'text-[#B91C1C]',
        titleColor: 'text-[#7F1D1D]',
        bodyColor: 'text-[#B91C1C]',
        title: 'Subscription canceled',
        body: `Start a new subscription to restore access.${gateSuffix(gate)}`,
        cta: { mode: 'checkout', label: 'Resume subscription', variant: 'primary' },
      }
    }

    case 'unknown': {
      return {
        Icon: AlertTriangle,
        wrapperBg: 'bg-[#F1F5F9]',
        wrapperBorder: 'border-[#E2E8F0]',
        iconColor: 'text-[#475569]',
        titleColor: 'text-[#0F172A]',
        bodyColor: 'text-[#475569]',
        title: 'Billing status unavailable',
        body: `We couldn’t determine your subscription state. Reach out if this persists.${gateSuffix(gate)}`,
      }
    }
  }
}
