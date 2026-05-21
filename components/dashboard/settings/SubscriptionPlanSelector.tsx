'use client'

import { useState } from 'react'
import { ArrowUpRight, Loader2, Mail } from 'lucide-react'
import { Button } from '@/components/dashboard/ui/Button'
import type {
  BillingPlanId,
  BillingPlanInterval,
} from '@/lib/billing/plans'

/**
 * Phase 9R — per-plan CTA used by `SubscriptionPlansCard`.
 *
 * Three modes:
 *   - Paid plan (Starter / Growth / Elite): POSTs
 *     `/api/billing/checkout` with `{ plan_id, interval, source:
 *     'subscription_plans_card' }` and hard-redirects to the Stripe
 *     Checkout URL.
 *   - Enterprise (`isCustom`): opens `mailto:sales@venuerise.com`
 *     with a prefilled subject. No Stripe round-trip.
 *   - Current plan (`isCurrent`): button reads "Current plan" and
 *     is disabled. We never re-issue checkout for the active tier.
 *
 * Inline error vocabulary maps the route's structured codes to
 * friendly sentences. We never paint card data or echo the Stripe
 * payload.
 */

interface Props {
  planId: BillingPlanId
  isCustom: boolean
  isCurrent: boolean
  disabled?: boolean
  ctaLabel: string
}

const SALES_EMAIL = 'sales@venuerise.com'

export default function SubscriptionPlanSelector({
  planId,
  isCustom,
  isCurrent,
  disabled,
  ctaLabel,
}: Props) {
  const [interval] = useState<BillingPlanInterval>('monthly')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Enterprise — contact-sales mailto. No checkout.
  if (isCustom) {
    return (
      <a
        href={`mailto:${SALES_EMAIL}?subject=${encodeURIComponent(
          'VenueRise Enterprise inquiry'
        )}`}
        className="inline-flex items-center justify-center gap-1.5 w-full rounded-md bg-[#0F172A] text-white text-[12.5px] font-semibold px-3 py-2 hover:bg-[#1E293B]"
      >
        <Mail className="w-3.5 h-3.5" />
        {ctaLabel}
      </a>
    )
  }

  const buttonDisabled = disabled || busy || isCurrent

  async function handleClick() {
    if (buttonDisabled) return
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/api/billing/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          plan_id: planId,
          interval,
          source: 'subscription_plans_card',
        }),
      })
      const json: unknown = await res.json().catch(() => null)
      if (res.ok && typeof json === 'object' && json && 'url' in json) {
        const target = String((json as { url: unknown }).url)
        window.location.assign(target)
        return
      }
      const code =
        typeof json === 'object' && json && 'error' in json
          ? String((json as { error: unknown }).error)
          : `request_failed_${res.status}`
      setError(humanize(code, planId))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Network error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col items-stretch gap-2">
      <Button
        onClick={handleClick}
        disabled={buttonDisabled}
        variant={isCurrent ? 'secondary' : 'primary'}
        size="md"
      >
        {busy && <Loader2 className="h-4 w-4 animate-spin" />}
        {busy ? 'Opening Stripe checkout…' : ctaLabel}
        {!busy && !isCurrent && <ArrowUpRight className="h-3.5 w-3.5" />}
      </Button>
      {error && (
        <div className="text-[11.5px] text-[#B91C1C] leading-relaxed">
          {error}
        </div>
      )}
      {!error && disabled && (
        <p className="text-[11px] text-[#B45309]">
          Only venue owners and admins can change the plan.
        </p>
      )}
    </div>
  )
}

function humanize(code: string, planId: BillingPlanId): string {
  switch (code) {
    case 'unauthorized':
      return 'Please sign in again to manage billing.'
    case 'forbidden':
      return 'Only venue owners and admins can change the plan.'
    case 'no_venue':
    case 'venue_not_found':
      return 'No active workspace found.'
    case 'enterprise_contact_required':
      return 'Enterprise plans are contact-sales only.'
    case 'stripe_price_not_configured':
      return `Stripe price for ${planId} is not configured. Ask the operator who runs deploys to set the matching STRIPE_PRICE_${planId.toUpperCase()}_* env var.`
    case 'billing_not_configured':
      return 'Stripe is not configured for this deploy. Contact support.'
    case 'price_id_missing':
      return 'No subscription plan is configured. Contact support.'
    case 'rate_limited':
      return 'Too many billing requests. Wait a moment and try again.'
    case 'validation_failed':
      return 'Invalid plan selection. Refresh the page and try again.'
    case 'stripe_failed':
      return 'Stripe returned an error. Try again in a moment.'
    default:
      return 'Could not start checkout. Try again or contact support.'
  }
}
