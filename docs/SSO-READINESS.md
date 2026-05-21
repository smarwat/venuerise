# SSO Readiness — Phase 9G

## Current state

VenueRise has the **scaffolding** for enterprise SSO/SAML/OIDC
but does NOT yet perform any real auth exchange. The system is in
"readiness mode": connections persist, login attempts are
audited, admin endpoints + UI are mounted, but every initiate /
callback resolves to a `notConfiguredAdapter` placeholder that
returns structured `SSO_*` error codes.

The point of this phase is to make the next phase — wiring a real
vendor — a single-file change instead of a multi-week refactor.

## What is implemented (Phase 9G)

- **Migration 030** — `sso_connections` + `sso_login_events`
  tables. Owner-only mutations on connections, admin SELECT,
  service-role-only inserts on events.
- **`lib/enterprise/sso/types.ts`** — typed shapes for protocol,
  provider, status, default role, connection, login event, and
  every adapter input/output. Stable `SsoErrorCode` vocabulary.
- **`lib/enterprise/sso/domain.ts`** — pure email-domain helpers
  (`normalizeEmailDomain`, `extractDomainFromEmail`,
  `isLikelyValidDomain`). Conservative regex; no DNS lookup.
- **`lib/enterprise/sso/audit.ts`** — `recordSsoLoginEvent`
  best-effort writer (never throws; logs + Sentry on failure).
- **`lib/enterprise/sso/provider.ts`** — `SsoProviderAdapter`
  interface + `resolveSsoAdapter()` registry. Every provider
  resolves to the placeholder in 9G.
- **`lib/enterprise/sso/adapters/not-configured.ts`** —
  placeholder adapter. `initiate` → `SSO_PROVIDER_NOT_CONFIGURED`,
  `handleCallback` → `SSO_CALLBACK_NOT_CONFIGURED`.
- **Public routes** — `POST /api/auth/sso/initiate` and
  `POST /api/auth/sso/callback`. Rate-limited via the new
  `vr:sso` Upstash prefix (10/min). `AUDIT_EXEMPT` because the
  forensic record lives in `sso_login_events`.
- **Admin endpoints**:
  - `GET /api/admin/security/sso-connections` — list (admin/owner)
  - `POST /api/admin/security/sso-connections` — create draft (owner)
  - `PATCH /api/admin/security/sso-connections/[id]` — update (owner)
  - `DELETE /api/admin/security/sso-connections/[id]` — delete draft/disabled (owner)
  - `GET /api/admin/security/sso-login-events` — list events (admin/owner)
- **Admin UI** — `SsoConnectionsCard` + `SsoLoginEventsCard` on
  `/dashboard/settings/billing` (admin-only mount).
- **Audit instrumentation** — `sso_connection_create`,
  `sso_connection_update`, `sso_connection_delete` actions on
  `audit_events` + mirror.
- **Rate-limit catalog** — `auth:sso:*` + `admin:sso-*` keys
  documented in `lib/rate-limit-catalog.ts`.

## What is intentionally placeholder

- **Vendor adapters** — every provider resolves to the
  `notConfiguredAdapter`. No real SAML / OIDC exchange.
- **JIT provisioning** — flag exists on the connection row but no
  code path consumes it. The future callback handler will create
  the user via `supabase.auth.admin.createUser({ email, ... })`
  + insert a `venue_members` row with `role = connection.default_role`.
- **SCIM provisioning** — flag exists on the row; no SCIM
  endpoint is mounted. A future phase wires SCIM at
  `/api/scim/v2/*` per RFC 7644 with the vendor's bearer token.
- **Secrets / certs** — never stored in the database. SAML signing
  certs + OIDC client secrets live in the vendor dashboard +
  process env. `metadata` jsonb is reserved for non-secret
  vendor refs (e.g. WorkOS connection id).
- **Session establishment** — the future callback handler will
  call `supabase.auth.admin.generateLink({ type: 'magiclink', ... })`
  or set a Supabase session cookie directly. None of that ships
  in 9G.

## SAML vs OIDC decision guide

| Dimension | SAML 2.0 | OIDC |
|---|---|---|
| Age | Mature, 2005 | Modern, 2014 |
| Enterprise IDP support | Universal (Okta, Azure AD, OneLogin, Ping) | Universal + better mobile/SPA story |
| Wire format | XML with signed assertions | JSON Web Tokens |
| Common buyer ask | "Yes we need SAML for procurement" | "OIDC is fine, our IDP supports it" |
| Implementation complexity | High (XML signing, certificates, response-binding nuance) | Lower (HTTP redirects + JWT verification) |
| Default for new builds | OIDC | OIDC |

**Recommendation for VenueRise:**
- Default to OIDC for new connections — simpler, fewer
  cert-rotation issues, better debugging via JWT inspection.
- Support SAML when a specific buyer requires it (most large
  venues won't; some hotel/resort chains with Active Directory
  Federation Services will).
