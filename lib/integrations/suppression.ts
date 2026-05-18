import 'server-only'
import { createServiceClient } from '@/lib/supabase/service'

/**
 * Global email suppression list (Phase 4B).
 *
 * Backed by `public.email_suppressions` — a system-owned table written only
 * via the service-role client. Used by `lib/integrations/email.ts` to short-
 * circuit sends, and by `app/api/resend/webhook/route.ts` + the unsubscribe
 * endpoint to add new entries.
 *
 * ── FAIL CLOSED VS. FAIL OPEN ──────────────────────────────────────────────
 * If the Supabase query for `isSuppressed` errors out (e.g. transient
 * connectivity), we FAIL CLOSED: return `{ suppressed: true, reason:
 * 'suppression_check_failed' }`. Sending to a suppressed address is a
 * compliance and deliverability hazard (CAN-SPAM, CASL, sender-reputation
 * loss); refusing to send is recoverable on the next retry. The caller's
 * error path will surface the failure for monitoring.
 * ──────────────────────────────────────────────────────────────────────────
 *
 * Marked `server-only` to keep the service-role client off the wire.
 */

export type SuppressionReason = 'bounce_hard' | 'complaint' | 'manual' | 'unsubscribe'

export interface SuppressionCheckResult {
  suppressed: boolean
  /** Present when suppressed=true. Includes the synthetic 'suppression_check_failed'. */
  reason?: SuppressionReason | 'suppression_check_failed'
}

function normalize(email: string | null | undefined): string {
  return (email ?? '').trim().toLowerCase()
}

/**
 * Returns true if the address must NOT be emailed.
 * Empty / malformed addresses are treated as `suppressed:true` with reason
 * `manual` so callers don't accidentally fire a Resend send with garbage.
 */
export async function isSuppressed(email: string): Promise<SuppressionCheckResult> {
  const normalized = normalize(email)
  if (!normalized || !normalized.includes('@')) {
    return { suppressed: true, reason: 'manual' }
  }

  try {
    const supabase = createServiceClient()
    const { data, error } = await supabase
      .from('email_suppressions')
      .select('reason')
      .eq('email', normalized)
      .maybeSingle()

    if (error) {
      // Fail closed — see header comment.
      console.error('[suppression] check failed (failing CLOSED)', { error: error.message })
      return { suppressed: true, reason: 'suppression_check_failed' }
    }

    if (!data) return { suppressed: false }
    const row = data as { reason: SuppressionReason }
    return { suppressed: true, reason: row.reason }
  } catch (err) {
    console.error('[suppression] check threw (failing CLOSED)', err)
    return { suppressed: true, reason: 'suppression_check_failed' }
  }
}

/**
 * Add an entry to the suppression list. Idempotent — if the email is already
 * present, the original reason wins (we don't downgrade `bounce_hard` to
 * `unsubscribe`, for example).
 *
 * Never throws — logs and returns. Callers (webhook, unsubscribe endpoint)
 * must not crash on a transient suppression-insert failure.
 */
export async function addSuppression(
  email: string,
  reason: SuppressionReason,
  source?: string
): Promise<void> {
  const normalized = normalize(email)
  if (!normalized || !normalized.includes('@')) {
    console.warn('[suppression] addSuppression called with invalid email — ignored')
    return
  }

  try {
    const supabase = createServiceClient()
    // ON CONFLICT DO NOTHING semantics — preserve the original reason.
    // (Postgres unique index on email handles dedup; using upsert with
    // ignoreDuplicates lets us avoid a read-before-write.)
    const { error } = await supabase
      .from('email_suppressions')
      .upsert(
        { email: normalized, reason, source: source ?? null },
        { onConflict: 'email', ignoreDuplicates: true }
      )

    if (error) {
      console.error('[suppression] addSuppression failed', {
        reason,
        source,
        error: error.message,
      })
      return
    }

    console.log('[suppression] added', { reason, source })
  } catch (err) {
    console.error('[suppression] addSuppression threw', err)
  }
}
