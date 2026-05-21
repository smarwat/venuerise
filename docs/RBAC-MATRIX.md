# RBAC Posture Matrix

Per-route tenant + role posture for every authenticated mutating
route. Pairs with `docs/AUDIT-COVERAGE.md` (which catalogs audit
writes); this doc catalogs **who is allowed to call** each route
and **how cross-tenant access is denied**.

## Conventions

- **Auth helper** — the helper that establishes the caller's
  identity + primary venue. Two patterns exist:
  - `requireAdmin()` — returns `{ ok, user, venueId, code, status }`.
    On failure returns `{ ok: false, code: 'unauthorized' | 'no_venue', status: 401 | 403 }`.
    Used by every `/api/admin/*` route.
  - `createClient()` → `supabase.auth.getUser()` — manual user
    fetch. Used by routes that need finer-grained role gating
    (e.g. SALES_ROLES, viewer-tolerant reads). Cross-tenant check
    is done via `getCurrentVenueForUser` + `requireVenueRole`.
- **Role set** — the venue roles allowed to mutate:
  - `ADMIN_ROLES` = `['owner', 'admin']`
  - `SALES_ROLES` = `['owner', 'admin', 'sales_manager', 'coordinator']`
  - `VENUE_ROLES` = `['owner', 'admin', 'sales_manager', 'coordinator', 'viewer']`
- **Tenant source** — where the route reads the `venue_id` it
  binds to. `caller-primary` = `requireAdmin().venueId` /
  `getCurrentVenueForUser`; `body` = `?venue_id` query / `venue_id`
  body field; `route param` = `[id]` segment.
- **Cross-tenant** — what happens when the resolved venue isn't
  the caller's primary AND the caller doesn't have admin role on
  the target. Standard posture is **403 → 404 collapse** so the
  surface can't be used to enumerate foreign venues.
- **Service role** — `Y` if the route uses
  `createServiceClient()` for the write AFTER the role check has
  already approved access.
- **RLS direct** — `Y` if the route relies on the user's RLS
  policy directly for the mutation (no explicit role check in
  application code).

## Matrix

### Leads

| Route | Method | Auth helper | Role set | Tenant source | Cross-tenant | Service role | RLS direct |
|---|---:|---|---|---|---|---:|---:|
| `/api/leads` | POST | createClient | SALES_ROLES | caller-primary | n/a (caller-primary only) | N | N (explicit role check) |
| `/api/leads/[id]` | PATCH | createClient | SALES_ROLES | route param → row.venue_id | 403→404 collapse | Y | N |
| `/api/leads/[id]` | DELETE | createClient | SALES_ROLES | route param → row.venue_id | 403→404 collapse | Y | N |

### Tours

| Route | Method | Auth helper | Role set | Tenant source | Cross-tenant | Service role | RLS direct |
|---|---:|---|---|---|---|---:|---:|
| `/api/tours` | POST | createClient | SALES_ROLES | body.lead_id → lead.venue_id | 403→404 collapse | Y | N |
| `/api/tours/[id]` | PATCH | createClient | SALES_ROLES | route param → row.venue_id | 403→404 collapse | Y | N |
| `/api/admin/tours/bulk-cancel` | POST | requireAdmin | ADMIN_ROLES | body.venue_id ?? caller | 403→404 collapse | Y | N |
| `/api/admin/tours/clear-pause` | POST | requireAdmin | ADMIN_ROLES | body.venue_id ?? caller | 403→404 collapse | Y | N |

### Venue + availability + blackouts

| Route | Method | Auth helper | Role set | Tenant source | Cross-tenant | Service role | RLS direct |
|---|---:|---|---|---|---|---:|---:|
| `/api/venues/[id]` | PATCH | createClient | ADMIN_ROLES | route param | 403→404 collapse | Y | N |
| `/api/venues/[id]/availability` | POST | createClient | ADMIN_ROLES | route param | 403→404 collapse | Y | N |
| `/api/venues/[id]/availability/[slotId]` | PATCH | createClient | ADMIN_ROLES | route param | 403→404 collapse | Y | N |
| `/api/venues/[id]/availability/[slotId]` | DELETE | createClient | ADMIN_ROLES | route param | 403→404 collapse | Y | N |
| `/api/venues/[id]/tour-blackouts` | POST | createClient | ADMIN_ROLES | route param | 403→404 collapse | Y | N |
| `/api/venues/[id]/tour-blackouts/[blackoutId]` | DELETE | createClient | ADMIN_ROLES | route param | 403→404 collapse | Y | N |

