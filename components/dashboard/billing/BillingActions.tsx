'use client'

import { useState } from 'react'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/dashboard/ui/Button'

/**
 * Phase 7D — billing CTA button.
 *
 * Posts to /api/billing/checkout or /api/billing/portal and redirects the
 * browser to the Stripe-hosted URL returned in the response. We deliberately
 * use `window.location.assign` rather than a Next router push: Stripe URLs
 * are absolute https URLs on a different origin, and we want the user to
 * land fully on Stripe's domain (not in an iframe).
 *
 * Errors render inline below the button. No toast library required.
 */

interface BillingActionsProps {
  mode: 'checkout' | 'portal'
  label?: string
  /** Optional className for the button (passed straight through). */
  className?: string
  variant?: React.ComponentProps<typeof Button>['variant']
  size?: React.ComponentProps<typeof Button>['size']
}

export default function BillingActions({
  mode,
  label,
  className,
  variant = 'primary',
  size = 'md',
}: BillingActionsProps) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const defaultLabel = mode === 'checkout' ? 'Start subscription' : 'Manage billing'
  const url = mode === 'checkout' ? '/api/billing/checkout' : '/api/billing/portal'

  async function handleClick() {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: mode === 'checkout' ? JSON.stringify({}) : undefined,
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
          : `Request failed (${res.status})`
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
        disabled={busy}
        variant={variant}
        size={size}
        className={className}
      >
        {busy && <Loader2 className="h-4 w-4 animate-spin" />}
        {busy ? (mode === 'checkout' ? 'Opening checkout…' : 'Opening portal…') : (label ?? defaultLabel)}
      </Button>
      {error && (
        <div className="text-xs text-[#B91C1C]">{error}</div>
      )}
    </div>
  )
}

function humanize(code: string, mode: 'checkout' | 'portal'): string {
  switch (code) {
    case 'unauthorized':
      return 'Please sign in again.'
    case 'no_venue':
      return 'No active workspace found.'
    case 'forbidden':
      return 'Only owners and admins can manage billing.'
    case 'billing_not_configured':
      return 'Billing is not configured for this deploy. Contact support.'
    case 'price_id_missing':
      return 'No subscription plan is configured. Contact support.'
    case 'billing_customer_not_found':
      return mode === 'portal'
        ? 'You haven’t started a subscription yet — start one first.'
        : 'No billing customer on file.'
    case 'stripe_failed':
      return 'Stripe returned an error. Try again in a moment.'
    default:
      return code
  }
}
