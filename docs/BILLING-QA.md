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

## 7b. Admin API for audit log (Phase 7G)

For operators who don't want to write SQL, two endpoints expose the Phase 7F audit log over HTTP.

### List

```
GET /api/admin/billing-events
```

Owner/admin only (`requireAdmin`). Rate-limited per caller (`admin:billing-events:{userId}`). Query params:

| Param | Type | Default | Notes |
|---|---|---|---|
| `event_type` | string | — | e.g. `customer.subscription.updated` |
| `handled` | `true`/`false`/`all` | `all` | restrict to handled / failed / no filter |
| `venue_id` | UUID | caller's primary | if set and different from caller's primary, caller must hold ADMIN_ROLES on it (re-verified) |
| `limit` | int 1–200 | 50 | |

Response: `{ items: [{ id, stripe_event_id, event_type, venue_id, stripe_customer_id, stripe_subscription_id, handled, handled_at, handler_error, duplicate_count, received_at }] }`. **`payload` is intentionally omitted** — slimmer rows + privacy.

Errors:
- 400 `invalid_query` (Zod validation)
- 401 `unauthorized`
- 403 `forbidden` (no admin venue, or `venue_id` you don't admin)
- 429 rate-limited
- 500 `unexpected_error`

### Detail

```
GET /api/admin/billing-events/[id]
```

Same auth. Different rate-limit key (`admin:billing-event-detail:{userId}`). Returns the **full** row including `payload`. 404 is the existence boundary — "not found", "row's venue_id is null", and "row belongs to a venue you don't admin" all return the same 404 so admins can't enumerate cross-tenant events.

### Quick recipes

```bash
# 1. Most recent failures (most useful single query).
curl -H "Cookie: sb-...-auth-token=..." \
  "$APP/api/admin/billing-events?handled=false&limit=50" | jq .

# 2. All subscription updates in the last batch — surface for "did Stripe
#    just retry us?" investigations.
curl -H "Cookie: sb-...-auth-token=..." \
  "$APP/api/admin/billing-events?event_type=customer.subscription.updated&limit=20" | jq .

# 3. Drill into one event (replace <id> with a list-response row.id).
curl -H "Cookie: sb-...-auth-token=..." \
  "$APP/api/admin/billing-events/<row id>" | jq .item.payload
```

### Privacy reminder

The detail endpoint is the only product surface that returns Stripe payloads. Stripe payloads contain customer email + billing-address fields. Do not screenshot or paste responses into shared channels.

## 7d. Stripe event replay (Phase 7I)

When a handler failed transiently (audit row shows `handled=false`), the cleanest recovery is to POST to the replay endpoint instead of re-clicking "Resend" in the Stripe dashboard. The endpoint:

1. Re-fetches the freshest event payload from Stripe (`stripe.events.retrieve`).
2. Dispatches through the same handler the webhook would have used (the dispatcher was extracted in 7I — `lib/billing/stripe-event-dispatcher.ts` — so there's one source of truth).
3. Updates the **same** audit row in place. No new row, no `duplicate_count` bump.

### Curl

```bash
# Find a failed event id:
curl -H "Cookie: sb-...-auth-token=..." \
  "$APP/api/admin/billing-events?handled=false&limit=10" | jq '.items[].id'

# Replay:
curl -X POST -H "Cookie: sb-...-auth-token=..." \
  "$APP/api/admin/billing-events/<id>/replay"
```

### Response shapes

Success:
```json
{
  "replayed": true,
  "handled": true,
  "ignored": false,
  "handler_error": null
}
```

Handler failed again (audit row's `handled` flipped back to `false`, `handler_error` populated):
```json
{
  "replayed": true,
  "handled": false,
  "ignored": false,
  "handler_error": "<failure message>"
}
```

Event was intentionally ignored (unknown type):
```json
{
  "replayed": true,
  "handled": true,
  "ignored": true,
  "handler_error": null
}
```

Errors: 401, 404 (missing / null venue / cross-tenant), 429, 502 (Stripe API failure), 503 (Stripe key missing), 500.

### When to use it vs Stripe dashboard "Resend"

- **Use `/replay`** for "this audit row failed; fix it in place." Most common case.
- **Use Stripe dashboard "Resend"** only when you specifically want Stripe to re-prove the signature path, or when the original payload was lost from our DB but Stripe still has it. (Our endpoint requires the audit row to exist; if it's been hard-deleted, Resend is the only option.)

### Discovery from the detail endpoint

The Phase 7G detail endpoint now includes `can_replay` so a future operator UI can show/hide the button without re-deriving the rule:

```bash
curl -H "Cookie: sb-...-auth-token=..." \
  "$APP/api/admin/billing-events/<id>" | jq '.item.can_replay'
# true  ← row has both stripe_event_id and venue_id
# false ← row is forensic-only (null venue_id) or missing stripe_event_id
```

`can_replay` is purely structural — it does NOT check whether `STRIPE_SECRET_KEY` is set. The replay endpoint itself returns 503 `billing_not_configured` when Stripe is unavailable.

### Safety

- Replay re-runs the full handler with the latest Stripe payload. For `customer.subscription.*`, that means overwriting our `subscriptions` row with current Stripe state. For `invoice.payment_*`, it pulls the parent subscription and re-syncs.
- The dispatcher uses the same idempotency story as the webhook path (`syncSubscriptionFromStripeSubscription` upserts on `stripe_subscription_id`), so back-to-back replays converge.
- Rate-limited per caller (`admin:billing-event-replay:{userId}`); accidental click-loops can't blow up the table.
- Replay does NOT trigger downstream emails or in-app notifications.

### Replay attribution (Phase 7J)

After a successful replay the route calls `public.record_billing_event_replay(p_event_id, p_user_id)` — a SECURITY DEFINER function that atomically increments `replay_count` and stamps `replayed_at` + `replayed_by` in one SQL round-trip. The function returns the new `replay_count` so the response includes it without a second query.

Response now includes `replay_count`:
```json
{
  "replayed": true,
  "handled": true,
  "ignored": false,
  "handler_error": null,
  "replay_count": 3
}
```

Counter increments AFTER Stripe retrieval succeeded and dispatch finished — regardless of whether the handler itself succeeded or failed. So a row whose handler keeps failing AND that an operator replays five times shows `replay_count: 5` with `handled: false`. That's the desired signal: "we know we keep trying."

Counter does NOT increment when Stripe `events.retrieve` returns 502 (event purged, Stripe API down, etc.) — those aborts happen before dispatch even starts.

The list endpoint surfaces `replay_count` + `replayed_at`; the detail endpoint additionally surfaces `replayed_by` (the operator's user id). We deliberately keep `replayed_by` out of the list to keep responses slim and to avoid spreading operator ids into wider tooling. SQL access via service role:
```sql
select id, stripe_event_id, handled, replay_count, replayed_at, replayed_by
from public.billing_events_log
where replay_count > 0
order by replayed_at desc;
```

## 7e. Dunning workflow (Phase 7K)

Daily Inngest cron `billing-dunning`, schedule `0 16 * * *` (4pm UTC ≈ noon ET / 9am PT depending on DST). Mirrors the Phase 7H trial-reminder shape — idempotency lives on `subscriptions.metadata`, never sends unless `sendEmail.delivered === true`, console-fallback doesn't consume an attempt slot.

### Policy

- **Eligibility**: `status='past_due' AND current_period_end IS NOT NULL`. No dunning for `trialing` / `active` / `canceled` / `incomplete` / `none`.
- **Stop after 3 attempts** per `current_period_end` date. Attempt 4 logs `jobs.billing_dunning.escalation_needed` + Sentry-captures (warning severity) and skips. When the period rolls over OR Stripe flips the sub back to active, the counter naturally resets because the date-in-key changes.
- **48-hour spacing** between attempts within the same period. Manual operator triggers still respect this guard.
- **Owner-only**: earliest `venue_members` row with `role='owner'`. Co-owners don't get the email (avoids noise; one dunning per venue per period).
- **Stripe Customer Portal URL** is created on-demand per email (Stripe expires portal URLs after ~1h; the email is sent now, so the link is fresh when received).

### Idempotency key

```
dunning:<venue_id>:<current_period_end YYYY-MM-DD>:attempt-<N>
```

The period date is part of the key so:
- A new period generates new keys (counter resets).
- A second cron same-day finds the key already present and skips.
- The 48h guard layered on top blocks back-to-back attempts within the same period.

### Example metadata after 3 attempts

```json
{
  "dunning_sent": [
    {
      "kind": "past_due",
      "key": "dunning:VENUE_ID:2026-06-01:attempt-1",
      "attempt": 1,
      "sent_at": "2026-05-20T16:00:00.000Z",
      "provider": "resend",
      "message_id": "abc123"
    },
    {
      "kind": "past_due",
      "key": "dunning:VENUE_ID:2026-06-01:attempt-2",
      "attempt": 2,
      "sent_at": "2026-05-22T16:00:00.000Z",
      "provider": "resend",
      "message_id": "def456"
    },
    {
      "kind": "past_due",
      "key": "dunning:VENUE_ID:2026-06-01:attempt-3",
      "attempt": 3,
      "sent_at": "2026-05-24T16:00:00.000Z",
      "provider": "resend",
      "message_id": "ghi789"
    }
  ]
}
```

### Candidate query

```sql
select id, venue_id, status, current_period_end, metadata
from public.subscriptions
where status = 'past_due'
  and current_period_end is not null;
```

### History query

```sql
select id, venue_id, metadata->'dunning_sent' as dunning_sent
from public.subscriptions
where metadata ? 'dunning_sent';
```

### Manual trigger (Inngest)

Local dev:
```bash
INNGEST_DEV=1 npm run dev
# in a second shell:
npx inngest-cli@latest dev
# then open the Inngest dev UI (default http://localhost:8288) →
# Functions → billing-dunning → Invoke.
```

Production:
Inngest dashboard → Apps → your app → Functions → `billing-dunning` → "Invoke".

Return shape: `{ scanned, sent, skipped, failed, escalation_needed }`. Healthy steady-state: most days return `{ scanned: 0 }` because `past_due` is rare.

### Combined with the seed script (staging)

```bash
# 1. Move a test venue into past_due.
SEED_SUBSCRIPTION_SUPABASE_URL=$STAGING_SUPABASE_URL \
  SEED_SUBSCRIPTION_SERVICE_ROLE_KEY=$STAGING_SERVICE_KEY \
  SEED_SUBSCRIPTION_VENUE_ID=$STAGING_TEST_VENUE \
  SEED_SUBSCRIPTION_STATUS=past_due \
  npm run billing:seed

# 2. Confirm the function is registered.
BILLING_MATRIX_APP_URL=$STAGING_URL \
  BILLING_MATRIX_SUPABASE_URL=$STAGING_SUPABASE_URL \
  BILLING_MATRIX_SUPABASE_ANON_KEY=$STAGING_ANON \
  BILLING_MATRIX_SUPABASE_SERVICE_ROLE_KEY=$STAGING_SERVICE_KEY \
  BILLING_MATRIX_TEST_USER_EMAIL=$STAGING_USER \
  BILLING_MATRIX_TEST_USER_PASSWORD=$STAGING_PASS \
  BILLING_MATRIX_VENUE_ID=$STAGING_TEST_VENUE \
  BILLING_MATRIX_DUNNING=1 \
  npm run billing:matrix

# 3. Invoke the cron from Inngest UI. Watch for an email to the test owner.
# 4. Verify the metadata row appeared:
#       select metadata->'dunning_sent' from public.subscriptions where id='...';
# 5. Restore.
SEED_SUBSCRIPTION_SUPABASE_URL=$STAGING_SUPABASE_URL \
  SEED_SUBSCRIPTION_SERVICE_ROLE_KEY=$STAGING_SERVICE_KEY \
  SEED_SUBSCRIPTION_VENUE_ID=$STAGING_TEST_VENUE \
  SEED_SUBSCRIPTION_STATUS=none \
  npm run billing:seed
```

### Diagnostic checklist

Full no-send playbook: [RUNBOOK.md §2.4g](./RUNBOOK.md). Short version:
1. `/api/health` → `billing.dunning: "mounted"`.
2. Inngest dashboard → run was green at 16:00 UTC today.
3. Candidate SQL returns the venue (status + current_period_end checks).
4. `metadata.dunning_sent` doesn't already have 3 entries for this period.
5. Latest entry is > 48h old.
6. Owner email exists.
7. Stripe portal can be created (`billing_customers` row exists).
8. Resend is `configured` in production.

## 7h. Payment recovery email (Phase 7M)

Single "Payment received — your VenueRise account is active" email sent when a venue's subscription transitions from `past_due` back to `active` or `trialing`. Fires from the Stripe webhook path — no cron. Detection happens because `syncSubscriptionFromStripeSubscription` (widened in 7M) now returns `{ previousStatus, newStatus, venueId, subscriptionId, currentPeriodEnd }` and the dispatcher inspects it.

### Trigger condition

```
previousStatus === 'past_due'
AND newStatus ∈ { 'active', 'trialing' }
AND venueId is not null
AND subscriptionId is not null
```

Fires on: `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.payment_succeeded`, `invoice.payment_failed` — i.e. every dispatcher path that runs the sync. In practice the overwhelmingly common emitter is `customer.subscription.updated` (Stripe flips status when an automatic retry clears the past_due charge).

### Idempotency

Key shape:
```
recovery:<venue_id>:<current_period_end YYYY-MM-DD | unknown-period>
```

Stored on `subscriptions.metadata.recovery_sent` (jsonb array, atomic append via the Phase 7L RPC). The period date in the key means:
- A customer who bounces past_due → active → past_due → active within ONE billing period gets ONE recovery email.
- A customer who lands past_due again in the NEXT period gets a fresh recovery email when they recover.
- `unknown-period` fallback for the rare case where Stripe doesn't include `current_period_end` on the event.

### Example metadata after dunning + recovery cycle

```json
{
  "recovery_sent": [
    {
      "kind": "payment_recovered",
      "key": "recovery:VENUE_ID:2026-06-01",
      "sent_at": "2026-05-20T18:10:00.000Z",
      "provider": "resend",
      "message_id": "rec_abc"
    }
  ],
  "dunning_sent": [
    {
      "kind": "past_due",
      "key": "dunning:VENUE_ID:2026-06-01:attempt-1",
      "attempt": 1,
      "sent_at": "2026-05-18T16:00:00.000Z",
      "provider": "resend",
      "message_id": "dun_abc"
    }
  ]
}
```

### SQL verification

```sql
-- All recoveries we've ever sent.
select id, venue_id, status, metadata->'recovery_sent' as recovery_sent
from public.subscriptions
where metadata ? 'recovery_sent'
order by updated_at desc;

-- Venues currently `active` that recovered from past_due (full lifecycle witness).
select s.id, s.venue_id, s.status,
       s.metadata->'recovery_sent' as recovery_sent,
       s.metadata->'dunning_sent'  as dunning_sent
from public.subscriptions s
where s.metadata ? 'recovery_sent' and s.metadata ? 'dunning_sent';
```

### Webhook response surface

The Stripe webhook response now optionally includes the recovery outcome:
```json
{
  "received": true,
  "handled": true,
  "ignored": false,
  "recovery_email": {
    "sent": true,
    "skipped": false
  }
}
```

`recovery_email` is omitted when the dispatcher didn't attempt one (different transition, missing ids, non-billing event). When present, it's either:
- `{ sent: true, skipped: false }` — email went out, metadata recorded.
- `{ sent: false, skipped: true, reason: 'already_sent' | 'no_owner_email' | 'subscription_not_found' }` — intentionally not sent.
- `{ sent: false, skipped: false, reason: 'metadata_append_failed' | 'lookup_failed' | 'send_threw' | 'not_delivered' | <provider error> }` — attempted, didn't land.

The webhook itself ALWAYS returns 200 — recovery failures don't trigger Stripe retries. Sentry captures the underlying error in every failure path.

### Troubleshooting

Full playbook: [RUNBOOK.md §2.4h](./RUNBOOK.md). Short checklist:
1. Subscription actually transitioned from `past_due` (check `payload.data.previous_attributes` in the audit log).
2. Webhook event landed (`billing_events_log` shows `handled=true`).
3. Dispatcher ran (Sentry shows `op: billing.payment_recovery` log lines).
4. Owner has an email.
5. Resend configured.
6. Recovery key not already present in metadata.
7. Metadata append succeeded (`metadata_append_failed` would surface in webhook response).

## 7g. Atomic metadata helper (Phase 7L)

Both billing crons (trial reminder + dunning) write entries to `subscriptions.metadata` JSONB arrays:
- trial reminder → `metadata.reminders_sent`
- dunning → `metadata.dunning_sent`

Before Phase 7L, the writes were read-modify-write from the cron's Node code. The Stripe webhook's subscription sync overwrites the whole `metadata` column on every update — if a sync landed between a cron's `select` and `update`, the cron's freshly-appended entry vanished silently.

Phase 7L closes the race with a Postgres function:

```sql
create or replace function public.append_subscription_metadata_array(
  p_subscription_id uuid,
  p_array_key       text,
  p_entry           jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
```

The function `jsonb_set`s the target array inside a single `UPDATE`. Postgres locks the row for the duration of the update, so the Stripe sync (which is a separate transaction) either lands strictly before OR strictly after — the appended entry is never lost.

### GRANT model

`security definer` + `set search_path = public` + `revoke all from public` + `grant execute to service_role`. The anon and authenticated roles cannot call the function. Only `lib/billing/subscription-metadata.ts` (which uses the service-role Supabase client) invokes it.

### Helper surface

```ts
appendSubscriptionMetadataArray({
  subscriptionId,
  arrayKey: 'reminders_sent' | 'dunning_sent' | string,
  entry: Record<string, unknown>,
  requestId?: string,
}): Promise<Record<string, unknown> | null>
```

Returns the updated `metadata` object on success, `null` on failure (logged + Sentry-captured inside the helper). Cron callers treat `null` as "count as failed, continue batch" — never throws.

### Known limitation (race still present on the read side)

The crons still do an idempotency PRE-CHECK by reading `metadata.reminders_sent` / `metadata.dunning_sent` before sending. Phase 7L only fixed the WRITE race. Theoretically two cron invocations starting simultaneously could:
1. Both read `metadata.reminders_sent`, both see no key for today.
2. Both send the email.
3. Both call the RPC; both succeed (append is additive — you get two entries with the same key).

In practice the Inngest scheduler de-duplicates invocations of the same cron function, so this requires a deliberate manual double-trigger to provoke. The downstream effect is "a customer got two reminder emails on the same day", which is recoverable + non-financial. A future migration could promote the dedup to the SQL level by making the RPC check `metadata.reminders_sent @> jsonb_build_array(jsonb_build_object('key', entry->>'key'))` before appending — out of scope here.

### SQL verification

```sql
select proname, pg_get_function_arguments(oid), pg_get_function_result(oid)
from pg_proc
where proname = 'append_subscription_metadata_array';
```

Expected: `(p_subscription_id uuid, p_array_key text, p_entry jsonb)` returning `jsonb`.

## 7c. Trial reminder cron (Phase 7H)

Daily Inngest function `billing-trial-reminder`, cron `0 14 * * *` (2pm UTC ≈ 9am ET / 8am CT depending on DST). For every `subscriptions` row whose `trial_end` lands on (now + 3 days, UTC) and hasn't been reminded yet, the owner gets a "Your VenueRise trial ends in 3 days" email.

**Idempotency** lives on `subscriptions.metadata.reminders_sent` (jsonb array). Each entry has shape:
```json
{
  "kind": "trial_3d",
  "key": "trial_3d:<venue_id>:<trial_end YYYY-MM-DD>",
  "sent_at": "2026-05-18T14:00:23.111Z",
  "provider": "resend",
  "message_id": "..."
}
```

The key includes the trial_end date, so:
- A second cron run on the same day finds the key already present and skips (cron drift safe).
- Extending a trial (new `trial_end`) generates a NEW key and re-arms the reminder.
- A venue with multiple subscription rows gets at most one reminder per row per date.

**Delivery honesty**: the reminder entry is only appended when `sendEmail({...}).delivered === true`. Console-fallback (no Resend) does NOT flip the flag — the next run retries once Resend is wired. Provider errors also don't flip the flag; they log + Sentry-capture and continue the batch.

### Candidate query

```sql
select id, venue_id, status, trial_end, metadata
from public.subscriptions
where status = 'trialing'
  and trial_end::date = (now() + interval '3 days')::date;
```

### Audit query — who's been reminded?

```sql
select id, venue_id, metadata->'reminders_sent' as reminders_sent
from public.subscriptions
where metadata ? 'reminders_sent';
```

### Manual trigger (Inngest dev / dashboard)

Local dev:
```bash
INNGEST_DEV=1 npm run dev
# in a second shell
npx inngest-cli@latest dev
```
Then open the Inngest dev UI (default `http://localhost:8288`) → Functions → `billing-trial-reminder` → "Invoke".

Production:
Inngest dashboard → Apps → your app → Functions → `billing-trial-reminder` → "Invoke".

The function returns `{ scanned, sent, skipped, failed }`. `skipped` covers both "already reminded" and "no owner email"; `failed` covers provider errors. Healthy steady-state: most runs return `{ scanned: 0 }` because there usually aren't venues hitting the exact-3-days mark.

### What to check when no email sends

Full diagnostic playbook: [RUNBOOK.md §2.4d](./RUNBOOK.md). The short version:
1. Inngest function registered (`/api/health` → `billing.trial_reminder: "mounted"`).
2. Today's run shows green in Inngest dashboard.
3. Candidate SQL returns the venue.
4. The metadata key for today isn't already present.
5. Owner row exists in `venue_members` with role=owner.
6. Owner has an email in `auth.users`.
7. Resend is `configured` (not console-fallback) in production.

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
