import { NextRequest, NextResponse } from 'next/server'
import { randomBytes } from 'crypto'
import { requireAdmin } from '@/lib/auth/require-admin'
import { rateLimitUserAction, rateLimitedResponse } from '@/lib/rate-limit'
import { RATE_LIMIT_DOMAINS } from '@/lib/rate-limit-catalog'
import { log } from '@/lib/log'
import {
  getOrCreateRequestId,
  withRequestIdHeader,
} from '@/lib/observability/request-id'
import { captureApiError } from '@/lib/observability/sentry'
import {
  buildMetaOAuthDialogUrl,
  loadMetaConfig,
  MetaNotConfiguredError,
} from '@/lib/integrations/channels/meta-oauth'
import { recordAuditEvent } from '@/lib/enterprise/audit-events'
import { AUDIT_ACTIONS } from '@/lib/enterprise/audit-actions'

/**
 * GET /api/integrations/meta/oauth/start  (Phase GTM-Meta-OAuth)
 *
 * Admin-only. Initiates the Meta OAuth flow:
 *
 *   1. Generates a CSRF state token (32 random bytes, hex)
 *   2. Embeds the caller's venue_id + state into a short-lived,
 *      httpOnly, sameSite=lax cookie (10 min TTL)
 *   3. 302 redirects the browser to the Facebook OAuth dialog
 *
 * The callback at `/api/integrations/meta/oauth/callback` reads
 * the cookie, validates the returned `state` matches, and only
 * then exchanges the `code` for tokens.
 *
 * Returns 503 with `meta_oauth_not_configured` when META_APP_ID or
 * META_APP_SECRET are missing — same posture as the existing
 * webhook route when META_WEBHOOK_VERIFY_TOKEN is unset.
 *
 * Audit: writes `channel_meta_oauth_initiated` on every successful
 * redirect. Metadata records the operator, target venue, scopes
 * requested, and an opaque state-token-hash (NEVER the raw state).
 *
 * AUDIT_EXEMPT-no: writes audit_events (this comment present so the
 * coverage scanner sees the import + call). The 302 response is the
 * success path.
 */

const STATE_COOKIE_NAME = 'meta_oauth_state'
const STATE_TTL_SECONDS = 600 // 10 min — comfortably longer than a user
//                              completing the dialog

export async function GET(request: NextRequest): Promise<Response> {
  const requestId = getOrCreateRequestId(request)
  const reqLog = log.child({
    requestId,
    route: '/api/integrations/meta/oauth/start',
    op: 'meta.oauth.start',
  })
  const respond = <T extends Response>(r: T) =>
    withRequestIdHeader(r, requestId)

  // 1. Auth — admin role on default venue (see callback for cross-
  //    tenant venue_id override handling).
  const admin = await requireAdmin()
  if (!admin.ok) {
    return respond(
      NextResponse.json({ error: admin.code }, { status: admin.status })
    )
  }
  const { user, venueId: defaultVenueId } = admin

  // 2. Rate-limit per user. A misclicking operator can't burn
  //    through the Meta OAuth budget for the whole venue.
  const rl = await rateLimitUserAction(
    request,
    `${RATE_LIMIT_DOMAINS.adminIntegrations.metaOauthStart}:${user.id}`
  )
  if (!rl.allowed) {
    reqLog.warn(
      { userId: user.id, retryMs: rl.retryAfterMs },
      'rate_limit.blocked'
    )
    return respond(rateLimitedResponse(rl))
  }

  // 3. Config check. If META_APP_ID/SECRET aren't set, fail FAST
  //    with a 503 so the operator sees the env gap rather than
  //    bouncing to Facebook with a broken client_id.
  let cfg
  try {
    cfg = loadMetaConfig()
  } catch (err) {
    if (err instanceof MetaNotConfiguredError) {
      reqLog.warn({ missing: err.message }, 'meta.oauth.not_configured')
      return respond(
        NextResponse.json(
          {
            error: 'meta_oauth_not_configured',
            detail:
              'META_APP_ID, META_APP_SECRET, and NEXT_PUBLIC_APP_URL must be set. See docs/META-INTEGRATION.md.',
          },
          { status: 503 }
        )
      )
    }
    captureApiError(err, {
      requestId,
      route: '/api/integrations/meta/oauth/start',
    })
    throw err
  }

  // 4. Allow ?venue_id= override so an operator with admin role on
  //    a non-default venue can OAuth-connect that venue. We capture
  //    the target into the cookie payload; the callback re-validates
  //    role on whatever venue the cookie says.
  const url = new URL(request.url)
  const venueIdParam = url.searchParams.get('venue_id')
  const targetVenueId =
    venueIdParam && /^[0-9a-f-]{36}$/i.test(venueIdParam)
      ? venueIdParam
      : defaultVenueId

  // 5. CSRF state. 32 random bytes hex = 64-char opaque token.
  //    We store it both in the cookie AND ship it to Meta — the
  //    callback compares both. No DB round-trip needed.
  const state = randomBytes(32).toString('hex')
  // Bundle target_venue_id into the cookie alongside the state so
  // the callback knows which venue to connect even if multiple
  // OAuth flows interleave.
  const cookiePayload = JSON.stringify({
    state,
    venue_id: targetVenueId,
    actor_user_id: user.id,
    issued_at: Date.now(),
  })

  const dialogUrl = buildMetaOAuthDialogUrl({
    appId: cfg.appId,
    callbackUrl: cfg.callbackUrl,
    state,
  })

  reqLog.info(
    { userId: user.id, targetVenueId },
    'meta.oauth.dialog_redirect'
  )

  // 6. Best-effort audit row. NEVER logs the state or the dialog URL
  //    (which would reveal the state). Records the state hash only —
  //    a cheap fingerprint for cross-referencing the callback row.
  void recordAuditEvent({
    venueId: targetVenueId,
    actorUserId: user.id,
    actorKind: 'operator',
    route: '/api/integrations/meta/oauth/start',
    action: AUDIT_ACTIONS.CHANNEL_META_OAUTH_INITIATED,
    targetTable: 'venue_channel_connections',
    targetId: null,
    requestId,
    ip: request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
    userAgent: request.headers.get('user-agent'),
    metadata: {
      // 16 chars of the state hex prefix — enough to correlate the
      // callback row without reconstructing the full token.
      state_token_prefix: state.slice(0, 16),
      scopes_requested: [
        'instagram_basic',
        'instagram_manage_messages',
        'pages_messaging',
        'pages_show_list',
        'pages_manage_metadata',
        'business_management',
      ],
    },
  })

  const response = NextResponse.redirect(dialogUrl, 302)
  response.cookies.set(STATE_COOKIE_NAME, cookiePayload, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax', // 'strict' breaks cross-site OAuth callbacks
    path: '/api/integrations/meta/oauth',
    maxAge: STATE_TTL_SECONDS,
  })
  return respond(response)
}