### Conversations + messages

| Route | Method | Auth helper | Role set | Tenant source | Cross-tenant | Service role | RLS direct |
|---|---:|---|---|---|---|---:|---:|
| `/api/conversations/[id]/messages` | POST | createClient | SALES_ROLES | route param → conversation.venue_id | 403→404 collapse | Y | N |

### AI safety

| Route | Method | Auth helper | Role set | Tenant source | Cross-tenant | Service role | RLS direct |
|---|---:|---|---|---|---|---:|---:|
| `/api/ai/actions/[id]/reject` | PATCH | createClient | SALES_ROLES | route param → ai_action.venue_id | 403→404 collapse | Y | N |
| `/api/admin/ai/autopilot-reviews/[aiActionId]` | POST | requireAdmin | ADMIN_ROLES | route param → ai_action.venue_id | 403→404 collapse | Y | N |

### Digest + suppressions

| Route | Method | Auth helper | Role set | Tenant source | Cross-tenant | Service role | RLS direct |
|---|---:|---|---|---|---|---:|---:|
| `/api/admin/digest/preferences` | POST | requireAdmin | ADMIN_ROLES | body.venue_id ?? caller | 403→404 collapse | Y | N |
| `/api/admin/digest/preview` | POST | requireAdmin | ADMIN_ROLES | body.venue_id ?? caller | 403→404 collapse | Y | N |
| `/api/admin/digest/send` | POST | requireAdmin | ADMIN_ROLES | body.venue_id ?? caller | 403→404 collapse | Y | N |
| `/api/admin/digest/suppressions/remove` | POST | requireAdmin | ADMIN_ROLES | body.venue_id ?? caller | 403→404 collapse | Y | N |
| `/api/admin/digest/suppressions/remove-all` | POST | requireAdmin | ADMIN_ROLES | body.venue_id ?? caller | 403→404 collapse | Y | N |
| `/api/admin/suppressions` | POST | requireAdmin | global | caller-primary (audit attribution) | n/a (global suppressions) | N | N |

### Billing

| Route | Method | Auth helper | Role set | Tenant source | Cross-tenant | Service role | RLS direct |
|---|---:|---|---|---|---|---:|---:|
| `/api/billing/checkout` | POST | createClient | ADMIN_ROLES | caller-primary | n/a | N (via helper) | N |
| `/api/billing/portal` | POST | createClient | ADMIN_ROLES | caller-primary | n/a | N (via helper) | N |
| `/api/admin/billing-events/[id]/clear-dunning` | POST | requireAdmin | ADMIN_ROLES | route param → event.venue_id | 403→404 collapse | Y | N |
| `/api/admin/billing-events/[id]/replay` | POST | requireAdmin | ADMIN_ROLES | route param → event.venue_id | 403→404 collapse | Y | N |

### Team / RBAC

| Route | Method | Auth helper | Role set | Tenant source | Cross-tenant | Service role | RLS direct |
|---|---:|---|---|---|---|---:|---:|
| `/api/team/invitations` | POST | createClient | ADMIN_ROLES | caller-primary | n/a | N (helper writes) | N |
| `/api/team/invitations` | GET | createClient | ADMIN_ROLES | caller-primary | n/a | N | N |
| `/api/team/invitations/[id]` | DELETE | createClient | ADMIN_ROLES | caller-primary | n/a (helper enforces venue match) | N | N |
| `/api/team/invitations/accept` | POST | createClient | any authed user | resolved by token | token-bound; refuses on email mismatch | N | N |
| `/api/team/members/[userId]` | DELETE | createClient | ADMIN_ROLES | caller-primary | n/a | N | N |
| `/api/team/members/[userId]` | PATCH | createClient | ADMIN_ROLES | caller-primary | n/a | N | N |

### Onboarding

| Route | Method | Auth helper | Role set | Tenant source | Cross-tenant | Service role | RLS direct |
|---|---:|---|---|---|---|---:|---:|
| `/api/onboarding/create-workspace` | POST | createClient | any authed user | new venue created for caller | n/a | Y (via helper) | N |

