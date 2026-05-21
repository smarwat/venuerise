import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireAdmin } from '@/lib/auth/require-admin'
import {
  requireVenueRole,
  TenantAccessError,
} from '@/lib/auth/tenant-access'
import { ADMIN_ROLES } from '@/lib/auth/roles'
import { createServiceClient } from '@/lib/supabase/service'
import { rateLimitUserAction, rateLimitedResponse } from '@/lib/rate-limit'
import { log } from '@/lib/log'
import {
  getOrCreateRequestId,
  withRequestIdHeader,
} from '@/lib/observability/request-id'
import { captureApiError } from '@/lib/observability/sentry'
import {
  computeReactivationSignals,
  isLostReason,
  type LostReason,
} from '@/lib/revenue-os/reactivation'

/**
 * GET /api/admin/leads/reactivation-queue  (Phase 8BD)
 *
 * Dedicated admin roll-up for the reactivation queue. The
 * Overview `ReactivationQueueCard` uses RLS-aware reads directly
 * (it's already inside a server component); this admin route is
 * here for future surfaces — a billing-page rollup, a digest
 * preview, a cron-driven summary — that need the same data
 * without the in-component DB calls.
 *
 * Safety posture (echoes the docs):
 *   - Read-only. No write paths.
 *   - No draft body, no message content, no lead email returned.
 *   - Per-row payload is the same shape the
 *     `ReactivationQueueCard` consumes plus the lead's
 *     `event_date` (operator-meaningful, already on the leads
 *     table).
 *   - `autonomous_sending_still_disabled` (from 8AX) remains
 *     `mounted`.
 *
 * Auth:
 *   - requireAdmin() — owner/admin only.
 *   - Cross-tenant `venue_id` gated via requireVenueRole(
 *     ADMIN_ROLES); forbidden collapses to 404.
 *   - Per-user rate limit: `admin:leads-reactivation:{userId}`.
 *
 * Query:
 *   venue_id?  uuid  defaults to caller's venue
 *   limit?     1..50 default 10
 */

const QuerySchema = z.object({
  venue_id: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
})

// Hard ceiling on rows scanned per call. Reactivation candidates
// have a long tail (a venue with hundreds of lost leads); the
// helper picks the top N by score so we never need to load the
// world.
const MAX_LOST_LEADS_SCAN = 500

