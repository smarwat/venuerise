import 'server-only'
import { log } from '@/lib/log'

/**
 * Phase GTM-Meta-OAuth — Meta OAuth + Graph API client helpers.
 *
 * Pure functions + thin Graph API wrappers. No Supabase, no React.
 * The OAuth route handlers + token refresh job both call into here;
 * unit tests can stub `fetch` directly.
 *
 * ── ENVIRONMENT CONTRACT ─────────────────────────────────────────────
 *
 *   META_APP_ID                   — Meta App ID (public)
 *   META_APP_SECRET               — Meta App Secret (server-only)
 *   META_GRAPH_API_VERSION        — e.g. 'v20.0'. Defaults to 'v20.0'.
 *   META_OUTBOUND_SENDING_ENABLED — 'true' to allow real outbound
 *                                   Graph API send calls. Default
 *                                   'false' — `sendMetaMessage` throws
 *                                   `MetaSendDisabledError` so a code
 *                                   path that wires the send helper
 *                                   in too early can't accidentally
 *                                   spray production users.
 *   NEXT_PUBLIC_APP_URL           — derives the OAuth callback URL
 *                                   `${APP_URL}/api/integrations/meta/oauth/callback`.
 *
 * If ANY of the first two are missing, the helpers throw
 * `MetaNotConfiguredError`. The OAuth routes catch this and return
 * 503 — same posture as the existing webhook route when
 * META_WEBHOOK_VERIFY_TOKEN is unset.
 *
 * ── SAFETY POSTURE ───────────────────────────────────────────────────
 *
 *   - NEVER log tokens, app_secret, code, state, or signed_request
 *     fields. Logs include only IDs + outcomes.
 *   - NEVER mirror tokens into Sentry breadcrumbs, audit metadata,
 *     or response bodies. Token persistence is the caller's job;
 *     storage lives in `meta_oauth_tokens` (deny-all RLS).
 *   - Outbound `sendMetaMessage` is dual-gated:
 *       1. `META_OUTBOUND_SENDING_ENABLED === 'true'`
 *       2. Caller passes `confirmedAllowedToSend: true`
 *     Either missing throws. This is a tripwire so the helper is
 *     impossible to wire into auto-send before Meta App Review.
 */

export const DEFAULT_GRAPH_API_VERSION = 'v20.0'

export const META_OAUTH_SCOPES = [
  'instagram_basic',
  'instagram_manage_messages',
  'pages_messaging',
  'pages_show_list',
  'pages_manage_metadata',
  'business_management',
] as const

export type MetaOAuthScope = (typeof META_OAUTH_SCOPES)[number]

// ──────────────────────────────────────────────────────────────────────
//  Errors — typed so route handlers can map to clean HTTP responses
// ──────────────────────────────────────────────────────────────────────

export class MetaNotConfiguredError extends Error {
  constructor(missing: string) {
    super(`meta_oauth_not_configured: ${missing}`)
    this.name = 'MetaNotConfiguredError'
  }
}

export class MetaSendDisabledError extends Error {
  constructor() {
    super(
      'meta_outbound_sending_disabled: set META_OUTBOUND_SENDING_ENABLED=true and pass confirmedAllowedToSend after App Review approval'
    )
    this.name = 'MetaSendDisabledError'
  }
}

export class MetaGraphError extends Error {
  readonly status: number
  readonly metaCode: number | null
  readonly metaSubcode: number | null
  readonly metaType: string | null
  readonly fbtraceId: string | null
  constructor(
    status: number,
    metaCode: number | null,
    metaSubcode: number | null,
    metaType: string | null,
    fbtraceId: string | null,
    message: string
  ) {
    super(message)
    this.name = 'MetaGraphError'
    this.status = status
    this.metaCode = metaCode
    this.metaSubcode = metaSubcode
    this.metaType = metaType
    this.fbtraceId = fbtraceId
  }
}

// ──────────────────────────────────────────────────────────────────────
//  Env loader
// ──────────────────────────────────────────────────────────────────────

interface MetaConfig {
  appId: string
  appSecret: string
  graphVersion: string
  callbackUrl: string
}

export function loadMetaConfig(): MetaConfig {
  const appId = process.env.META_APP_ID?.trim()
  const appSecret = process.env.META_APP_SECRET?.trim()
  const graphVersion =
    process.env.META_GRAPH_API_VERSION?.trim() || DEFAULT_GRAPH_API_VERSION
  const appUrl = process.env.NEXT_PUBLIC_APP_URL?.trim()
  if (!appId) throw new MetaNotConfiguredError('META_APP_ID')
  if (!appSecret) throw new MetaNotConfiguredError('META_APP_SECRET')
  if (!appUrl) throw new MetaNotConfiguredError('NEXT_PUBLIC_APP_URL')
  return {
    appId,
    appSecret,
    graphVersion,
    callbackUrl: `${appUrl.replace(/\/+$/, '')}/api/integrations/meta/oauth/callback`,
  }
}

