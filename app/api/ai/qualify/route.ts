import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { handleNewLead } from '@/lib/agents/orchestrator'
import { verifyInternalRequest, INTERNAL_SIGNATURE_HEADER } from '@/lib/auth/internal-hmac'
import { assertOwnsLead, OwnershipError } from '@/lib/auth/assert-ownership'
import { SALES_ROLES } from '@/lib/auth/roles'
import { requireActiveSubscription, SubscriptionRequiredError } from '@/lib/billing/subscription-status'
import { rateLimitAi, rateLimitedResponse } from '@/lib/rate-limit'
import { log } from '@/lib/log'
import { getOrCreateRequestId, withRequestIdHeader } from '@/lib/observability/request-id'
import { captureApiError } from '@/lib/observability/sentry'
import { z } from 'zod'

const isDev = process.env.NODE_ENV === 'development'

const Schema = z.object({
  lead_id: z.string().uuid(),
  conversation_id: z.string().uuid().nullable().optional(),
  source: z.string().optional(),
})

function devError(error: string, detail?: unknown) {
  return isDev ? { error, detail } : { error }
}

export async function POST(request: NextRequest) {
  const requestId = getOrCreateRequestId(request)
  const reqLog = log.child({ requestId, route: '/api/ai/qualify' })
  const respond = <T extends Response>(r: T) => withRequestIdHeader(r, requestId)

  // 1. Parse + validate body
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return respond(NextResponse.json(devError('Invalid JSON'), { status: 400 }))
  }

  const parsed = Schema.safeParse(body)
  if (!parsed.success) {
    return respond(NextResponse.json(devError('Invalid payload', parsed.error.flatten()), { status: 400 }))
  }
  const { lead_id, conversation_id } = parsed.data

  // 2. Auth — try signed internal first, then user session. Reject anonymous.
  const signature = request.headers.get(INTERNAL_SIGNATURE_HEADER)
  const isInternalCall = !!signature && verifyInternalRequest(parsed.data, signature)

  let venueId: string | null = null

  if (isInternalCall) {
    // Internal mode — service-to-service. Resolve the venue from the lead.
    // RLS bypassed because this is a server-only signed call.
    const svc = createServiceClient()
    const { data: leadRow, error: leadErr } = await svc
      .from('leads')
      .select('venue_id')
      .eq('id', lead_id)
      .maybeSingle()

    if (leadErr) {
      reqLog.error(
        { mode: 'internal', leadId: lead_id, errorMessage: leadErr.message },
        'ai.qualify.lead_lookup_failed'
      )
      captureApiError(leadErr, { requestId, route: '/api/ai/qualify', leadId: lead_id })
      return respond(NextResponse.json(devError('Lead lookup failed', leadErr.message), { status: 500 }))
    }
    if (!leadRow) {
      reqLog.warn({ mode: 'internal', leadId: lead_id }, 'ai.qualify.lead_not_found')
      return respond(NextResponse.json(devError('Lead not found', lead_id), { status: 404 }))
    }
    venueId = (leadRow as { venue_id: string }).venue_id
  } else if (signature) {
    // A signature was sent but it didn't verify — explicitly reject.
    reqLog.warn({}, 'ai.qualify.bad_internal_signature')
    return respond(NextResponse.json({ error: 'Unauthorized' }, { status: 401 }))
  } else {
    // User mode — fall back to Supabase session + ownership check.
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return respond(NextResponse.json({ error: 'Unauthorized' }, { status: 401 }))

    // Rate limit user-initiated requalification. Internal HMAC calls (above)
    // are intentionally exempt — those come from our own job runtime and
    // are governed by Inngest concurrency, not per-request budgets.
    const rl = await rateLimitAi(request, `qualify:user:${user.id}`)
    if (!rl.allowed) {
      reqLog.warn({ userId: user.id, retryMs: rl.retryAfterMs, mode: rl.mode }, 'rate_limit.blocked')
      return respond(rateLimitedResponse(rl))
    }

    try {
      // User-initiated requalification is a write action — gate to SALES_ROLES.
      // Internal HMAC mode (above) is intentionally exempt: it's our own
      // job runtime, governed by Inngest concurrency, not user RBAC.
      const own = await assertOwnsLead(supabase, user.id, lead_id, SALES_ROLES)
      venueId = own.venue_id
    } catch (err) {
      if (err instanceof OwnershipError) {
        // 404 (not 403) to avoid disclosing existence of leads in other tenants.
        return respond(NextResponse.json({ error: 'Lead not found' }, { status: 404 }))
      }
      throw err
    }

    // Phase 7D — billing gate applies to USER mode only. Internal HMAC mode
    // skips the gate because the job runtime drives qualification for new
    // leads regardless of billing state (we don't punish the lead for the
    // venue's lapsed payment — see widget exception comment below).
    try {
      await requireActiveSubscription(venueId, { requestId, route: '/api/ai/qualify' })
    } catch (err) {
      if (err instanceof SubscriptionRequiredError) {
        return respond(NextResponse.json(
          { error: err.code, subscription_status: err.subscriptionStatus.kind },
          { status: err.status }
        ))
      }
      throw err
    }
  }

  if (!venueId) {
    return respond(NextResponse.json(devError('Unable to resolve venue for lead'), { status: 500 }))
  }

  // 3. Run orchestrator
  reqLog.info({ leadId: lead_id, venueId }, 'ai.qualify.started')
  try {
    const result = await handleNewLead(lead_id, venueId, conversation_id ?? null, requestId)
    reqLog.info({ leadId: lead_id, venueId }, 'ai.qualify.completed')
    return respond(NextResponse.json(result))
  } catch (err) {
    const message = err instanceof Error ? err.message : 'AI qualification failed'
    reqLog.error({ err, leadId: lead_id, venueId }, 'ai.qualify.failed')
    captureApiError(err, { requestId, route: '/api/ai/qualify', leadId: lead_id, venueId })
    return respond(NextResponse.json(devError(message), { status: 500 }))
  }
}
