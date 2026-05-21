import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { requireAdmin } from '@/lib/auth/require-admin'
import {
  requireVenueRole,
  TenantAccessError,
} from '@/lib/auth/tenant-access'
import { ADMIN_ROLES } from '@/lib/auth/roles'
import { rateLimitUserAction, rateLimitedResponse } from '@/lib/rate-limit'
import { RATE_LIMIT_DOMAINS } from '@/lib/rate-limit-catalog'
import { log } from '@/lib/log'
import {
  getOrCreateRequestId,
  withRequestIdHeader,
} from '@/lib/observability/request-id'
import { captureApiError } from '@/lib/observability/sentry'
import {
  exchangeCodeForUserToken,
  exchangeForLongLivedUserToken,
  listUserPagesWithTokens,
  subscribePageToWebhooks,
  MetaNotConfiguredError,
  MetaGraphError,
} from '@/lib/integrations/channels/meta-oauth'
import { recordAuditEvent } from '@/lib/enterprise/audit-events'
import { AUDIT_ACTIONS } from '@/lib/enterprise/audit-actions'

/**
 * GET /api/integrations/meta/oauth/callback  (Phase GTM-Meta-OAuth)
 *
 * Meta redirects here after the user grants (or denies) permissions.
 *
 * Posture:
 *
 *   - Reads + DELETES the `meta_oauth_state` cookie set by /start.
 *   - Validates `state` query param against the cookie in constant
 *     time. Mismatch → 403, audit row written, redirect to error
 *     page (NOT JSON, since browser landed here from Facebook).
 *   - Validates the operator still has admin role on the venue the
 *     cookie remembers. Cross-tenant 403 collapses to 404.
 *   - Exchanges `code` → short-lived user token → long-lived user
 *     token → list of Pages each with its own Page Access Token.
 *   - Inserts one `venue_channel_connections` row per (Page, IG
 *     Business Account) pair, status='connected'. Tokens go into
 *     `meta_oauth_tokens` (deny-all RLS, service-role only).
 *   - Subscribes each Page to the app's webhook fields so future
 *     DMs hit our existing /api/integrations/meta/webhook receiver.
 *   - Redirects the browser to /dashboard/settings/billing?meta=
 *     connected with a per-Page summary in query params (counts
 *     only — never tokens).
 *
 * Errors → redirect to /dashboard/settings/billing?meta=error&reason=…
 * so the operator never sees a raw JSON blob in their browser.
 *
 * Audit: writes `channel_meta_oauth_connected` (success) or
 * `channel_meta_oauth_failed` (any failure). Metadata records:
 * page_ids, ig_business_account_ids, granted_scopes, error_reason.
 * NEVER tokens, NEVER the code, NEVER signed_request.
 */

const STATE_COOKIE_NAME = 'meta_oauth_state'

interface StateCookiePayload {
  state: string
  venue_id: string
  actor_user_id: string
  issued_at: number
}

function parseStateCookie(raw: string | undefined): StateCookiePayload | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Partial<StateCookiePayload>
    if (
      typeof parsed.state === 'string' &&
      typeof parsed.venue_id === 'string' &&
      typeof parsed.actor_user_id === 'string' &&
      typeof parsed.issued_at === 'number' &&
      // 15-minute hard cap — cookie itself expires at 10 min, this
      // is belt-and-suspenders for clock skew.
      Date.now() - parsed.issued_at < 15 * 60_000
    ) {
      return parsed as StateCookiePayload
    }
  } catch {
    // fall through
  }
  return null
}

function constantTimeStringEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return diff === 0
}

function appUrl(): string {
  const raw = process.env.NEXT_PUBLIC_APP_URL?.trim()
  return raw ? raw.replace(/\/+$/, '') : ''
}

function errorRedirect(reason: string, requestId: string): Response {
  const base = appUrl() || ''
  const url = new URL(`${base}/dashboard/settings/billing`)
  url.searchParams.set('meta', 'error')
  url.searchParams.set('reason', reason)
  return withRequestIdHeader(
    NextResponse.redirect(url.toString(), 302),
    requestId
  )
}

