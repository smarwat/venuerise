import { NextRequest } from 'next/server'
import { handleTourActionRequest } from '@/lib/integrations/tour-action-token'

/**
 * Phase 8K — public lead-facing tour confirmation endpoint.
 *
 *   GET /tour/confirm?token=<signed>
 *
 * Verifies the HMAC token, validates the tour can be confirmed, flips
 * status `scheduled → confirmed`, and fires the Phase 8G `confirmed`
 * notification email. Renders a small inline HTML page back to the lead.
 *
 * Auth: the token IS the auth — no session required, no cookies, no
 * CSRF token. The token's HMAC signature + short TTL is the entire
 * trust boundary. Per-IP rate limit is applied inside the handler.
 *
 * All branching + response shaping lives in `handleTourActionRequest`
 * so this file stays a one-line wrapper that anchors the route to
 * `action: 'confirm'`.
 */
export async function GET(request: NextRequest): Promise<Response> {
  return handleTourActionRequest(request, 'confirm')
}
