/**
 * Phase 9G — Enterprise SSO types.
 *
 * Vendor-agnostic shape for the SSO subsystem. Adapters
 * (workos, clerk, stytch, supabase_sso, custom_oidc) implement
 * the same interface; routes use these types so swapping a vendor
 * later is an adapter change, not a route rewrite.
 *
 * Nothing in this file performs an actual auth exchange. The
 * placeholder `not-configured` adapter (Phase 9G) returns
 * structured "not configured" errors; a future phase wires a real
 * vendor SDK in behind the same interface.
 */

// ── Identifiers ──────────────────────────────────────────────────────────

export type SsoProtocol = 'saml' | 'oidc'

export type SsoProvider =
  | 'workos'
  | 'clerk'
  | 'stytch'
  | 'supabase_sso'
  | 'custom_oidc'

export type SsoConnectionStatus =
  | 'draft'
  | 'pending'
  | 'active'
  | 'disabled'

export type SsoLoginOutcome =
  | 'initiated'
  | 'success'
  | 'failed'
  | 'blocked'

/**
 * Default role assigned to a JIT-provisioned user. Constrained to
 * the lowest-privilege subset of VENUE_ROLES so a SAML assertion
 * can NEVER mint an owner / admin / sales_manager. Operators
 * promote manually via the existing audited
 * `/api/team/members/[userId]` PATCH path.
 */
export type SsoDefaultRole = 'viewer' | 'coordinator'

// ── Persistence shapes (match migration 030) ─────────────────────────────

export interface SsoConnection {
  id: string
  venueId: string
  provider: SsoProvider
  protocol: SsoProtocol
  domain: string
  status: SsoConnectionStatus
  defaultRole: SsoDefaultRole
  jitProvisioningEnabled: boolean
  scimEnabled: boolean
  metadata: Record<string, unknown>
  createdBy: string | null
  createdAt: string
  updatedAt: string
}

export interface SsoLoginEvent {
  id: string
  venueId: string | null
  connectionId: string | null
  userId: string | null
  email: string | null
  domain: string | null
  provider: SsoProvider | null
  protocol: SsoProtocol | null
  outcome: SsoLoginOutcome
  reason: string | null
  ipHash: string | null
  requestId: string | null
  metadata: Record<string, unknown>
  createdAt: string
}

// ── Adapter inputs / outputs ─────────────────────────────────────────────

export interface SsoInitiateInput {
  email: string
  /** Normalized lowercase domain extracted from the email. */
  domain: string
  /** Active connection resolved from the domain lookup. */
  connection: SsoConnection
  /** Phase 9A request id, for cross-feed correlation. */
  requestId: string
  /** Salted-SHA-256 IP fingerprint, when available. */
  ipHash: string | null
}

export type SsoInitiateResult =
  | {
      ok: true
      /** Vendor-issued redirect URL the route returns to the browser. */
      redirectUrl: string
    }
  | {
      ok: false
      /** Stable code the route surfaces to the client. */
      code: SsoErrorCode
      /** Operator-visible explanation; never customer-facing PII. */
      message: string
    }

export interface SsoCallbackInput {
  /** Raw payload the vendor POSTed back. Adapter parses it. */
  rawBody: unknown
  /** Query string from the callback request. */
  query: Record<string, string>
  /** Phase 9A request id. */
  requestId: string
  /** Salted-SHA-256 IP fingerprint, when available. */
  ipHash: string | null
}

export type SsoCallbackResult =
  | {
      ok: true
      /** Resolved venue connection the assertion validated against. */
      connectionId: string
      venueId: string
      /** Resolved user; null when JIT provisioning is off + the user doesn't exist yet. */
      userId: string | null
      email: string
      domain: string
    }
  | {
      ok: false
      code: SsoErrorCode
      message: string
      /** Optional venue/connection context for the audit row. */
      connectionId?: string | null
      venueId?: string | null
      domain?: string | null
    }

/**
 * Stable error vocabulary. New codes append; existing codes never
 * change shape. Routes match on these to surface user-facing
 * messages; audit rows store them in `reason`.
 */
export type SsoErrorCode =
  | 'SSO_PROVIDER_NOT_CONFIGURED'
  | 'SSO_CONNECTION_NOT_ACTIVE'
  | 'SSO_DOMAIN_NOT_CONFIGURED'
  | 'SSO_CALLBACK_NOT_CONFIGURED'
  | 'SSO_CALLBACK_INVALID'
  | 'SSO_PROVIDER_ERROR'
  | 'SSO_ROLE_NOT_ALLOWED'
  | 'SSO_RATE_LIMITED'
