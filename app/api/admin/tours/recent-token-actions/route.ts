import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createServiceClient } from '@/lib/supabase/service'
import { requireAdmin } from '@/lib/auth/require-admin'
import { requireVenueRole, TenantAccessError } from '@/lib/auth/tenant-access'
import { ADMIN_ROLES } from '@/lib/auth/roles'
import { rateLimitUserAction, rateLimitedResponse } from '@/lib/rate-limit'
import { log } from '@/lib/log'
import { getOrCreateRequestId, withRequestIdHeader } from '@/lib/observability/request-id'
import { captureApiError } from '@/lib/observability/sentry'

/**
 * GET /api/admin/tours/recent-token-actions  (Phase 8K → rewritten in 8L)
 *
 * Phase 8K shipped this as a best-effort proxy via `tours.updated_at`
 * (couldn't distinguish public-token transitions from operator-dashboard
 * ones). Phase 8L promotes it to a real audit feed reading from the new
 * `tour_action_events` table, joined to `leads` for the operator UI.
 *
 * ── AUTH / TENANT ─────────────────────────────────────────────────────────
 *   - `requireAdmin()` first.
 *   - Optional `venue_id` overrides the caller's primary venue;
 *     cross-tenant access re-verified via `requireVenueRole(ADMIN_ROLES)`.
 *     Cross-tenant denial collapses to 404 (no UUID enumeration).
 *   - Per-caller rate limit `admin:tours-recent-token-actions:{userId}`.
 *
 * ── QUERY STRATEGY ────────────────────────────────────────────────────────
 * Two service-role round-trips:
 *   1. SELECT the last N `tour_action_events` rows for the venue.
 *   2. Batch-resolve `lead_id`s via a single `IN ()` against `leads`.
 *
 * The split keeps the Supabase typing trivially correct (PostgREST's
 * foreign-table joins go through a TypeScript inference path that bites
 * when the column types aren't generated). It also lets us return
 * `lead_name`/`lead_email` for rows whose `lead_id` is null (deleted
 * lead) — those columns just come back as null.
 *
 * ── PII POSTURE ───────────────────────────────────────────────────────────
 *   - `token_nonce` is NEVER returned. It exists only as the single-use
 *     claim in the DB.
 *   - `source_ip` is already CIDR-masked by the route handler at insert
 *     time (192.168.1.42 → 192.168.1.0). The DB never holds the raw IP.
 *   - `user_agent` is capped at 500 chars at the handler boundary.
 *   - Lead email is returned because admins legitimately need it for
 *     "who clicked what?" triage; the admin role gate is the access
 *     control surface.
 */

const QuerySchema = z.object({
  venue_id: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
})

interface EventRow {
  id: string
  venue_id: string
  tour_id: string
  lead_id: string | null
  action: 'confirm' | 'cancel' | string
  source_ip: string | null
  user_agent: string | null
  occurred_at: string
}

interface LeadLookupRow {
  id: string
  name: string | null
  email: string | null
}

