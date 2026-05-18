# VenueRise — Billing Entitlement Matrix & QA Playbook

Last reviewed: Phase 7E.

This document is the source of truth for "what does each route do under each subscription state". Read it before:
- enabling `BILLING_GATE_ENABLED=1` in any environment,
- adding a new write route (you must place it in the matrix),
- debugging a customer report of "I got 402 / I expected to be blocked but wasn't".

Pair with [SECURITY.md §10c](./SECURITY.md) for the architectural model and [RUNBOOK.md §2.4b](./RUNBOOK.md) for incident playbooks.

---

## 1. The states

Source: `lib/billing/subscription-status.ts`. `getVenueSubscriptionStatus(venueId)` returns one of:

| State        | Meaning |
|---           |---|
| `none`       | No `subscriptions` row for the venue. New tenants briefly land here before the onboarding trial seed runs; after the seed they transition to `trialing`. |
| `trialing`   | Onboarding 14-day trial row, OR a Stripe-managed trial. Counts as paid for gate purposes. |
| `active`     | Stripe subscription `status=active`. Fully paid. |
| `past_due`   | Stripe subscription is overdue. Stripe is retrying the charge; we surface the dunning UX. |
| `canceled`   | Stripe subscription canceled (or our `incomplete_expired` synonym). |
| `incomplete` | Checkout started but first payment didn't clear. |
| `unknown`    | Stripe returned a status we don't have a branch for (e.g. `paused`). Treated as not-active. |

Picker priority when multiple rows exist for a venue: `active > trialing > past_due > incomplete > unpaid > paused > canceled > incomplete_expired`. Ties broken by `created_at` desc.

---

## 2. The matrix

Columns are routes (or route families). Rows are subscription states.

Legend:
- ✅ allowed (request goes through to its normal handler)
- 🔒 blocked with HTTP **402** `subscription_required` (only when `BILLING_GATE_ENABLED=1`)
- ⚪ never gated regardless of flag
- 401/403/404 — these are auth/role failures that run BEFORE the gate; they happen for everyone

### 2.1 With `BILLING_GATE_ENABLED=1` (the gate enforced)

| State        | dashboard read | lead read | lead create / update / delete | tour create / update | AI chat | AI qualify (user) | AI followup | team invite send | team invite accept | billing checkout | billing portal | public widget submit | webhooks (Stripe / Resend / Inngest) |
|---           |---             |---        |---                            |---                   |---      |---                |---          |---               |---                 |---               |---             |---                   |---                                   |
| `none`       | ✅              | ✅         | 🔒                             | 🔒                    | 🔒       | 🔒                 | 🔒           | 🔒                | ⚪                  | ⚪                | ⚪              | ⚪                    | ⚪                                    |
| `trialing`   | ✅              | ✅         | ✅                             | ✅                    | ✅       | ✅                 | ✅           | ✅                | ⚪                  | ⚪                | ⚪              | ⚪                    | ⚪                                    |
| `active`     | ✅              | ✅         | ✅                             | ✅                    | ✅       | ✅                 | ✅           | ✅                | ⚪                  | ⚪                | ⚪              | ⚪                    | ⚪                                    |
| `past_due`   | ✅              | ✅         | 🔒                             | 🔒                    | 🔒       | 🔒                 | 🔒           | 🔒                | ⚪                  | ⚪                | ⚪              | ⚪                    | ⚪                                    |
| `canceled`   | ✅              | ✅         | 🔒                             | 🔒                    | 🔒       | 🔒                 | 🔒           | 🔒                | ⚪                  | ⚪                | ⚪              | ⚪                    | ⚪                                    |
| `incomplete` | ✅              | ✅         | 🔒                             | 🔒                    | 🔒       | 🔒                 | 🔒           | 🔒                | ⚪                  | ⚪                | ⚪              | ⚪                    | ⚪                                    |
| `unknown`    | ✅              | ✅         | 🔒                             | 🔒                    | 🔒       | 🔒                 | 🔒           | 🔒                | ⚪                  | ⚪                | ⚪              | ⚪                    | ⚪                                    |

### 2.2 With `BILLING_GATE_ENABLED=0` (default — gate off)

Every cell that was 🔒 above becomes ✅. The dashboard banner still renders to nudge the user, but no API enforcement occurs.

Concretely: 🔒 → ✅ everywhere; ✅ stays ✅; ⚪ stays ⚪.

### 2.3 Concrete route → column mapping

