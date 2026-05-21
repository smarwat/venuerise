'use client'

import { useState } from 'react'
import { ArrowUpRight, Loader2 } from 'lucide-react'
import { Button } from '@/components/dashboard/ui/Button'

/**
 * Phase 9Q — PaymentMethodsCard action button.
 *
 * Mirrors the BillingActions pattern (Phase 7D) but tags the audit
 * source so admins can tell "operator clicked Manage from the new
 * Payment Methods card" apart from "operator clicked Manage from the
 * existing BillingStatusCard" in the enterprise audit feed.
 *
 * The flow is identical:
 *   - POST /api/billing/portal   when there's an existing Stripe customer
 *   - POST /api/billing/checkout when there isn't
 *   - The route returns `{ url }` and we hard-redirect via
 *     `window.location.assign` so the user lands fully on Stripe's
 *     origin (never in an iframe).
 *
 * Errors render inline below the button — same error vocabulary as
 * BillingActions, plus a couple of Phase 9Q-specific safe codes.
 */

interface Props {
  mode: 'portal' | 'checkout'
  disabled?: boolean
}

export default function PaymentMethodActions({ mode, disabled }: Props) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const label = mode === 'portal' ? 'Manage payment method' : 'Set up billing'
  const url = mode === 'portal' ? '/api/billing/portal' : '/api/billing/checkout'

  async function handleClick() {
    if (disabled) return
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Phase 9Q — `source` tags the audit row. Only the portal
        // route reads this; checkout is left as-is (the audit
        // metadata already captures the price-id intent).
        body: JSON.stringify(
          mode === 'portal' ? { source: 'payment_methods_card' } : {}
        ),
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
      setError(humanize(code, mode))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Network error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="inline-flex flex-col items-stretch gap-2">
      <Button
        onClick={handleClick}
        disabled={disabled || busy}
        variant="primary"
        size="md"
      >
        {busy && <Loader2 className="h-4 w-4 animate-spin" />}
        {busy
          ? mode === 'portal'
            ? 'Opening Stripe portal…'
            : 'Opening checkout…'
          : label}
        {!busy && <ArrowUpRight className="h-3.5 w-3.5" />}
      </Button>
      {error && (
        <div className="text-[12px] text-[#B91C1C] max-w-xs leading-relaxed">
          {error}
        </div>
      )}
    </div>
  )
}

function humanize(code: string, mode: 'portal' | 'checkout'): string {
  switch (code) {
    case 'unauthorized':
      return 'Please sign in again to manage billing.'
    case 'forbidden':
      return 'Only venue owners and admins can manage billing.'
    case 'no_venue':
    case 'venue_not_found':
      return 'No active workspace found.'
    case 'billing_not_configured':
      return 'Stripe is not configured for this deploy. Contact support.'
    case 'billing_customer_not_found':
    case 'stripe_customer_missing':
      return mode === 'portal'
        ? 'Stripe customer missing. Start checkout first to set up billing.'
        : 'No billing customer on file.'
    case 'price_id_missing':
      return 'No subscription plan is configured. Contact support.'
    case 'stripe_failed':
    case 'portal_session_failed':
      return 'Could not open Stripe portal. Try again or contact support.'
    case 'rate_limited':
      return 'Too many billing requests. Wait a moment and try again.'
    default:
      return mode === 'portal'
        ? 'Could not open Stripe portal. Try again or contact support.'
        : 'Could not start checkout. Try again or contact support.'
  }
}