### Settings (Revenue OS)

| Route | Method | Auth helper | Role set | Tenant source | Cross-tenant | Service role | RLS direct |
|---|---:|---|---|---|---|---:|---:|
| `/api/admin/revenue-os/settings` | POST | requireAdmin | ADMIN_ROLES | body.venue_id ?? caller | 403→404 collapse | Y | N |

### Admin operations / diagnostics

| Route | Method | Auth helper | Role set | Tenant source | Cross-tenant | Service role | RLS direct |
|---|---:|---|---|---|---|---:|---:|
| `/api/admin/demo/seed` | POST | requireAdmin | global admin gate | caller-primary | n/a | Y | N |
| `/api/admin/demo/reset` | POST | requireAdmin | global admin gate | caller-primary | n/a | Y | N |
| `/api/admin/test-send` | POST | requireAdmin | global admin gate | caller-primary | n/a | Y (via email helper) | N |
| `/api/admin/anthropic-probe` | POST | requireAdmin | global admin gate | n/a | n/a | N (read-only probe) | N |

### Data lifecycle (Phase 9D)

| Route | Method | Auth helper | Role set | Tenant source | Cross-tenant | Service role | RLS direct |
|---|---:|---|---|---|---|---:|---:|
| `/api/admin/data-export` | POST | requireAdmin | ADMIN_ROLES | body.venue_id ?? caller | 403→404 collapse | Y (read-only) | N |
| `/api/admin/leads/[leadId]/redact-pii` | POST | requireAdmin | ADMIN_ROLES | route param → lead.venue_id | 403→404 collapse | Y | N |

### Security / abuse (Phase 9F)

| Route | Method | Auth helper | Role set | Tenant source | Cross-tenant | Service role | RLS direct |
|---|---:|---|---|---|---|---:|---:|
| `/api/admin/security/abuse-events` | GET | requireAdmin | ADMIN_ROLES | query.venue_id ?? caller | 403→404 collapse | Y (read-only) | N |

### Enterprise SSO (Phase 9G)

| Route | Method | Auth helper | Role set | Tenant source | Cross-tenant | Service role | RLS direct |
|---|---:|---|---|---|---|---:|---:|
| `/api/auth/sso/initiate` | POST | (anonymous) | n/a | resolved from email domain | n/a (anonymous) | Y (lookup) | N |
| `/api/auth/sso/callback` | POST/GET | (anonymous) | n/a | resolved from connection state | n/a (anonymous) | N (placeholder) | N |
| `/api/admin/security/sso-connections` | GET | requireAdmin | ADMIN_ROLES | query.venue_id ?? caller | 403→404 collapse | Y (read-only) | N |
| `/api/admin/security/sso-connections` | POST | requireAdmin | **`['owner']`** | body.venue_id ?? caller | 403→404 collapse for cross-tenant; 403 for same-tenant non-owner | Y | N (+ RLS belt) |
| `/api/admin/security/sso-connections/[id]` | PATCH | requireAdmin | **`['owner']`** | route param → row.venue_id | 403→404 collapse for cross-tenant; 403 for same-tenant non-owner | Y | N (+ RLS belt) |
| `/api/admin/security/sso-connections/[id]` | DELETE | requireAdmin | **`['owner']`** | route param → row.venue_id | 403→404 collapse for cross-tenant; 403 for same-tenant non-owner | Y | N (+ RLS belt) |
| `/api/admin/security/sso-login-events` | GET | requireAdmin | ADMIN_ROLES | query.venue_id ?? caller | 403→404 collapse | Y (read-only) | N |

**Owner-only mutation posture.** SSO connection mutations are
the only routes in the system that require the strict `['owner']`
role set (not `ADMIN_ROLES`). SSO configuration controls who can
log in at all — admin role is too permissive. The application-
layer gate AND migration 030 RLS policies both enforce it. The
two layers fail closed independently.

### Disaster recovery (Phase 9H)

