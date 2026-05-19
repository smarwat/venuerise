import { NextRequest } from 'next/server'
import { handleTourActionRequest } from '@/lib/integrations/tour-action-token'

/**
 * Phase 8K — public lead-facing tour cancellation endpoint.
 *
 *   GET /tour/cancel?token=<signed>
 *
 * Verifies the HMAC token, validates the tour can still be cancelled
 * (status ∈ {scheduled, confirmed} AND scheduled_at in the future),
 * flips status to `cancelled`, and fires the Phase 8G `cancelled`
 * notification email. Renders a small inline HTML page back to the lead.
 *
 * Auth: the token IS the auth (see `/tour/confirm` for full design notes).
 * Per-IP rate limit is applied inside the handler.
 */
export async function GET(request: NextRequest): Promise<Response> {
  return handleTourActionRequest(request, 'cancel')
}
