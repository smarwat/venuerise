import { NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getJobsRuntime } from '@/lib/jobs/queue'
import { emailConfigured } from '@/lib/integrations/email'
import { getRateLimitStatus, type RateLimitStatus } from '@/lib/rate-limit'
import { log } from '@/lib/log'
import { getOrCreateRequestId, withRequestIdHeader } from '@/lib/observability/request-id'
import { captureApiError } from '@/lib/observability/sentry'
import pkg from '../../../package.json'

/**
 * Health endpoint for uptime monitors.
 *
 * - Unauthenticated (so external pingers can hit it).
 * - Never leaks secrets — only coarse status strings.
 * - Never spends Anthropic tokens or Resend credits — provider checks are
 *   strictly configuration-presence, not live pings.
 * - Returns 200 unless Supabase is unreachable (then 503).
 */

type Status = 'ok' | 'configured' | 'missing' | 'down' | 'console-fallback'

interface HealthBody {
  ok: boolean
  version: string
  supabase: Status
  anthropic: Status
  email: Status
  resend_webhook: 'configured' | 'missing'
  jobs: 'inngest' | 'local-fallback'
  upstash: RateLimitStatus
  sentry: 'configured' | 'missing'
  admin: { mounted: true; endpoints: number }
  tenant_access: {
    venue_members: 'ok' | 'missing'
    rls_membership: 'ok' | 'missing'
  }
  onboarding: { api: 'mounted' }
  team: { invitations: 'mounted'; dashboard: 'mounted' }
  billing: {
    stripe: 'configured' | 'missing'
    webhook: 'configured' | 'missing'
    gate: 'enabled' | 'disabled'
    events_log: 'mounted'
    trial_reminder: 'mounted'
    replay: 'mounted'
    dunning: 'mounted'
    recovery_email: 'mounted'
    admin_clear_dunning: 'mounted'
    tour_auto_pause: 'mounted'
    tour_auto_resume: 'mounted'
    tour_auto_pause_rearm: 'mounted'
    bulk_cancel_notifications: 'mounted'
  }
  demo: {
    seed: 'mounted'
    realtime: 'mounted'
    tour_quick_schedule: 'mounted'
    tour_drawer: 'mounted'
    tour_edit: 'mounted'
    tour_reschedule_from_inbox: 'mounted'
    tour_pause_audit: 'mounted'
    tour_bulk_resume: 'mounted'
    tour_week_panel: 'mounted'
    tour_action_links: 'mounted'
    tour_action_audit: 'mounted'
    tour_status_audit: 'mounted'
    tour_audit_ui: 'mounted'
    tour_status_backfill: 'mounted'
    tour_status_filters: 'mounted'
    tour_status_csv: 'mounted'
    tour_status_realtime: 'mounted'
    tour_status_url_filters: 'mounted'
    tour_status_csv_pagination: 'mounted'
    tour_status_realtime_debounce: 'mounted'
    tour_audit_deeplink: 'mounted'
    tour_status_filter_persistence: 'mounted'
    tour_status_search: 'mounted'
    tour_status_streamed_csv: 'mounted'
    tour_status_metadata_search: 'mounted'
    operator_activity_digest: 'mounted'
    tour_status_metadata_search_index: 'mounted'
    operator_digest_html: 'mounted'
    operator_digest_unsubscribe: 'mounted'
  }
  uptime_ms: number
  ts: string
}