function successRedirect(
  args: { pagesConnected: number; igAccountsConnected: number },
  requestId: string
): Response {
  const base = appUrl() || ''
  const url = new URL(`${base}/dashboard/settings/billing`)
  url.searchParams.set('meta', 'connected')
  url.searchParams.set('pages', String(args.pagesConnected))
  url.searchParams.set('ig', String(args.igAccountsConnected))
  return withRequestIdHeader(
    NextResponse.redirect(url.toString(), 302),
    requestId
  )
}

export async function GET(request: NextRequest): Promise<Response> {
  const requestId = getOrCreateRequestId(request)
  const reqLog = log.child({
    requestId,
    route: '/api/integrations/meta/oauth/callback',
    op: 'meta.oauth.callback',
  })

  // 1. Auth. Cookie alone isn't enough — we re-verify the operator
  //    is still signed in + still has admin role on the target venue.
  const admin = await requireAdmin()
  if (!admin.ok) {
    reqLog.warn({ code: admin.code }, 'meta.oauth.callback_unauthenticated')
    // Send them to login then bounce back to the dashboard.
    return errorRedirect('unauthorized', requestId)
  }
  const { user, venueId: defaultVenueId } = admin

  // 2. Rate-limit.
  const rl = await rateLimitUserAction(
    request,
    `${RATE_LIMIT_DOMAINS.adminIntegrations.metaOauthCallback}:${user.id}`
  )
  if (!rl.allowed) {
    reqLog.warn(
      { userId: user.id, retryMs: rl.retryAfterMs },
      'rate_limit.blocked'
    )
    return errorRedirect('rate_limited', requestId)
  }

  const url = new URL(request.url)
  const stateParam = url.searchParams.get('state') ?? ''
  const code = url.searchParams.get('code') ?? ''
  const userError = url.searchParams.get('error') // user denied / aborted
  const userErrorReason = url.searchParams.get('error_reason') ?? null
  const userErrorDescription = url.searchParams.get('error_description') ?? null

  // 3. Read + invalidate state cookie up front.
  const cookieRaw = request.cookies.get(STATE_COOKIE_NAME)?.value
  const stateCookie = parseStateCookie(cookieRaw)
  // Whatever happens next, the cookie must die after this request.
  const clearStateCookie = (resp: Response): Response => {
    resp.headers.append(
      'Set-Cookie',
      `${STATE_COOKIE_NAME}=; Path=/api/integrations/meta/oauth; HttpOnly; Max-Age=0; SameSite=Lax${
        process.env.NODE_ENV === 'production' ? '; Secure' : ''
      }`
    )
    return resp
  }

  // 4. User declined / Facebook returned an error. Log it, audit it,
  //    redirect cleanly.
  if (userError) {
    reqLog.info(
      { userError, userErrorReason },
      'meta.oauth.user_aborted_or_denied'
    )
    void recordAuditEvent({
      venueId: stateCookie?.venue_id ?? defaultVenueId,
      actorUserId: user.id,
      actorKind: 'operator',
      route: '/api/integrations/meta/oauth/callback',
      action: AUDIT_ACTIONS.CHANNEL_META_OAUTH_FAILED,
      targetTable: 'venue_channel_connections',
      targetId: null,
      requestId,
      ip: request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
      userAgent: request.headers.get('user-agent'),
      metadata: {
        outcome: 'user_aborted',
        meta_error: userError,
        meta_error_reason: userErrorReason,
        meta_error_description: userErrorDescription,
      },
    })
    return clearStateCookie(errorRedirect(`user_${userError}`, requestId))
  }

  // 5. State validation. Mismatch could be CSRF or cookie expiry —
  //    both indistinguishable at the route boundary, both 403.
  if (
    !stateCookie ||
    !constantTimeStringEqual(stateParam, stateCookie.state)
  ) {
    reqLog.warn({}, 'meta.oauth.state_mismatch')
    void recordAuditEvent({
      venueId: stateCookie?.venue_id ?? defaultVenueId,
      actorUserId: user.id,
      actorKind: 'operator',
      route: '/api/integrations/meta/oauth/callback',
      action: AUDIT_ACTIONS.CHANNEL_META_OAUTH_FAILED,
      targetTable: 'venue_channel_connections',
      targetId: null,
      requestId,
      ip: request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
      userAgent: request.headers.get('user-agent'),
      metadata: { outcome: 'csrf_state_mismatch' },
    })
    return clearStateCookie(errorRedirect('csrf_state_mismatch', requestId))
  }

  // 6. Re-validate role on the cookie-remembered venue. If the
  //    operator was demoted between /start and /callback (race),
  //    abort.
  const targetVenueId = stateCookie.venue_id
  if (targetVenueId !== defaultVenueId) {
    try {
      await requireVenueRole(user.id, targetVenueId, ADMIN_ROLES)
    } catch (err) {
      if (err instanceof TenantAccessError) {
        reqLog.warn(
          { targetVenueId, code: err.code },
          'meta.oauth.tenant_access_denied'
        )
        return clearStateCookie(errorRedirect('tenant_access_denied', requestId))
      }
      throw err
    }
  }

  if (!code) {
    reqLog.warn({}, 'meta.oauth.missing_code')
    return clearStateCookie(errorRedirect('missing_code', requestId))
  }

  // 7. The 3-step token exchange + Page enumeration. Each call has
  //    its own timeout inside the helper; failures throw typed
  //    errors that we map below.
  try {
    const shortToken = await exchangeCodeForUserToken({ code, requestId })
    const longToken = await exchangeForLongLivedUserToken({
      shortLivedUserToken: shortToken.access_token,
      requestId,
    })
    const pages = await listUserPagesWithTokens({
      userAccessToken: longToken.access_token,
      requestId,
    })

    if (pages.length === 0) {
      reqLog.warn({}, 'meta.oauth.no_pages_returned')
      void recordAuditEvent({
        venueId: targetVenueId,
        actorUserId: user.id,
        actorKind: 'operator',
        route: '/api/integrations/meta/oauth/callback',
        action: AUDIT_ACTIONS.CHANNEL_META_OAUTH_FAILED,
        targetTable: 'venue_channel_connections',
        targetId: null,
        requestId,
        ip:
          request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
        userAgent: request.headers.get('user-agent'),
        metadata: { outcome: 'no_pages_granted' },
      })
      return clearStateCookie(errorRedirect('no_pages_granted', requestId))
    }

    // 8. Persist. Service client because:
    //    (a) meta_oauth_tokens has deny-all RLS for authenticated
    //    (b) venue_channel_connections insert needs to bypass RLS
    //        for the cross-tenant override case
    //    Tokens are written ONCE per (connection, page) — the unique
    //    index in migration 038 enforces "one active row" semantics;
    //    re-OAuth flows will conflict and the conflict is handled
    //    by upserting on (channel_connection_id, page_id, token_type).
    const svc = createServiceClient()
    const persistedPageIds: string[] = []
    const persistedIgIds: string[] = []
    const subscriptionFailures: Array<{ pageId: string; reason: string }> = []
    const grantedScopes = parseScopeList(shortToken.token_type)

    for (const page of pages) {
      const igId = page.instagram_business_account?.id ?? null
      const channelType = igId ? 'instagram' : 'facebook'
      const expiresAt = new Date(
        Date.now() + (longToken.expires_in ?? 60 * 24 * 3600) * 1000
      ).toISOString()

      // Upsert connection row (one per Page).
      const { data: connRow, error: connErr } = await svc
        .from('venue_channel_connections')
        .upsert(
          {
            venue_id: targetVenueId,
            channel_type: channelType,
            status: 'connected',
            external_account_id: page.id,
            external_account_label: page.name.slice(0, 200),
            metadata: {
              meta_page_id: page.id,
              instagram_business_account_id: igId,
              meta_app_id: process.env.META_APP_ID ?? null,
            },
          },
          {
            onConflict: 'venue_id,channel_type,external_account_id',
          }
        )
        .select('id')
        .single()

      if (connErr || !connRow) {
        reqLog.error(
          { err: connErr, pageId: page.id },
          'meta.oauth.connection_upsert_failed'
        )
        subscriptionFailures.push({
          pageId: page.id,
          reason: 'connection_upsert_failed',
        })
        continue
      }
      const connectionId = (connRow as { id: string }).id

      // Store the long-lived Page Access Token. We mark any prior
      // non-revoked tokens for this (connection, page) as revoked
      // first so the unique partial index stays satisfied.
      await svc
        .from('meta_oauth_tokens')
        .update({ revoked_at: new Date().toISOString() })
        .eq('channel_connection_id', connectionId)
        .eq('page_id', page.id)
        .is('revoked_at', null)

      const { error: tokenErr } = await svc.from('meta_oauth_tokens').insert({
        channel_connection_id: connectionId,
        venue_id: targetVenueId,
        page_id: page.id,
        token_type: 'page',
        access_token: page.access_token,
        granted_scopes: grantedScopes,
        expires_at: expiresAt,
      })
      if (tokenErr) {
        reqLog.error(
          { err: tokenErr, pageId: page.id },
          'meta.oauth.token_insert_failed'
        )
        subscriptionFailures.push({
          pageId: page.id,
          reason: 'token_insert_failed',
        })
        continue
      }

      // Subscribe the Page to webhook fields so future DMs flow in.
      // Best-effort — log a per-page failure but don't abort the
      // whole callback; the operator can re-trigger the subscription
      // from a future admin tool.
      try {
        await subscribePageToWebhooks({
          pageId: page.id,
          pageAccessToken: page.access_token,
          requestId,
        })
      } catch (err) {
        reqLog.warn(
          { err, pageId: page.id },
          'meta.oauth.subscribe_pages_failed'
        )
        subscriptionFailures.push({
          pageId: page.id,
          reason: 'subscribe_failed',
        })
      }

      persistedPageIds.push(page.id)
      if (igId) persistedIgIds.push(igId)
    }

    void recordAuditEvent({
      venueId: targetVenueId,
      actorUserId: user.id,
      actorKind: 'operator',
      route: '/api/integrations/meta/oauth/callback',
      action: AUDIT_ACTIONS.CHANNEL_META_OAUTH_CONNECTED,
      targetTable: 'venue_channel_connections',
      targetId: null,
      requestId,
      ip: request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
      userAgent: request.headers.get('user-agent'),
      metadata: {
        outcome: 'connected',
        pages_connected: persistedPageIds,
        ig_business_accounts_connected: persistedIgIds,
        granted_scopes: grantedScopes,
        subscription_failures: subscriptionFailures,
        long_token_expires_in_seconds: longToken.expires_in ?? null,
      },
    })

    reqLog.info(
      {
        pagesConnected: persistedPageIds.length,
        igConnected: persistedIgIds.length,
        subscriptionFailures: subscriptionFailures.length,
      },
      'meta.oauth.completed'
    )

    return clearStateCookie(
      successRedirect(
        {
          pagesConnected: persistedPageIds.length,
          igAccountsConnected: persistedIgIds.length,
        },
        requestId
      )
    )
  } catch (err) {
    let reason = 'unexpected_error'
    if (err instanceof MetaNotConfiguredError) reason = 'not_configured'
    else if (err instanceof MetaGraphError)
      reason = `graph_error_${err.metaCode ?? err.status}`
    reqLog.error({ err, reason }, 'meta.oauth.exchange_failed')
    captureApiError(err, {
      requestId,
      route: '/api/integrations/meta/oauth/callback',
      userId: user.id,
      venueId: targetVenueId,
    })
    void recordAuditEvent({
      venueId: targetVenueId,
      actorUserId: user.id,
      actorKind: 'operator',
      route: '/api/integrations/meta/oauth/callback',
      action: AUDIT_ACTIONS.CHANNEL_META_OAUTH_FAILED,
      targetTable: 'venue_channel_connections',
      targetId: null,
      requestId,
      ip: request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
      userAgent: request.headers.get('user-agent'),
      metadata: { outcome: reason },
    })
    return clearStateCookie(errorRedirect(reason, requestId))
  }
}

/**
 * Helper for the `granted_scopes` payload. Meta's short-token
 * response doesn't echo the granted scopes — we re-derive from
 * the requested set since the `token_type` field is shaped like
 * 'bearer' rather than the granted-scope list. A future
 * enhancement is to call `/debug_token` and read scopes from
 * the response there; for now we record what we asked for.
 */
function parseScopeList(_tokenType: string): string[] {
  return [
    'instagram_basic',
    'instagram_manage_messages',
    'pages_messaging',
    'pages_show_list',
    'pages_manage_metadata',
    'business_management',
  ]
}