export function metaIsConfigured(): boolean {
  try {
    loadMetaConfig()
    return true
  } catch {
    return false
  }
}

// ──────────────────────────────────────────────────────────────────────
//  OAuth — URL construction (pure)
// ──────────────────────────────────────────────────────────────────────

/**
 * Build the Facebook OAuth dialog URL the user gets redirected to.
 * `state` MUST be a cryptographically-random CSRF token that the
 * callback validates against a short-lived cookie.
 */
export function buildMetaOAuthDialogUrl(args: {
  appId: string
  callbackUrl: string
  state: string
  scopes?: ReadonlyArray<MetaOAuthScope>
  graphVersion?: string
}): string {
  const scopes = args.scopes ?? META_OAUTH_SCOPES
  const version = args.graphVersion ?? DEFAULT_GRAPH_API_VERSION
  const url = new URL(`https://www.facebook.com/${version}/dialog/oauth`)
  url.searchParams.set('client_id', args.appId)
  url.searchParams.set('redirect_uri', args.callbackUrl)
  url.searchParams.set('state', args.state)
  url.searchParams.set('scope', scopes.join(','))
  url.searchParams.set('response_type', 'code')
  // `auth_type=rerequest` so a user who previously declined a scope
  // sees it again on re-OAuth instead of silently being approved
  // with the reduced set.
  url.searchParams.set('auth_type', 'rerequest')
  return url.toString()
}

// ──────────────────────────────────────────────────────────────────────
//  Graph API calls
// ──────────────────────────────────────────────────────────────────────

interface GraphFetchOptions {
  method?: 'GET' | 'POST'
  searchParams?: Record<string, string>
  body?: Record<string, unknown>
  /** Per-request timeout. Default 10s — Graph is usually <2s. */
  timeoutMs?: number
  requestId?: string
}

async function graphFetch<T>(
  path: string,
  options: GraphFetchOptions = {}
): Promise<T> {
  const cfg = loadMetaConfig()
  const url = new URL(`https://graph.facebook.com/${cfg.graphVersion}${path}`)
  if (options.searchParams) {
    for (const [k, v] of Object.entries(options.searchParams)) {
      url.searchParams.set(k, v)
    }
  }
  const controller = new AbortController()
  const timer = setTimeout(
    () => controller.abort(new Error('meta_graph_timeout')),
    options.timeoutMs ?? 10_000
  )
  const reqLog = log.child({
    requestId: options.requestId,
    op: 'meta.graph',
    path,
  })
  const startedAt = Date.now()
  try {
    const resp = await fetch(url.toString(), {
      method: options.method ?? 'GET',
      headers: options.body
        ? { 'Content-Type': 'application/json' }
        : undefined,
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: controller.signal,
    })
    const elapsed = Date.now() - startedAt
    let json: unknown = null
    try {
      json = await resp.json()
    } catch {
      // fall through with json=null
    }
    if (!resp.ok) {
      const err = extractGraphError(resp.status, json)
      reqLog.warn(
        {
          status: resp.status,
          metaCode: err.metaCode,
          metaSubcode: err.metaSubcode,
          metaType: err.metaType,
          fbtraceId: err.fbtraceId,
          elapsedMs: elapsed,
        },
        'meta.graph.error'
      )
      throw err
    }
    reqLog.info({ elapsedMs: elapsed }, 'meta.graph.ok')
    return json as T
  } finally {
    clearTimeout(timer)
  }
}

function extractGraphError(status: number, body: unknown): MetaGraphError {
  if (body && typeof body === 'object' && 'error' in body) {
    const e = (body as { error: unknown }).error
    if (e && typeof e === 'object') {
      const eo = e as Record<string, unknown>
      return new MetaGraphError(
        status,
        typeof eo.code === 'number' ? eo.code : null,
        typeof eo.error_subcode === 'number' ? eo.error_subcode : null,
        typeof eo.type === 'string' ? eo.type : null,
        typeof eo.fbtrace_id === 'string' ? eo.fbtrace_id : null,
        typeof eo.message === 'string' ? eo.message : `meta_graph_error_${status}`
      )
    }
  }
  return new MetaGraphError(
    status,
    null,
    null,
    null,
    null,
    `meta_graph_error_${status}`
  )
}

// ──────────────────────────────────────────────────────────────────────
//  Token exchanges
// ──────────────────────────────────────────────────────────────────────

interface ShortLivedTokenResponse {
  access_token: string
  token_type: string
  expires_in?: number
}

/**
 * Step 1 of OAuth — exchange the `code` from the callback for a
 * short-lived user access token (~1 hour). Wrapper around
 * `GET /oauth/access_token`.
 */