| Column | Route(s) |
|---|---|
| dashboard read | server-component reads under `/dashboard/*` (`GET /api/leads`, `GET /api/tours`, `GET /api/team/members`, …) |
| lead read | `GET /api/leads`, `GET /api/leads/[id]` |
| lead create / update / delete | `POST /api/leads`, `PATCH /api/leads/[id]`, `DELETE /api/leads/[id]` |
| tour create / update | `POST /api/tours`, `PATCH /api/tours/[id]` |
| AI chat | `POST /api/ai/chat` |
| AI qualify (user) | `POST /api/ai/qualify` (user-session mode only — internal HMAC mode is exempt) |
| AI followup | `POST /api/ai/followup` |
| team invite send | `POST /api/team/invitations` |
| team invite accept | `POST /api/team/invitations/accept` |
| billing checkout | `POST /api/billing/checkout` |
| billing portal | `POST /api/billing/portal` |
| public widget submit | `POST /api/widget` |
| webhooks | `POST /api/stripe/webhook`, `POST /api/resend/webhook`, `POST /api/inngest` |

---

## 3. Why these specific cells are ⚪ (never gated)

- **billing checkout / portal** — gating these would lock users out of fixing the very condition that triggers the gate. The whole point is to send them to Stripe.
- **team invite accept** — the invitee is a separate user, possibly NOT a member of the venue yet. Their access shouldn't depend on a billing relationship they don't control. (Sending invites IS gated; accepting one isn't.)
- **public widget submit** — the visitor is a prospect, not a customer of ours. Their experience must never depend on the venue owner's billing state. If you want to suppress lead intake for a delinquent venue, flip `venues.is_active=false` (which already returns 403); subscription state belongs to the OWNER's relationship with us, not the visitor's relationship with the venue.
- **webhooks** — Stripe/Resend/Inngest call us. They have no Supabase session and shouldn't be subject to subscription state (Stripe's webhook is how we EXIT past_due in the first place).
- **dashboard reads & GETs** — read-only access keeps the platform "graceful degrade" rather than "lights off". Customers in `past_due` can still see their pipeline, just can't mutate it.

---

## 4. Operating the gate

### 4.1 Enabling the gate

The gate is **OFF by default** (`BILLING_GATE_ENABLED` unset or anything other than the literal string `"1"`).

To turn it on:

1. Verify in staging first with `npm run billing:matrix` (see §5).
2. In Vercel → Project → Environment Variables → Production, set `BILLING_GATE_ENABLED=1`.
3. Redeploy.
4. Confirm: `curl -s $APP/api/health | jq .billing.gate` → `"enabled"`.
5. Confirm: `curl -s $APP/api/readiness | jq .checks.billing_gate` → `"enabled"` and not in `.failed`.

The setting is intentionally exact-string-match (`"1"`) so a typoed value (`"true"`, `"yes"`, `"on"`) silently defaults to OFF — fail-safe, not fail-loud.

### 4.2 Disabling the gate quickly

Single-step rollback for a customer outage:

