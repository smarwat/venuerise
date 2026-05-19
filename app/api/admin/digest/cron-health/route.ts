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
 * GET /api/admin/digest/cron-health?venue_id=<optional uuid>  (Phase 8AB)
 *
 * Lightweight health surface for the Phase 8R operator-activity-digest
 * cron. Mounted on `/dashboard/settings/billing` as
 * `DigestCronHealthCard`, which renders a green/amber/red dot beside
 * the existing `DigestPreferencesCard`.
 *
 * ── IMPORTANT LIMITATION ──────────────────────────────────────────────────
 * This is a DELIVERY-DERIVED health check, NOT an Inngest run-history
 * check. We don't probe Inngest's cron runs directly — that would
 * require an Inngest API token + a new integration. Instead we infer
 * health from the most-recent `cron`-tagged outbound digest row.
 *
 * Caveat: a venue with no tour activity in the last 24h won't get a
 * digest (the Phase 8R cron skips zero-event venues), so `status:
 * 'no_data'` can be normal. The card UI calls this out explicitly so
 * operators don't misread it as a cron failure.
 *
 * For unambiguous cron-run telemetry, point operators at the Inngest
 * dashboard — that's the source of truth.
 *
 * ── STATUS LOGIC ──────────────────────────────────────────────────────────
 *   - no_data  — zero cron rows in the last 72h lookback window.
 *   - ok       — last cron row created within 30 hours.
 *   - stale    — last cron row older than 30 hours.
 *
 * The 30h threshold gives the daily cron one full cycle of slack +
 * a few hours of grace (cron schedule 8am UTC; 30h covers
 * yesterday's tick + this morning's missed-by-an-hour window).
 *
 * ── RATE LIMIT ────────────────────────────────────────────────────────────
 * `admin:digest-cron-health:{userId}` — distinct from the other
 * digest admin keys so a noisy card poll doesn't drain a shared
 * budget.
 */

const QuerySchema = z.object({
  venue_id: z.string().uuid().optional(),
})

const LOOKBACK_MS = 72 * 60 * 60 * 1000 // 72 hours
const STALE_THRESHOLD_MS = 30 * 60 * 60 * 1000 // 30 hours
const EXPECTED_SCHEDULE = 'daily 8am UTC'

type Status = 'ok' | 'stale' | 'no_data'

interface LastSummary {
  status: string | null
  event_count: number | null
  recipient_user_id: string | null
  cadence: string | null
  weekly_day: string | null
}

interface CronHealthBody {
  venue_id: string
  ok: boolean
  last_run_at: string | null
  lag_minutes: number | null
  status: Status
  expected_schedule: string
  last_summary: LastSummary | null
}

interface CronRow {
  status: string
  created_at: string
  metadata: Record<string, unknown> | null
}

function readString(v: unknown): string | null {
  if (typeof v !== 'string' || v.length === 0) return null
  return v
}

function readNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.length > 0) {
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  return null
}

export async function GET(request: NextRequest): Promise<Response> {
  const requestId = getOrCreateRequestId(request)
  const reqLog = log.child({
    requestId,
    route: '/api/admin/digest/cron-health',
    op: 'admin.digest_cron_health',
  })
  const respond = <T extends Response>(r: T) => withRequestIdHeader(r, requestId)

  const admin = await requireAdmin()
  if (!admin.ok) {
    return respond(NextResponse.json({ error: admin.code }, { status: admin.status }))
  }
  const { user, venueId: callerVenueId } = admin

  const rl = await rateLimitUserAction(request, `admin:digest-cron-health:${user.id}`)
  if (!rl.allowed) {
    reqLog.warn({ userId: user.id, retryMs: rl.retryAfterMs }, 'rate_limit.blocked')
    return respond(rateLimitedResponse(rl))
  }

  const url = new URL(request.url)
  const parsed = QuerySchema.safeParse({
    venue_id: url.searchParams.get('venue_id') ?? undefined,
  })
  if (!parsed.success) {
    return respond(
      NextResponse.json(
        { error: 'validation_failed', detail: parsed.error.flatten() },
        { status: 400 }
      )
    )
  }
  const targetVenueId = parsed.data.venue_id ?? callerVenueId
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

  // Probe the most-recent cron-tagged digest row inside the 72h window.
  // Archived rows are deliberately INCLUDED — a 70h-old row that was
  // archived 30 minutes ago is still evidence that the cron ran 70h
  // ago. The freshness threshold (30h) is what controls ok/stale.
  const sinceIso = new Date(Date.now() - LOOKBACK_MS).toISOString()
  const svc = createServiceClient()
  const { data: rowsRaw, error: queryErr } = await svc
    .from('outbound_messages')
    .select('status, created_at, metadata')
    .eq('venue_id', targetVenueId)
    .eq('related_table', 'tour_status_events')
    .filter('metadata->>tour_digest_send_kind', 'eq', 'cron')
    .gte('created_at', sinceIso)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (queryErr) {
    reqLog.error(
      { err: queryErr, venueId: targetVenueId },
      'admin.digest_cron_health.query_failed'
    )
    captureApiError(queryErr, {
      requestId,
      route: '/api/admin/digest/cron-health',
      userId: user.id,
      venueId: targetVenueId,
    })
    return respond(NextResponse.json({ error: 'unexpected_error' }, { status: 500 }))
  }

  const row = (rowsRaw ?? null) as CronRow | null

  const body: CronHealthBody = (() => {
    if (!row) {
      return {
        venue_id: targetVenueId,
        // `ok` mirrors the status semantically — `no_data` isn't a
        // failure (could just be a quiet week), so we keep `ok: true`
        // and let the card render the amber "no recent send" copy.
        ok: true,
        last_run_at: null,
        lag_minutes: null,
        status: 'no_data',
        expected_schedule: EXPECTED_SCHEDULE,
        last_summary: null,
      }
    }
    const createdAt = new Date(row.created_at)
    const lagMs = Date.now() - createdAt.getTime()
    const lagMinutes = Math.max(0, Math.round(lagMs / 60_000))
    const status: Status = lagMs > STALE_THRESHOLD_MS ? 'stale' : 'ok'
    const meta = (row.metadata ?? {}) as Record<string, unknown>
    return {
      venue_id: targetVenueId,
      ok: status === 'ok',
      last_run_at: row.created_at,
      lag_minutes: lagMinutes,
      status,
      expected_schedule: EXPECTED_SCHEDULE,
      last_summary: {
        status: row.status,
        event_count: readNumber(meta.tour_digest_total),
        recipient_user_id: readString(meta.tour_digest_recipient_user_id),
        cadence: readString(meta.tour_digest_cadence),
        weekly_day: readString(meta.tour_digest_weekly_day) || null,
      },
    }
  })()

  reqLog.info(
    {
      venueId: targetVenueId,
      status: body.status,
      lagMinutes: body.lag_minutes,
    },
    'admin.digest_cron_health.computed'
  )

  return respond(NextResponse.json(body))
}