export async function GET(request: NextRequest) {
  const requestId = getOrCreateRequestId(request)
  const reqLog = log.child({
    requestId,
    route: '/api/admin/tours/recent-token-actions',
  })
  // Phase 8M — this endpoint is superseded by the unified
  // `/api/admin/tours/status-events` (filter `actor_kind=lead_token` for
  // an equivalent slice). We keep the route mounted for one release
  // cycle and tag every response with the standard HTTP Deprecation +
  // Link/successor-version headers so client SDKs can surface a warning
  // and dashboards can route operators to the new path.
  const respond = <T extends Response>(r: T) => {
    const withId = withRequestIdHeader(r, requestId)
    withId.headers.set('Deprecation', 'true')
    withId.headers.set(
      'Link',
      '</api/admin/tours/status-events?actor_kind=lead_token>; rel="successor-version"'
    )
    return withId
  }

  // 1. Auth.
  const admin = await requireAdmin()
  if (!admin.ok) {
    return respond(NextResponse.json({ error: admin.code }, { status: admin.status }))
  }
  const { user, venueId: callerVenueId } = admin

  // 2. Rate-limit.
  const rl = await rateLimitUserAction(
    request,
    `admin:tours-recent-token-actions:${user.id}`
  )
  if (!rl.allowed) {
    reqLog.warn({ userId: user.id, retryMs: rl.retryAfterMs }, 'rate_limit.blocked')
    return respond(rateLimitedResponse(rl))
  }

  // 3. Validate query.
  const url = new URL(request.url)
  const queryParsed = QuerySchema.safeParse({
    venue_id: url.searchParams.get('venue_id') ?? undefined,
    limit: url.searchParams.get('limit') ?? undefined,
  })
  if (!queryParsed.success) {
    return respond(
      NextResponse.json(
        { error: 'validation_failed', detail: queryParsed.error.flatten() },
        { status: 400 }
      )
    )
  }
  const { venue_id: bodyVenueId, limit } = queryParsed.data

  // 4. Resolve target venue + tenant bind.
  const targetVenueId = bodyVenueId ?? callerVenueId
  if (targetVenueId !== callerVenueId) {
    try {
      await requireVenueRole(user.id, targetVenueId, ADMIN_ROLES)
    } catch (err) {
      if (err instanceof TenantAccessError) {
        if (err.status === 403) {
          return respond(NextResponse.json({ error: 'not_found' }, { status: 404 }))
        }
        return respond(NextResponse.json({ error: err.code }, { status: err.status }))
      }
      throw err
    }
  }

  // 5. Phase 8L — read from the real audit table.
  // NOTE: `token_nonce` is intentionally excluded from the SELECT.
  // PostgREST's column-narrowing means we can't accidentally leak it
  // even if a future operator copy-pastes the response into a log.
  const svc = createServiceClient()
  const { data: eventsRaw, error: eventsErr } = await svc
    .from('tour_action_events')
    .select(
      'id, venue_id, tour_id, lead_id, action, source_ip, user_agent, occurred_at'
    )
    .eq('venue_id', targetVenueId)
    .order('occurred_at', { ascending: false })
    .limit(limit)

  if (eventsErr) {
    reqLog.error(
      { err: eventsErr },
      'admin.tours_recent_token_actions.events_query_failed'
    )
    captureApiError(eventsErr, {
      requestId,
      route: '/api/admin/tours/recent-token-actions',
      userId: user.id,
      venueId: targetVenueId,
    })
    return respond(NextResponse.json({ error: 'unexpected_error' }, { status: 500 }))
  }

  const events = (eventsRaw ?? []) as EventRow[]

  // 6. Batch-resolve lead identities. Deduplicate lead_ids first so a
  // run of 50 events for the same lead doesn't pull 50 identical rows.
  const leadIds = Array.from(
    new Set(
      events
        .map((e) => e.lead_id)
        .filter((id): id is string => typeof id === 'string' && id.length > 0)
    )
  )
  const leadById = new Map<string, LeadLookupRow>()
  if (leadIds.length > 0) {
    const { data: leadsRaw, error: leadsErr } = await svc
      .from('leads')
      .select('id, name, email')
      .in('id', leadIds)
    if (leadsErr) {
      // We don't fail the whole request — leads lookup is non-critical.
      // The operator sees event rows with null lead_name/lead_email and
      // can pivot through `lead_id` themselves if needed.
      reqLog.warn(
        { err: leadsErr, leadIdCount: leadIds.length },
        'admin.tours_recent_token_actions.leads_query_failed'
      )
    } else {
      for (const row of (leadsRaw ?? []) as LeadLookupRow[]) {
        leadById.set(row.id, row)
      }
    }
  }

  // 7. Compose the response. Map shape matches the Phase 8L prompt
  // exactly — admin UIs / dashboards can rely on this contract.
  const items = events.map((e) => {
    const lead = e.lead_id ? leadById.get(e.lead_id) ?? null : null
    return {
      id: e.id,
      venue_id: e.venue_id,
      tour_id: e.tour_id,
      lead_id: e.lead_id,
      lead_name: lead?.name ?? null,
      lead_email: lead?.email ?? null,
      action: e.action,
      source_ip: e.source_ip,
      user_agent: e.user_agent,
      occurred_at: e.occurred_at,
    }
  })

  reqLog.info(
    {
      userId: user.id,
      venueId: targetVenueId,
      returned: items.length,
      leadsResolved: leadById.size,
    },
    'admin.tours_recent_token_actions.completed'
  )

  return respond(NextResponse.json({ items }))
}
