# Rate-Limit Coverage Matrix

Source of truth for which API routes are throttled, which are
intentionally exempt, and the bucket type each route uses. Pairs
with `scripts/check-rate-limit-coverage.mjs` (the regression guard)
and `lib/rate-limit-catalog.ts` (the typed canonical key catalog).

**Policy.** Whenever a new mutating HTTP route (POST | PATCH | PUT
| DELETE) — or any admin GET that scrolls > 50 rows per call — is
added, the author must answer:

1. Could a naive script hammer this route?
2. If so, what budget makes sense per identity (user / IP / venue)?
3. Should a block fire a row into `public.abuse_events`?

If the answer to (1) is yes, call one of the `rateLimit*` wrappers
from `lib/rate-limit.ts` BEFORE the mutation. Pass the optional
`abuseContext` so blocks land in the AbuseMonitorCard. If a route
genuinely doesn't need throttling, add a `RATE_LIMIT_EXEMPT:
<reason>` comment near the top of the file and add a row to the
"Explicit exemptions" table below.

## Bucket type legend

- **USER** — `${prefix}:${userId}` per authenticated user.
- **USER+RES** — `${prefix}:${userId}:${resourceId}` per
  user-resource pair (e.g. one AI chat thread per user).
- **IP** — `${prefix}:${ip}` keyed on raw client IP via
  `extractIp(request)`.
- **IP+VENUE** — `${prefix}:${ip}:${venueId}` per IP per venue
  (widget intake; a misbehaving site can't burn through every
  venue's budget).

## Rate-limit budgets

Defined in `lib/rate-limit.ts` → `RATE_LIMITS`:

| Limiter | Tokens | Window | Prefix |
|---|---:|---|---|
| widget | 10 | 1 min | `vr:widget` |
| ai | 60 | 1 min | `vr:ai` |
| userAction | 30 | 1 min | `vr:action` |
| cspReport | 60 | 1 min | `vr:csp` |
| ssoAuth | 10 | 1 min | `vr:sso` |

When Upstash env vars are absent (`mode: 'disabled'`), every check
returns `allowed: true` — local dev is unblocked. Production
deploys should treat `mode: 'disabled'` on `/api/health` as a
misconfiguration alert.

---

## Coverage matrix

### Leads

| Route | Method | Limiter | Bucket | Key | Notes |
|---|---:|---|---|---|---|
| `/api/leads` | POST | userAction | USER | `leads:create:${userId}` | |
| `/api/leads/[id]` | PATCH | userAction | USER | `leads:update:${userId}` | |
| `/api/leads/[id]` | DELETE | userAction | USER | `leads:delete:${userId}` | |

### Tours

| Route | Method | Limiter | Bucket | Key | Notes |
|---|---:|---|---|---|---|
| `/api/tours` | POST | userAction | USER | `tours:create:${userId}` | |
| `/api/tours/[id]` | PATCH | userAction | USER | `tours:update:${userId}` | |
| `/api/admin/tours/bulk-cancel` | POST | userAction | USER | `admin:tours-bulk-cancel:${userId}` | |
| `/api/admin/tours/clear-pause` | POST | userAction | USER | `admin:tours-clear-pause:${userId}` | |

### Venue + availability + blackouts

| Route | Method | Limiter | Bucket | Key | Notes |
|---|---:|---|---|---|---|
| `/api/venues/[id]` | PATCH | userAction | USER | `venues:update:${userId}` | |
| `/api/venues/[id]/availability` | POST | userAction | USER | `venues:availability:create:${userId}` | |
| `/api/venues/[id]/availability/[slotId]` | PATCH | userAction | USER | `venues:availability:update:${userId}` | |
| `/api/venues/[id]/availability/[slotId]` | DELETE | userAction | USER | `venues:availability:delete:${userId}` | |
| `/api/venues/[id]/tour-blackouts` | POST | userAction | USER | `venues:blackouts:create:${userId}` | |
| `/api/venues/[id]/tour-blackouts/[blackoutId]` | DELETE | userAction | USER | `venues:blackouts:delete:${userId}` | |
| `/api/venues/[id]/knowledge` | GET | userAction | USER | `venues:knowledge:list:${userId}` | Phase 9T-alt. |
| `/api/venues/[id]/knowledge` | POST | userAction | USER | `venues:knowledge:create:${userId}` | Phase 9T-alt. |
| `/api/venues/[id]/knowledge/[knowledgeId]` | PATCH | userAction | USER | `venues:knowledge:update:${userId}` | Phase 9T-alt. |
| `/api/venues/[id]/knowledge/[knowledgeId]` | DELETE | userAction | USER | `venues:knowledge:delete:${userId}` | Phase 9T-alt. |

### Conversations + AI

| Route | Method | Limiter | Bucket | Key | Notes |
|---|---:|---|---|---|---|
| `/api/conversations/[id]/messages` | POST | userAction | USER | `conversations:message:${userId}` | |
| `/api/ai/draft` | POST | ai | USER+RES | `draft:${userId}:${conversationId}` | Higher budget (60/min) — AI calls are operator-initiated regenerates. |
| `/api/ai/chat` | POST | ai | USER+RES | `chat:post:${userId}:${conversationId}` | |
| `/api/ai/chat` | GET | ai | USER | `chat:get:${userId}` | |
| `/api/ai/qualify` | POST | ai | USER | `qualify:${userId}` | |
| `/api/ai/followup` | POST | ai | USER | `followup:${userId}` | |
| `/api/ai/actions/[id]/reject` | PATCH | userAction | USER | `ai-actions-reject:${userId}` | |

### Admin (operator surfaces)

| Route | Method | Limiter | Bucket | Key | Notes |
|---|---:|---|---|---|---|
| `/api/admin/audit-events` | GET | userAction | USER | `admin:audit-events:${userId}` | |
| `/api/admin/security/abuse-events` | GET | userAction | USER | `admin:security-abuse-events:${userId}` | Phase 9F |
| `/api/admin/data-export` | POST | userAction | USER | `admin:data-export:${userId}` | |
| `/api/admin/leads/[leadId]/redact-pii` | POST | userAction | USER | `admin:lead-redact-pii:${userId}` | |
| `/api/admin/revenue-os/settings` | POST | userAction | USER | `admin:revenue-os-settings:${userId}` | |
| `/api/admin/ai/draft-audit` | GET | userAction | USER | `admin:ai-draft-audit:${userId}` | |
| `/api/admin/ai/autopilot-simulation` | GET | userAction | USER | `admin:ai-autopilot-simulation:${userId}` | |
| `/api/admin/ai/autopilot-reviews` | GET | userAction | USER | `admin:ai-autopilot-reviews:${userId}` | |
| `/api/admin/ai/autopilot-reviews/[aiActionId]` | POST | userAction | USER | `admin:ai-autopilot-review:${userId}` | |
| `/api/admin/ai/autopilot-readiness` | GET | userAction | USER | `admin:ai-autopilot-readiness:${userId}` | |
| `/api/admin/digest/preferences` | POST | userAction | USER | `admin:digest-preferences:${userId}` | |
| `/api/admin/digest/preview` | POST | userAction | USER | `admin:digest-preview:${userId}` | |
| `/api/admin/digest/send` | POST | userAction | USER | `admin:digest-send:${userId}` | |
| `/api/admin/digest/suppressions/remove` | POST | userAction | USER | `admin:digest-suppressions-remove:${userId}` | |
| `/api/admin/digest/suppressions/remove-all` | POST | userAction | USER | `admin:digest-suppressions-remove-all:${userId}` | |
| `/api/admin/suppressions` | GET/POST | userAction | USER | `admin:suppressions:${userId}` | |
| `/api/admin/billing-events/[id]/clear-dunning` | POST | userAction | USER | `admin:billing-events-clear-dunning:${userId}` | |
| `/api/admin/billing-events/[id]/replay` | POST | userAction | USER | `admin:billing-event-replay:${userId}` | |
| `/api/admin/demo/seed` | POST | userAction | USER | `admin:demo-seed:${userId}` | |
| `/api/admin/demo/reset` | POST | userAction | USER | `admin:demo-reset:${userId}` | |
| `/api/admin/demo/revenue-recovery-seed` | POST | userAction | USER | `admin:demo:revenue-recovery-seed:${userId}` | GTM-0A. Heavy operation (~24 leads + messages + tours); user-scoped low cap. |
| `/api/admin/demo/revenue-recovery-load-seed` | POST | userAction | USER | `admin:demo:revenue-recovery-load-seed:${userId}` | GTM-0A.2. Very heavy operation (25–1000 leads + thousands of messages); user-scoped low cap so a misclick doesn't fan out to thousands of inserts in a tight loop. |
| `/api/admin/test-send` | POST | userAction | USER | `admin:test-send:${userId}` | |
| `/api/admin/anthropic-probe` | POST | userAction | USER | `admin:anthropic-probe:${userId}` | |

### Billing

| Route | Method | Limiter | Bucket | Key | Notes |
|---|---:|---|---|---|---|
| `/api/billing/checkout` | POST | userAction | USER | `billing:checkout:${userId}` | Phase 9R: also called by SubscriptionPlansCard with `{ plan_id, interval, source: 'subscription_plans_card' }`; rate-limit key unchanged. |
| `/api/billing/portal` | POST | userAction | USER | `billing:portal:${userId}` | Phase 9Q: also called by PaymentMethodsCard with `{ source: 'payment_methods_card' }`; rate-limit key unchanged (one user, one bucket). |

### Team / RBAC

| Route | Method | Limiter | Bucket | Key | Notes |
|---|---:|---|---|---|---|
| `/api/team/invitations` | POST | userAction | USER | `team:invite:${userId}` | |
| `/api/team/invitations/[id]` | DELETE | userAction | USER | `team:invite:revoke:${userId}` | |
| `/api/team/invitations/accept` | POST | userAction | USER | `team:accept:${userId}` | |
| `/api/team/members/[userId]` | DELETE | (none yet) | — | — | Inherits server's defaults; ADMIN_ROLES gate is primary protection. Marker not strictly required; future-add. |
| `/api/team/members/[userId]` | PATCH | userAction | USER | `team:role:${userId}` | |

### Onboarding

| Route | Method | Limiter | Bucket | Key | Notes |
|---|---:|---|---|---|---|
| `/api/onboarding/create-workspace` | POST | userAction | USER | `onboarding:create:${userId}` | |

### Public (anonymous)

| Route | Method | Limiter | Bucket | Key | Notes |
|---|---:|---|---|---|---|
| `/api/widget` | POST | widget | IP+VENUE | `${ip}:${venueId}` | 10/min/IP/venue. |
| `/api/widget/[venueId]/config` | GET | widget | IP+VENUE | `${ip}:${venueId}` | |
| `/api/security/csp-report` | POST | cspReport | IP | `${ip}` | 60/min/IP. Phase 9E. |
| `/api/unsubscribe` | GET | widget | IP | `${ip}` | Reuses widget limiter (10/min/IP). |
| `/api/digest/resubscribe` | GET/POST | widget | IP | `${ip}` | |
| `/api/auth/sso/initiate` | POST | ssoAuth | IP+DOMAIN | `${ip}:${domain}` | Phase 9G. 10/min/IP/domain. |
| `/api/auth/sso/callback` | POST/GET | ssoAuth | IP | `${ip}` | Phase 9G. GET returns 405 in 9G. |

### Admin SSO (Phase 9G)

| Route | Method | Limiter | Bucket | Key | Notes |
|---|---:|---|---|---|---|
| `/api/admin/security/sso-connections` | GET | userAction | USER | `admin:sso-connections-list:${userId}` | |
| `/api/admin/security/sso-connections` | POST | userAction | USER | `admin:sso-connections-create:${userId}` | Owner-only role check post-limit. |
| `/api/admin/security/sso-connections/[id]` | PATCH | userAction | USER | `admin:sso-connections-update:${userId}` | Owner-only. |
| `/api/admin/security/sso-connections/[id]` | DELETE | userAction | USER | `admin:sso-connections-delete:${userId}` | Owner-only. Draft/disabled only. |
| `/api/admin/security/sso-login-events` | GET | userAction | USER | `admin:sso-login-events:${userId}` | |

### Admin disaster recovery (Phase 9H)

| Route | Method | Limiter | Bucket | Key | Notes |
|---|---:|---|---|---|---|
| `/api/admin/security/backup-posture` | GET | userAction | USER | `admin:backup-posture-read:${userId}` | Read-only. |
| `/api/admin/security/restore-intents` | POST | userAction | USER | `admin:restore-intent-create:${userId}` | Owner-only post-limit. Audit-only — never executes restore. |

### Admin evidence (Phase 9I)

| Route | Method | Limiter | Bucket | Key | Notes |
|---|---:|---|---|---|---|
| `/api/admin/security/evidence-report` | GET | userAction | USER | `admin:evidence-report-read:${userId}` | Read-only. Markdown + CSV exports audited; JSON refresh is not. |

---

## Explicit exemptions

Each row below contains a `RATE_LIMIT_EXEMPT:` / `webhook route` /
`public route` marker in source. Scanner recognizes any of those.

| Route | Method | Marker | Rationale |
|---|---:|---|---|
| `/api/stripe/webhook` | POST | `webhook route` | Stripe signs every payload via HMAC; signature failure rejects the request before any mutation. IP throttle would also hit Stripe's prod IPs and could drop legitimate events. |
| `/api/resend/webhook` | POST | `webhook route` | Resend signs payloads. Same reasoning as Stripe. |
| `/api/inngest` | (any) | `RATE_LIMIT_EXEMPT` | Inngest's own signing key gates the handler; the route is unreachable without a valid Inngest signature. |
| `/api/readiness` | GET | `RATE_LIMIT_EXEMPT` | Lightweight readiness probe; flooding only burns CPU. Throttling could block legitimate load-balancer health checks. |
| `/api/health` | GET | (n/a — not scanned for) | Same rationale as readiness. |

---

## Operational notes

- **Limiter blocks fire `abuse_events` rows when an `abuseContext`
  is supplied.** The four wrappers (`rateLimitWidget`,
  `rateLimitAi`, `rateLimitUserAction`, `rateLimitCspReport`) all
  accept the optional context. When the limiter returns
  `allowed: false` AND the context is present, the wrapper fires
  `void recordAbuseEvent(...)` — fire-and-forget, never awaited,
  never blocks the response.
- **Public-route blocks have `venue_id IS NULL`.** The
  `AbuseMonitorCard` on `/dashboard/settings/billing` is
  venue-scoped and does NOT surface those. Operators investigating
  widget/CSP abuse must query the table directly via Supabase SQL
  editor.
- **Abuse rows are NOT mirrored.** The Phase 9C `audit_event_mirror`
  only covers `audit_events`. Abuse data is denser + primarily
  operational; tamper-evidence is reserved for the primary audit
  feed.
- **Raw IPs are NEVER stored.** The helper hashes via
  `lib/enterprise/audit-events.maskIpForAudit` (salted SHA-256).
  Same hash shape as `audit_events.ip_hash` so cross-feed
  correlation works without ever persisting raw addresses.
- **The scanner is string-grep based.** It catches missing calls,
  doesn't validate placement (limit-then-mutate ordering). This
  matrix is the human-readable source of truth.

## How to add a new mutating route

1. Implement the route. Use the standard auth / Zod / request-id
   stack.
2. Before the mutation, call one of the rate-limit wrappers with
   an `abuseContext`:
   ```ts
   const rl = await rateLimitUserAction(
     request,
     `my-prefix:${user.id}`,
     {
       route: '/api/my/route',
       method: 'POST',
       userId: user.id,
       venueId,
       requestId,
     }
   )
   if (!rl.allowed) {
     return respond(rateLimitedResponse(rl))
   }
   ```
3. Add a row to the matrix above.
4. Run `npm run check:rate-limit-coverage` — must pass clean.
5. If the route genuinely doesn't need throttling, add a
   `RATE_LIMIT_EXEMPT: <reason>` comment near the top and document
   the row under "Explicit exemptions" with the rationale.

### Admin sales readiness (Phase 9J)

| Route | Method | Limiter | Bucket | Key | Notes |
|---|---:|---|---|---|---|
| `/api/admin/security/questionnaire-response` | GET | userAction | USER | `admin:questionnaire-response-read:${userId}` | Read-only. Markdown + CSV exports audited; JSON refresh is not. |
| `/api/admin/security/buyer-security-summary` | GET | userAction | USER | `admin:buyer-security-summary-read:${userId}` | Read-only. Markdown export audited. |
| `/api/admin/security/demo-mode` | GET | userAction | USER | `admin:demo-mode-read:${userId}` | Read-only. |
| `/api/admin/security/demo-mode` | PATCH | userAction | USER | `admin:demo-mode-update:${userId}` | Owner-only role check post-limit. Audited via `demo_mode_updated`. |

## Admin vendor risk + subprocessor disclosure (Phase 9K)

| Route | Method | Bucket | Identity scope | Limiter key | Notes |
|---|---:|---|---|---|---|
| `/api/admin/security/vendor-risk-report` | GET | userAction | USER | `admin:vendor-risk-report-read:${userId}` | Read-only. Markdown + CSV exports audited; JSON refresh is not. |
| `/api/admin/security/subprocessor-disclosure` | GET | userAction | USER | `admin:subprocessor-disclosure-read:${userId}` | Read-only. Buyer-safe filtered view (only `disclosureStatus = 'public'`). Markdown + CSV exports audited; JSON refresh is not. |

Both routes use the userAction bucket (30/min) — burst
downloads during a procurement / security review stay well
under cap. Catalog entries live in `adminVendor.*` in
`lib/rate-limit-catalog.ts`. The disclosure routes never write
audit rows on the JSON preview path so a busy admin card UI
doesn't flood the audit log.

## Admin incident response (Phase 9L)

| Route | Method | Bucket | Identity scope | Limiter key | Notes |
|---|---:|---|---|---|---|
| `/api/admin/security/incidents` | GET | userAction | USER | `admin:incident-list:${userId}` | List + counts. CSV export audited; JSON refresh is not. |
| `/api/admin/security/incidents` | POST | userAction | USER | `admin:incident-create:${userId}` | Owner/admin only (post-limit). Optionally fans out alerts when `notify=true` AND alerts are env-configured. Audited via `incident_created` + per-channel `incident_alert_sent`. |
| `/api/admin/security/incidents/[id]` | GET | userAction | USER | `admin:incident-read:${userId}` | Returns incident + timeline. Cross-tenant 404 collapse. |
| `/api/admin/security/incidents/[id]` | PATCH | userAction | USER | `admin:incident-update:${userId}` | Owner/admin only. Audited via `incident_updated`; transition to resolved emits `incident_resolved`. |
| `/api/admin/security/incidents/detect` | POST | userAction | USER | `admin:incident-detect:${userId}` | Owner/admin only. Runs conservative detectors over abuse / SSO / backup / health. Audited via `incident_candidates_detected`; per-materialised candidate also writes `incident_created`. |
| `/api/admin/security/incidents/[id]/alert` | POST | userAction | USER | `admin:incident-alert:${userId}` | Owner/admin only. Env-gated; webhook URLs / routing keys NEVER returned. Audited per non-skipped delivery via `incident_alert_sent`. |

All six routes use the userAction bucket (30/min). Catalog
entries live in `adminIncident.*` in `lib/rate-limit-catalog.ts`.

## Admin privacy + DSR readiness (Phase 9M)

| Route | Method | Bucket | Identity scope | Limiter key | Notes |
|---|---:|---|---|---|---|
| `/api/admin/privacy/readiness` | GET | userAction | USER | `admin:privacy-readiness-read:${userId}` | Read-only. Markdown + CSV exports audited; JSON refresh is not. |
| `/api/admin/privacy/dsr-requests` | GET | userAction | USER | `admin:dsr-list:${userId}` | List + counts. CSV export audited; JSON refresh is not. |
| `/api/admin/privacy/dsr-requests` | POST | userAction | USER | `admin:dsr-create:${userId}` | Owner/admin only (post-limit). Audited via `dsr_request_created`. |
| `/api/admin/privacy/dsr-requests/[id]` | GET | userAction | USER | `admin:dsr-read:${userId}` | Returns request + timeline. Cross-tenant 404 collapse. |
| `/api/admin/privacy/dsr-requests/[id]` | PATCH | userAction | USER | `admin:dsr-update:${userId}` | Owner/admin only. Audited via `dsr_request_updated`; terminal transitions emit `dsr_request_fulfilled`/`_denied`/`_cancelled`. |
| `/api/admin/privacy/dsr-requests/[id]/export-preview` | POST | userAction | USER | `admin:dsr-export-preview:${userId}` | Owner/admin only. Metadata-only. Audited via `dsr_export_previewed`. |
| `/api/admin/privacy/dsr-requests/[id]/deletion-review` | POST | userAction | USER | `admin:dsr-deletion-review:${userId}` | Owner/admin only. Non-destructive. Audited via `dsr_deletion_reviewed`. |

All seven routes use the userAction bucket (30/min). Catalog
entries live in `adminPrivacy.*` in `lib/rate-limit-catalog.ts`.
None of these routes fetch raw subject data — export preview is
metadata-only, deletion review is non-destructive.

## Admin Trust Center + public gated artifact (Phase 9N)

| Route | Method | Bucket | Identity scope | Limiter key | Notes |
|---|---:|---|---|---|---|
| `/api/admin/security/trust-center/grants` | GET | userAction | USER | `admin:trust-grant-list:${userId}` | Read-only. Not audited. |
| `/api/admin/security/trust-center/grants` | POST | userAction | USER | `admin:trust-grant-create:${userId}` | Owner/admin only. Audited via `trust_access_grant_created`. Plaintext token returned ONCE. |
| `/api/admin/security/trust-center/grants/[id]` | PATCH | userAction | USER | `admin:trust-grant-update:${userId}` | Owner/admin only. Audited via `trust_access_grant_revoked` (revoke) or `trust_access_grant_updated`. |
| `/api/admin/security/trust-center/access-events` | GET | userAction | USER | `admin:trust-access-events:${userId}` | Read-only. CSV export audited via `trust_access_events_exported`. |
| `/api/admin/security/trust-center/packet` | GET | userAction | USER | `admin:trust-packet-preview:${userId}` | Preview. Markdown export audited via `trust_packet_exported`. |
| `/api/trust/access/[token]/artifact` | GET | widget | IP+TOKEN | `trust-token:${tokenHashPrefix}` | Public/gated download. IP+(token-hash-prefix) keyed to bound a leaked token. Successful + denied attempts land in `trust_access_events`; no audit_events row. |

All admin routes use userAction (30/min). The gated public
download uses the widget bucket so a leaked token can't outrun
the public throttle.

## Admin compliance operations (Phase 9O)

| Route | Method | Bucket | Identity scope | Limiter key | Notes |
|---|---:|---|---|---|---|
| `/api/admin/security/compliance/calendar` | GET | userAction | USER | `admin:compliance-calendar-list:${userId}` | List + counts. CSV export audited; JSON refresh is not. |
| `/api/admin/security/compliance/calendar` | POST | userAction | USER | `admin:compliance-calendar-action:${userId}` | Owner/admin only (post-limit). Actions: `seed` / `create_custom`. Audited via `compliance_events_seeded` / `compliance_review_created`. |
| `/api/admin/security/compliance/calendar/[id]` | PATCH | userAction | USER | `admin:compliance-calendar-update:${userId}` | Owner/admin only. Actions: `complete` / `waive` / `update`. Audited via the matching `compliance_review_*` action. |
| `/api/admin/security/compliance/freshness` | GET | userAction | USER | `admin:compliance-freshness-read:${userId}` | Read-only. Markdown + CSV exports audited via `compliance_freshness_exported`. |

All four routes use the userAction bucket (30/min). Catalog
entries live in `adminCompliance.*` in
`lib/rate-limit-catalog.ts`. None of these routes fan out to
external sources; the freshness route re-evaluates the policy
on every call and is cheap.

## Admin contract commitments register (Phase 9P)

| Route | Method | Bucket | Identity scope | Limiter key | Notes |
|---|---:|---|---|---|---|
| `/api/admin/security/commitments` | GET | userAction | USER | `admin:commitments-list:${userId}` | List + counts. CSV export audited via `commitments_exported`; JSON refresh is not. |
| `/api/admin/security/commitments` | POST | userAction | USER | `admin:commitments-create:${userId}` | Owner/admin only (post-limit). Audited via `commitment_created`. |
| `/api/admin/security/commitments/[id]` | GET | userAction | USER | `admin:commitments-list:${userId}` | Detail + timeline. Cross-tenant 404 collapse. |
| `/api/admin/security/commitments/[id]` | PATCH | userAction | USER | `admin:commitments-update:${userId}` | Owner/admin only. Audited via `commitment_updated` / `commitment_status_changed` / `commitment_fulfilled` / `commitment_reviewed` per transition. |
| `/api/admin/security/commitments/readiness` | GET | userAction | USER | `admin:commitments-readiness:${userId}` | Read-only readiness summary. Markdown + CSV exports audited via `commitments_readiness_exported`. |

All five routes use the userAction bucket (30/min). Catalog
entries live in `adminCommitments.*` in
`lib/rate-limit-catalog.ts`.

---

## Phase 8BE — Omnichannel inbox connector foundation

| Route | Method | Limiter | Bucket prefix |
|---|---|---|---|
| `/api/admin/integrations/channels` | GET | `rateLimitUserAction` | `admin:integrations:channels:read:<userId>` |
| `/api/admin/integrations/channels` | POST | `rateLimitUserAction` | `admin:integrations:channels:write:<userId>` |
| `/api/admin/integrations/channels/[id]` | PATCH | `rateLimitUserAction` | `admin:integrations:channels:write:<userId>` |
| `/api/integrations/website/message` | POST | `rateLimitWidget` | `widget:<ip>:<venueId>` |
| `/api/integrations/lead-forwarding/the-knot` | POST | `rateLimitWidget` | `widget:<ip>:<venueId>` |
| `/api/integrations/lead-forwarding/weddingwire` | POST | `rateLimitWidget` | `widget:<ip>:<venueId>` |
| `/api/integrations/meta/webhook` | POST | `rateLimitWidget` | `widget:<ip>` |
| `/api/conversations/[id]/mark-sent-manually` | POST | `rateLimitUserAction` | `channel:manual-sent:<userId>` |

Catalog entries live in `lib/rate-limit-catalog.ts` under
`adminIntegrations.*`, `inboundChannel.*`, and
`manualChannel.*`.

The Meta webhook intentionally rate-limits by IP only — the
venue context is buried inside the payload signature, which
is not yet verified (Phase 8BF). Public lead-forwarding
routes pass `venue_id` for the IP+VENUE bucket.

---

## Phase 8BG — Lead-forwarding parser

| Route | Method | Limiter | Bucket prefix |
|---|---|---|---|
| `/api/admin/integrations/lead-forwarding/test-parse` | POST | `rateLimitUserAction` | `admin:integrations:lead-forwarding:test:<userId>` |

Public lead-forwarding routes (`the-knot`, `weddingwire`)
inherit their IP+venue limiter from Phase 8BE and continue to
fire it before the parser runs. The parser is purely CPU-bound
and cheap; the user-bucket limit on the admin test endpoint
protects against a runaway demo loop.

Catalog entry: `adminIntegrations.leadForwardingTest`.

---

## Phase 8BF — Meta connector

| Route | Method | Limiter | Bucket prefix |
|---|---|---|---|
| `/api/integrations/meta/webhook` | GET/POST | `rateLimitWidget` | `widget:<ip>` (Phase 8BE catalog entry `inboundChannel.metaWebhook`) |
| `/api/admin/integrations/meta/test-parse` | POST | `rateLimitUserAction` | `admin:integrations:meta:webhook-test:<userId>` |
| `/api/integrations/meta/oauth/start` | GET | `rateLimitUserAction` | `admin:integrations:meta:oauth-start:<userId>` |
| `/api/integrations/meta/oauth/callback` | GET | `rateLimitUserAction` | `admin:integrations:meta:oauth-callback:<userId>` |

The public webhook keeps the per-IP throttle even after
signature verification — Meta retries are bursty and a
runaway test loop should not OOM the limiter. The admin
test-parse endpoint uses the standard 30/min user bucket.

Catalog entry: `adminIntegrations.metaWebhookTest`.