export async function exchangeCodeForUserToken(args: {
  code: string
  requestId?: string
}): Promise<ShortLivedTokenResponse> {
  const cfg = loadMetaConfig()
  return graphFetch<ShortLivedTokenResponse>('/oauth/access_token', {
    method: 'GET',
    searchParams: {
      client_id: cfg.appId,
      client_secret: cfg.appSecret,
      redirect_uri: cfg.callbackUrl,
      code: args.code,
    },
    requestId: args.requestId,
  })
}

/**
 * Step 2 — exchange the short-lived user token for a long-lived
 * (~60 day) user token. Required before requesting Page tokens
 * so the resulting Page tokens are themselves long-lived.
 */
export async function exchangeForLongLivedUserToken(args: {
  shortLivedUserToken: string
  requestId?: string
}): Promise<ShortLivedTokenResponse> {
  const cfg = loadMetaConfig()
  return graphFetch<ShortLivedTokenResponse>('/oauth/access_token', {
    method: 'GET',
    searchParams: {
      grant_type: 'fb_exchange_token',
      client_id: cfg.appId,
      client_secret: cfg.appSecret,
      fb_exchange_token: args.shortLivedUserToken,
    },
    requestId: args.requestId,
  })
}

interface MetaUserPage {
  id: string
  name: string
  access_token: string
  category?: string | null
  tasks?: string[]
  /** Present when the Page has an Instagram Business account linked. */
  instagram_business_account?: { id: string } | null
}

/**
 * Step 3 — list every Page the user grants us access to, each with
 * its own Page Access Token (long-lived because we did step 2
 * first). Returns also the IG Business Account ID when linked.
 */
export async function listUserPagesWithTokens(args: {
  userAccessToken: string
  requestId?: string
}): Promise<MetaUserPage[]> {
  type Resp = {
    data: MetaUserPage[]
    paging?: { next?: string }
  }
  const out: MetaUserPage[] = []
  let cursor: string | null = '/me/accounts'
  let safety = 0
  while (cursor && safety < 10) {
    safety += 1
    const resp: Resp = await graphFetch<Resp>(cursor, {
      method: 'GET',
      searchParams: {
        access_token: args.userAccessToken,
        fields:
          'id,name,access_token,category,tasks,instagram_business_account{id}',
        limit: '50',
      },
      requestId: args.requestId,
    })
    if (Array.isArray(resp.data)) out.push(...resp.data)
    // Defensive: stop paging — most venues have 1-2 Pages.
    cursor = null
  }
  return out
}

/**
 * Subscribe a Page to the app's webhook fields. Required after
 * OAuth so the Page actually delivers incoming DMs to our
 * webhook receiver.
 */
export async function subscribePageToWebhooks(args: {
  pageId: string
  pageAccessToken: string
  requestId?: string
}): Promise<{ success: boolean }> {
  return graphFetch<{ success: boolean }>(
    `/${args.pageId}/subscribed_apps`,
    {
      method: 'POST',
      searchParams: {
        access_token: args.pageAccessToken,
        subscribed_fields:
          'messages,messaging_postbacks,message_deliveries,messaging_handovers',
      },
      requestId: args.requestId,
    }
  )
}

// ──────────────────────────────────────────────────────────────────────
//  Outbound — DUAL-GATED, throws unless explicitly enabled
// ──────────────────────────────────────────────────────────────────────

export interface SendMetaMessageArgs {
  /** Long-lived Page Access Token. Caller loads from
   *  `meta_oauth_tokens` via the service client. */
  pageAccessToken: string
  /** The recipient's PSID (Page-scoped ID) as delivered by the
   *  webhook in `sender.id`. */
  recipientPsid: string
  text: string
  /** Tripwire flag: the caller MUST explicitly opt in to sending.
   *  Combined with `META_OUTBOUND_SENDING_ENABLED=true` env. Without
   *  BOTH, the helper throws `MetaSendDisabledError`. */
  confirmedAllowedToSend: true
  requestId?: string
}

export async function sendMetaMessage(
  args: SendMetaMessageArgs
): Promise<{ recipient_id: string; message_id: string }> {
  if (
    process.env.META_OUTBOUND_SENDING_ENABLED !== 'true' ||
    args.confirmedAllowedToSend !== true
  ) {
    throw new MetaSendDisabledError()
  }
  return graphFetch<{ recipient_id: string; message_id: string }>(
    '/me/messages',
    {
      method: 'POST',
      searchParams: { access_token: args.pageAccessToken },
      body: {
        recipient: { id: args.recipientPsid },
        message: { text: args.text },
        // RESPONSE = within the 24-hour messaging window. Anything
        // else requires a Message Tag (CONFIRMED_EVENT_UPDATE etc.)
        // and is rejected for typical sales-followup content.
        messaging_type: 'RESPONSE',
      },
      requestId: args.requestId,
    }
  )
}
