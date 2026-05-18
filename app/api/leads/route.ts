import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { rateLimitUserAction, rateLimitedResponse } from '@/lib/rate-limit'
import { log } from '@/lib/log'
import { getOrCreateRequestId, withRequestIdHeader } from '@/lib/observability/request-id'
import { captureApiError } from '@/lib/observability/sentry'
import { getCurrentVenueForUser } from '@/lib/auth/tenant-access'
import { SALES_ROLES } from '@/lib/auth/roles'
import { requireActiveSubscription, SubscriptionRequiredError } from '@/lib/billing/subscription-status'
import { z } from 'zod'

const CreateLeadSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  phone: z.string().optional().nullable(),
  stage: z.enum(['new_inquiry', 'qualified', 'tour_scheduled', 'tour_completed', 'negotiation', 'booked', 'lost']).default('new_inquiry'),
  urgency: z.enum(['low', 'medium', 'high', 'critical']).default('medium'),
  event_date: z.string().optional().nullable(),
  guest_count: z.number().int().optional().nullable(),
  budget: z.number().optional().nullable(),
  source: z.string().default('dashboard'),
  notes: z.string().optional().nullable(),
})

export async function GET(request: NextRequest) {
  const requestId = getOrCreateRequestId(request)
  const respond = <T extends Response>(r: T) => withRequestIdHeader(r, requestId)

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return respond(NextResponse.json({ error: 'Unauthorized' }, { status: 401 }))

  // Phase 6B: any member (readonly+) can list leads.
  const venue = await getCurrentVenueForUser(user.id)
  if (!venue) return respond(NextResponse.json({ error: 'Venue not found' }, { status: 404 }))

  const { searchParams } = new URL(request.url)
  const stage = searchParams.get('stage')

  let query = supabase
    .from('leads')
    .select('*')
    .eq('venue_id', venue.venueId)
    .order('created_at', { ascending: false })

  if (stage) query = query.eq('stage', stage)

  const { data, error } = await query
  if (error) {
    captureApiError(error, { requestId, route: '/api/leads', userId: user.id, venueId: venue.venueId })
    return respond(NextResponse.json({ error: error.message }, { status: 500 }))
  }

  return respond(NextResponse.json(data))
}

export async function POST(request: NextRequest) {
  const requestId = getOrCreateRequestId(request)
  const reqLog = log.child({ requestId, route: '/api/leads' })
  const respond = <T extends Response>(r: T) => withRequestIdHeader(r, requestId)

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return respond(NextResponse.json({ error: 'Unauthorized' }, { status: 401 }))

  // Rate limit manual lead creation per user (dashboard-facing). 30/min.
  // GET is intentionally not rate-limited — it's a read-heavy list view.
  const rl = await rateLimitUserAction(request, `leads:create:${user.id}`)
  if (!rl.allowed) {
    reqLog.warn({ userId: user.id, retryMs: rl.retryAfterMs }, 'rate_limit.blocked')
    return respond(rateLimitedResponse(rl))
  }

  // Phase 6B: only SALES_ROLES can create leads. Viewers are read-only.
  const venue = await getCurrentVenueForUser(user.id)
  if (!venue) return respond(NextResponse.json({ error: 'Venue not found' }, { status: 404 }))
  if (!(SALES_ROLES as readonly string[]).includes(venue.role)) {
    return respond(NextResponse.json({ error: 'forbidden' }, { status: 403 }))
  }

  // Phase 7D — billing gate (no-op when BILLING_GATE_ENABLED !== '1').
  try {
    await requireActiveSubscription(venue.venueId, { requestId, route: '/api/leads' })
  } catch (err) {
    if (err instanceof SubscriptionRequiredError) {
      return respond(NextResponse.json(
        { error: err.code, subscription_status: err.subscriptionStatus.kind },
        { status: err.status }
      ))
    }
    throw err
  }

  const body = await request.json()
  const parsed = CreateLeadSchema.safeParse(body)
  if (!parsed.success) return respond(NextResponse.json({ error: parsed.error.flatten() }, { status: 400 }))

  const { data, error } = await supabase
    .from('leads')
    .insert({ ...parsed.data, venue_id: venue.venueId, lead_score: 0 })
    .select()
    .single()

  if (error) {
    captureApiError(error, { requestId, route: '/api/leads', userId: user.id, venueId: venue.venueId })
    return respond(NextResponse.json({ error: error.message }, { status: 500 }))
  }

  return respond(NextResponse.json(data, { status: 201 }))
}
