// public route — anonymous widget intake. No authenticated actor
// to attribute. Every successful POST writes a `leads` row whose
// `source` column ('widget') + `created_at` timestamp give the
// forensic trail; the orchestrator's downstream side effects
// (qualification, follow-up) emit their own pino + ai_actions
// records. Per Phase 9A "don't touch widget intake," this stays
// out of `audit_events`. Documented in docs/AUDIT-COVERAGE.md.
import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { enqueueLeadCreated } from '@/lib/jobs/queue'
import { rateLimitWidget, rateLimitedResponse } from '@/lib/rate-limit'
import { log } from '@/lib/log'
import { getOrCreateRequestId, withRequestIdHeader } from '@/lib/observability/request-id'
import { captureApiError } from '@/lib/observability/sentry'
import { z } from 'zod'
// Phase 8BH — Lead attribution capture. Parses the optional
// `attribution` payload submitted by the widget JS (UTM, click
// ids, landing page, referrer) into the canonical metadata
// shape so the dashboard can render source labels + the
// AttributionPerformanceCard.
import { parseLeadAttribution } from '@/lib/enterprise/attribution/parse'

const isDev = process.env.NODE_ENV === 'development'

/**
 * Phase 7A — widget origin allowlist.
 *
 * The widget is intentionally a public endpoint (any visitor on a venue's
 * site can submit a lead), but in production we don't want random scripts
 * on the open internet POSTing to it. A lightweight Origin check raises
 * the floor without breaking the legitimate flows.
 *
 * Allowed callers:
 *   - Requests with NO Origin header (curl, server-to-server, native fetch
 *     from server runtimes) — accepted in BOTH dev and prod. The widget
 *     /api/widget/[venueId]/config GET is the cache-friendly path; POST
 *     bodies come from browsers and *do* set Origin.
 *   - Origin matches NEXT_PUBLIC_APP_URL.
 *   - In development: any localhost / 127.0.0.1 / 0.0.0.0 origin.
 *
 * Rejected: a real-looking but non-matching Origin in production.
 *
 * KNOWN LIMITATION: there's no per-venue `allowed_origins` column yet, so
 * we can't yet allow a real venue website (e.g. https://magnolia.com) to
 * embed. Track in docs/SECURITY.md → "Widget origin allowlist".
 */
function isOriginAllowed(request: Request): boolean {
  const origin = request.headers.get('origin')
  if (!origin) return true // curl / server-to-server / native fetch
  const trimmed = origin.trim().toLowerCase()
  if (trimmed === 'null') return true // file:// or sandboxed iframes
  const appUrl = (process.env.NEXT_PUBLIC_APP_URL ?? '').trim().toLowerCase()
  if (appUrl) {
    try {
      const appOrigin = new URL(appUrl).origin.toLowerCase()
      if (trimmed === appOrigin) return true
    } catch {
      // Malformed env value — fall through to dev allowance.
    }
  }
  if (isDev) {
    try {
      const u = new URL(trimmed)
      if (
        u.hostname === 'localhost' ||
        u.hostname === '127.0.0.1' ||
        u.hostname === '0.0.0.0'
      ) {
        return true
      }
    } catch {
      return false
    }
  }
  return false
}

// Phase 8BH — optional attribution payload. Every field is
// optional + length-clamped at the parser layer so a malformed
// or missing field never blocks intake. UTM aliases (`utm_*`)
// are accepted so the widget JS can pass through whatever the
// landing page had without server-side renaming.
const AttributionSchema = z
  .object({
    source: z.string().max(500).optional().nullable(),
    medium: z.string().max(500).optional().nullable(),
    campaign: z.string().max(500).optional().nullable(),
    term: z.string().max(500).optional().nullable(),
    content: z.string().max(500).optional().nullable(),
    utm_source: z.string().max(500).optional().nullable(),
    utm_medium: z.string().max(500).optional().nullable(),
    utm_campaign: z.string().max(500).optional().nullable(),
    utm_term: z.string().max(500).optional().nullable(),
    utm_content: z.string().max(500).optional().nullable(),
    landing_page: z.string().max(500).optional().nullable(),
    referrer: z.string().max(500).optional().nullable(),
    gclid: z.string().max(200).optional().nullable(),
    fbclid: z.string().max(200).optional().nullable(),
    msclkid: z.string().max(200).optional().nullable(),
    ttclid: z.string().max(200).optional().nullable(),
    captured_at: z.string().max(60).optional().nullable(),
  })
  .strict()
  .optional()
  .nullable()