| Route | Method | Auth helper | Role set | Tenant source | Cross-tenant | Service role | RLS direct |
|---|---:|---|---|---|---|---:|---:|
| `/api/admin/security/backup-posture` | GET | requireAdmin | ADMIN_ROLES | caller-primary (read is project-scoped, not venue-scoped) | n/a | N (Management API only) | N |
| `/api/admin/security/restore-intents` | POST | requireAdmin | **`['owner']`** | body.affected_venue_id ?? caller | 403→404 collapse for cross-tenant; 403 for same-tenant non-owner | N (audit-only) | N |

**Owner-only intent posture.** Restore intent filings are
owner-only by design — the operator who can decide "we should
restore" is the same operator who carries billing-level
responsibility for the data. Cross-tenant collapse to 404 holds
the standard admin posture. The route NEVER executes a restore;
the audit row records intent only and is mirrored to
`audit_event_mirror` (Phase 9C) when enabled.

### Evidence packaging (Phase 9I)

| Route | Method | Auth helper | Role set | Tenant source | Cross-tenant | Service role | RLS direct |
|---|---:|---|---|---|---|---:|---:|
| `/api/admin/security/evidence-report` | GET | requireAdmin | ADMIN_ROLES | caller-primary (report is project-scoped, not venue-scoped) | n/a | N (static + backup posture helper) | N |

**Evidence report access posture.** The evidence report is
project-scoped, not venue-scoped — the control catalog describes
platform-level posture (RBAC matrix, rate-limit coverage, audit
coverage, etc.). Any admin/owner can read it. Markdown + CSV
exports write an `evidence_report_exported` audit row so the
provenance of "who downloaded the evidence pack" is traceable.
JSON refreshes are not audited (flood prevention).

### Public endpoints (no actor)

| Route | Method | Notes |
|---|---:|---|
| `/api/widget` | POST | Public widget intake. Validates `venue_id` exists; rate-limited by IP. Writes `leads.source='widget'`. |
| `/api/stripe/webhook` | POST | Stripe-signed; verifies signature. Service-role writes are scoped by event payload. |
| `/api/resend/webhook` | POST | HMAC-signed; verifies signature. Service-role writes are scoped by message id. |

## Findings + posture rules

The 9B sweep surfaced these consistency rules. New routes should
follow them by default.

1. **Cross-tenant always collapses to 404.** Every admin route that
   accepts a `?venue_id=` override returns `404 not_found` when
   the caller can't reach the target — never `403 forbidden`. The
   product surface NEVER reveals whether a foreign venue exists.
   The standard pattern is:
   ```ts
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
   ```

2. **Service-role writes require an explicit role check first.**
   `createServiceClient()` bypasses RLS. Every route that calls it
   for a mutation MUST have already called `requireAdmin()` or
   `requireVenueRole(...)`. RLS is defense-in-depth, not the
   primary gate, on these surfaces.

3. **SALES_ROLES vs ADMIN_ROLES.** Mutations that affect
   day-to-day venue operation (lead stage, tour scheduling,
   reject AI draft, send message) accept `SALES_ROLES` so
   coordinators can do their job. Mutations that affect billing,
   team membership, venue settings, availability windows, AI
   safety calibration, or destructive admin operations require
   `ADMIN_ROLES`.

4. **Viewers are read-only.** No mutating route accepts
   `viewer` in its role set. The `VENUE_ROLES` constant exists
   for completeness; only `/api/team/members/[userId]` PATCH
   validates that the role the operator is ASSIGNING is a valid
   `VENUE_ROLES` member.

5. **Onboarding + invite-accept are intentionally permissive.**
   These run pre-membership: `/api/onboarding/create-workspace`
   creates the caller's first venue + owner row;
   `/api/team/invitations/accept` lets any authed user trade a
   token for a member row. Both are rate-limited per user, and
   both are audited.

6. **Public + webhook routes never read auth context.**
   `/api/widget`, `/api/stripe/webhook`, `/api/resend/webhook`
   don't establish a venue_id from the user session — they
   resolve it from request payload (signed in the webhook case).
   Per Phase 9A: these stay out of `audit_events`; their
   forensic trail lives on their respective canonical tables.

7. **Subscription gate is orthogonal to role gate.**
   `requireActiveSubscription` returns 402 `subscription_required`
   when `BILLING_GATE_ENABLED=1` and the venue's subscription
   isn't in an active state. This runs AFTER the role check; a
   non-admin user gets the role error first.