- The connection row's `protocol` column already supports both.
  An adapter that supports both registers two entries in
  `RESOLVE` (one per protocol).

## Vendor comparison

| Vendor | Strength | Weakness | Best for |
|---|---|---|---|
| **WorkOS** | Best-in-class SAML + OIDC + SCIM. Fastest "we accept your IDP" story. Pricing transparent. | Per-connection cost adds up at scale. | Recommended default — fastest path to "we support SAML" answer. |
| **Stytch** | OIDC-first, modern API, good SDK. SAML newer than WorkOS. | SAML quirks under load have been reported. | OIDC-heavy customer mix. |
| **Clerk** | Bundles auth UI + SSO. Excellent React story. | Lock-in: harder to swap if you've already adopted their hosted UI. | Greenfield projects that want one auth vendor for everything. |
| **Supabase SSO** | Same vendor as the database. Single config surface. | SAML-only as of writing. No SCIM. Limited to enterprise plan. | If we go all-in on Supabase + a buyer accepts SAML-only. |
| **Custom OIDC** | Zero vendor cost. Full control. | We own SAML XML parsing + cert rotation forever. | Last resort. |

**Recommended default: WorkOS.** Fastest enterprise SAML/OIDC +
SCIM with the least lock-in. The connection row carries
`provider = 'workos'` + WorkOS connection id in `metadata`; the
adapter file at `lib/enterprise/sso/adapters/workos.ts` is the
single piece a future phase needs to add.

## Security rules

1. **JIT users default to lowest privilege.** The connection
   row's `default_role` is constrained at the DB layer (CHECK
   constraint) to `viewer` or `coordinator`. A SAML assertion can
   NEVER mint an owner/admin/sales_manager.
2. **Owner manually promotes.** Promotion to higher roles flows
   through the existing `/api/team/members/[userId]` PATCH —
   Phase 9B audited, Phase 9F rate-limited.
3. **No raw IP storage.** Every `sso_login_events` row hashes IP
   via `maskIpForAudit` (Phase 9A) before insert.
4. **Audit every initiate + callback.** Even blocked attempts
   write a row. The SsoLoginEventsCard surfaces them.
5. **Rate-limit every SSO endpoint.** Phase 9F's coverage scanner
   enforces this. Initiate is keyed by `${ip}:${domain}`;
   callback by `${ip}` (the identifier isn't extractable before
   parsing).
6. **Owner-only connection mutations.** Application layer +
   migration 030 RLS both enforce this. Admin role is too
   permissive for the surface that controls who can log in.
7. **No secrets in the database.** Vendor SDKs read from env;
   the connection's `metadata` jsonb carries non-secret refs
   only.

## Future implementation checklist

When the time comes to wire a real adapter (likely WorkOS):

1. `npm i @workos-inc/node` — add SDK.
2. `WORKOS_API_KEY`, `WORKOS_CLIENT_ID`, `WORKOS_REDIRECT_URI`
   in env. Document rotation cadence in RUNBOOK secrets table.
3. Create `lib/enterprise/sso/adapters/workos.ts` implementing
   `SsoProviderAdapter`:
   - `initiate(input)` calls `workos.sso.getAuthorizationUrl(...)`
     with `connection: input.connection.metadata.workos_connection_id`,
     `clientId`, `redirectUri`, `state` (signed JWT carrying
     `connectionId` for callback resolution).
   - `handleCallback(input)` calls
     `workos.sso.getProfileAndToken({ code: input.query.code, clientId })`,
     verifies the state JWT, resolves the connection.
4. Update `resolveSsoAdapter()` in `lib/enterprise/sso/provider.ts`
   to return the WorkOS adapter when `provider === 'workos'`.
5. Implement JIT in the callback route:
   - Look up `auth.users` by email.
   - If absent AND `connection.jit_provisioning_enabled`, create
     the user via `supabase.auth.admin.createUser`.
   - Insert / upsert `venue_members` row with
     `role = connection.default_role`.
   - Set session cookie via Supabase auth helpers.
6. Test with a WorkOS sandbox connection. Verify `sso_login_events`
   shows the full `initiated → success` chain.
7. Update health flags to `sso_workos_adapter: 'mounted'` and
   bump `ADMIN_ENDPOINT_COUNT` if you add a SCIM endpoint.

The point of 9G: items 3–6 are the only ones that require new
code. Everything else (DB, audit, rate limit, RBAC, UI) is
already done.

## Known limitations

- No real SAML/OIDC exchange yet — placeholder adapter only.
- No SCIM provisioning yet — flag exists; endpoint doesn't.
- No JIT user creation yet — connection callback resolves to
  placeholder error.
- No SSO secrets / certificates stored — by design.
- Provider adapter is intentionally placeholder — vendor SDK
  swap is the next phase.
- Admin role can read connections but cannot mutate them.
  Owner-only mutations are deliberate; if it becomes a workflow
  burr, the application-layer gate can relax to `['owner','admin']`
  without a migration (RLS UPDATE/DELETE policies would need a
  matching change).
