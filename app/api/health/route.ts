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
    operator_digest_preferences: 'mounted'
    operator_digest_cadence: 'mounted'
    tour_status_short_search: 'mounted'
    operator_digest_per_user: 'mounted'
    operator_digest_weekly_day: 'mounted'
    tour_status_search_hint: 'mounted'
    operator_digest_preview: 'mounted'
    operator_digest_recipient_batching: 'mounted'
    member_digest_backfill: 'mounted'
    operator_digest_resubscribe: 'mounted'
    operator_digest_send_kind: 'mounted'
    operator_digest_preview_suppression_ux: 'mounted'
    operator_digest_footer_links: 'mounted'
    operator_digest_manual_send: 'mounted'
    operator_digest_send_kind_manual: 'mounted'
    operator_digest_member_picker: 'mounted'
    operator_digest_send_audit: 'mounted'
    operator_digest_respect_cadence_manual: 'mounted'
    operator_digest_send_pagination: 'mounted'
    operator_digest_send_realtime: 'mounted'
    operator_digest_suppression_triage: 'mounted'
    operator_digest_suppression_remove: 'mounted'
    operator_digest_send_search: 'mounted'
    operator_digest_suppression_realtime_refresh: 'mounted'
    operator_digest_retention: 'mounted'
    operator_digest_cron_health: 'mounted'
    operator_digest_bulk_suppression_remove: 'mounted'
    operator_digest_search_highlights: 'mounted'
    operator_digest_show_archived: 'mounted'
    operator_digest_cron_health_realtime: 'mounted'
    operator_digest_audit_events: 'mounted'
    operator_digest_retention_dry_run: 'mounted'
    operator_digest_audit_search: 'mounted'
    operator_digest_audit_pagination: 'mounted'
    operator_digest_audit_action_family: 'mounted'
    operator_digest_cron_send_audit: 'mounted'
    operator_digest_cron_fired_toast: 'mounted'
    operator_digest_audit_url_state: 'mounted'
    operator_digest_audit_metadata_search: 'mounted'
    operator_digest_preview_audit: 'mounted'
    operator_digest_audit_preview_family: 'mounted'
    operator_digest_audit_cursor_read: 'mounted'
    operator_digest_send_url_state: 'mounted'
    operator_digest_audit_drawer: 'mounted'
    operator_digest_cron_audit_dedupe: 'mounted'
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
 *   - Phase 8T: 20 (added digest/preferences; GET + POST share the route)
 *   - Phase 8V: 21 (added digest/preview)
 *   - Phase 8X: 22 (added digest/send — operator-triggered manual send)
 *   - Phase 8Y: 24 (added digest/members + digest/sends)
 *   - Phase 8Z: 25 (added digest/suppressions)
 *   - Phase 8AA: 26 (added digest/suppressions/remove)
 *   - Phase 8AB: 28 (added digest/cron-health + digest/suppressions/remove-all)
 *   - Phase 8AC: 29 (added digest/audit-events)
 */