1. Vercel → Environment Variables → Production → `BILLING_GATE_ENABLED` → set to `0` (or delete the variable).
2. Trigger an immediate redeploy (Vercel CLI: `vercel --prod` or the dashboard's "Redeploy" button).
3. Within ~60 seconds, all 🔒 cells flip back to ✅.

No data is lost. No subscription state is changed. The gate is purely an enforcement flag.

### 4.3 Customer reports `subscription_required` (HTTP 402)

See [RUNBOOK.md §2.4b](./RUNBOOK.md) for the full diagnostic. Quick triage:

1. Is the gate even on? `curl -s $APP/api/health | jq .billing.gate`.
2. What's their venue's status? Service-role SQL:
   ```sql
   select status, current_period_end, trial_end, canceled_at, created_at, metadata
   from public.subscriptions where venue_id='<venue id>'
   order by created_at desc limit 5;
   ```
3. The picker favors `active > trialing` first. If they have an active row and you're still seeing 402, the gate is reading a stale cache — confirm React `cache()` isn't memoizing across processes (it shouldn't; it's request-scoped).
4. To extend a trial manually while diagnosing:
   ```sql
   update public.subscriptions
   set trial_end = now() + interval '14 days', status='trialing'
   where venue_id='<venue id>' and stripe_subscription_id is null;
   ```
5. To bypass the gate temporarily — see §4.2.

---

## 5. Verification scripts (Phase 7E)

Two scripts ship alongside this doc. Both are zero-dep Node 18+ scripts; neither requires Supabase MCP.

### 5.1 `npm run billing:matrix`

Runs against any deployed environment and asserts that the real route responses match this matrix.

```bash
BILLING_MATRIX_APP_URL=https://staging.venuerise.com \
BILLING_MATRIX_SUPABASE_URL=https://xxx.supabase.co \
BILLING_MATRIX_SUPABASE_ANON_KEY=eyJ... \
BILLING_MATRIX_SUPABASE_SERVICE_ROLE_KEY=eyJ... \
BILLING_MATRIX_TEST_USER_EMAIL=smoke-owner@example.com \
BILLING_MATRIX_TEST_USER_PASSWORD='hunter2' \
BILLING_MATRIX_VENUE_ID=<uuid> \
BILLING_MATRIX_EXPECT_GATE=1 \
npm run billing:matrix
```

The script signs in via Supabase Auth REST, hits ~7 representative routes (one per matrix column), and prints `route | expected | actual | pass/fail`. Exit nonzero on any mismatch. Set `BILLING_MATRIX_EXPECT_GATE=0` to verify the gate-OFF mode.

### 5.2 `npm run billing:seed`

Moves a test venue into a specific subscription state without round-tripping through Stripe. **Local + staging only — never production.** It tags rows it creates with `metadata.source='billing_gate_test'` so it can clean them up later without touching real Stripe-driven subscriptions.

```bash
SEED_SUBSCRIPTION_SUPABASE_URL=https://xxx.supabase.co \
SEED_SUBSCRIPTION_SERVICE_ROLE_KEY=eyJ... \
SEED_SUBSCRIPTION_VENUE_ID=<uuid> \
SEED_SUBSCRIPTION_STATUS=past_due \
npm run billing:seed
```

Allowed statuses: `none`, `trialing`, `active`, `past_due`, `canceled`, `incomplete`. With `none`, the script DELETES any test rows for that venue (only rows tagged `metadata.source='billing_gate_test'`). With any other status, it deletes the previous test row and inserts a fresh one.

**Verify after seeding**: hit `/api/readiness` (still 200), then run `npm run billing:matrix` (or a single curl) to confirm the route behavior matches the new state.

---

## 6. Typical QA loop

Verify staging before flipping the gate in prod:

```bash
# 1. Confirm baseline (gate off, trial state).
BILLING_GATE_ENABLED=0  # in Vercel staging env
npm run billing:matrix BILLING_MATRIX_EXPECT_GATE=0   # all routes pass

# 2. Flip the gate on in staging.
BILLING_GATE_ENABLED=1  # redeploy

# 3. Move the test venue to past_due.
npm run billing:seed SEED_SUBSCRIPTION_STATUS=past_due

# 4. Assert gated routes 402, untouched routes 2xx.
BILLING_MATRIX_EXPECT_GATE=1 npm run billing:matrix

# 5. Move back to trialing.
npm run billing:seed SEED_SUBSCRIPTION_STATUS=trialing

# 6. Re-assert: gated routes flip to 2xx, widget still 201.
BILLING_MATRIX_EXPECT_GATE=1 npm run billing:matrix

# 7. Clean up.
npm run billing:seed SEED_SUBSCRIPTION_STATUS=none
```

After 30+ minutes of stable behavior in staging, the gate is safe to enable in prod (§4.1).

---

## 7a. Audit log inspection (Phase 7F)

Every Stripe webhook event is recorded in `public.billing_events_log` before dispatch — see [SECURITY.md §10e](./SECURITY.md) for the safety posture. The most useful operator queries:

```sql
-- recent failures across all tenants (service-role read)
select stripe_event_id, event_type, handler_error, venue_id, received_at
from public.billing_events_log
where handled = false and handler_error is not null
  and received_at > now() - interval '24 hours'
order by received_at desc limit 50;

-- Stripe retried us — anything > 0 means our previous response was 5xx
-- or Stripe network-flaked.
select stripe_event_id, event_type, duplicate_count, received_at
from public.billing_events_log
where duplicate_count > 0
order by duplicate_count desc, received_at desc limit 20;

-- timeline for one venue
select stripe_event_id, event_type, handled, handler_error,
       duplicate_count, received_at
from public.billing_events_log
where venue_id='<venue id>'
order by received_at desc limit 30;
```

To **replay an event** from the Stripe dashboard:
Stripe → Developers → Webhooks → your endpoint → click an event → "Resend".

Our webhook handler treats a redelivery as: insert hits the UNIQUE on `stripe_event_id` → helper bumps `duplicate_count` and returns `duplicate: true` → handler short-circuits with HTTP 200 `{ received: true, duplicate: true }`. Subscription state is NOT re-synced (it doesn't need to be — Stripe already replayed the same payload).

If you need to **force a re-sync**, change something Stripe-side (e.g. add metadata, toggle cancel-at-period-end) so Stripe emits a fresh `customer.subscription.updated` event with a NEW `stripe_event_id`. That will land as a new audit row and run the handler.

## 7. Adding a new write route

When you add a new mutation endpoint, you MUST:

1. Add it to the matrix (§2.3) under the right column or create a new column.
2. Wire `requireActiveSubscription(venueId, { requestId, route })` AFTER auth + role + venue resolution but BEFORE any expensive work (DB write, AI call).
3. Map `SubscriptionRequiredError` to the canonical 402 response:
   ```json
   { "error": "subscription_required", "subscription_status": "<kind>" }
   ```
4. Extend `scripts/billing-gate-matrix.mjs` with a probe for the new route.
5. Update this doc.

Skipping any of those is an audit failure on the next phase.
