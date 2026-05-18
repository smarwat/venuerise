import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { enqueueLeadCreated } from '@/lib/jobs/queue'
import { rateLimitWidget, rateLimitedResponse } from '@/lib/rate-limit'
import { log } from '@/lib/log'
import { getOrCreateRequestId, withRequestIdHeader } from '@/lib/observability/request-id'
import { z } from 'zod'

const isDev = process.env.NODE_ENV === 'development'

const WidgetLeadSchema = z.object({
  venue_id: z.string().uuid(),
  name: z.string().min(1).max(100),
  email: z.string().email(),
  phone: z.string().optional().nullable(),
  event_date: z.string().optional().nullable(),
  guest_count: z.number().int().min(1).max(10000).optional().nullable(),
  budget: z.number().min(0).optional().nullable(),
  message: z.string().optional().nullable(),
})

function devError(error: string, detail?: unknown) {
  if (isDev) return { error, detail }
  return { error }
}

export async function POST(request: NextRequest) {
  const requestId = getOrCreateRequestId(request)
  const reqLog = log.child({ requestId, route: '/api/widget' })
  const respond = <T extends Response>(r: T) => withRequestIdHeader(r, requestId)

  // 0. Verify env is loaded
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    reqLog.error(
      {
        hasUrl: !!process.env.NEXT_PUBLIC_SUPABASE_URL,
        hasServiceKey: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
      },
      'widget.config.missing_supabase_env'
    )
    return respond(NextResponse.json(
      devError('Server not configured', 'Supabase env vars missing — check .env.local'),
      { status: 500 }
    ))
  }

  const supabase = createServiceClient()

  // 1. Parse JSON
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return respond(NextResponse.json(devError('Invalid JSON'), { status: 400 }))
  }

  if (isDev) {
    const b = body as Record<string, unknown> | null
    // Email omitted to avoid logging PII; venue_id is non-secret.
    reqLog.debug({ venueId: b?.venue_id }, 'widget.request.received')
  }

  // 2. Validate schema
  const parsed = WidgetLeadSchema.safeParse(body)
  if (!parsed.success) {
    reqLog.warn(
      { errors: parsed.error.flatten().formErrors.length },
      'widget.request.invalid_payload'
    )
    return respond(NextResponse.json(devError('Invalid payload', parsed.error.flatten()), { status: 400 }))
  }

  const { venue_id, name, email, phone, event_date, guest_count, budget, message } = parsed.data

  // 2b. Rate-limit by IP + venue. 10/min sliding (see lib/rate-limit.ts).
  const rl = await rateLimitWidget(request, venue_id)
  if (!rl.allowed) {
    reqLog.warn(
      { venueId: venue_id, retryMs: rl.retryAfterMs, mode: rl.mode },
      'rate_limit.blocked'
    )
    return respond(rateLimitedResponse(rl))
  }

  // 3. Look up venue — distinguish "doesn't exist" vs. "inactive" vs. "db error"
  const { data: venueRow, error: venueErr } = await supabase
    .from('venues')
    .select('id, is_active, name')
    .eq('id', venue_id)
    .maybeSingle()

  if (venueErr) {
    reqLog.error(
      { venueId: venue_id, errorMessage: venueErr.message },
      'widget.venue_lookup.failed'
    )
    return respond(NextResponse.json(
      devError('Database error while looking up venue', venueErr.message),
      { status: 500 }
    ))
  }

  if (!venueRow) {
    reqLog.warn({ venueId: venue_id }, 'widget.venue_lookup.not_found')
    return respond(NextResponse.json(
      devError(
        'Venue not found',
        `No venue exists with id ${venue_id}. Create one in Supabase or use a different venue_id.`
      ),
      { status: 404 }
    ))
  }

  const venue = venueRow as { id: string; is_active: boolean; name: string }

  if (!venue.is_active) {
    reqLog.warn({ venueId: venue_id }, 'widget.venue_lookup.inactive')
    return respond(NextResponse.json(
      devError(
        'Venue is inactive',
        `Venue "${venue.name}" exists but has is_active=false. Set venues.is_active=true in Supabase.`
      ),
      { status: 403 }
    ))
  }

  // 4. Create lead
  const { data: lead, error: leadErr } = await supabase
    .from('leads')
    .insert({
      venue_id,
      name,
      email,
      phone: phone ?? null,
      event_date: event_date ?? null,
      guest_count: guest_count ?? null,
      budget: budget ?? null,
      notes: message ?? null,
      source: 'widget',
      stage: 'new_inquiry',
      lead_score: 0,
      urgency: 'medium',
      ai_active: true,
    })
    .select('id')
    .single()

  if (leadErr || !lead) {
    reqLog.error(
      { venueId: venue_id, errorMessage: leadErr?.message },
      'widget.lead.insert_failed'
    )
    return respond(NextResponse.json(devError('Failed to save lead', leadErr?.message), { status: 500 }))
  }

  const leadData = lead as { id: string }

  // 5. Pre-create the conversation row so we can return its id immediately.
  //    The orchestrator is idempotent: if a conversation for this lead already
  //    exists, it will reuse it rather than create a duplicate.
  const { data: conv, error: convErr } = await supabase
    .from('conversations')
    .insert({
      lead_id: leadData.id,
      venue_id,
      sentiment: 'neutral',
      unread_count: 0,
    })
    .select('id')
    .single()

  if (convErr || !conv) {
    // Non-fatal — orchestrator will create one if missing — but log loudly.
    reqLog.warn(
      { leadId: leadData.id, errorMessage: convErr?.message },
      'widget.conversation.pre_create_failed'
    )
  }

  const conversationId = (conv as { id: string } | null)?.id ?? null

  reqLog.info(
    { leadId: leadData.id, conversationId, venueId: venue_id },
    'widget.lead.created'
  )

  // 6. Enqueue AI qualification on the job runtime. The request id is
  //    threaded through so every downstream log line (job handler,
  //    orchestrator, email send, webhook update) can be correlated.
  try {
    await enqueueLeadCreated({
      lead_id: leadData.id,
      conversation_id: conversationId,
      request_id: requestId,
    })
    reqLog.info({ leadId: leadData.id }, 'widget.job.enqueued')
  } catch (err) {
    // Even if enqueue fails, the lead is in the DB — the visitor sees success.
    // A monitor on ai_actions / Inngest dashboard will catch the gap.
    reqLog.error({ err, leadId: leadData.id }, 'widget.job.enqueue_failed')
  }

  return respond(NextResponse.json(
    { success: true, lead_id: leadData.id, conversation_id: conversationId },
    { status: 201 }
  ))
}