export async function GET(request: NextRequest): Promise<Response> {
  const requestId = getOrCreateRequestId(request)
  const reqLog = log.child({
    requestId,
    route: '/api/admin/leads/reactivation-queue',
    op: 'admin.leads.reactivation_queue',
  })
  const respond = <T extends Response>(r: T) =>
    withRequestIdHeader(r, requestId)

  const admin = await requireAdmin()
  if (!admin.ok) {
    return respond(
      NextResponse.json({ error: admin.code }, { status: admin.status })
    )
  }
  const { user, venueId: callerVenueId } = admin

  const rl = await rateLimitUserAction(
    request,
    `admin:leads-reactivation:${user.id}`
  )
  if (!rl.allowed) {
    reqLog.warn(
      { userId: user.id, retryMs: rl.retryAfterMs },
      'rate_limit.blocked'
    )
    return respond(rateLimitedResponse(rl))
  }

  const url = new URL(request.url)
  const parsed = QuerySchema.safeParse({
    venue_id: url.searchParams.get('venue_id') ?? undefined,
    limit: url.searchParams.get('limit') ?? undefined,
  })
  if (!parsed.success) {
    return respond(
      NextResponse.json(
        { error: 'validation_failed', detail: parsed.error.flatten() },
        { status: 400 }
      )
    )
  }
  const { venue_id: bodyVenueId, limit = 10 } = parsed.data

  const targetVenueId = bodyVenueId ?? callerVenueId
  if (targetVenueId !== callerVenueId) {
    try {
      await requireVenueRole(user.id, targetVenueId, ADMIN_ROLES)
    } catch (err) {
      if (err instanceof TenantAccessError) {
        if (err.status === 403) {
          return respond(
            NextResponse.json({ error: 'not_found' }, { status: 404 })
          )
        }
        return respond(
          NextResponse.json({ error: err.code }, { status: err.status })
        )
      }
      throw err
    }
  }

  const svc = createServiceClient()

  // 1. Fetch lost leads + their metadata. We deliberately do NOT
  // pull `email` — the spec asks us to avoid it on this admin
  // surface (digest + analytics surfaces shouldn't surface PII
  // unless they're going to display it).
  let lostLeads: Array<{
    id: string
    name: string
    stage: string
    lead_score: number
    event_date: string | null
    updated_at: string
    metadata: Record<string, unknown> | null
  }> = []
  try {
    const { data, error } = await svc
      .from('leads')
      .select(
        'id, name, stage, lead_score, event_date, updated_at, metadata'
      )
      .eq('venue_id', targetVenueId)
      .eq('stage', 'lost')
      .order('updated_at', { ascending: false })
      .limit(MAX_LOST_LEADS_SCAN)
    if (error) throw error
    lostLeads = (data as typeof lostLeads) ?? []
  } catch (err) {
    reqLog.error(
      { err, targetVenueId },
      'admin.leads.reactivation_queue.leads_query_failed'
    )
    captureApiError(err, {
      requestId,
      route: '/api/admin/leads/reactivation-queue',
      userId: user.id,
      venueId: targetVenueId,
    })
    return respond(
      NextResponse.json({ error: 'unexpected_error' }, { status: 500 })
    )
  }

  if (lostLeads.length === 0) {
    return respond(
      NextResponse.json({
        venue_id: targetVenueId,
        items: [],
      })
    )
  }

  // 2. Per-lead last lead-role message. One IN-batched read.
  const leadIds = lostLeads.map((l) => l.id)
  const lastInboundByLead: Record<string, string | null> = {}
  try {
    const { data } = await svc
      .from('messages')
      .select('lead_id, created_at')
      .eq('venue_id', targetVenueId)
      .eq('role', 'lead')
      .in('lead_id', leadIds)
      .order('created_at', { ascending: false })
    for (const m of (data as Array<{
      lead_id: string
      created_at: string
    }> | null) ?? []) {
      if (!(m.lead_id in lastInboundByLead)) {
        lastInboundByLead[m.lead_id] = m.created_at
      }
    }
  } catch (err) {
    // Best-effort — if the messages probe fails the helper's
    // cooling gate excludes affected leads (no signal → drop).
    // Better than returning 500 for the rest of the response.
    reqLog.warn(
      { err, targetVenueId },
      'admin.leads.reactivation_queue.messages_probe_failed'
    )
  }
  for (const id of leadIds) {
    if (!(id in lastInboundByLead)) lastInboundByLead[id] = null
  }

  // 3. Project metadata.lost_reason → LostReason and hand the
  // shape to the pure helper.
  const helperLeads = lostLeads.map((l) => {
    const md = l.metadata
    const block =
      md && typeof md === 'object'
        ? (md as { lost_reason?: unknown }).lost_reason
        : undefined
    const reason =
      block &&
      typeof block === 'object' &&
      isLostReason((block as { reason?: unknown }).reason)
        ? ((block as { reason: LostReason }).reason)
        : null
    return {
      id: l.id,
      name: l.name,
      stage: l.stage,
      lead_score: l.lead_score,
      event_date: l.event_date,
      updated_at: l.updated_at,
      lost_reason: reason,
    }
  })

  const signals = computeReactivationSignals({
    leads: helperLeads,
    lastMessages: lastInboundByLead,
  })

  // 4. Stitch the response. We expose the per-row data the
  // operator needs — lead name + score + lost_reason + last
  // contact + event_date + the helper's candidacy/rationale/
  // suggested_instruction. No email, no message body, no
  // metadata-blob passthrough.
  const leadById = new Map(lostLeads.map((l) => [l.id, l]))
  const items = signals.slice(0, limit).map((sig) => {
    const lead = leadById.get(sig.leadId)
    return {
      lead_id: sig.leadId,
      lead_name: lead?.name ?? null,
      stage: lead?.stage ?? 'lost',
      lost_reason: sig.reason,
      last_message_at: lastInboundByLead[sig.leadId] ?? null,
      event_date: lead?.event_date ?? null,
      lead_score: lead?.lead_score ?? null,
      candidacy: sig.candidacy,
      rationale: sig.rationale,
      suggested_instruction: sig.suggestedInstruction,
    }
  })

  reqLog.info(
    {
      targetVenueId,
      limit,
      lost_count: lostLeads.length,
      candidates: signals.length,
      returned: items.length,
    },
    'admin.leads.reactivation_queue.served'
  )

  return respond(
    NextResponse.json({
      venue_id: targetVenueId,
      items,
    })
  )
}