## Known limitations

- **No RLS-write policies on `audit_events`.** Inserts only happen
  via the service-role helper; the table has SELECT policies for
  owner/admin via `has_venue_role`. A future phase may add WORM
  guarantees for compliance contexts (append-only object storage
  copy).
- **No bulk admin endpoint scanner.** This matrix is maintained
  by hand. `scripts/check-audit-coverage.mjs` catches missing
  audit calls but does not currently validate that every admin
  route has a role check. A future regression guard could parse
  for `requireAdmin` / `requireVenueRole` presence the same way.
- **Automated cross-tenant probe is opt-in.** Phase 9C added
  `scripts/check-cross-tenant-rbac.mjs` — an operator-run smoke
  harness that probes a representative set of admin + resource
  routes for the 403→404 collapse posture. Runs via
  `npm run check:cross-tenant-rbac`. Requires real seeded test
  tenants (env-driven; see `.env.example`); skips cleanly with a
  hint when env is missing so it's safe to call from CI.
  - **Probe coverage:** 8 routes per pass × 2 passes
    (authenticated venue-A user against venue-B resources;
    unauthenticated against the same routes). Targets:
    `/api/admin/audit-events`, `/api/admin/ai/autopilot-readiness`,
    `/api/admin/ai/autopilot-simulation`,
    `/api/admin/leads/reactivation-queue`,
    `/api/admin/revenue-os/settings`,
    `/api/leads/[id]`, `/api/tours/[id]`,
    `/api/ai/actions/[id]/reject`.
  - **Expected posture:** authenticated cross-tenant → 404
    (NEVER 403); unauthenticated → 401.
  - **What it does NOT test:** every single admin route. The
    probe set is representative, not exhaustive — add an entry
    when a NEW route family appears. The matrix above remains
    the source of truth.

### Sales readiness (Phase 9J)

| Route | Method | Auth helper | Role set | Tenant source | Cross-tenant | Service role | RLS direct |
|---|---:|---|---|---|---|---:|---:|
| `/api/admin/security/questionnaire-response` | GET | requireAdmin | ADMIN_ROLES | caller-primary (response is project-scoped) | n/a | N | N |
| `/api/admin/security/buyer-security-summary` | GET | requireAdmin | ADMIN_ROLES | caller-primary (response is project-scoped) | n/a | N | N |
| `/api/admin/security/demo-mode` | GET | requireAdmin | ADMIN_ROLES | caller-primary | n/a | Y (single venue row read) | N |
| `/api/admin/security/demo-mode` | PATCH | requireAdmin | **`['owner']`** | caller-primary | n/a (same-tenant only) | Y | N |

**Owner-only demo mode posture.** Flipping demo mode affects
every operator at the venue (they all see the banner). Admin
role is too permissive; only the venue owner can toggle it.
Application-layer gate enforces. The GET branch allows admin
so they can see whether demo mode is currently on before
asking the owner to flip it.

### Vendor risk + subprocessor disclosure (Phase 9K)

| Route | Method | Auth helper | Role set | Tenant source | Cross-tenant | Service role | RLS direct |
|---|---:|---|---|---|---|---:|---:|
| `/api/admin/security/vendor-risk-report` | GET | requireAdmin | ADMIN_ROLES | caller-primary (response is project-scoped) | n/a | N | N |
| `/api/admin/security/subprocessor-disclosure` | GET | requireAdmin | ADMIN_ROLES | caller-primary (response is project-scoped) | n/a | N | N |

**Access posture.** Both routes are admin/owner; no mutating
verbs. The vendor registry is project-scoped (not per-venue),
so there is no cross-tenant probe surface — every authenticated
admin sees the same registry. The buyer-safe filtered view is
the SAME shape that ships to procurement, so admin reads are
safe to share internally without further redaction.

**Disclosure posture.** The vendor-risk-report includes every
row (admin/owner only, evidence references intact). The
subprocessor-disclosure route strips evidence env/package
references and includes ONLY vendors with
`disclosureStatus === 'public'`. Operators MUST review the
markdown/CSV export before sharing externally.

**No public route yet.** A buyer-facing
`/security/subprocessors` page is NOT shipped in 9K. Disclosure
ships from the admin surface today; once disclosure copy has
been reviewed by legal, the same `buildSubprocessorDisclosure`
helper can back a public page without changing the registry.