/**
 * Phase 5E admin surface. Bumped manually when /api/admin/* routes change.
 * Kept as a constant rather than a runtime filesystem probe so a monitor
 * checking this value will alert if a new admin endpoint isn't mounted
 * (e.g. accidentally excluded from a build).
 *
 * Changelog:
 *   - Phase 5E: 6 (ai-actions, anthropic-probe, outbound-messages,
 *               suppressions, test-send, workflow-status)
 *   - Phase 7G: 8 (added billing-events list + detail)
 *   - Phase 7I: 9 (added billing-events/[id]/replay)
 *   - Phase 7N: 10 (added billing-events/[id]/clear-dunning)
 *   - Phase 8A: 12 (added demo/seed + demo/reset)
 *   - Phase 8F: 13 (added tours/bulk-cancel)
 *   - Phase 8G: 14 (added tours/paused-venues)
 *   - Phase 8I: 16 (added tours/pause-history + tours/clear-pause)
 *   - Phase 8J: 17 (added tours/notification-stats)
 *   - Phase 8K: 18 (added tours/recent-token-actions)
 *   - Phase 8M: 19 (added tours/status-events; recent-token-actions
 *     stays mounted with Deprecation headers for one release cycle)
 */
const ADMIN_ENDPOINT_COUNT = 19

const startedAt = Date.now()

async function checkSupabase(): Promise<Status> {
  try {
    const supabase = createServiceClient()
    const { error } = await supabase
      .from('venues')
      .select('id', { count: 'exact', head: true })
      .limit(1)
    if (error) {
      log.error({ route: '/api/health', errorMessage: error.message }, 'health.supabase.down')
      captureApiError(error, { route: '/api/health' })
      return 'down'
    }
    return 'ok'
  } catch (err) {
    log.error({ route: '/api/health', err }, 'health.supabase.threw')
    captureApiError(err, { route: '/api/health' })
    return 'down'
  }
}

/**
 * Cheap probe — does the venue_members table exist? Uses a HEAD-style
 * count so no row data is fetched (and no count is exposed in the
 * response — we report only ok/missing).
 */
async function checkTenantAccess(): Promise<'ok' | 'missing'> {
  try {
    const supabase = createServiceClient()
    const { error } = await supabase
      .from('venue_members')
      .select('id', { count: 'exact', head: true })
      .limit(1)
    if (error) return 'missing'
    return 'ok'
  } catch {
    return 'missing'
  }
}

/**
 * Phase 6B probe — is the member-aware RLS in place?
 *
 * Calls the `is_venue_member` SECURITY DEFINER helper (migration 004) that
 * every new RLS policy in migration 005 references. If the function exists
 * and answers, the membership-aware policy graph is reachable. We pass
 * zero-UUIDs so the call is harmless (returns false) and never touches a
 * real tenant. A missing function or RPC error → 'missing'.
 */
async function checkRlsMembership(): Promise<'ok' | 'missing'> {
  try {
    const supabase = createServiceClient()
    const { error } = await supabase.rpc('is_venue_member', {
      check_venue_id: '00000000-0000-0000-0000-000000000000',
      check_user_id: '00000000-0000-0000-0000-000000000000',
    })
    if (error) return 'missing'
    return 'ok'
  } catch {
    return 'missing'
  }
}

function checkAnthropic(): Status {
  return process.env.ANTHROPIC_API_KEY ? 'configured' : 'missing'
}

function checkEmail(): Status {
  // emailConfigured() is true only when BOTH api key AND from-email exist.
  if (emailConfigured()) return 'configured'
  // If the API key is present but no from-email, that's a misconfigured prod
  // and a half-broken dev — surface as 'missing' so the operator notices.
  if (process.env.RESEND_API_KEY && !process.env.RESEND_FROM_EMAIL) return 'missing'
  if (process.env.NODE_ENV === 'development') return 'console-fallback'
  return 'missing'
}