const ADMIN_ENDPOINT_COUNT = 29

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
      // 8T — admin GET/POST /api/admin/digest/preferences for reading
      // and writing the per-venue digest cadence
      // (`subscriptions.metadata.digest_cadence` ∈ daily | weekly | off).
      // Surfaced as a card on /dashboard/settings/billing. Writer
      // keeps the legacy `digest_disabled` flag in sync.
      operator_digest_preferences: 'mounted',
      // 8T — digest cron now honors cadence. 'off' → skip
      // (operator_digest.skipped_disabled). 'weekly' on non-Monday →
      // skip (operator_digest.skipped_cadence). 'daily' always sends.
      operator_digest_cadence: 'mounted',
      // 8T — `?q=` short-query optimization on status-events: terms
      // shorter than 3 chars skip the metadata RPC and use a scalar
      // PostgREST .or() chain instead (avoiding a wasted trigram
      // bitmap probe). `qMode` log values: none | scalar_short |
      // metadata_rpc.
      tour_status_short_search: 'mounted',
      // 8U — migration 016 adds `venue_members.metadata` jsonb so each
      // admin/owner controls their own digest cadence + weekly day.
      // The Phase 8R cron fans out per recipient with per-recipient
      // idempotency. Member preference wins over venue subscription
      // fallback wins over the legacy `digest_disabled` flag wins
      // over the global default ('daily').
      operator_digest_per_user: 'mounted',
      // 8U — `weekly` cadence now supports a per-user day-of-week
      // (sun..sat, defaults to mon UTC). The digest body footer names
      // the recipient's chosen day.
      operator_digest_weekly_day: 'mounted',
      // 8U — billing-page activity feed surfaces a small amber pill
      // when the operator types a 1-2 char search term, explaining
      // that metadata isn't included until the term reaches 3 chars
      // (the Phase 8T short-circuit threshold).
      tour_status_search_hint: 'mounted',
      // 8V — admin POST /api/admin/digest/preview sends the caller a
      // sample digest immediately. Bypasses cadence + idempotency
      // checks; outbound row tagged with `tour_digest_preview=true`
      // so the next cron run's per-recipient idempotency probe
      // ignores it.
      operator_digest_preview: 'mounted',
      // 8V — `findDigestRecipients` switched from serial auth lookups
      // to bounded concurrency 5 via Promise.allSettled, with
      // per-failure isolation. True batch via auth.admin.listUsers
      // would scan every auth user; this is the safe middle ground
      // documented in BILLING-QA §7ab.
      operator_digest_recipient_batching: 'mounted',
      // 8V — manual-trigger Inngest backfill (env-gated by
      // SEED_MEMBER_DIGEST=1) writes explicit `digest_cadence='daily'`
      // onto every owner/admin venue_members row that doesn't already
      // have one. Idempotent; capped at 1000 rows per run.
      member_digest_backfill: 'mounted',
      // 8W — public GET /api/digest/resubscribe?venue_id&user_id&token.
      // HMAC-signed token (DIGEST_UNSUBSCRIBE_SECRET, 30d TTL, action
      // discriminator) writes `digest_cadence='daily'` onto the
      // matching owner/admin venue_members row. Per-user re-enable;
      // does NOT touch subscriptions.metadata. NOT counted in
      // ADMIN_ENDPOINT_COUNT (public route, no admin auth).
      operator_digest_resubscribe: 'mounted',
      // 8W — `outbound_messages.metadata.tour_digest_send_kind`
      // discriminator added to both the cron ('cron') and the preview
      // route ('preview'). The cron's per-recipient idempotency probe
      // now filters on send_kind='cron' so earlier-today previews
      // can't dedupe the day's real digest. Reserved value 'manual'
      // for future operator-initiated sends.
      operator_digest_send_kind: 'mounted',
      // 8W — DigestPreferencesCard friendlier UX for the 409
      // `suppressed` preview branch. Replaces the raw "Couldn't send
      // sample: suppressed" with a copy block explaining the Resend
      // suppression list + contact-support resolution path.
      operator_digest_preview_suppression_ux: 'mounted',
      // 8X — digest email body footers now include explicit "Manage
      // your digest preferences" + unsubscribe + resubscribe links.
      // Cron sends omit the resubscribe link (recipient cadence is
      // never 'off' on a successful cron send); preview + manual
      // sends include both so the operator can QA the full preference
      // loop in one click. All links omit when
      // DIGEST_UNSUBSCRIBE_SECRET is missing (once-per-process warn).
      operator_digest_footer_links: 'mounted',
      // 8X — POST /api/admin/digest/send. Operator-triggered manual
      // send to self or another admin/owner member of the venue.
      // Tags the outbound row with `tour_digest_send_kind='manual'`
      // so the cron's per-recipient idempotency probe ignores it.
      // Optional `respect_cadence` flag preserves cadence-skip
      // semantics for dry-run "would today's cron send to this
      // person?" verification. Cross-user sends omit `sent_to` to
      // prevent email enumeration.
      operator_digest_manual_send: 'mounted',
      // 8X — `tour_digest_send_kind` now formally supports the
      // 'manual' value alongside 'cron' (8W) and 'preview' (8W). The
      // cron probe filters strictly on 'cron'; manual rows are never
      // dedupe candidates.
      operator_digest_send_kind_manual: 'mounted',
      // 8Y — GET /api/admin/digest/members lists owner/admin members
      // of the venue + their resolved emails so the manual-send
      // picker can target another admin without typing a UUID.
      // Bounded-concurrency (5) auth lookups, capped at 10 members
      // per venue to match the cron's fan-out limit.
      operator_digest_member_picker: 'mounted',
      // 8Y — GET /api/admin/digest/sends — operator audit feed over
      // outbound_messages digest rows. JSON + CSV branches, send_kind
      // / recipient_user_id / since / limit filters. Recipient email
      // is masked (`y***@domain.com`) to defend against CSV
      // screenshots scattering raw addresses. Surfaced as
      // DigestAuditFeed card on /dashboard/settings/billing.
      operator_digest_send_audit: 'mounted',
      // 8Y — manual-send endpoint formalized the `respect_cadence`
      // body flag (defaults to false). When true, honors recipient's
      // effective cadence preference and returns
      // { sent: false, skipped: true, reason: 'off'|'weekly_wrong_day' }
      // so the card can render amber inline status. Useful for QAing
      // weekly-day scheduling without burning a real send.
      operator_digest_respect_cadence_manual: 'mounted',
      // 8Z — GET /api/admin/digest/sends now accepts
      // `?occurred_before=<ISO>` cursor. JSON response adds
      // { next_cursor, has_more }; CSV adds X-Has-More + X-Next-Cursor
      // headers. DigestAuditFeed gains a "Load older" button that
      // appends without replacing existing rows.
      operator_digest_send_pagination: 'mounted',
      // 8Z — RealtimeDigestSendsLayer subscribes to
      // outbound_messages INSERTs filtered by venue_id, narrows to
      // digest rows in the handler (related_table='tour_status_events'
      // AND metadata.tour_digest_send_kind present), toasts every
      // event, debounces router.refresh() by 1000ms. Requires
      // outbound_messages in the supabase_realtime publication
      // (NOT enabled by default; see RUNBOOK for the alter
      // publication recipe).
      operator_digest_send_realtime: 'mounted',
      // 8Z — GET /api/admin/digest/suppressions intersects venue
      // owner/admin members with the global email_suppressions
      // table. DigestSuppressionsCallout renders an amber banner on
      // /dashboard/settings/billing when ≥1 admin email is on the
      // list. PII posture: masked emails only, never raw.
      operator_digest_suppression_triage: 'mounted',
      // 8AA — POST /api/admin/digest/suppressions/remove. Inline
      // "Remove suppression" action on DigestSuppressionsCallout.
      // Server re-resolves the email from venue_members + Supabase
      // Auth admin (client never sends the address); deletes from
      // email_suppressions by resolved email. PII posture: response
      // returns masked email only; logs never include raw email.
      operator_digest_suppression_remove: 'mounted',
      // 8AA — GET /api/admin/digest/sends now accepts ?q=<string>.
      // 1-2 chars: scalar + send_kind allowlist (status, provider,
      // error, to_address, metadata->>tour_digest_send_kind). 3+
      // chars: widens to cadence, weekly_day, recipient_user_id,
      // manual_initiator_user_id. Search applies to both JSON and
      // CSV branches and composes with the Phase 8Z cursor.
      operator_digest_send_search: 'mounted',
      // 8AA — RealtimeDigestSendsLayer dispatches a browser
      // CustomEvent (`venuerise:digest-suppression-refresh`)
      // whenever a new outbound digest row arrives with
      // status='suppressed'. DigestSuppressionsCallout listens and
      // refetches without a page reload. No global store; one
      // event, one consumer.
      operator_digest_suppression_realtime_refresh: 'mounted',
      // 8AB — weekly Inngest cron `digest-audit-retention` soft-
      // archives outbound digest rows older than
      // DIGEST_AUDIT_RETENTION_DAYS (default 365). Idempotent;
      // capped at 500 rows/run. Env-gated by
      // DIGEST_AUDIT_RETENTION_ENABLED=1. Default sends feed
      // excludes archived rows; `?include_archived=true` surfaces
      // them with the new `archived` JSON field + CSV column.
      operator_digest_retention: 'mounted',
      // 8AB — GET /api/admin/digest/cron-health surfaces a
      // delivery-derived health indicator (ok / stale / no_data)
      // for the operator-activity-digest cron. NOT an Inngest
      // run-history probe — a zero-event venue can be 'no_data'
      // and that's fine. Mounted as DigestCronHealthCard on
      // /dashboard/settings/billing.
      operator_digest_cron_health: 'mounted',
      // 8AB — POST /api/admin/digest/suppressions/remove-all wipes
      // every suppression hit for owner/admin members of the venue
      // in one call. DigestSuppressionsCallout surfaces a single
      // "Remove all suppressions" button when items.length >= 3.
      operator_digest_bulk_suppression_remove: 'mounted',
      // 8AB — search highlights in DigestAuditFeed. Pure-React
      // <mark>-wrapped substrings; no dangerouslySetInnerHTML, no
      // regex injection (uses String.indexOf with lowercased
      // halves). Visible cells only — hidden metadata isn't
      // highlighted because it isn't rendered.
      operator_digest_search_highlights: 'mounted',
      // 8AC — DigestAuditFeed `Show archived` toggle. Persisted in
      // localStorage (key `venuerise:digest-audit-feed:include-archived:v1`);
      // threads ?include_archived=true into JSON / Load older / CSV
      // export URLs. Archived rows render with an additional slate
      // "Archived" tag beside the Kind badge.
      operator_digest_show_archived: 'mounted',
      // 8AC — DigestCronHealthCard listens for the
      // `venuerise:digest-cron-fired` CustomEvent dispatched by
      // RealtimeDigestSendsLayer on every cron INSERT. Refetches
      // its own snapshot without a full page reload, so the lag
      // counter + "last run" timestamp update live.
      operator_digest_cron_health_realtime: 'mounted',
      // 8AC — migration 017 introduces public.digest_audit_events.
      // Suppression remove + bulk remove + retention cron all
      // record one row per action via recordDigestAuditEvent.
      // GET /api/admin/digest/audit-events surfaces them; the
      // DigestAuditLogCard renders a compact table on the billing
      // page with All / Suppression / Retention chips and a CSV
      // export.
      operator_digest_audit_events: 'mounted',
      // 8AC — DIGEST_AUDIT_RETENTION_DRY_RUN=1 puts the retention
      // cron into preview mode. Selects candidates and returns
      // { dry_run: true, candidate_count, sample_ids, retention_days }
      // without mutating a single row. Skips the audit-event write
      // — dry-run is a diagnostic, not an operator action.
      operator_digest_retention_dry_run: 'mounted',
      // 8AD — GET /api/admin/digest/audit-events accepts `?q=`
      // (max 120, trimmed) for ILIKE search across action, reason,
      // target_email_masked. Composes with every other filter +
      // pagination cursor.
      operator_digest_audit_search: 'mounted',
      // 8AD — same endpoint accepts `?occurred_before=<ISO>` cursor
      // (strict `<`). JSON response carries { next_cursor, has_more };
      // CSV adds X-Has-More + X-Next-Cursor headers. DigestAuditLogCard
      // gains a Load older button that preserves search + family.
      operator_digest_audit_pagination: 'mounted',
      // 8AD — `?action_family=suppression|retention|cron|all` server-
      // side fan-out. Replaces the Phase 8AC client-side multi-fetch
      // — the card's chip click is now a single round-trip. `action`
      // exact filter wins when both are supplied.
      operator_digest_audit_action_family: 'mounted',
      // 8AD — DIGEST_AUDIT_LOG_CRON_SENDS=1 enables per-recipient
      // `digest_send_cron` audit events from the operator-activity-
      // digest cron. Default off (high row volume); operators flip
      // on per environment for forensic "who got the digest at 8:03
      // UTC?" coverage. Uses the existing recordDigestAuditEvent
      // helper; best-effort, never fails the cron.
      operator_digest_cron_send_audit: 'mounted',
      // 8AD — DigestCronHealthCard surfaces an auto-dismissing
      // inline "Digest cron just ran." notice on every
      // `venuerise:digest-cron-fired` CustomEvent (alongside the
      // existing Phase 8AC silent refetch). No global toast
      // dependency.
      operator_digest_cron_fired_toast: 'mounted',
      // 8AE — DigestAuditLogCard syncs family / q / cursor to the
      // URL via router.replace + localStorage fallback for family.
      // Operators can share a "stuck investigation" link with a
      // teammate and the chip + search restore on load. URL wins
      // over localStorage; q is URL-only (not persisted).
      operator_digest_audit_url_state: 'mounted',
      // 8AE — migration 018 adds pg_trgm + a generated stored
      // `metadata_text` column on digest_audit_events + a GIN
      // trigram index. The `?q=` route widens to include
      // `metadata_text ILIKE` for terms ≥ 3 chars; sub-3-char
      // terms stay scalar-only. Log field `qMode` ∈
      // none|scalar_short|metadata_indexed.
      operator_digest_audit_metadata_search: 'mounted',
      // 8AE — /api/admin/digest/preview writes a `digest_send_preview`
      // audit row on success when DIGEST_AUDIT_LOG_CRON_SENDS=1.
      // Best-effort; reuses recordDigestAuditEvent. Same env gate
      // as the Phase 8AD cron-send audit so operators flip one knob
      // to get per-recipient digest audit coverage.
      operator_digest_preview_audit: 'mounted',
      // 8AE — `?action_family=preview` server-side fan-out alongside
      // suppression / retention / cron / all. DigestAuditLogCard
      // chip strip adds a Preview button. Action exact filter still
      // wins.
      operator_digest_audit_preview_family: 'mounted',
      // 8AF — DigestAuditLogCard honors `?digest_audit_cursor=` on
      // initial mount: first fetch passes occurred_before=<cursor>
      // and an amber "Viewing an earlier audit page." banner +
      // Jump to latest button surface. Jump to latest clears the
      // cursor in URL + memory; chip/search/Reset also clear it.
      operator_digest_audit_cursor_read: 'mounted',
      // 8AF — DigestAuditFeed mirrors the URL-state pattern:
      // digest_send_kind / digest_send_recipient / digest_send_q /
      // digest_send_cursor / digest_send_archived. URL >
      // localStorage > defaults. localStorage keys:
      //   venuerise:digest-send-feed:kind:v1
      //   venuerise:digest-send-feed:recipient:v1
      //   venuerise:digest-send-feed:include-archived:v1
      // (legacy Phase 8AC archived key still honored for one
      // release cycle). q is URL-only. Cursor read on mount with
      // earlier-page banner; Reset clears URL + storage.
      operator_digest_send_url_state: 'mounted',
      // 8AF — DigestAuditEventDrawer: click any row in
      // DigestAuditLogCard → slide-in dialog with full payload,
      // pretty-printed metadata JSON, Copy audit ID + Copy
      // metadata buttons. When metadata.outbound_message_id is
      // present, a "View related digest send" button sets
      // ?digest_send_q=<id> so the sibling DigestAuditFeed
      // filters to the matching outbound row. Pure-React render;
      // no dangerouslySetInnerHTML.
      operator_digest_audit_drawer: 'mounted',
      // 8AF — migration 019 adds a partial unique index on
      // (venue_id, target_user_id, action,
      // (occurred_at at time zone 'utc')::date)
      // where action = 'digest_send_cron'. Helper detects 23505
      // unique-violation and returns { ok: false, error:
      // 'duplicate' } as an info-level log line; the cron
      // continues. Belt-and-suspenders against duplicate
      // digest_send_cron rows from cron retries.
      operator_digest_cron_audit_dedupe: 'mounted',
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