const WidgetLeadSchema = z.object({
  venue_id: z.string().uuid(),
  name: z.string().min(1).max(100),
  email: z.string().email(),
  phone: z.string().optional().nullable(),
  event_date: z.string().optional().nullable(),
  guest_count: z.number().int().min(1).max(10000).optional().nullable(),
  budget: z.number().min(0).optional().nullable(),
  message: z.string().optional().nullable(),
  attribution: AttributionSchema,
})

function devError(error: string, detail?: unknown) {
  if (isDev) return { error, detail }
  return { error }
}

export async function POST(request: NextRequest) {
  const requestId = getOrCreateRequestId(request)
  const reqLog = log.child({ requestId, route: '/api/widget' })
  const respond = <T extends Response>(r: T) => withRequestIdHeader(r, requestId)

  // Origin allowlist — block scripts on random domains. See isOriginAllowed.
  if (!isOriginAllowed(request)) {
    reqLog.warn(
      { origin: request.headers.get('origin') ?? null },
      'widget.origin_not_allowed'
    )
    return respond(NextResponse.json({ error: 'origin_not_allowed' }, { status: 403 }))
  }

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

  const {
    venue_id,
    name,
    email,
    phone,
    event_date,
    guest_count,
    budget,
    message,
    attribution,
  } = parsed.data

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
    captureApiError(venueErr, { requestId, route: '/api/widget', venueId: venue_id })
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
  //
  // PHASE 7D — INTENTIONALLY NOT BILLING-GATED.
  //
  // Public widget submissions are intentionally not subscription-gated.
  // The visitor experience should never fail because the venue has billing
  // issues — they're a prospect, not a customer of ours. We accept the
  // lead, persist it, and let the orchestrator do its work. Downstream
  // AI/follow-up cost is bounded by Inngest concurrency + Anthropic retry
  // limits, so a billing-lapsed venue can't run up an unbounded bill.
  //
  // If we ever need to soft-gate the widget (e.g. show a "venue closed"
  // landing instead of accepting the lead), do it via `venues.is_active`
  // — which already drives a 403 path above — not via the subscription
  // table. Subscription state belongs to the OWNER's relationship with us,
  // not to the visitor's relationship with the venue.
  // Phase 8BH — Always run the attribution parser, even when
  // the widget didn't submit any UTM fields. The result with
  // an empty input is the safe `Unknown` shape and we stamp
  // `channel_type: 'website'` so the dashboard groups the
  // lead under the Website source label rather than Unknown.
  const attributionMetadata = parseLeadAttribution({
    ...(attribution ?? {}),
    channel_type: 'website',
    captured_at: attribution?.captured_at ?? new Date().toISOString(),
  })

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
      metadata: { attribution: attributionMetadata },
    })
    .select('id')
    .single()

  if (leadErr || !lead) {
    reqLog.error(
      { venueId: venue_id, errorMessage: leadErr?.message },
      'widget.lead.insert_failed'
    )
    captureApiError(leadErr ?? new Error('lead insert returned no row'), {
      requestId, route: '/api/widget', venueId: venue_id,
    })
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
    captureApiError(err, {
      requestId, route: '/api/widget', venueId: venue_id, leadId: leadData.id,
    })
  }

  return respond(NextResponse.json(
    { success: true, lead_id: leadData.id, conversation_id: conversationId },
    { status: 201 }
  ))
}