export async function GET(request: Request) {
  const requestId = getOrCreateRequestId(request)
  // Run independent probes in parallel.
  const [supabase, venueMembers, rlsMembership] = await Promise.all([
    checkSupabase(),
    checkTenantAccess(),
    checkRlsMembership(),
  ])
  const anthropic = checkAnthropic()
  const email = checkEmail()
  const jobs = getJobsRuntime()
  const upstash = getRateLimitStatus()
  // Webhook health: env-presence only. We never call Resend's verifier here.
  const resend_webhook: 'configured' | 'missing' = process.env.RESEND_WEBHOOK_SECRET
    ? 'configured'
    : 'missing'
  // Sentry health: env-presence only. We never send a test event here.
  const sentry: 'configured' | 'missing' = process.env.SENTRY_DSN ? 'configured' : 'missing'

  const body: HealthBody = {
    ok: supabase !== 'down',
    version: (pkg as { version: string }).version,
    supabase,
    anthropic,
    email,
    resend_webhook,
    jobs,
    upstash,
    sentry,
    admin: { mounted: true, endpoints: ADMIN_ENDPOINT_COUNT },
    tenant_access: { venue_members: venueMembers, rls_membership: rlsMembership },
    // Phase 6C — bumped manually if the onboarding API surface changes.
    // Compile-time presence is the signal; we don't probe by HTTP-ing ourselves.
    onboarding: { api: 'mounted' },
    // Phase 6D + 6E — team API + dashboard surface presence signals.
    team: { invitations: 'mounted', dashboard: 'mounted' },
    // Phase 7C + 7D + 7F + 7H — billing surface. Env presence + compile-time
    // presence of the audit log / trial reminder code paths. Never pings Stripe.
    billing: {
      stripe: process.env.STRIPE_SECRET_KEY ? 'configured' : 'missing',
      webhook: process.env.STRIPE_WEBHOOK_SECRET ? 'configured' : 'missing',
      gate: process.env.BILLING_GATE_ENABLED === '1' ? 'enabled' : 'disabled',
      events_log: 'mounted',
      // 7H — the Inngest cron is registered in allJobFunctions; we surface
      // it as a compile-time mounted flag here. Operators verify the
      // function appears in the Inngest dashboard's function list.
      trial_reminder: 'mounted',
      // 7I — admin replay endpoint /api/admin/billing-events/[id]/replay
      // is compile-time mounted; runtime availability requires Stripe
      // configuration (see `stripe`/`webhook` flags above).
      replay: 'mounted',
      // 7K — past-due dunning Inngest cron `billing-dunning` is
      // registered in allJobFunctions; runtime delivery requires Resend
      // + Stripe portal configuration. Operators verify in Inngest UI.
      dunning: 'mounted',
      // 7M — payment recovery email is a webhook-triggered side effect
      // (no cron). Runtime delivery requires Resend; the dispatcher only
      // fires it on past_due → active/trialing transitions.
      recovery_email: 'mounted',
      // 7N — operator escape hatch: POST /api/admin/billing-events/[id]/clear-dunning
      // wipes prefix-matched entries from subscriptions.metadata.dunning_sent.
      admin_clear_dunning: 'mounted',
      // 8F — past-due tour auto-pause cron `billing-tour-auto-pause` is
      // registered in allJobFunctions; runs daily at 6pm UTC. Cancels
      // future scheduled/confirmed tours for venues past_due > 7 days
      // and stamps subscriptions.metadata.tours_paused_at/reason/count.
      tour_auto_pause: 'mounted',
      // 8G — operational counterpart to tour_auto_pause. When the Stripe
      // dispatcher detects past_due → active/trialing, it stamps
      // subscriptions.metadata.tours_resumed_at + tours_resumed_reason
      // so the /dashboard/tours banner can flip off. Does NOT resurrect
      // any already-cancelled tour — that remains operator-controlled.
      tour_auto_resume: 'mounted',
      // 8H — window-aware re-arm on the auto-pause cron. When a venue
      // bounces past_due → active → past_due, the cron archives the
      // prior pause/resume pair into metadata.tour_pause_history and
      // stamps a fresh pause. Idempotent on repeated runs in the same
      // past-due window.
      tour_auto_pause_rearm: 'mounted',
      // 8H — POST /api/admin/tours/bulk-cancel now fans out best-effort
      // cancellation emails to affected leads at concurrency 5. Email
      // failures never turn a successful bulk-cancel into a 500; the
      // response includes a notification_summary block for telemetry.
      bulk_cancel_notifications: 'mounted',
    },
    // Phase 8A — demo seed + reset admin surface.
    // Phase 8B — realtime layers on /dashboard/leads + /dashboard/inbox.
    demo: {
      seed: 'mounted',
      realtime: 'mounted',
      // 8C — variant inquiries + quick-schedule-tour + tours realtime.
      tour_quick_schedule: 'mounted',
      // 8D — full ScheduleTourDrawer mounted on /dashboard/tours +
      // LeadDetailPanel. Always available regardless of NEXT_PUBLIC_DEMO_BUTTON.
      tour_drawer: 'mounted',
      // 8E — EditTourDrawer + click-to-edit + Mark-confirmed inline +
      // URL-based ?month=YYYY-MM navigation on /dashboard/tours. All
      // production UX, no demo flag required.
      tour_edit: 'mounted',
      // 8F — TourLifecycleStrip on /dashboard/inbox/[leadId] surfaces
      // the most relevant tour with a one-click schedule / edit /
      // reschedule action. Reuses the 8D/8E drawers verbatim.
      tour_reschedule_from_inbox: 'mounted',
      // 8I — operator audit surface for tour pause/resume. New admin
      // routes GET /api/admin/tours/pause-history + POST
      // /api/admin/tours/clear-pause; new PauseHistoryTable on
      // /dashboard/settings/billing (admins/owners only).
      tour_pause_audit: 'mounted',
      // 8I — "Re-schedule cancelled tour" shortcut on the inbox
      // TourLifecycleStrip when the most-recent tour was cancelled.
      // Opens ScheduleTourDrawer pre-filled with the cancelled slot.
      tour_bulk_resume: 'mounted',
      // 8J — "This week's tours" sidebar panel on /dashboard/inbox.
      // Server-rendered, click any row to jump to the conversation
      // thread. Reads the existing `tours` + `leads` tables only;
      // no new admin route, no new env vars.
      tour_week_panel: 'mounted',
      // 8K — public /tour/confirm + /tour/cancel routes plus signed
      // HMAC token in lead-facing tour emails. Runtime presence
      // requires TOUR_ACTION_SECRET (>= 16 chars); when absent the
      // email path silently sends without links and warns once per
      // process. Mounted flag here reflects code presence, NOT secret
      // configuration — operators check NEXT_PUBLIC_APP_URL +
      // TOUR_ACTION_SECRET separately.
      tour_action_links: 'mounted',
      // 8L — `tour_action_events` table + single-use claim on the
      // public action handler + audit-fed recent-token-actions admin
      // endpoint + HTML email templates. ADMIN_ENDPOINT_COUNT is
      // unchanged because recent-token-actions already existed (it was
      // rewritten in-place, not added).
      tour_action_audit: 'mounted',
      // 8M — `tour_status_events` table + `recordTourStatusEvent` writes
      // from all four tour status-change paths (lead token, operator
      // PATCH, bulk-cancel, auto-pause cron). Unified admin endpoint
      // GET /api/admin/tours/status-events with actor_kind / tour /
      // lead / action filters. The narrow Phase 8K/8L
      // recent-token-actions endpoint stays mounted with HTTP
      // Deprecation + Link/successor-version headers.
      tour_status_audit: 'mounted',
      // 8N — operator UI surfaces over the Phase 8M audit feed:
      //   - TourAuditDrawer (per-tour drawer mounted on /dashboard/tours
      //     + /dashboard/inbox/[leadId])
      //   - Inbox TourLifecycleStrip recent activity panel (silent for
      //     non-admins via 401/403/404 fall-through)
      //   - /dashboard/settings/billing TourStatusActivityFeed
      //     (server-rendered, admins/owners only)
      tour_audit_ui: 'mounted',
      // 8N — manual-trigger Inngest backfill job (`seed-tour-status-events`,
      // event `admin/tour-status-events.backfill`). Gated behind
      // `TOUR_STATUS_BACKFILL=1` AND requires a manual event send — no
      // cron. Inserts synthetic `actor_kind='system'` rows for legacy
      // tours that pre-date Phase 8M.
      tour_status_backfill: 'mounted',
      // 8O — interactive operator features over the unified audit feed:
      //   - billing-page TourStatusActivityFeedClient with actor_kind +
      //     action filter chips
      //   - GET /api/admin/tours/status-events?format=csv export
      //   - RealtimeTourStatusLayer subscribed to
      //     tour_status_events INSERTs (table added to the
      //     supabase_realtime publication out-of-band; see RUNBOOK §7)
      tour_status_filters: 'mounted',
      tour_status_csv: 'mounted',
      tour_status_realtime: 'mounted',
      // 8P — operator polish: URL-synced billing filters,
      // cursor-paginated CSV+JSON export (?occurred_before=ISO →
      // next_cursor/has_more body fields + X-Next-Cursor/X-Has-More
      // headers), realtime refresh debounce (~1s trailing, every
      // INSERT still toasts), and audit-drawer deep linking
      // (?audit_tour=<uuid> on /dashboard/tours preserves the
      // month=YYYY-MM Phase 8E query).
      tour_status_url_filters: 'mounted',
      tour_status_csv_pagination: 'mounted',
      tour_status_realtime_debounce: 'mounted',
      tour_audit_deeplink: 'mounted',
      // 8Q — operator depth: localStorage-backed filter persistence
      // (URL wins → localStorage fallback → defaults), server-side
      // `?q=…` search over scalar columns + client-side metadata
      // search over the loaded slice, and streamed CSV export
      // (`?format=csv&stream=1`) bounded by a 5000-row hard cap and
      // emitted via a ReadableStream so a wide export doesn't
      // materialize in memory.
      tour_status_filter_persistence: 'mounted',
      tour_status_search: 'mounted',
      tour_status_streamed_csv: 'mounted',
      // 8R — server-side metadata::text search via the
      // search_tour_status_events SECURITY DEFINER RPC (migration 014).
      // Active only when `?q=` is present; non-`q` path stays on the
      // PostgREST chain. RPC is GRANT EXECUTE to service_role only —
      // never callable from authenticated/anon contexts.
      tour_status_metadata_search: 'mounted',
      // 8R — manual-cron operator activity digest. Compile-time
      // mounted; runtime delivery requires OPERATOR_DIGEST_ENABLED=1
      // AND Resend configured. Daily 8am UTC; per-venue 24h summary
      // emailed to the venue owner.
      operator_activity_digest: 'mounted',
      // 8S — migration 015 adds pg_trgm + a generated `metadata_text`
      // column + a GIN trigram index, then re-issues the Phase 8R RPC
      // to query the indexed column. `?q=` searches over `metadata`
      // now use the index instead of a sequential ILIKE cast.
      tour_status_metadata_search_index: 'mounted',
      // 8S — operator digest now ships multipart with an Outlook-safe
      // HTML body (white card, slate background, brand-blue chip,
      // tables for counts) alongside the existing plaintext.
      operator_digest_html: 'mounted',
      // 8S — public unsubscribe surface at GET /api/digest/unsubscribe.
      // HMAC-signed token (DIGEST_UNSUBSCRIBE_SECRET, 30d TTL) flips
      // `subscriptions.metadata.digest_disabled = true` for the venue.
      // The cron checks this flag before sending. Without the secret,
      // emails ship without the link + a once-per-process warn fires.
      operator_digest_unsubscribe: 'mounted',
    },
    uptime_ms: Date.now() - startedAt,
    ts: new Date().toISOString(),
  }

  const response = NextResponse.json(body, {
    status: body.ok ? 200 : 503,
    headers: { 'Cache-Control': 'no-store' },
  })
  return withRequestIdHeader(response, requestId)
}
