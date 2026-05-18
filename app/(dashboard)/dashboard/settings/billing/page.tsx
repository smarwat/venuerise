import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { getCurrentVenueForUser } from '@/lib/auth/tenant-access'
import { getVenueSubscriptionStatus } from '@/lib/billing/subscription-status'
import PageHeader from '@/components/dashboard/PageHeader'
import BillingStatusCard from '@/components/dashboard/billing/BillingStatusCard'

export const dynamic = 'force-dynamic'

/**
 * Phase 7D — /dashboard/settings/billing
 *
 * Server-rendered. Reads the venue's subscription status via the helper
 * (service-role internally, request-memoized) and renders a single status
 * card with the right action set. The card is pure UI — all server →
 * Stripe round-trips happen via BillingActions → /api/billing/{checkout,portal}.
 */
export default async function BillingSettingsPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const venue = await getCurrentVenueForUser(user.id)
  if (!venue) redirect('/onboarding')

  // Tolerate a transient status read failure — the card falls through to
  // its "unknown" state and the user can still hit the manage-billing CTA.
  let status: Awaited<ReturnType<typeof getVenueSubscriptionStatus>>
  try {
    status = await getVenueSubscriptionStatus(venue.venueId)
  } catch {
    status = { kind: 'unknown', raw_status: 'read_failed' }
  }

  return (
    <div className="p-6 lg:p-8 animate-slide-up">
      <PageHeader
        title="Billing"
        subtitle="Manage your subscription, payment method, and invoice history."
      />
      <div className="space-y-6">
        <BillingStatusCard status={status} />
      </div>
    </div>
  )
}
