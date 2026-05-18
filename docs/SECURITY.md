# VenueRise — Security Model

Last reviewed: Phase 7A.

This document is the canonical reference for "what protects what" in VenueRise. Read it before:
- granting a teammate access to production secrets,
- adding a new public endpoint,
- changing RLS or role logic,
- shipping a new outbound integration.

---

## 1. Trust boundaries

```
┌──────────────────────────────────────────────────────────────┐
│  Public internet                                             │
│  • marketing pages, widget UI, login page                    │
│  • POST /api/widget, GET /api/widget/[venueId]/config        │
│  • GET /api/health, GET /api/readiness                       │
│  • GET /api/unsubscribe                                      │
│  • POST /api/resend/webhook  (verified via Svix signature)   │
│  • POST /api/inngest         (verified by Inngest SDK)       │
└──────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌──────────────────────────────────────────────────────────────┐
│  Authenticated user (Supabase session cookie)                │
│  • /dashboard/**, /onboarding, /onboarding/accept            │
│  • All /api/leads, /api/tours, /api/venues, /api/team/**     │
│  • /api/ai/{chat,followup,qualify(user-mode)}                │
└──────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌──────────────────────────────────────────────────────────────┐
│  ADMIN_ROLES (owner / admin) of a venue                      │
│  • /api/admin/**  — operator-tier read/observability         │
│  • /api/team/invitations (POST/GET/DELETE)                   │
│  • /api/team/members/[userId] (PATCH role / DELETE remove)   │
│  • /api/venues/[id] PATCH                                    │
└──────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌──────────────────────────────────────────────────────────────┐
│  Service-role + signed internal calls                        │
│  • /api/ai/qualify (internal HMAC mode, called by widget→job)│
│  • Job runtime (Inngest functions)                           │
│  • Webhook handlers after signature verification             │
└──────────────────────────────────────────────────────────────┘
```

---

## 2. Service-role key rules

The `SUPABASE_SERVICE_ROLE_KEY` bypasses RLS. Treat it like the database password it effectively is.

- **NEVER prefix with `NEXT_PUBLIC_`.** Vercel will leak it into the browser bundle.
- Only imported through `lib/supabase/service.ts` (which is `server-only`).
- Allowed paths that legitimately use it:
  - `app/api/widget/route.ts` — anonymous visitor needs to write a lead.
  - `app/api/resend/webhook/route.ts` — provider can't be RLS-authed.
  - `app/api/inngest/route.ts` (indirectly via orchestrator) — same.
  - `app/api/ai/qualify/route.ts` (internal HMAC mode) — server-to-server.
  - `lib/onboarding/onboarding-service.ts` — user isn't a member yet.
  - `lib/team/team-service.ts` (acceptInvitation, listMembers email enrichment).
  - `app/api/admin/*` — operator surface, gated by `requireAdmin`.
  - `app/api/health/route.ts` + `app/api/readiness/route.ts` — read-only probes.
  - `lib/auth/{require-admin,tenant-access}.ts` legacy-owner fallback paths.

Anywhere else, prefer the user-scoped client (`createClient()` from `lib/supabase/server.ts`) so RLS does the heavy lifting.

---

## 3. Public vs secret env vars

Anything starting with `NEXT_PUBLIC_` is shipped to the browser bundle by Next.js. Today the public set is:

- `NEXT_PUBLIC_APP_URL`
- `NEXT_PUBLIC_APP_VERSION`
- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY` (anon key is RLS-bound and safe to expose by design)
- `NEXT_PUBLIC_SENTRY_DSN` (Sentry DSNs are explicitly designed to be public)
- `NEXT_PUBLIC_SENTRY_TRACES`

Everything else is server-only. Audit by grepping for `NEXT_PUBLIC_` in `lib/` and `app/` — every hit should appear in the list above.

---

## 4. RLS model

Migration **001** created tables with "venue owner access" RLS, gating SELECT/INSERT/UPDATE/DELETE to `venues.owner_user_id == auth.uid()`.

Migration **005** widened RLS to `venue_members`:
- `is_venue_member(venue_id, user_id)` SECURITY DEFINER function answers "is this user a member?".
- `has_venue_role(venue_id, user_id, allowed_roles[])` answers "is this user in one of these roles?".
- SELECT on every tenant table → `is_venue_member` (any role).
- INSERT/UPDATE/DELETE on lead-data tables → `has_venue_role(SALES_ROLES)`.
- INSERT/UPDATE/DELETE on `venues` → owner only for DELETE, ADMIN_ROLES for UPDATE, authed user for INSERT.
- Audit tables (`ai_actions`, `outbound_messages`) → SELECT for members; writes service-role only.

Legacy `venues.owner_user_id` is kept and honored as a SELECT fallback in `venues: select for members or owner` so pre-migration venues without seeded membership rows still resolve.

---

## 5. Role model (Phase 6A → 6E)

Five venue roles, single source of truth in `lib/auth/roles.ts`:

- `owner` — full control, cannot be invited (transferred manually only).
- `admin` — can invite, change roles, modify venue settings.
- `sales_manager` — can write leads/conversations/tours, can't manage team.
- `coordinator` — same write surface as sales_manager.
- `viewer` — read-only.

Three role groups:
- `ADMIN_ROLES = [owner, admin]`
- `SALES_ROLES = [owner, admin, sales_manager, coordinator]`
- `READONLY_ROLES = [owner, admin, sales_manager, coordinator, viewer]`

Last-owner protection (Phase 6D + 6E): `removeMember` and `updateMemberRole` refuse to leave a venue with zero owners. Enforced server-side; the dashboard pre-disables the corresponding UI controls as belt-and-suspenders.

---

## 6. Widget origin allowlist (Phase 7A)

Added by Phase 7A to raise the floor on widget abuse. The check lives in:
- `app/api/widget/route.ts` (POST)
- `app/api/widget/[venueId]/config/route.ts` (GET + OPTIONS)

Policy:
- **No Origin header** → accepted (curl, server-to-server, native fetch).
- **Origin equals `NEXT_PUBLIC_APP_URL`** → accepted.
- **In dev, localhost / 127.0.0.1 / 0.0.0.0** → accepted.
- Otherwise → 403 `{ "error": "origin_not_allowed" }`.

### Known limitation

There is **no per-venue origin allowlist** column yet. That means:
- A venue can't embed the widget on their own website without setting up a CNAME/proxy to `$APP_URL` first.
- A determined attacker can curl the widget endpoint (no Origin) and forge a venue_id to create junk leads, though rate-limiting + `is_active` checks + AI qualification scoring keep the blast radius small.

Recommended follow-up: add `venues.allowed_origins text[]` and extend `isOriginAllowed` to consult it per request. Tracked as part of a future "embeddable widget V2" phase.

---

## 7. Rate limiting model

Provider: Upstash sliding-window via `@upstash/ratelimit`.

| Surface | Key shape | Limit | File |
|---|---|---|---|
| Widget POST | `widget:{ip}:{venueId}` | 10 / min | `lib/rate-limit.ts` `rateLimitWidget` |
| AI POST routes | `ai:{key}` | 30 / min | `lib/rate-limit.ts` `rateLimitAi` |
| User actions | `user:{key}` | 30 / min | `lib/rate-limit.ts` `rateLimitUserAction` |
| Onboarding create | `onboarding:create:{userId}` | inherits user-action | Phase 6C |
| Team invite | `team:invite:{userId}` | inherits user-action | Phase 6D |
| Team accept | `team:accept:{userId}` | inherits user-action | Phase 6D |
| Team role change | `team:role:{userId}` | inherits user-action | Phase 6E |

**Fail-open**: if Upstash is unreachable, the limiter returns `allowed: true` and logs `rate_limit.disabled` exactly once. We accept this tradeoff to avoid taking the product offline when our rate limiter has an outage. Monitor for the warning in production.

---

## 8. HMAC / internal secret usage

`INTERNAL_API_SECRET` is used for:
1. **Internal signed calls** between the widget and `/api/ai/qualify`. Header `X-VR-Signature` carries an HMAC-SHA256 over the canonical-JSON body. Verified in `lib/auth/internal-hmac.ts`.
2. **Unsubscribe link signing**: `lib/integrations/email.ts → buildUnsubscribeUrl` signs `{ email, ts }` and the URL carries `sig` + `ts`. `/api/unsubscribe` verifies + enforces a 90-day TTL.

Readiness requires `INTERNAL_API_SECRET` to be present AND ≥ 32 characters. Generate with `openssl rand -hex 32`.

---

## 9. Resend webhook verification

`/api/resend/webhook` verifies the Svix-format signature using `RESEND_WEBHOOK_SECRET`. Unsigned or invalid requests get 401 with no body. Missing secret in production is a readiness failure.

Suppressions (bounces + complaints) are written to `public.suppressions` and consulted by every outbound send in `lib/integrations/email.ts → checkSuppression`.

---

## 10. Unsubscribe / suppression model

- Every outbound email includes a one-click unsubscribe URL signed with the internal secret (see §8).
- `GET /api/unsubscribe?email=…&ts=…&sig=…` validates the signature + age and inserts into `suppressions`.
- Resend webhook events `email.bounced` and `email.complained` also insert into `suppressions`.
- Before any send, `checkSuppression` short-circuits with `suppressed:<reason>` if the address is on the list.

---

## 10g. Atomic metadata append (Phase 7L)

Migration 010 added one SECURITY DEFINER function: `public.append_subscription_metadata_array(p_subscription_id uuid, p_array_key text, p_entry jsonb) returns jsonb`.

**Why a function?** Read-modify-write on `subscriptions.metadata` from JS races with the Stripe webhook sync (which overwrites the whole `metadata` column wholesale). The function does the JSONB array append inside a single `UPDATE` so Postgres's per-row locking serializes both writers.

**SECURITY DEFINER hardening**:
- `set search_path = public` — defends against schema-injection attacks on schema-qualified DDL.
- `revoke all from public` + `grant execute to service_role` — anon and authenticated roles cannot call it. Only billing cron jobs (via the service-role client) execute it.
- The function only mutates `subscriptions.metadata`. It cannot escalate to other tables or columns.

**Input validation**: the function raises if `p_array_key` is null/empty or if `p_entry` is null. It also raises `subscription not found` if `p_subscription_id` doesn't match a row (defends callers that pass stale ids from cached lookups).

**Race scope**: WRITE side only. The cron's pre-send idempotency check (`already in metadata.reminders_sent?`) is still read-from-Node, so two simultaneous cron invocations can theoretically send two emails for the same key. Inngest's per-function dedup makes this require a deliberate manual double-trigger. See [BILLING-QA.md §7g](./BILLING-QA.md) for the trade-off.

**No new env vars.** The function uses the existing `service_role` grant from migration 008's pattern.

---

## 10f. Replay attribution (Phase 7J)

Migration 009 added three columns to `billing_events_log` — `replayed_at`, `replayed_by`, `replay_count` — and one SECURITY DEFINER function — `public.record_billing_event_replay(p_event_id uuid, p_user_id uuid) returns integer`.

**Why a function?** PostgREST can't express atomic `replay_count = replay_count + 1` increments without a function. The alternative (read row → write `replay_count + 1`) loses updates under concurrent replays. The function does the increment in one statement and returns the new count so the route doesn't re-query.

**SECURITY DEFINER hardening**:
- `set search_path = public` so a future schema injection can't redirect the table reference.
- `revoke all from public` + `grant execute to service_role` — anon + authenticated roles can't call it. The only caller is the replay route (which uses the service-role client).
- The function only updates `billing_events_log`. It cannot escalate to other tables.

**RLS interaction**: `billing_events_log` SELECT is ADMIN_ROLES via `has_venue_role`. The new audit columns inherit that — admins of the row's venue see `replayed_at`/`replayed_by`/`replay_count`; everyone else sees nothing. `replayed_by` is a `uuid` (the operator's user id), not an email — operator emails stay in `auth.users` which is service-role-only.

**`replayed_by` lifecycle**: `ON DELETE SET NULL` on the FK to `auth.users(id)`. If we ever hard-delete an operator account (Phase 6E doesn't have that path yet, but a future GDPR request might), `replayed_by` becomes NULL — the rows survive with their replay history intact, just unattributed.

---

## 10e. Stripe event audit log (Phase 7F)

`public.billing_events_log` durably records every Stripe webhook event after signature verification. Three properties make it safe under fire:

1. **Insert-before-dispatch.** Recording happens before the subscription sync runs, so a handler crash doesn't lose the event-receipt evidence.
2. **UNIQUE on `stripe_event_id`.** Stripe redeliveries hit the constraint, we bump `duplicate_count`, and the handler short-circuits — no double-fire on side effects (current sync is idempotent on `stripe_subscription_id`, but future side effects like emails benefit from the guard).
3. **Failure-tolerant.** If the audit log write itself throws (DB outage, RLS misconfig), the helper logs + Sentry-captures internally and returns `{ logId: null }`. The webhook keeps moving and stays responsive to Stripe — a 5xx back would just trigger Stripe's retry machine, which is worse than missing audit rows.

**RLS posture**:
- SELECT for ADMIN_ROLES (`owner` / `admin`) of the row's venue. Rows with `venue_id IS NULL` (events we couldn't resolve to a tenant) are invisible to authenticated users — operators inspect via service role.
- No INSERT/UPDATE/DELETE policy for `authenticated` → service-role-only writes from the webhook handler.

**PII / payload posture**:
- The full Stripe event payload is stored verbatim in `payload jsonb`. Stripe payloads include customer email, partial card details (last4, brand), and billing addresses.
- The table is never exposed via product APIs — only forensic / admin surfaces. Treat payload fields as ADMIN-eyes-only and do NOT echo them into customer-facing logs or emails.
- Retention: indefinite for now. A future migration may add a partition-drop policy for rows older than 12 months once we see real volume.

**No env vars required** — the table is enabled by migration 008 and used unconditionally by `/api/stripe/webhook`.

---

## 10d. Billing QA scripts (Phase 7E)

Two scripts verify the gate without touching Stripe:

- **`scripts/billing-gate-matrix.mjs`** (`npm run billing:matrix`) — signs in as a test user via Supabase Auth REST, probes representative routes, and asserts each response matches the documented matrix. Safe to run against any environment (uses the Phase 7A widget Origin allowlist + the existing rate limiter). Cleans up its own probe leads (`leads.email='billing-matrix@example.com'`) by default; opt out via `BILLING_MATRIX_CLEANUP=0`.

- **`scripts/seed-subscription-state.mjs`** (`npm run billing:seed`) — **STAGING / LOCAL ONLY**. Writes a synthetic `subscriptions` row tagged `metadata.source='billing_gate_test'` via service-role REST. The script's cleanup path (and the script itself) only touch tagged rows — real Stripe-driven rows are never affected. There is **no production guardrail** beyond operator discipline: the script's warning banner says "STAGING / LOCAL ONLY" but it won't refuse to run against a production URL. Treat the service-role key as the access control: do not export production credentials when running this script.

Both scripts are zero-dependency Node 18+; neither uses Supabase MCP, so they work from any CI runner or laptop with `node` installed. Full walk-through: [docs/BILLING-QA.md](./BILLING-QA.md).

---

## 10c. Subscription gate (Phase 7D)

The billing gate sits between role-checked write routes and their handlers. When `BILLING_GATE_ENABLED=1`, `requireActiveSubscription(venueId)` reads `public.subscriptions` (latest row, service-role read for tenant-isolated tables) and throws `SubscriptionRequiredError` (HTTP 402) unless the kind is `active` or `trialing`.

**Routes gated** (all 9 require auth + role first; gate runs AFTER auth/role):
- `POST /api/leads`, `PATCH /api/leads/[id]`, `DELETE /api/leads/[id]`
- `POST /api/tours`, `PATCH /api/tours/[id]`
- `POST /api/ai/chat`, `POST /api/ai/qualify` (user-session mode only), `POST /api/ai/followup`
- `POST /api/team/invitations`

**Routes NEVER gated** — intentional:
- All GET routes (reads).
- Dashboard server-component loads.
- `POST /api/billing/checkout` + `POST /api/billing/portal` — gating these would lock users out of fixing their billing.
- `POST /api/team/invitations/accept` — invited member shouldn't be blocked by the inviter's billing state.
- `POST /api/onboarding/create-workspace` — workspace setup is pre-billing.
- `POST /api/widget` — public lead intake. The widget is the visitor's experience, not the customer's. Documented in-code at `app/api/widget/route.ts`.
- `POST /api/stripe/webhook`, `POST /api/resend/webhook`, `POST /api/inngest` — provider callbacks.
- `POST /api/ai/qualify` internal HMAC mode — driven by the job runtime for newly-created widget leads, not user traffic.

**Tenant safety**:
- The gate reads via service-role (RLS on `subscriptions` is ADMIN_ROLES-only for SELECT, but the gate runs for every authed role; using user-scoped client would silently unlock sales/coordinator/viewer roles).
- The `venueId` argument is already venue-scoped by the route's auth layer — the gate never accepts a user-supplied venue id.
- Status read failures re-throw (do NOT silently 402, do NOT silently 200) — flaky DB shouldn't demand a credit card OR unlock the product.

**Onboarding trial**: `createWorkspaceForUser` inserts a synthetic `subscriptions` row with `status='trialing'`, `trial_end = now() + 14 days`, `stripe_subscription_id = null`. Best-effort — failure logs + Sentry-captures but doesn't fail workspace creation.

---

## 10b. Stripe billing (Phase 7C)

Stripe is the source of truth for subscription state. Local Postgres tables `billing_customers` and `subscriptions` are caches populated exclusively by the webhook handler at `/api/stripe/webhook`.

**Webhook verification**: every POST to `/api/stripe/webhook` is verified via `Stripe.webhooks.constructEvent(rawBody, sigHeader, STRIPE_WEBHOOK_SECRET)`. Unsigned, mis-signed, or replay-protected requests return 401 with no body. Missing webhook secret in production is a readiness failure.

**Raw-body requirement**: the webhook route reads `await request.text()` BEFORE any JSON parsing — calling `request.json()` first would parse + re-stringify and the HMAC would never match. This is enforced in code by the order of operations in `app/api/stripe/webhook/route.ts`.

**Idempotency**:
- `getOrCreateStripeCustomer` resolves a 23505 unique violation by re-reading the winning row.
- `syncSubscriptionFromStripeSubscription` upserts on `stripe_subscription_id`, so webhook redeliveries don't create duplicates.
- `createCheckoutSession` passes an idempotency key shaped `checkout:<venue>:<hour>` so a quick double-click doesn't create two Stripe sessions.

**Authorization**:
- `/api/billing/checkout` + `/api/billing/portal` require ADMIN_ROLES (owner or admin) of the caller's venue.
- `/api/stripe/webhook` is unauthenticated to Supabase but authenticated to Stripe via the signature header — the equivalent of an HMAC bearer token.

**RLS posture for billing rows** (migration 007):
- `billing_customers` + `subscriptions` SELECT → ADMIN_ROLES only. Viewers and sales/coordinator roles cannot read billing state.
- No INSERT/UPDATE/DELETE policies for `authenticated`; service-role-only writes via the webhook handler.

**Secrets**: `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` are server-only — never `NEXT_PUBLIC_`. `STRIPE_DEFAULT_PRICE_ID` is server-only by convention (not sensitive, but mismatched env/var-name discipline causes deploys to fail). `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` is public by design once Phase 7D wires the client SDK.

**Known gaps for Phase 7C**:
- No subscription-gated product access yet. Phase 7D will introduce middleware that consults `subscriptions.status` and short-circuits non-paying tenants.
- No `billing_events_log` table — webhook events are only persisted to the extent that they mutate `subscriptions`. Re-deliver from Stripe if you need to replay history.
- Customer Portal allows ALL self-service operations Stripe supports for the configuration. Lock the portal down in Stripe → Settings → Customer Portal if you want to disable specific actions (e.g. plan switching).

---

## 11. Security headers (Phase 7A)

Applied in `next.config.js`:

| Header | Scope | Value |
|---|---|---|
| `X-Content-Type-Options` | All | `nosniff` |
| `Referrer-Policy` | All | `strict-origin-when-cross-origin` |
| `Permissions-Policy` | All | `camera=(), microphone=(), geolocation=(), payment=(), usb=(), fullscreen=(self)` |
| `Strict-Transport-Security` | All (prod only) | `max-age=63072000; includeSubDomains; preload` |
| `X-Frame-Options` | All EXCEPT `/widget/*` | `SAMEORIGIN` |
| `Content-Security-Policy: frame-ancestors` | All EXCEPT `/widget/*` | `'self'` |
| `Content-Security-Policy: frame-ancestors` | `/widget/*` | `*` |

Tradeoff: we don't set a strict `script-src` CSP because Next.js inlines runtime scripts with per-build hashes; a working strict CSP needs the nonce middleware, which is a separate phase. The Permissions-Policy + SAMEORIGIN combination keeps clickjacking + powerful-API risk down in the meantime.

---

## 12. Known gaps

- No per-venue widget origin allowlist (see §6). Mitigation: rate limit + `is_active` gate + AI scoring.
- No strict `script-src` CSP. Mitigation: Sentry catches injection symptoms; X-Frame-Options keeps the dashboard out of iframes.
- No automated PII redaction in Sentry beyond the manual `beforeSend` allowlist. Mitigation: ad-hoc audit before each release.
- Service-role key has no per-environment scoping — a leaked prod key has full access. Mitigation: rotate on any suspicion (§4 of RUNBOOK).
- `INTERNAL_API_SECRET` rotation invalidates outstanding unsubscribe links. Acceptable today; revisit if we ship long-lived shareable invite links signed with the same secret.
- Webhook secret rotation (Resend) has a ~30s overlap window where both old and new are valid. Acceptable; documented in RUNBOOK §2.4.
- Stripe webhook secret rotation (Phase 7C) has a longer overlap window controlled by the Stripe dashboard ("Roll secret" → "Stop accepting old secret"). Documented in RUNBOOK §2.5.
- Billing tables expose subscription state to ADMIN_ROLES, NOT to sales/coordinator/viewer. If a salesperson needs "is this venue billable?" awareness, expose a derived field via a dedicated read API instead of widening the RLS policy.
- The Phase 7E seed script (`scripts/seed-subscription-state.mjs`) has no runtime production check. Mitigation: keep the production service-role key out of the shell environment used for QA work, and never set `SEED_SUBSCRIPTION_SUPABASE_URL` to the production URL.
