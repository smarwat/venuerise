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