### Incident response (Phase 9L)

| Route | Method | Auth helper | Role set | Tenant source | Cross-tenant | Service role | RLS direct |
|---|---:|---|---|---|---|---:|---:|
| `/api/admin/security/incidents` | GET | requireAdmin | ADMIN_ROLES | caller-primary (venue-scoped list) | 404 collapse | Y (service-role read so platform-wide rows visible when applicable) | N |
| `/api/admin/security/incidents` | POST | requireAdmin + requireVenueRole | `['owner','admin']` | caller-primary | 404 collapse | Y (insert via service) | N |
| `/api/admin/security/incidents/[id]` | GET | requireAdmin | ADMIN_ROLES | caller-primary; incident.venueId mismatch → 404 | 404 collapse | Y | N |
| `/api/admin/security/incidents/[id]` | PATCH | requireAdmin + requireVenueRole | `['owner','admin']` | caller-primary; incident.venueId mismatch → 404 | 404 collapse | Y | N |
| `/api/admin/security/incidents/detect` | POST | requireAdmin + requireVenueRole | `['owner','admin']` | caller-primary | n/a (scoped to caller venue) | Y (queries abuse/sso/backup sources) | N |
| `/api/admin/security/incidents/[id]/alert` | POST | requireAdmin + requireVenueRole | `['owner','admin']` | caller-primary; incident.venueId mismatch → 404 | 404 collapse | Y | N |

**Access posture.** Read routes accept ADMIN_ROLES; mutating
routes (POST + PATCH + detect + alert) require an explicit
`requireVenueRole(['owner','admin'])` second gate. Cross-tenant
access collapses to 404 (NEVER 403) to prevent enumeration.
RLS on `public.incidents` mirrors the application policy:
SELECT for owner/admin/sales_manager/coordinator; INSERT +
UPDATE for owner/admin only. Timeline + alert delivery tables
are service-role write only.

**Alert routing posture.** Webhook URLs (`INCIDENT_SLACK_WEBHOOK_URL`,
`INCIDENT_PAGERDUTY_ROUTING_KEY`) are server-only secrets;
they never appear in responses, logs, or `incident_alert_deliveries`
rows (only the operator-readable label is stored). When env is
absent, helpers return `skipped_disabled` / `skipped_unconfigured`
and do not throw.

### Privacy + DSR readiness (Phase 9M)

| Route | Method | Auth helper | Role set | Tenant source | Cross-tenant | Service role | RLS direct |
|---|---:|---|---|---|---|---:|---:|
| `/api/admin/privacy/readiness` | GET | requireAdmin | ADMIN_ROLES | caller-primary | n/a | Y (counts via service) | N |
| `/api/admin/privacy/dsr-requests` | GET | requireAdmin | ADMIN_ROLES | caller-primary | n/a | Y | N |
| `/api/admin/privacy/dsr-requests` | POST | requireAdmin + requireVenueRole | `['owner','admin']` | caller-primary | 404 collapse | Y | N |
| `/api/admin/privacy/dsr-requests/[id]` | GET | requireAdmin | ADMIN_ROLES | caller-primary; dsr.venueId mismatch → 404 | 404 collapse | Y | N |
| `/api/admin/privacy/dsr-requests/[id]` | PATCH | requireAdmin + requireVenueRole | `['owner','admin']` | caller-primary; dsr.venueId mismatch → 404 | 404 collapse | Y | N |
| `/api/admin/privacy/dsr-requests/[id]/export-preview` | POST | requireAdmin + requireVenueRole | `['owner','admin']` | caller-primary; dsr.venueId mismatch → 404 | 404 collapse | Y | N |
| `/api/admin/privacy/dsr-requests/[id]/deletion-review` | POST | requireAdmin + requireVenueRole | `['owner','admin']` | caller-primary; dsr.venueId mismatch → 404 | 404 collapse | Y | N |

