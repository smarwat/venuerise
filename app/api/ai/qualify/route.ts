import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { handleNewLead } from '@/lib/agents/orchestrator'
import { verifyInternalRequest, INTERNAL_SIGNATURE_HEADER } from '@/lib/auth/internal-hmac'
import { assertOwnsLead, OwnershipError } from '@/lib/auth/assert-ownership'
import { rateLimitAi, rateLimitedResponse } from '@/lib/rate-limit'
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
  // 1. Parse + validate body
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json(devError('Invalid JSON'), { status: 400 })
  }

  const parsed = Schema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(devError('Invalid payload', parsed.error.flatten()), { status: 400 })
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
      if (isDev) console.error('[qualify:internal] lead lookup error:', leadErr)
      return NextResponse.json(devError('Lead lookup failed', leadErr.message), { status: 500 })
    }
    if (!leadRow) {
      if (isDev) console.warn('[qualify:internal] lead not found:', lead_id)
      return NextResponse.json(devError('Lead not found', lead_id), { status: 404 })
    }
    venueId = (leadRow as { venue_id: string }).venue_id
  } else if (signature) {
    // A signature was sent but it didn't verify — explicitly reject.
    if (isDev) console.warn('[qualify] bad internal signature')
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  } else {
    // User mode — fall back to Supabase session + ownership check.
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    // Rate limit user-initiated requalification. Internal HMAC calls (above)
    // are intentionally exempt — those come from our own job runtime and
    // are governed by Inngest concurrency, not per-request budgets.
    const rl = await rateLimitAi(request, `qualify:user:${user.id}`)
    if (!rl.allowed) return rateLimitedResponse(rl)

    try {
      const own = await assertOwnsLead(supabase, user.id, lead_id)
      venueId = own.venue_id
    } catch (err) {
      if (err instanceof OwnershipError) {
        // 404 (not 403) to avoid disclosing existence of leads in other tenants.
        return NextResponse.json({ error: 'Lead not found' }, { status: 404 })
      }
      throw err
    }
  }

  if (!venueId) {
    return NextResponse.json(devError('Unable to resolve venue for lead'), { status: 500 })
  }

  // 3. Run orchestrator
  try {
    const result = await handleNewLead(lead_id, venueId, conversation_id ?? null)
    return NextResponse.json(result)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'AI qualification failed'
    if (isDev) console.error('[qualify] orchestrator failed:', err)
    return NextResponse.json(devError(message), { status: 500 })
  }
}