**Access posture.** Read routes accept ADMIN_ROLES; mutating
routes (POST + PATCH + export-preview + deletion-review)
require an explicit `requireVenueRole(['owner','admin'])`
second gate. Cross-tenant access collapses to 404 (NEVER 403).
RLS on `public.dsr_requests` mirrors the application policy:
SELECT + INSERT + UPDATE for owner/admin only (sales_manager /
coordinator are intentionally excluded — DSRs carry sensitive
subject identity + legal review notes). Timeline rows are
service-role write only.

**Data handling posture.** Export preview is metadata-only —
no subject data is fetched. Deletion review is
non-destructive — nothing is deleted. Real exports + deletions
happen via the existing operator-facing flows (Phase 9D data
export, lead PII redaction) under legal review.

### Trust Center (Phase 9N)

| Route | Method | Auth helper | Role set | Tenant source | Cross-tenant | Service role | RLS direct |
|---|---:|---|---|---|---|---:|---:|
| `/api/admin/security/trust-center/grants` | GET | requireAdmin | ADMIN_ROLES | caller-primary | n/a | Y (service-role read) | N |
| `/api/admin/security/trust-center/grants` | POST | requireAdmin + requireVenueRole | `['owner','admin']` | caller-primary | 404 collapse | Y (service-role insert; token hash computed server-side) | N |
| `/api/admin/security/trust-center/grants/[id]` | PATCH | requireAdmin + requireVenueRole | `['owner','admin']` | caller-primary; grant.venueId mismatch → 404 | 404 collapse | Y | N |
| `/api/admin/security/trust-center/access-events` | GET | requireAdmin | ADMIN_ROLES | caller-primary | n/a | Y | N |
| `/api/admin/security/trust-center/packet` | GET | requireAdmin | ADMIN_ROLES | caller-primary (preview) | n/a | N | N |
| `/api/trust/access/[token]/artifact` | GET | bearer token | n/a (anonymous + token) | grant.venueId | n/a (token-scoped) | Y (service-role read for validation + event insert) | N |

**Access posture.** Admin GET routes accept ADMIN_ROLES;
mutating routes (POST grant, PATCH grant) require an explicit
`requireVenueRole(['owner','admin'])` second gate.
Cross-tenant access on `[id]` collapses to 404.

**Trust access posture.** The public gated download is an
ANONYMOUS route gated by bearer token. The token validator
constant-time compares the salted-SHA-256 hash; failed
validations return a generic 401 + record `access_denied`
without leaking WHICH state (invalid / expired / revoked) the
token is in.

**RLS posture.** `public.trust_access_grants` SELECT / INSERT
/ UPDATE for owner/admin only (sales_manager / coordinator
intentionally excluded — grants carry buyer identity + may
gate sensitive packets). `public.trust_access_events` SELECT
for owner/admin; INSERT is service-role only (the gated
download route uses the service-role server client to record
events regardless of buyer session state).

**Token posture.** Bearer tokens are 32-byte crypto-random,
stored as salted-SHA-256 hash. Plaintext returned ONCE at
creation and NEVER logged. The `incident_alert_deliveries`-
style discipline applies: only operator-readable identifiers
appear in `trust_access_events`; the token itself does not.

### Compliance operations (Phase 9O)

| Route | Method | Auth helper | Role set | Tenant source | Cross-tenant | Service role | RLS direct |
|---|---:|---|---|---|---|---:|---:|
| `/api/admin/security/compliance/calendar` | GET | requireAdmin | ADMIN_ROLES | caller-primary | n/a | Y | N |
| `/api/admin/security/compliance/calendar` | POST | requireAdmin + requireVenueRole | `['owner','admin']` | caller-primary | 404 collapse | Y | N |
| `/api/admin/security/compliance/calendar/[id]` | PATCH | requireAdmin + requireVenueRole | `['owner','admin']` | caller-primary; event.venueId mismatch → 404 | 404 collapse | Y | N |
| `/api/admin/security/compliance/freshness` | GET | requireAdmin | ADMIN_ROLES | caller-primary | n/a | Y | N |

**Access posture.** Read routes accept ADMIN_ROLES; mutating
routes (POST + PATCH) require an explicit
`requireVenueRole(['owner','admin'])` second gate. Cross-tenant
PATCH access collapses to 404 (NEVER 403).

**RLS posture.** `public.compliance_review_events` SELECT /
INSERT / UPDATE for owner/admin only (sales_manager /
coordinator excluded — review notes may contain sensitive
operational context). DELETE is intentionally NOT exposed —
operators waive instead so the trail stays intact.

**Audit posture.** Every meaningful mutation writes a typed
audit row (`compliance_events_seeded` / `compliance_review_created`
/ `compliance_review_completed` / `compliance_review_waived` /
`compliance_review_updated` / `compliance_calendar_exported` /
`compliance_freshness_exported`). JSON refreshes are not
audited.

### Contract commitments register (Phase 9P)

| Route | Method | Auth helper | Role set | Tenant source | Cross-tenant | Service role | RLS direct |
|---|---:|---|---|---|---|---:|---:|
| `/api/admin/security/commitments` | GET | requireAdmin | ADMIN_ROLES | caller-primary | n/a | Y | N |
| `/api/admin/security/commitments` | POST | requireAdmin + requireVenueRole | `['owner','admin']` | caller-primary | 404 collapse | Y | N |
| `/api/admin/security/commitments/[id]` | GET | requireAdmin | ADMIN_ROLES | caller-primary; commitment.venueId mismatch → 404 | 404 collapse | Y | N |
| `/api/admin/security/commitments/[id]` | PATCH | requireAdmin + requireVenueRole | `['owner','admin']` | caller-primary; commitment.venueId mismatch → 404 | 404 collapse | Y | N |
| `/api/admin/security/commitments/readiness` | GET | requireAdmin | ADMIN_ROLES | caller-primary | n/a | Y | N |

**Access posture.** Read routes accept ADMIN_ROLES; mutating
routes (POST + PATCH) require an explicit
`requireVenueRole(['owner','admin'])` second gate. Cross-tenant
PATCH access collapses to 404 (NEVER 403).

**RLS posture.** `public.contract_commitments` SELECT /
INSERT / UPDATE for owner/admin only (sales_manager /
coordinator excluded — commitments carry buyer identity +
sensitive operational context). `public.contract_commitment_events`
SELECT for owner/admin; INSERT is service-role only. DELETE
is intentionally NOT exposed — operators move commitments
to `withdrawn` to preserve the trail.

**Audit posture.** Every meaningful mutation writes a typed
audit row (`commitment_created` / `commitment_updated` /
`commitment_status_changed` / `commitment_fulfilled` /
`commitment_reviewed` / `commitments_exported` /
`commitments_readiness_exported`). JSON refreshes are not
audited.

---

## Phase 8BE — Omnichannel inbox connector foundation

| Surface | owner | admin | sales_manager | coordinator | anon |
|---|:---:|:---:|:---:|:---:|:---:|
| `GET /api/admin/integrations/channels` | ✅ | ✅ | ❌ | ❌ | ❌ |
| `POST /api/admin/integrations/channels` | ✅ | ✅ | ❌ | ❌ | ❌ |
| `PATCH /api/admin/integrations/channels/[id]` | ✅ | ✅ | ❌ | ❌ | ❌ |
| `POST /api/conversations/[id]/mark-sent-manually` | ✅ | ✅ | ✅ | ✅ | ❌ |
| `POST /api/integrations/website/message` | — | — | — | — | ✅ |
| `POST /api/integrations/lead-forwarding/the-knot` | — | — | — | — | ✅ |
| `POST /api/integrations/lead-forwarding/weddingwire` | — | — | — | — | ✅ |
| `GET/POST /api/integrations/meta/webhook` | — | — | — | — | ✅ |
| `venue_channel_connections` SELECT | ✅ | ✅ | ✅ | ✅ | ❌ |
| `venue_channel_connections` INSERT/UPDATE | ✅ | ✅ | ❌ | ❌ | ❌ |
| `external_conversations` SELECT | ✅ | ✅ | ✅ | ✅ | ❌ |
| `external_conversations` writes | service-role only |
| `external_messages` SELECT | ✅ | ✅ | ✅ | ✅ | ❌ |
| `external_messages` writes | service-role only |

Cross-tenant guard on `PATCH /api/admin/integrations/channels/[id]`:
when the connection row exists but belongs to a different
venue, the route returns 404 — the standard admin posture.

`venue_channel_connections` has no DELETE policy by design.
Operators flip to `status='disconnected'` (and may
reactivate to `draft`) so the trail is preserved.
