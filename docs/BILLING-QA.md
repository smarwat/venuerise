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

## 7i. Clear dunning admin tool (Phase 7N)

Operator escape hatch for the rare customer-support case where dunning attempt records need to be cleared on a `subscriptions.metadata.dunning_sent` array.

```
POST /api/admin/billing-events/[id]/clear-dunning
```

Owner/admin only. Rate-limited per caller (`admin:billing-events-clear-dunning:{userId}`). The `[id]` in the path is any billing event log row id that belongs to the same venue as the subscription being modified (same tenant-binding pattern as the Phase 7G/7I endpoints).

### Request

```json
{
  "subscription_id": "<uuid>",
  "period_date": "2026-06-01",          // optional, YYYY-MM-DD
  "reason": "<freeform, max 240 chars>" // optional, audit context
}
```

### Response

```json
{
  "success": true,
  "subscription_id": "...",
  "cleared_prefix": "dunning:VENUE_ID:2026-06-01",
  "metadata": { "dunning_sent": [/* remaining entries */] }
}
```

`cleared_prefix` echoes back what was actually matched so the operator can sanity-check. The `metadata` field is the updated full metadata object (includes `dunning_sent` + everything else like `reminders_sent`, `recovery_sent`).

### Prefix targeting

| `period_date` | Prefix applied | Effect |
|---|---|---|
| `'2026-06-01'` | `dunning:<venue>:2026-06-01` | Removes attempts for ONE period only |
| omitted | `dunning:<venue>:` | Removes EVERY period's attempts for the venue |

The prefix LIKE match in the SQL is `prefix || '%'`, so a date-scoped prefix matches `dunning:<v>:2026-06-01:attempt-1`, `attempt-2`, `attempt-3`. The venue-only prefix matches every key the dunning job has ever written for that venue.

### Before / after example

Before:
```json
{
  "dunning_sent": [
    {
      "kind": "past_due",
      "key": "dunning:VENUE_ID:2026-06-01:attempt-1",
      "attempt": 1,
      "sent_at": "2026-05-18T16:00:00.000Z",
      "provider": "resend",
      "message_id": "..."
    },
    {
      "kind": "past_due",
      "key": "dunning:VENUE_ID:2026-06-01:attempt-2",
      "attempt": 2,
      "sent_at": "2026-05-20T16:00:00.000Z",
      "provider": "resend",
      "message_id": "..."
    }
  ]
}
```

Operator runs:
```bash
curl -X POST -H "Cookie: ..." -H "Content-Type: application/json" \
  -d '{"subscription_id":"<uuid>","period_date":"2026-06-01","reason":"customer says they paid; verified in Stripe"}' \
  "$APP/api/admin/billing-events/<event id>/clear-dunning"
```

After:
```json
{
  "dunning_sent": []
}
```

(Entries for OTHER periods stay; only the `2026-06-01` ones are gone.)

### Errors

| HTTP | code | meaning |
|---|---|---|
| 200 | — | cleared (whether the prefix matched any entries or not) |
| 400 | `validation_failed` | body fails Zod (bad `period_date` format, `reason` too long, missing `subscription_id`) |
| 401 | `unauthorized` | no session |
| 403 | `forbidden` | session exists, no admin venue (rare path) |
| 404 | `not_found` | event id missing / `venue_id IS NULL` / cross-tenant / subscription not in event's venue / param not a UUID |
| 429 | rate-limited | per-caller throttle |
| 500 | `unexpected_error` | RPC error or DB unavailable; Sentry-captured |

The 404 collapse for cross-tenant / null-venue cases preserves the existence boundary (admins can't enumerate events in tenants they don't admin).

### Safety notes

- Clearing attempts re-arms the cron. The next time the `billing-dunning` Inngest function runs (4pm UTC) it sees zero attempts for the current period and starts fresh — potentially sending three more emails over six days. Only clear when you understand this.
- For a customer who genuinely paid, the **recovery email** (Phase 7M, §7h) usually fires automatically when Stripe flips `past_due → active`. Clear-dunning is for the rare case where that didn't happen (status didn't transition, or recovery email skipped for some reason).
- Sentry / Pino capture the operator id, billing event id, subscription id, period date, and supplied `reason` on every successful call. The full metadata array is NOT logged.
- The route does NOT trigger any emails or notifications. It's a state-edit operation only.

### Full diagnostic / when-to-use playbook

[RUNBOOK.md §2.4i](./RUNBOOK.md) walks through curl examples, before/after capture, prefix-targeting decision tree, and the SQL fallback.

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

## 7b. Tour auto-pause for past_due venues (Phase 8F)

VenueRise runs a daily Inngest cron (`billing-tour-auto-pause`, schedule `0 18 * * *`) that cancels every future `scheduled|confirmed` tour for any venue whose subscription has been `past_due` for more than 7 days. This is the operational counterpart to the Phase 7K dunning cron — by the time we reach 7 days past due, the venue has already received their three dunning emails, so further outreach is unlikely to recover the payment.

### How it picks venues

```sql
-- The candidate query (logical equivalent — actual code is in
-- lib/jobs/functions/billing-tour-auto-pause.ts).
select id, venue_id, status, current_period_end, metadata
from public.subscriptions
where status = 'past_due'
  and current_period_end is not null
  and current_period_end < now() - interval '7 days'
order by current_period_end asc
limit 200;
```

The cron then filters in JS to decide whether each candidate is **paused for the current past-due window** (skip) or has a **stale pause from a prior cycle** (re-arm — see §7b.1 below). A second run on the same day is a no-op for venues already paused for the current window.

### 7b.1 Re-arm after a recovery + lapse (Phase 8H)

Before Phase 8H, the cron checked only `metadata.tours_paused_at`. That meant a venue that paused → recovered (Phase 8G stamps `tours_resumed_at`) → lapsed back to `past_due` would NEVER get re-paused — the original `tours_paused_at` blocked the guard forever. Phase 8H replaces that flat check with a window-aware predicate:

| `tours_paused_at` | `tours_resumed_at` | `tours_resumed_at` vs `current_period_end` | Action |
|---|---|---|---|
| missing | — | — | first pause → cancel + stamp |
| set | missing | — | currently paused → skip |
| set | set | `resumed_at >= current_period_end` | still paused for this window → skip |
| set | set | `resumed_at <  current_period_end` | **stale pair — re-arm**: archive into `tour_pause_history`, clear `tours_resumed_*`, stamp fresh pause |

The re-arm flow archives the prior `(paused_at, resumed_at, paused_reason, resumed_reason, paused_count, archived_at)` tuple into `metadata.tour_pause_history` (jsonb array, append-only) BEFORE stamping the new pause, so the full timeline survives.

### 7b.2 Metadata shape (post-Phase 8H)

```ts
{
  // current pause (cleared/overwritten on next re-arm)
  tours_paused_at:       string  // ISO timestamp
  tours_paused_reason:   string  // 'past_due_7_days'
  tours_paused_count:    number  // tours cancelled this cycle

  // present only after Phase 8G recovery, until the next re-arm
  tours_resumed_at?:     string
  tours_resumed_reason?: string  // 'payment_recovered'

  // appended on every re-arm — never trimmed
  tour_pause_history?: Array<{
    paused_at:      string
    resumed_at:     string
    paused_reason:  string | null
    resumed_reason: string | null
    paused_count:   number | null
    archived_at:    string  // ISO timestamp of when the cron archived
  }>
}
```

The old `tours_paused_reason` constant (`'past_due_7_days'`) is intentionally preserved across Phase 8H — operator SQL queries and the existing audit trail continue to work without migration. The example shape in the Phase 8H prompt used `'past_due_auto_pause'`; that was illustrative and the implementation stuck with the established string.

### 7b.3 How to manually test re-arm

```sql
-- 1. Pick a non-prod subscription. Synthesize a "recovered-then-lapsed"
--    state. The `current_period_end` must be older than 7 days so the
--    candidate query picks it up.
update public.subscriptions
set status = 'past_due',
    current_period_end = now() - interval '10 days',
    metadata = jsonb_build_object(
      'tours_paused_at',   (now() - interval '20 days')::text,
      'tours_paused_reason','past_due_7_days',
      'tours_paused_count', 2,
      'tours_resumed_at',  (now() - interval '15 days')::text,
      'tours_resumed_reason','payment_recovered'
    )
where id = '<subscription_id>';
```

2. Run the cron — either via Inngest UI or programmatically:
   ```ts
   import { runAutoPauseScan } from '@/lib/jobs/functions/billing-tour-auto-pause'
   console.log(await runAutoPauseScan())
   ```
3. Verify:
   ```sql
   select metadata->>'tours_paused_at'        as new_paused_at,
          metadata->>'tours_paused_count'      as new_paused_count,
          metadata->'tours_resumed_at'         as resumed_at_should_be_null,
          jsonb_array_length(metadata->'tour_pause_history') as history_len
   from public.subscriptions
   where id = '<subscription_id>';
   ```
   - `new_paused_at` should be a fresh ISO timestamp from this run.
   - `resumed_at_should_be_null` should be `null` (cleared by the re-arm).
   - `history_len` should be 1 (one archived prior pair).
4. Re-run the cron → assert `history_len` stays at 1 and `new_paused_at` doesn't change (idempotent in the current window).

### What it writes

For each eligible venue:

1. **Cancels future tours** — bulk `UPDATE tours SET status='cancelled' WHERE venue_id=$ AND scheduled_at > now() AND status IN ('scheduled','confirmed')`. Past tours and already-cancelled / completed / no-show rows are left untouched.
2. **Stamps the subscription** — sets three scalar fields on `subscriptions.metadata`:
   - `tours_paused_at` — ISO timestamp of the pause
   - `tours_paused_reason` — always `"past_due_7_days"` for this cron
   - `tours_paused_count` — how many rows the cancellation touched

### Why a direct UPDATE (not the Phase 7L atomic-append RPC)

These are scalar metadata fields, not array entries. The webhook-vs-cron race window is small (the cron runs nightly, the webhook lands on a Stripe event), and the worst case is one missed pause stamp that the next nightly pass will reapply. The Phase 7L RPC is reserved for cases where multiple writers genuinely contend on the same array.

### Manual verification

After the cron runs:

```sql
-- venues that got auto-paused in the last 24h
select s.venue_id,
       s.metadata->>'tours_paused_at'    as paused_at,
       s.metadata->>'tours_paused_reason' as reason,
       s.metadata->>'tours_paused_count'  as paused_count
from public.subscriptions s
where s.metadata ? 'tours_paused_at'
  and (s.metadata->>'tours_paused_at')::timestamptz > now() - interval '24 hours';

-- confirm the tour cancellations match the recorded count
select venue_id, count(*) as cancelled_today
from public.tours
where status = 'cancelled'
  and updated_at > now() - interval '24 hours'
group by venue_id;
```

The two counts per venue should agree (modulo any operator-initiated cancels in the same window).

### Run it manually

For staging / debugging, hit the Inngest dashboard and trigger `billing-tour-auto-pause` directly. Or in a Node REPL with service-role creds:

```ts
import { runAutoPauseScan } from '@/lib/jobs/functions/billing-tour-auto-pause'
const summary = await runAutoPauseScan()
console.log(summary)
// → { scanned, paused, cancelled_tours, skipped, failed }
```

### Recovery / unpause

This cron has no automatic unpause. When billing recovers (Stripe webhook flips status back to `active` or `trialing`), the venue's tours stay cancelled. Operators who want to restore them should ask the venue to re-schedule via the inbox lifecycle strip (Phase 8F), or drop the `tours_paused_at` key from metadata and re-insert tours manually.

### Logging + Sentry

- Every per-venue action logs structured fields: `venueId`, `subscriptionId`, `periodEnd`, `cancelledCount`, `pausedAtIso`. Phase 8H adds three new log events:
  - `jobs.billing_tour_auto_pause.already_paused_current_window` — skip because we're still in the active pause window.
  - `jobs.billing_tour_auto_pause.history_archived` — prior pause/resume pair was archived on a re-arm.
  - `jobs.billing_tour_auto_pause.rearmed` — fresh pause stamped on a previously-recovered venue.
- Per-venue failures (cancel UPDATE failed / metadata UPDATE failed) get `captureJobError('billing-tour-auto-pause', err, { venueId })` and increment `failed` in the summary — they do NOT abort the batch, so one bad venue can't block the rest.
- The scan summary `{ scanned, paused, rearmed, cancelled_tours, skipped, failed }` is logged at INFO level on completion (Phase 8H added `rearmed`). Set up an Inngest run alert if `failed > 0` for two consecutive runs.

## 7j. Tour auto-resume on payment recovery (Phase 8G)

The operational mirror of §7b. When Stripe transitions a subscription from `past_due` → `active` / `trialing`, the dispatcher (`lib/billing/stripe-event-dispatcher.ts`) fires **two** side effects in sequence:

1. **Recovery email** (Phase 7M) — owner-facing "your account is active again" notice.
2. **Tour auto-resume stamp** (Phase 8G) — writes `subscriptions.metadata.tours_resumed_at` (ISO timestamp) + `tours_resumed_reason = 'payment_recovered'`.

Both run on the same transition; both are idempotent on webhook redeliveries. Failure in one does NOT block the other.

### What auto-resume does NOT do

- **It does not resurrect cancelled tours.** Any tour that was cancelled by the Phase 8F auto-pause cron stays `status='cancelled'`. The lifecycle of those rows is intentionally operator-controlled — if the venue wants them back, an admin recreates them via the dashboard or asks the leads to re-book.
- **It does not clear `tours_paused_at`.** The audit pair "paused on X, resumed on Y" remains readable for forensics.

### Re-arming after a bounce (Phase 8H)

**Resolved in Phase 8H.** The auto-pause cron now distinguishes between "currently paused in this past-due window" and "stale pause from a prior cycle". When a venue bounces past_due → active → past_due, the cron:

1. Archives the prior `(paused_at, resumed_at, paused_reason, resumed_reason, paused_count, archived_at)` tuple into `metadata.tour_pause_history` (jsonb array, append-only).
2. Clears `tours_resumed_at` / `tours_resumed_reason`.
3. Stamps a fresh `tours_paused_at` + cancels future tours for the new cycle.

See §7b.1 / §7b.2 / §7b.3 above for the decision rule, metadata shape, and a step-by-step test recipe.

No manual SQL clear is needed any more. The pre-8H workaround (deleting the metadata keys to force a re-pause) still works, but if you do that you'll also lose the history record of the prior cycle — let the cron archive it for you instead.

### Inspect paused / resumed venues

```sql
-- venues currently in the paused state (banner is showing for them)
select id, venue_id, status,
       metadata->>'tours_paused_at'    as paused_at,
       metadata->>'tours_paused_count'  as paused_count,
       metadata->>'tours_resumed_at'    as resumed_at
from public.subscriptions
where metadata ? 'tours_paused_at'
  and not (metadata ? 'tours_resumed_at')
order by paused_at desc;

-- venues that paused + recovered (banner hidden again)
select id, venue_id, status,
       metadata->>'tours_paused_at'  as paused_at,
       metadata->>'tours_resumed_at' as resumed_at
from public.subscriptions
where metadata ? 'tours_paused_at'
  and metadata ? 'tours_resumed_at'
order by resumed_at desc;
```

There is also a thin admin endpoint that returns the first query as JSON:

```bash
curl -s http://localhost:3000/api/admin/tours/paused-venues \
  -H "Cookie: <copy from logged-in browser session>" | jq .
```

Auth: `requireAdmin()` only. Returns 401 unauthenticated, 403 if the user has no admin/owner membership anywhere, and `{ items: [...] }` otherwise. Each item contains `venue_id`, `subscription_id`, `status`, `tours_paused_at`, `tours_paused_count` — no PII.

### Tour notification emails (Phase 8G + 8H)

Best-effort lead-facing emails fire on every tour status event:

| Event | Trigger | Subject |
|---|---|---|
| Created | `POST /api/tours` | `Your venue tour is scheduled` |
| Rescheduled | `PATCH /api/tours/[id]` changes `scheduled_at` | `Your venue tour has been updated` |
| Confirmed | `PATCH` flips status to `confirmed` | `Your venue tour is confirmed` |
| Cancelled | `PATCH` flips status to `cancelled` | `Your venue tour was cancelled` |
| Cancelled (bulk) | `POST /api/admin/tours/bulk-cancel` | `Your venue tour was cancelled` |

If a single PATCH changes both `status` AND `scheduled_at`, only one email is sent — priority is `cancelled` > `confirmed` > `rescheduled`.

**Phase 8H — bulk-cancel notifications**: the operator escape hatch `POST /api/admin/tours/bulk-cancel` now fans out cancellation emails to every affected lead at concurrency 5 via `runWithConcurrency()` (defined in `lib/integrations/tour-notifications.ts`). Behavior:

- Best-effort. Email failures NEVER turn a successful bulk-cancel into a 500.
- Only rows that were actually flipped to `cancelled` by the UPDATE get notified — rows that flipped status mid-request (e.g. operator manually completed them) are excluded.
- Suppression / no-email-on-file leads are reflected in `notification_summary.skipped`.
- Response gets a new top-level block:
  ```json
  {
    "success": true,
    "cancelled_count": 3,
    "notification_summary": {
      "attempted": 3,
      "queued": 3,
      "skipped": 0,
      "failed": 0
    }
  }
  ```
  `queued` counts helper-returned `{ sent: true }` (handed off to Resend successfully). `skipped` is "lead had no email or hit suppression". `failed` is "provider error / threw". The names "queued" vs "delivered" reflect the helper's contract: a successful return from `sendEmail` means Resend accepted the request, not that the recipient's inbox received it — delivery confirmation lives in the Resend webhook (Phase 4B+).

**Failure model**: the per-row email send is fire-and-forget for `POST /api/tours` + `PATCH /api/tours/[id]`. For bulk-cancel, the email outcome is awaited (to populate the response summary) but wrapped in `runWithConcurrency()` which catches every throw. Failures are structured-logged + Sentry-captured (except `suppressed:*` which is an expected outcome and not a fault). Leads with no `email` on file are silently skipped.

**Suppression**: rides on the existing `sendEmail` layer — `public.email_suppressions` blocks delivery and the helper returns `result.error = 'suppressed:<reason>'`.

### Health surface

```json
{
  "billing": {
    "...": "...",
    "tour_auto_pause": "mounted",
    "tour_auto_resume": "mounted"
  }
}
```

`ADMIN_ENDPOINT_COUNT` bumped from 13 → 14 (added `/api/admin/tours/paused-venues`).

## 7k. Tour pause history + clear-pause admin tool (Phase 8I)

Phase 8H made the auto-pause cron re-arm aware. Phase 8I exposes the resulting timeline to operators and gives them an explicit reset button.

### Endpoint contracts

**`GET /api/admin/tours/pause-history`**

| Field | Type | Notes |
|---|---|---|
| auth | `requireAdmin()` | 401 unauthenticated, 403 if not admin/owner anywhere |
| rate-limit key | `admin:tours-pause-history:{userId}` | shared with all other admin rate-limited reads |
| query `venue_id?` | uuid | falls back to caller's primary venue; cross-tenant requires `ADMIN_ROLES` on the target |
| query `limit?` | int 1–100 | default 20 — caps the number of `items` returned |

Response (always 200 on success):

```json
{
  "items": [
    {
      "paused_at":      "2026-05-01T18:00:00.000Z",
      "resumed_at":     "2026-05-04T18:00:00.000Z",
      "paused_reason":  "past_due_7_days",
      "resumed_reason": "payment_recovered",
      "paused_count":   4,
      "archived_at":    "2026-05-18T18:00:00.000Z"
    }
  ],
  "current": {
    "paused_at":      "2026-05-18T18:00:00.000Z",
    "paused_reason":  "past_due_7_days",
    "paused_count":   2,
    "resumed_at":     null,
    "resumed_reason": null
  }
}
```

- `items` is `tour_pause_history` reversed (newest first) then capped at `limit`. Malformed entries are silently dropped — one bad row never breaks the whole audit surface.
- `current` is always present; every field is `null` when the venue has never been paused.
- Returns ONLY the six pause/resume keys + four current-state scalars. Other subscription metadata (Stripe-side fields, dunning audit, etc.) is never spread into the response.

**`POST /api/admin/tours/clear-pause`**

| Field | Type | Notes |
|---|---|---|
| auth | `requireAdmin()` | same as above |
| rate-limit key | `admin:tours-clear-pause:{userId}` | per-caller |
| body `venue_id?` | uuid | optional override; cross-tenant requires `ADMIN_ROLES` on target |
| body `reason?` | string max 240 | optional free-text recorded in metadata |

Response shapes (200 in every success branch):

```json
// pause existed, cleared
{ "success": true, "changed": true, "venue_id": "...", "subscription_id": "..." }

// no current pause to clear (idempotent)
{ "success": true, "changed": false, "reason": "not_paused" }

// venue has no subscription row at all (rare — pre-onboarding)
{ "success": true, "changed": false, "reason": "no_subscription" }
```

### Metadata before / after

**Before clear-pause** (typical Phase 8H re-arm state):

```json
{
  "tours_paused_at":   "2026-05-18T18:00:00.000Z",
  "tours_paused_reason": "past_due_7_days",
  "tours_paused_count":  2,
  "tour_pause_history": [
    { "paused_at": "...", "resumed_at": "...", "paused_reason": "...",
      "resumed_reason": "...", "paused_count": 4, "archived_at": "..." }
  ]
}
```

**After clear-pause** (with operator-supplied `reason`):

```json
{
  "tour_pause_history": [
    { "paused_at": "...", "resumed_at": "...", "paused_reason": "...",
      "resumed_reason": "...", "paused_count": 4, "archived_at": "..." }
  ],
  "tours_pause_cleared_at":     "2026-05-19T08:12:00.000Z",
  "tours_pause_cleared_by":     "<operator user uuid>",
  "tours_pause_cleared_reason": "Stripe webhook lost, recovered out-of-band"
}
```

Note what survives and what doesn't:

- `tour_pause_history` is preserved verbatim. The cleared cycle is NOT moved into history (it never had a `resumed_at`).
- The five scalar pause/resume keys (`tours_paused_at`, `tours_paused_reason`, `tours_paused_count`, `tours_resumed_at`, `tours_resumed_reason`) are all deleted.
- Three new forensic keys are written. `tours_pause_cleared_by` is the operator's auth.users.id, NOT email — pivot through `auth.admin.getUserById` if you need to identify them.

### When to clear pause vs let Stripe recovery handle it

The Phase 8G dispatcher already stamps `tours_resumed_at` on `past_due → active|trialing`, and the `/dashboard/tours` banner check is `tours_paused_at IS NOT NULL AND tours_resumed_at IS NULL`. So **in the normal recovery flow, the banner flips off on its own** — you don't need clear-pause for that.

Use clear-pause ONLY when:

| Scenario | Why clear-pause |
|---|---|
| Webhook lost / Stripe outage | Recovery happened in Stripe but no `customer.subscription.updated` ever landed; the dispatcher never got a chance to stamp `tours_resumed_at`. |
| Out-of-band billing fix | Write-off, comp, or manual invoice marking — Stripe will never send a recovery event, so no `tours_resumed_at` will ever land. |
| QA / staging cleanup | A synthetic `past_due` was used to exercise the pause flow and needs to be reset without re-running through Stripe. |

In all three cases, clear-pause is the right tool. For routine "payment recovered" cases, the webhook does it for you.

### Dashboard surface

`/dashboard/settings/billing` now renders `<PauseHistoryTable>` below the billing status card for admins and owners. The table:

- Shows the active pause (if any) with a "Clear pause" button that POSTs to the endpoint above + calls `router.refresh()` on success.
- Lists the last 10 archived `tour_pause_history` entries (newest first), each with paused-at, resumed-at, duration between, cancelled count, and the reason transition.
- Returns "No tour pause history yet." when both `current` and `items` are empty.

Sales / coordinator / viewer roles see only the existing billing status card — the table is gated server-side by `ADMIN_ROLES` membership.

## 7l. Tour notification stats (Phase 8J)

`GET /api/admin/tours/notification-stats` aggregates `outbound_messages` rows scoped to tour communications. Use it to spot delivery problems before customers complain.

### Endpoint contract

| Field | Type | Notes |
|---|---|---|
| auth | `requireAdmin()` | 401 unauthenticated, 403 if not admin/owner anywhere |
| rate-limit key | `admin:tours-notification-stats:{userId}` | shared with other admin-list reads |
| `venue_id?` | uuid | defaults to caller's primary; cross-tenant requires `ADMIN_ROLES` |
| `days?` | int 1–90 | default 30 |

### Example

```bash
curl -s "http://localhost:3000/api/admin/tours/notification-stats?days=30" \
  -H "Cookie: <admin session>" | jq .
```

Response:

```json
{
  "venue_id": "8b7c5a90-…",
  "window_days": 30,
  "items": [
    { "kind": "created",      "provider": "resend",  "status": "delivered", "count": 42 },
    { "kind": "cancelled",    "provider": "resend",  "status": "delivered", "count": 5 },
    { "kind": "reminder_24h", "provider": "resend",  "status": "delivered", "count": 18 },
    { "kind": "reminder_24h", "provider": "resend",  "status": "suppressed","count": 1 },
    { "kind": "reminder_2h",  "provider": "resend",  "status": "queued",    "count": 17 },
    { "kind": null,           "provider": "console", "status": "queued",    "count": 3 }
  ],
  "totals": { "attempted": 86, "sent": 82, "failed": 0, "suppressed": 1 }
}
```

### Status roll-up rules

| `outbound_messages.status` | Counts in `totals.*` |
|---|---|
| `queued`, `delivered` | `sent` |
| `failed`, `bounced`, `complained` | `failed` |
| `suppressed` | `suppressed` |
| (any) | `attempted` always increments |

**`queued`/`sent` means provider handoff, not inbox placement.** Resend transitions `queued → delivered` asynchronously via webhook (Phase 4B+). A `queued` row counted under `sent` here means "Resend accepted the request"; true delivery requires correlating with the Resend webhook trail in `outbound_messages.status = 'delivered'` after the webhook fires.

### `kind: null` rows

The Phase 8G `sendTourNotificationEmail` helper + the Phase 8J reminder cron both tag emails with `metadata.tour_notification_kind`. Older rows (Phase 4B-era tour reminders sent before Phase 8J) have NULL `tour_notification_kind` — these surface in `items` with `kind: null`. The `totals` still counts them correctly; only the per-kind breakdown loses fidelity for those legacy rows.

### PII posture

- Never returns lead emails, message bodies, subjects, or provider_message_id.
- Only the three group-by keys + count per row + the four-bucket totals.
- Sentry-captures DB errors.

## 7m. Tour action links (Phase 8K)

Lead-facing tour emails carry signed action URLs that let the recipient confirm or cancel a tour with one click — no dashboard account required.

### Security model

| Layer | What it does |
|---|---|
| **HMAC-SHA256** | Token payload (`{tour_id, action, exp, nonce}`) signed with `TOUR_ACTION_SECRET`. Tamper attempts fail `verifyTourActionToken` with `invalid_signature` → 400 + Sentry warn. |
| **TTL** | Default 7 days. Expired tokens fail with `expired` → 400. |
| **Action binding** | `/tour/confirm` only accepts tokens with `action='confirm'`; `/tour/cancel` only accepts `action='cancel'`. Mismatch → 400 with the same generic copy as expired (we don't leak which dimension failed). |
| **Per-IP rate limit** | The existing Upstash user-action limiter (30/min) keyed by `tour-action:<ip>`. Hits return a small HTML 429 page. |
| **Status-transition guards** | Confirm requires `status='scheduled'`. Cancel requires `status ∈ {scheduled, confirmed}`. Tours with `scheduled_at <= now` are rejected as `tour_in_past`. |
| **`X-Robots-Tag: noindex, nofollow`** | Set on every response so even if a token URL leaks into a public web archive, search engines won't index it. |
| **Redacted logs** | The full token never appears in any structured log line. `redactTourToken()` emits `<first6>…<first6>` for correlation only. |

### No DB storage — what that means

Phase 8K ships migration-free. We do NOT persist:
- which tokens have been issued
- which tokens have been redeemed
- when a token was last used

Idempotent state machines stand in for true single-use:
- `confirm` clicked twice → first click flips `scheduled→confirmed`; second click hits `already_handled` (no-op, no second email, no 500).
- `cancel` clicked twice → first click flips current status to `cancelled`; second click hits `already_handled`.
- `confirm` after a cancel → refused with `already_handled (currentStatus=cancelled)` — we never reverse a cancel via the link surface.

**Replay window**: an attacker who lifts a valid token from a leaked log can replay it until either (a) the tour transitions out of the eligible-status set, or (b) the 7-day `exp` passes. This is the explicit cost of going migration-free. A future phase will add a `tour_action_events` table for write-once persistence:

```sql
-- future Phase 8L sketch — NOT in this phase
create table public.tour_action_events (
  id uuid primary key default uuid_generate_v4(),
  tour_id uuid not null references public.tours(id) on delete cascade,
  token_nonce text not null,             -- the `nonce` field from the payload
  action text not null check (action in ('confirm', 'cancel')),
  source_ip text,
  user_agent text,
  occurred_at timestamptz not null default now(),
  unique (tour_id, token_nonce)          -- enforces true single-use
);
```

With that table the handler can `INSERT … ON CONFLICT DO NOTHING` to atomically claim the nonce and refuse a replay.

### Recent token actions admin endpoint

`GET /api/admin/tours/recent-token-actions` (Phase 8K). Best-effort operator surface — returns recent tours that landed in `confirmed` or `cancelled` for a venue:

```bash
curl -s "http://localhost:3000/api/admin/tours/recent-token-actions?limit=20" \
  -H "Cookie: <admin session>" | jq .items
```

Response:

```json
{
  "items": [
    { "tour_id": "...", "lead_id": "...", "lead_name": "...",
      "lead_email": "...", "status": "confirmed",
      "updated_at": "2026-05-18T18:00:00.000Z" }
  ]
}
```

**Important caveat**: without `tour_action_events`, this endpoint cannot distinguish between a status flip from the public token link vs the operator dashboard PATCH vs the admin bulk-cancel route vs raw SQL. It surfaces every recent terminal-status update for the venue and trusts the operator to cross-reference with conversation context.

## 7n. Tour action audit + single-use enforcement (Phase 8L)

Phase 8K shipped lead-facing confirm/cancel links with stateless HMAC tokens — replay-able within the 7-day TTL. Phase 8L closes the replay gap with migration 012 (`tour_action_events`) and an audit-fed admin endpoint.

### Migration 012 — `public.tour_action_events`

| Column | Type | Notes |
|---|---|---|
| `id` | uuid | pk, `gen_random_uuid()` |
| `venue_id` | uuid | FK → `venues(id)` ON DELETE CASCADE |
| `tour_id` | uuid | FK → `tours(id)` ON DELETE CASCADE |
| `lead_id` | uuid | FK → `leads(id)` ON DELETE SET NULL (survives lead deletion for forensics) |
| `token_nonce` | text | the random hex from the signed token payload; never returned by any endpoint |
| `action` | text | `'confirm' \| 'cancel'` (CHECK) |
| `source_ip` | text | already CIDR-masked at insert time (192.168.1.42 → 192.168.1.0) |
| `user_agent` | text | capped at 500 chars at insert time |
| `occurred_at` | timestamptz | `default now()` |

Constraints / indexes:
- `unique (tour_id, token_nonce)` — the single-use claim.
- `(venue_id, occurred_at desc)` — operator "recent activity for this venue" feed.
- `(tour_id, occurred_at desc)` — "what's happened to this specific tour?" triage.
- `(action, occurred_at desc)` — monitoring aggregates ("how many confirms in the last day?").

RLS:
- SELECT for `has_venue_role(venue_id, auth.uid(), array['owner','admin'])`.
- No INSERT/UPDATE/DELETE policies for authenticated callers — every write comes from the service-role route handler.

### Single-use enforcement flow

```
verify_token  →  load tour  →  status guards  →  INSERT tour_action_events  →  UPDATE tours  →  notify
                                                  │
                                                  ├── ok        → continue
                                                  ├── unique    → render "Already handled", skip UPDATE + notify
                                                  └── other DB  → Sentry-capture, render error, skip UPDATE
```

The INSERT happens AFTER cryptographic verification, so tampered tokens never produce audit rows. The `unique (tour_id, token_nonce)` constraint is the atomic claim: even two concurrent requests with the same nonce can't both succeed.

Status idempotency from Phase 8K is preserved as defense in depth — if `tour_action_events` is ever wiped (test reset, manual SQL), the existing status guards still prevent double-flips.

### What happens on…

| Scenario | Result |
|---|---|
| First click on a `confirm` token for a scheduled tour | Audit row inserted, tour flips to `confirmed`, notification email fires, page shows "Tour confirmed" |
| Second click on the same `confirm` token | Audit INSERT hits unique violation, page shows "Already handled" with `currentStatus=<value>`, NO second status flip, NO second email |
| `cancel` token clicked after the lead already confirmed | New nonce + different `(tour_id, nonce)` pair → audit row inserted, tour flips to `cancelled`, cancellation email fires |
| Tampered token (one char changed) | Signature verification fails → page shows "Link not valid", NO audit row, Sentry warn captures `invalid_signature` |
| Expired token (past `exp`) | Verification fails with `expired` → page shows "Link not valid", NO audit row, structured log only (not Sentry — expected outcome) |
| Tour deleted between email send and click | Tour lookup returns null → page shows "We couldn't find that tour", NO audit row |
| Tour `scheduled_at` already in the past | Tour-in-past guard fires → page shows "This tour has already passed", NO audit row |

### Admin endpoint — now backed by the audit table

`GET /api/admin/tours/recent-token-actions` (existed since Phase 8K; rewritten in 8L):

```bash
curl -s "http://localhost:3000/api/admin/tours/recent-token-actions?limit=20" \
  -H "Cookie: <admin session>" | jq .items
```

Response:

```json
{
  "items": [
    { "id": "...",
      "venue_id": "...",
      "tour_id": "...",
      "lead_id": "...",
      "lead_name": "Sarah Johnson",
      "lead_email": "sarah@example.com",
      "action": "confirm",
      "source_ip": "192.168.1.0",
      "user_agent": "Mozilla/5.0 …",
      "occurred_at": "2026-05-18T14:21:00.000Z" }
  ]
}
```

`token_nonce` is **never** returned. `source_ip` is **always** the CIDR-masked form — the raw IP is never written to the DB in the first place.

Implementation: two service-role queries (events first, then a batched `IN ()` against `leads` to resolve names/emails). Splitting them avoids PostgREST's foreign-table inference quirks and lets us return events for deleted leads with `lead_name: null`.

### HTML email templates (Phase 8L)

`buildTourNotificationHtml(args)` ships alongside the existing plaintext builder. Both shapes are passed to `sendEmail` so Resend delivers multipart/alternative. Clients that strip HTML fall back to the unchanged plaintext.

Visual identity (per Phase 8L spec):
- Clean white card on `#F4F6FB` slate background
- Brand blue `#1D4ED8` primary "Confirm tour" CTA
- Muted slate text-link "Need to cancel?" secondary
- Table-based layout (Outlook-safe), inline CSS only
- Zero external assets — no images, no web fonts, no tracking pixels
- Max-width 480px for mobile-safe rendering

The `confirmed` + `cancelled` kinds intentionally omit the action buttons (no useful action to offer once the tour is in a terminal state).

### Debug HTML preview

For QA / styling work without burning real tokens:

```
GET /tour/confirm?as=html&kind=success
GET /tour/cancel?as=html&kind=already
                         &kind=invalid
                         &kind=expired
```

Gated to non-production OR `TOUR_ACTION_DEBUG_PREVIEW=1`. The branch reads zero data, mutates nothing, never honors `?token=`. In production with the flag off, the `?as=html` query is silently ignored.

## 7o. Unified tour status-event audit (Phase 8M)

Phase 8L's `tour_action_events` is narrow — it locks down lead-token redemption and that's it. Phase 8M adds `tour_status_events`, a wider audit feed that records every tour status change regardless of who or what triggered it.

### Two tables, two jobs

| Table | Phase | Role |
|---|---|---|
| `public.tour_action_events` | 8L | Single-use claim for lead-token redemption. The `unique (tour_id, token_nonce)` constraint is the atomic replay defeat. NOT a general audit. |
| `public.tour_status_events` | 8M | Unified audit of every tour status change across every write path. Use this when the question is "who/what changed this tour, when?". |

Lead-token actions write to BOTH tables for one release cycle. After downstream dashboards have migrated off the deprecated `/api/admin/tours/recent-token-actions`, a future phase can stop double-writing.

### Migration 013 — `public.tour_status_events`

| Column | Type | Notes |
|---|---|---|
| `id` | uuid | pk |
| `venue_id` | uuid | FK ON DELETE CASCADE |
| `tour_id` | uuid | FK ON DELETE CASCADE |
| `lead_id` | uuid | FK ON DELETE SET NULL |
| `actor_kind` | text | CHECK ∈ {`lead_token`, `operator`, `cron`, `system`} |
| `actor_id` | text | polymorphic: operator → user uuid; cron → function id; lead_token → null; system → free-form |
| `action` | text | free-form verb (`confirm`, `cancel`, `status_change`, `reschedule`, `bulk_cancel`, `auto_pause_cancel`, …) |
| `previous_status` | text | nullable — pre-flip status |
| `new_status` | text | not null |
| `source_ip` | text | already CIDR-masked at write time |
| `user_agent` | text | capped at 500 chars at write time |
| `reason` | text | operator-supplied free-text (e.g. bulk-cancel reason) |
| `metadata` | jsonb | structured context, PII-free by convention |
| `occurred_at` | timestamptz | `default now()` |

Indexes: `(venue_id, occurred_at desc)`, `(tour_id, occurred_at desc)`, `(venue_id, actor_kind, occurred_at desc)`, `(action, occurred_at desc)`.

RLS: enabled. SELECT for `has_venue_role(venue_id, auth.uid(), array['owner','admin'])`. No INSERT/UPDATE/DELETE policies for authenticated callers — every write goes through the service-role `recordTourStatusEvent` helper.

### Write paths covered

| Path | `actor_kind` | `actor_id` | `action` |
|---|---|---|---|
| `GET /tour/confirm?token=…` | `lead_token` | null | `confirm` |
| `GET /tour/cancel?token=…` | `lead_token` | null | `cancel` |
| `PATCH /api/tours/[id]` flip to confirmed | `operator` | `user.id` | `confirm` |
| `PATCH /api/tours/[id]` flip to cancelled | `operator` | `user.id` | `cancel` |
| `PATCH /api/tours/[id]` other status change | `operator` | `user.id` | `status_change` |
| `PATCH /api/tours/[id]` reschedule only (no status change) | `operator` | `user.id` | `reschedule` |
| `POST /api/admin/tours/bulk-cancel` per affected tour | `operator` | `user.id` | `bulk_cancel` |
| `billing-tour-auto-pause` cron per cancelled tour | `cron` | `'billing-tour-auto-pause'` | `auto_pause_cancel` |

Every write is best-effort. Audit failures NEVER fail the primary action — the status change already landed, the audit is just observability.

### Admin endpoint

`GET /api/admin/tours/status-events`

```bash
# all recent activity for the caller's venue
curl -s "http://localhost:3000/api/admin/tours/status-events?limit=50" \
  -H "Cookie: <admin session>" | jq .items

# everything that happened to one tour
curl -s "…/api/admin/tours/status-events?tour_id=<uuid>" -H "Cookie: …" | jq .items

# one lead's audit slice
curl -s "…/api/admin/tours/status-events?lead_id=<uuid>" -H "Cookie: …" | jq .items

# only operator-driven changes (no lead tokens, no cron)
curl -s "…/api/admin/tours/status-events?actor_kind=operator" -H "Cookie: …" | jq .items

# all bulk cancels in the last N rows
curl -s "…/api/admin/tours/status-events?action=bulk_cancel&limit=200" -H "Cookie: …" | jq .items

# all cron auto-pause cancellations
curl -s "…/api/admin/tours/status-events?actor_kind=cron&action=auto_pause_cancel" -H "Cookie: …" | jq .items
```

Filters (all optional, all combinable): `venue_id`, `tour_id`, `lead_id`, `actor_kind` (`lead_token|operator|cron|system|all`), `action`, `limit` (1..200, default 50).

PII posture:
- Does NOT join leads. `lead_name`/`lead_email` are not returned. Pivot via `lead_id` → `/dashboard/inbox/<lead_id>`.
- `source_ip` always returned in the CIDR-masked form (raw IPs never reach the DB).
- `token_nonce` is exclusive to `tour_action_events`; not present in this table.
- `metadata` spread as-is; write paths keep PII out by convention.

### Deprecation: `/api/admin/tours/recent-token-actions`

The Phase 8K/8L narrow endpoint stays mounted for one release cycle. Every response now carries:

```http
Deprecation: true
Link: </api/admin/tours/status-events?actor_kind=lead_token>; rel="successor-version"
```

External dashboards should switch to the unified endpoint. The deprecated route continues to work — it reads from `tour_action_events`, the unified endpoint reads from `tour_status_events`.

### Common diagnostic queries

```sql
-- complete history for one tour (every transition, every path)
select occurred_at, actor_kind, actor_id, action, previous_status, new_status, reason
from public.tour_status_events
where tour_id = '<uuid>'
order by occurred_at asc;

-- one lead's tour activity over the last 30 days
select occurred_at, actor_kind, action, new_status, tour_id
from public.tour_status_events
where lead_id = '<uuid>' and occurred_at > now() - interval '30 days'
order by occurred_at desc;

-- bulk cancels in the last 24h (operator triage)
select occurred_at, actor_id, venue_id, tour_id, reason
from public.tour_status_events
where action = 'bulk_cancel' and occurred_at > now() - interval '24 hours'
order by occurred_at desc;

-- all lead-token confirms/cancels in the last week, by venue
select venue_id, action, count(*) as n
from public.tour_status_events
where actor_kind = 'lead_token' and occurred_at > now() - interval '7 days'
group by 1, 2 order by 1, 2;

-- all cron auto-pause cancellations
select occurred_at, venue_id, tour_id, metadata->>'subscription_id' as sub
from public.tour_status_events
where actor_kind = 'cron' and action = 'auto_pause_cancel'
order by occurred_at desc;
```

## 7p. Tour status audit UI surfaces (Phase 8N)

Phase 8M shipped the unified audit feed; operators still had to curl `/api/admin/tours/status-events` or write SQL to see it. Phase 8N adds three in-product surfaces over the same data.

### Surfaces

| Surface | Where | Depth | How it reads |
|---|---|---|---|
| Inbox recent activity panel | `/dashboard/inbox/[leadId]` (in `TourLifecycleStrip`) | last 5 events for the lead's relevant tour | client `fetch` to `/api/admin/tours/status-events?tour_id=…&limit=5` |
| Per-tour audit drawer | `/dashboard/tours` Upcoming list (Audit button) + the inbox "View full audit" button | last 50 events for one tour, expandable metadata, Copy event id | client `fetch` to `/api/admin/tours/status-events?tour_id=…&limit=50` |
| Billing settings activity feed | `/dashboard/settings/billing` (below pause history) | last 25 venue-wide events as a compact table | server-side service-role read of `tour_status_events` |

The drawer + inbox panel hit the same admin endpoint (cookie auth), so the existing `requireAdmin()` gate is the access boundary. Non-admins get 401/403 and the UI hides silently — no error surface, no leaked existence. The billing feed reuses the service-role read directly because the page is already RLS-gated by the operator-side `venue.role ∈ ADMIN_ROLES` check.

### Two-vs-three table primer

Operators sometimes ask which audit table to query for what. Quick mental model:

| Question | Table | Why |
|---|---|---|
| "Did this token already redeem?" (replay defense) | `tour_action_events` | Owns `unique (tour_id, token_nonce)` — Phase 8L |
| "Who changed this tour, when, from what to what?" | `tour_status_events` | Unified feed across all write paths — Phase 8M |
| "What does the operator see in the Audit drawer?" | `tour_status_events` | The drawer reads only from the unified feed |

The lead-token write path still inserts into BOTH tables for one release cycle.

### Backfill (`seed-tour-status-events`)

Optional one-shot Inngest job that writes synthetic baseline rows for legacy tours (anything updated in the last 90 days that has no `tour_status_events` row yet). Triggered manually only:

```ts
// Inngest dashboard → send event:
{ name: 'admin/tour-status-events.backfill' }
```

Requires `TOUR_STATUS_BACKFILL=1` in the runtime environment. Without the flag the job short-circuits with `{ skipped: true, reason: 'disabled' }`. No cron schedule.

Idempotent — re-runs skip any tour that already has at least one audit row. Capped at 500 tours per invocation. Synthetic rows are easy to spot in audit queries:

```sql
select count(*) as synthetic_rows
from public.tour_status_events
where actor_kind = 'system' and actor_id = 'backfill-8N';
```

## 7q. Tour status filters + CSV export + realtime (Phase 8O)

Phase 8N surfaced the unified audit feed inside the product. Phase 8O makes it operationally useful: filter in the UI, export for compliance, and stay live without manual refresh.

### Billing-page filter chips

`/dashboard/settings/billing` → "Tour status activity" card now exposes two selects:

| Filter | Options |
|---|---|
| Actor | `All actors`, `Lead`, `Operator`, `Cron`, `System` |
| Action | `All actions`, `Confirmed`, `Cancelled`, `Rescheduled`, `Status changed`, `Bulk cancelled`, `Auto-paused`, `Legacy snapshot` |

Filtering happens client-side against the already-loaded 25-row slice — no extra DB hit. For a deeper window or a different filter combination, pivot to the admin CSV export below.

Distinct empty states:
- No rows in the slice at all → "No tour status events recorded yet."
- Rows exist but none match the active filters → "No events match the active filters." + a Reset filters link.

### CSV export

`GET /api/admin/tours/status-events?format=csv` returns the same filtered rows as the JSON variant, serialized as a downloadable `.csv`.

```bash
curl -i "$APP/api/admin/tours/status-events?format=csv&actor_kind=operator&action=cancel&limit=200" \
  -b "sb-...-auth-token=..."
```

Response headers:

```
HTTP/1.1 200 OK
Content-Type: text/csv; charset=utf-8
Content-Disposition: attachment; filename="tour-status-events-2026-05-18.csv"
Cache-Control: no-store
X-Request-Id: <uuid>
```

Columns (in order): `id, venue_id, tour_id, lead_id, actor_kind, actor_id, action, previous_status, new_status, source_ip, user_agent, reason, occurred_at, metadata_json`.

Escaping rules:
- Fields containing comma, quote, CR, or LF are wrapped in double quotes.
- Internal quotes are doubled (`"` → `""`).
- `metadata_json` is the compact JSON of the row's `metadata` jsonb column — operators get the full structured context without losing fidelity vs the JSON endpoint.
- File starts with a UTF-8 BOM so Excel opens it correctly.

Auth / tenant / rate-limit / Sentry posture is **identical** to the JSON path. All other query params (`venue_id`, `tour_id`, `lead_id`, `actor_kind`, `action`, `limit`) work the same way.

### CSV privacy posture

- `token_nonce` from `tour_action_events` is **never** included. CSV exposes only `tour_status_events` columns.
- `source_ip` is already CIDR-masked at write time (Phase 8L `maskIp`). The DB never holds raw IPs.
- `lead_id` is included (it's already in the JSON endpoint), but no lead email/name join.
- `user_agent` is capped at 500 chars at write time.

### Realtime audit stream

`RealtimeTourStatusLayer` subscribes to Supabase Realtime:

| Setting | Value |
|---|---|
| Channel | `tour-status-events:venue:${venueId}` |
| Event | `postgres_changes` filtered to `INSERT` |
| Schema/table | `public.tour_status_events` |
| Filter | `venue_id=eq.${venueId}` |
| On insert | Toast `"Tour activity recorded"` + `router.refresh()` |

Mounted on `/dashboard/tours` and `/dashboard/settings/billing` (admin/owner only on billing). The layer is non-rendering except for the toast.

**Prereq**: `tour_status_events` must be in the `supabase_realtime` publication. Applied via ops command in Phase 8O (no migration file):

```sql
alter publication supabase_realtime add table public.tour_status_events;
```

If the table is ever removed from the publication, the channel subscribes successfully but receives no events. The RUNBOOK §7 includes the idempotent re-apply recipe.

### Known limitation: CSV export is capped by `limit`

The CSV path honors the same `limit` query param as the JSON path (max 200, default 50). For compliance or insurance requests that need a wider window, the operator either:
1. Submits multiple paginated requests, OR
2. Queries the DB directly via SQL/Supabase.

A future phase could add streaming export with cursor-based pagination — out of scope for 8O.

## 7r. URL-synced filters + cursor pagination + debounced realtime (Phase 8P)

Phase 8O made the audit data interactive. Phase 8P tightens the operator workflow with four ergonomic improvements.

### URL-synced billing-page filters

`/dashboard/settings/billing` activity feed filters now read and write to URL query params:

| Param | Values |
|---|---|
| `?actor` | `lead_token`, `operator`, `cron`, `system` (absent = all) |
| `?action` | `confirm`, `cancel`, `reschedule`, `status_change`, `bulk_cancel`, `auto_pause_cancel`, `legacy_status_snapshot` (absent = all) |

Behavior:
- Changing a select uses `router.replace`, not full navigation — no browser history pollution.
- Copying the URL and opening in a new tab restores the same filters.
- Invalid values (typos, stale links, malicious input) silently coerce to `all`.
- **Reset filters** removes both params from the URL.
- Filtering still runs client-side over the loaded 25-row slice; URL-syncing is purely state preservation.

### Cursor pagination on `GET /api/admin/tours/status-events`

New optional query param:

```
?occurred_before=<ISO-8601 timestamp>
```

Returns rows with `occurred_at < occurred_before`, still ordered `occurred_at desc`. Works in both JSON and CSV branches.

**JSON response shape** (existing `items` array unchanged, two new fields added):

```json
{
  "items": [...],
  "next_cursor": "2026-05-18T12:34:56.000Z",
  "has_more": true
}
```

- `next_cursor` = `occurred_at` of the last returned row when `items.length === limit`.
- `has_more` = `items.length === limit`.
- If fewer rows than `limit` come back, `next_cursor: null` + `has_more: false`.

**CSV response** keeps the same body + Content-Disposition, plus two new headers:

```
X-Has-More: true | false
X-Next-Cursor: 2026-05-18T12:34:56.000Z   (only when has_more === true)
```

Example chain (CSV):

```bash
# page 1
curl -i "$APP/api/admin/tours/status-events?format=csv&limit=200" \
  -b "$COOKIE" \
  -D headers1.txt -o page1.csv

# read X-Next-Cursor from headers1.txt → 2026-05-18T12:00:00.000Z
curl -i "$APP/api/admin/tours/status-events?format=csv&limit=200&occurred_before=2026-05-18T12:00:00.000Z" \
  -b "$COOKIE" \
  -D headers2.txt -o page2.csv
```

The strict `<` comparison guarantees chained pages never duplicate rows. A venue whose row count is exactly a multiple of `limit` will return `has_more: true` on the final full page; the next page comes back empty as the stop signal.

### Realtime refresh debounce

`RealtimeTourStatusLayer` now debounces `router.refresh()` calls:

- Each INSERT still fires an immediate "Tour activity recorded" toast (so operators see bulk volume).
- `router.refresh()` calls are coalesced via a **1000ms trailing debounce** — every new event resets the timer; only the last one survives the window.
- A burst of 20 events typically produces 20 toasts but only 1–3 refreshes.
- Pending timeout is cleared on unmount so a fast page transition doesn't trigger a stray refresh.
- Channel/filter/event/table strings are unchanged from Phase 8O.

### Audit drawer deep linking on `/dashboard/tours`

Clicking the **Audit** button on a tour row now writes:

```
/dashboard/tours?audit_tour=<tour_uuid>
```

Behavior:
- Initial render reads `?audit_tour` and auto-opens the drawer if shape-valid.
- Closing the drawer strips `?audit_tour` from the URL but preserves every other param (notably `?month=YYYY-MM` from the Phase 8E MonthNavClient).
- Invalid shapes (non-UUID-like strings) are ignored client-side; the drawer stays closed and the param remains for the operator to fix.
- Back/Forward across `audit_tour` changes is honored: a sibling component that updates the URL flips the drawer state.

Example deep link:

```
https://app.venuerise.com/dashboard/tours?month=2026-06&audit_tour=8b7c5a90-...
```

## 7s. Filter persistence + audit search + streamed CSV (Phase 8Q)

Phase 8P syncs filter state to the URL. Phase 8Q adds three operator-depth features without changing schema or auth posture.

### Per-user filter persistence

The billing-page activity feed now persists filter selections to `localStorage` under the key:

```
venuerise:tour-status-feed:filters:v1
```

Priority order on every page load:

1. **URL params** (`?actor`, `?action`, `?q`) when present and valid — always win.
2. **localStorage** values from a previous session — used only if URL is empty.
3. **Defaults** (`all` / empty search) when neither source has values.

When the operator changes a filter or search, both surfaces update in lockstep: the URL via `router.replace` (no history pollution) AND the storage slot. Reset filters wipes both.

Edge cases:
- Invalid JSON in storage (manual tampering, schema drift) is silently ignored. The next valid change overwrites the slot.
- Default values (`all` / empty) are NOT persisted — storage gets removed instead. A cleared state round-trips cleanly to "no defaults" on next load.
- The bootstrap runs once on mount; opening a deep-linked tab with URL params still wins, and clearing storage in another tab takes effect on the next visit.

### `?q=` search

Add a free-text filter to `GET /api/admin/tours/status-events`:

```
?q=<string>
```

Validation:
- Optional. Empty after trim → treated as absent.
- Max 120 chars (Zod rejects longer with 400 `validation_failed`).
- Trimmed at the route boundary.

Server-side search runs a PostgREST `.or(...)` clause over scalar columns:

| Column |
|---|
| `reason` |
| `actor_id` |
| `action` |
| `previous_status` |
| `new_status` |

All matches are case-insensitive substring (`ilike` with `%term%`). Backslashes and double-quotes are escaped before being embedded in the `.or()` expression.

**Known limitation: `metadata::text` is NOT searched server-side.** PostgREST's chainable `.or()` doesn't cleanly express a jsonb-cast `ilike`, and a Postgres function would require a migration (forbidden in 8Q). The billing-page client search compensates by also matching the stringified metadata over the loaded slice, so operators searching for e.g. `stripe_event` or `past_due_7_days` still find rows in the UI. A future migration can add a generated text column + a single `or()` arm.

Combines with every other filter (`venue_id`, `tour_id`, `lead_id`, `actor_kind`, `action`), every output format (`json` and `csv`), and cursor pagination (`occurred_before`).

### Streamed CSV export

```
?format=csv&stream=1
```

Only meaningful when `format=csv` (the route silently treats `?stream=1` without `format=csv` as a regular JSON request — no error). Internally pages through results using the existing `occurred_at` cursor; emits one continuous CSV body via a `ReadableStream` so the entire export never materializes in memory.

Bounds:
- Page size = `?limit` if provided, otherwise 200.
- Hard cap = **5000 rows** per request (constant `STREAM_HARD_CAP`). Pages stop when the cap is hit OR a page returns fewer rows than its requested limit.
- `?occurred_before=<ISO>` is honored as the STARTING cursor (resume mid-stream).

Response headers:

```
Content-Type: text/csv; charset=utf-8
Content-Disposition: attachment; filename="tour-status-events-stream-YYYY-MM-DD.csv"
Cache-Control: no-store
X-Streamed: true
X-Row-Limit: 5000
```

Body shape:
- UTF-8 BOM at start (Excel compatibility).
- CSV header row emitted ONCE.
- Per-page chunks appended with the same column ordering as the Phase 8O CSV path.
- Each data row terminated by `\n`. No duplicate header rows.

Failure mode:
- Per-page DB error → a trailing comment line `# stream aborted: <message>\n` is emitted, the stream is closed, and the error is Sentry-captured. The downloaded file's row count will be short; the trailing comment is the truth signal.

Auth / tenant / rate-limit / Sentry posture is identical to the non-streamed paths.

Example:

```bash
curl -L "$APP/api/admin/tours/status-events?format=csv&stream=1&limit=200&q=cancel&actor_kind=operator" \
  -b "sb-...-auth-token=..." \
  -o tour-status-events.csv
```

This single command replaces the multi-page Phase 8P shell loop for any export ≤ 5000 rows.

## 7t. Metadata-aware audit search (Phase 8R)

Phase 8Q's `?q=` search was scalar-only — `metadata::text` couldn't be reached through PostgREST's chainable `.or()`. Phase 8R adds migration 014 with a SECURITY DEFINER RPC that closes the gap.

### RPC contract

```
public.search_tour_status_events(
  p_venue_id        uuid              REQUIRED
  p_tour_id         uuid    DEFAULT null
  p_lead_id         uuid    DEFAULT null
  p_actor_kind      text    DEFAULT null
  p_action          text    DEFAULT null
  p_q               text    DEFAULT null
  p_occurred_before timestamptz DEFAULT null
  p_limit           integer DEFAULT 50    (clamped 1..200 inside SQL)
) RETURNS TABLE (… every column of tour_status_events)
```

Search semantics:
- `p_q` is trimmed; empty after trim → no search filter.
- Otherwise the predicate matches case-insensitive substring (`ILIKE '%term%'`) against:
  - `actor_id`
  - `action`
  - `previous_status`
  - `new_status`
  - `reason`
  - `source_ip`
  - `user_agent`
  - `metadata::text` ← the gap Phase 8Q couldn't close
- Other filters apply with AND semantics. `p_venue_id` is always required (the RPC body explicitly applies it as defense-in-depth even though the route already tenant-binds).

### Security posture

- `SECURITY DEFINER` — runs with the function owner's privileges.
- `set search_path = public` — pinned at function definition time, no path-injection.
- `REVOKE ALL FROM PUBLIC` + `GRANT EXECUTE TO service_role` only. `authenticated` and `anon` never get execute, so a leaked anon key can't enumerate the audit log.
- The route's `requireAdmin()` + cross-venue `requireVenueRole(ADMIN_ROLES)` remain the primary access boundary. The RPC's `p_venue_id` filter is defense-in-depth.
- `p_q` is passed as a parameterized bind — Postgres handles escaping. The `%` wildcards are appended inside the SQL expression, not concatenated into a query string.

### Route integration

`GET /api/admin/tours/status-events` now branches:

| `?q=` present | Path | Searches metadata |
|---|---|---|
| No | PostgREST chain (Phase 8O/8P/8Q) | No |
| Yes | `search_tour_status_events` RPC (Phase 8R) | **Yes** |

Both branches honor the same filters, return the same JSON/CSV/stream shapes, and use the same cursor-pagination semantics. The completion log gets a new `filters.q_mode: 'rpc_metadata' | 'standard'` field so operators can audit which path served a request.

### Example

```bash
# returns rows where metadata jsonb mentions 'past_due_7_days'
curl -s "$APP/api/admin/tours/status-events?q=past_due_7_days" \
  -b "$COOKIE" | jq '.items[] | {action, metadata}'

# combine with all other filters
curl -s "$APP/api/admin/tours/status-events?actor_kind=cron&q=past_due_7_days&limit=200" \
  -b "$COOKIE" | jq .items

# streamed CSV with metadata search
curl -L "$APP/api/admin/tours/status-events?format=csv&stream=1&q=stripe_event" \
  -b "$COOKIE" -o stripe-events.csv
```

### Direct SQL access

For ops queries that bypass the HTTP route:

```sql
select id, action, previous_status, new_status, metadata
from public.search_tour_status_events(
  p_venue_id   := '<venue uuid>',
  p_q          := 'past_due_7_days',
  p_actor_kind := 'cron',
  p_limit      := 100
)
order by occurred_at desc;
```

Only callable from the `service_role` role.

## 7u. Daily operator activity digest (Phase 8R)

Optional Inngest cron that emails venue owners a 24-hour summary of `tour_status_events` activity.

| Field | Value |
|---|---|
| Function id | `operator-activity-digest` |
| Schedule | `0 8 * * *` (daily 8am UTC) |
| Hard gate | `OPERATOR_DIGEST_ENABLED === '1'` (absent / any other value → skips with `{ skipped: true, reason: 'disabled' }`) |
| Lookback | 24 hours |
| Venue cap | 200 per run |
| Email subject | `VenueRise daily activity summary` |

### Summary shape

For each venue with ≥ 1 event in the lookback window, the body includes:
- Venue name (resolved from `public.venues`) or short id fallback.
- Total events count.
- Counts by `action` (sorted by count desc).
- Counts by `actor_kind` (sorted by count desc).
- Link to `${NEXT_PUBLIC_APP_URL}/dashboard/settings/billing`.

### Idempotency posture

Before sending to a venue, the cron probes `outbound_messages` for an existing row this UTC date with:
- `venue_id = <target>`
- `related_table = 'tour_status_events'`
- `metadata->>'tour_digest_date' = <today utc>`

If found, skip (idempotent on re-trigger within the same UTC day).

**Known limitation**: this is a best-effort de-dup, not a strong guarantee. Two crons firing within the same minute could both probe, both find no row, and both send. Real deployments run a single Inngest worker per function, so the exposure is narrow. A future migration could add a dedicated `digest_sends` table for absolute single-send.

### Failure posture

- One venue failure NEVER aborts the batch.
- Owner lookup failures → skip with `skip_no_owner_email`.
- Suppression → skip; next-day's run retries.
- Console-fallback → skip (digest not marked sent; retried next day once Resend is configured).
- Provider errors → Sentry-captured + `failed` counter incremented.
- Returns `{ scannedVenues, sent, skipped, failed }` for the Inngest run summary.

### Run it manually

For staging / debugging, trigger the Inngest function from the dashboard. Or in a Node REPL with service-role creds:

```ts
import { runDigestScan } from '@/lib/jobs/functions/operator-activity-digest'
const summary = await runDigestScan()
console.log(summary)
// → { skipped: true, reason: 'disabled' }   if OPERATOR_DIGEST_ENABLED !== '1'
// → { scannedVenues, sent, skipped, failed } otherwise
```

## 7v. Indexed metadata audit search (Phase 8S)

Phase 8R closed the metadata-search gap with a SECURITY DEFINER RPC, but the underlying predicate (`metadata::text ILIKE '%term%'`) was unindexed — fine at < ~1k rows, linear-slower past that. Phase 8S adds migration 015 with a generated column + a trigram GIN index so operator search stays fast as the audit log grows.

### Migration 015 — what it adds

1. `create extension if not exists pg_trgm` — idempotent; Supabase usually ships pg_trgm pre-loaded.
2. `metadata_text text generated always as (coalesce(metadata::text, '')) stored` — a materialized mirror of `metadata::text` on `tour_status_events`. Operator-search-only; nothing else in the app reads this column.
3. `create index ... using gin (metadata_text gin_trgm_ops)` — the index that turns `ILIKE '%term%'` into an indexed lookup.
4. `create or replace function search_tour_status_events(...)` — same signature, same return shape, same SECURITY DEFINER posture, same `GRANT EXECUTE TO service_role`. Only the predicate body changes: `metadata::text ILIKE …` becomes `metadata_text ILIKE …`.

### Verification

```sql
-- column present?
select column_name, data_type, generation_expression
from information_schema.columns
where table_schema='public' and table_name='tour_status_events'
  and column_name='metadata_text';

-- index present?
select indexname, indexdef from pg_indexes
where schemaname='public' and tablename='tour_status_events'
  and indexname='tour_status_events_metadata_text_trgm_idx';

-- RPC still SECURITY DEFINER?
select proname, prosecdef from pg_proc
where proname='search_tour_status_events';
```

### Expected performance improvement

For a typical metadata search (`?q=past_due_7_days` over a few hundred thousand `tour_status_events` rows), the trigram GIN index drops the predicate from a sequential ILIKE scan to a bitmap index scan + recheck. On synthetic data the planner typically:

- Without index: `Seq Scan` over `tour_status_events`, filtering on the cast.
- With index: `Bitmap Index Scan tour_status_events_metadata_text_trgm_idx` → `Bitmap Heap Scan tour_status_events`.

For very short search terms (1-2 chars) the planner may still prefer a seq scan — trigram indexes need at least 3 characters of selectivity to win. Operators searching for `id` or `ok` may not see speedup; documented as expected behavior.

### Write amplification

Every INSERT/UPDATE on `tour_status_events` now also writes a `metadata_text` value + a GIN index entry. The audit table is append-only and venue volumes are small (handful of rows per venue per day at the high end), so the overhead is negligible. The Phase 8M write paths (`recordTourStatusEvent`) are unaffected — they don't reference the new column.

### Security posture — unchanged

The RPC is still:
- `SECURITY DEFINER` with pinned `search_path = public`
- `REVOKE ALL FROM PUBLIC` + `GRANT EXECUTE TO service_role` only
- Called by the HTTP route ONLY after `requireAdmin()` + cross-venue `requireVenueRole(ADMIN_ROLES)` pass
- `p_venue_id` applied as a hard WHERE clause inside the function body (defense in depth)

The route contract is unchanged. Callers already using `?q=` get the speedup automatically.

## 7w. Operator digest HTML + unsubscribe (Phase 8S)

### HTML email body

The Phase 8R operator-activity-digest cron now ships an Outlook-safe HTML body alongside the plaintext fallback. Visual identity matches the Phase 8L tour notification emails:

- White rounded card on a slate (`#F4F6FB`) background
- Brand-blue total-event chip
- Stacked detail tables (one per "by action" / "by actor")
- Inline CSS only, no images, no web fonts, no tracking pixels
- Max-width 480px for mobile
- `<table>` layout (Outlook-safe)

Plaintext stays as the canonical fallback for clients that strip HTML. The cron passes both `text` + `html` to `sendEmail` so Resend delivers multipart/alternative.

### Unsubscribe token model

```ts
// Token payload
{
  venue_id: string,  // UUID
  exp:      number,  // Unix ms — 30 day TTL
  nonce:    string   // 32 hex chars (16 random bytes)
}

// Wire format
<base64url(JSON payload)>.<base64url(HMAC-SHA256)>

// URL
${NEXT_PUBLIC_APP_URL}/api/digest/unsubscribe?venue_id=<uuid>&token=<signed>
```

- HMAC secret: `DIGEST_UNSUBSCRIBE_SECRET` (≥16 chars enforced).
- Short/missing secret → digest emails ship without the link, single warn per process.
- URL `venue_id` MUST match the signed payload `venue_id` — defends against an attacker swapping the param to unsubscribe a different venue using a leaked token.
- Tamper attempts (`invalid_signature`) → 400 page + Sentry capture.
- Per-IP rate limit on the public route (reuses the Upstash user-action limiter keyed `digest-unsubscribe:<ip>`).
- `X-Robots-Tag: noindex, nofollow` on every response.
- Full token never appears in logs — `redactDigestUnsubscribeToken` emits `<head6>…<tail6>` for correlation.

### `subscriptions.metadata.digest_disabled` flag

The unsubscribe route looks up the most-recent subscription for the venue (same priority order as Phase 7D/8I) and merges:

```jsonc
{
  // ...preserved existing keys...
  "digest_disabled": true,
  "digest_disabled_at": "2026-05-18T18:00:00.000Z"
}
```

The digest cron's per-venue loop reads the same row before sending; if `digest_disabled === true`, it skips with `operator_digest.skipped_disabled` and never invokes `sendEmail`.

### Re-enable a venue's digest

There's no in-app "resubscribe" UI in Phase 8S (deferred). To re-enable manually via SQL:

```sql
update public.subscriptions
set metadata = (metadata - 'digest_disabled' - 'digest_disabled_at')
where id = '<subscription_id>';
```

The next morning's cron run will include the venue again.

## 7x. Operator digest cadence + reactivation (Phase 8T)

Phase 8S shipped binary opt-out via `subscriptions.metadata.digest_disabled`. Phase 8T promotes it to a three-value cadence model with an admin UI + read/write endpoints, while keeping the legacy flag fully working.

### Cadence values

```ts
type DigestCadence = 'daily' | 'weekly' | 'off'
```

| Value | Send schedule |
|---|---|
| `daily`  | Cron sends every morning (8am UTC). |
| `weekly` | Cron sends only on Monday UTC (`Date.getUTCDay() === 1`). |
| `off`   | Cron skips entirely. |

### Backward compatibility rules

| Metadata state | Effective cadence |
|---|---|
| `digest_disabled === true` (regardless of `digest_cadence`) | `off` |
| `digest_cadence` is a valid enum value | that value |
| Missing cadence + no `digest_disabled` | `daily` (default) |

Setting cadence to `off` ALSO writes `digest_disabled = true` + `digest_disabled_at`. Setting cadence to `daily`/`weekly` REMOVES both legacy keys. The Phase 8S unsubscribe route now writes BOTH `digest_disabled = true` AND `digest_cadence = 'off'` so the two signals are always coherent.

### Endpoints

**`GET /api/admin/digest/preferences[?venue_id=<uuid>]`**

Returns the current cadence + legacy flag state:

```json
{
  "venue_id": "<uuid>",
  "subscription_id": "<uuid|null>",
  "cadence": "daily|weekly|off",
  "digest_disabled": true | false,
  "digest_disabled_at": "<iso|null>"
}
```

When no subscription exists yet (rare — would be pre-onboarding), returns `cadence: "daily"`, `subscription_id: null`, `digest_disabled: false`.

**`POST /api/admin/digest/preferences`**

```json
{
  "venue_id": "<uuid optional>",
  "cadence": "daily|weekly|off"
}
```

Updates the latest subscription row for the target venue. Returns:

```json
{
  "success": true,
  "venue_id": "<uuid>",
  "subscription_id": "<uuid>",
  "cadence": "daily|weekly|off"
}
```

Failure modes (all `400`/`404`/`500`):
- `validation_failed` — body shape / enum mismatch.
- `subscription_not_found` — no subscription row exists for the venue (404).
- `unexpected_error` — DB read/write failure (500, Sentry-captured).

Both methods enforce `requireAdmin()` + optional cross-tenant `requireVenueRole(ADMIN_ROLES)`. Rate-limited per caller (GET: `admin:digest-preferences:{userId}`, POST: `admin:digest-preferences-update:{userId}`). `X-Request-Id` set on every response.

### Metadata before / after examples

**Before** (legacy Phase 8S unsubscribe):

```jsonc
{
  "stripe_subscription_id": "sub_…",
  "digest_disabled": true,
  "digest_disabled_at": "2026-05-18T18:00:00.000Z"
}
```

**After POST `{ cadence: 'weekly' }`**:

```jsonc
{
  "stripe_subscription_id": "sub_…",
  "digest_cadence": "weekly"
  // digest_disabled + digest_disabled_at REMOVED
}
```

**After POST `{ cadence: 'off' }`**:

```jsonc
{
  "stripe_subscription_id": "sub_…",
  "digest_cadence": "off",
  "digest_disabled": true,
  "digest_disabled_at": "2026-05-19T08:00:00.000Z"
}
```

### Digest cron behavior (updated)

Per-venue skip paths in priority order:
1. `cadence === 'off'` → log `operator_digest.skipped_disabled`, increment `skipped`.
2. `cadence === 'weekly'` AND `now.getUTCDay() !== 1` → log `operator_digest.skipped_cadence`, increment `skipped`.
3. Existing idempotency probe via `outbound_messages` (already-sent-today).
4. Existing owner-email lookup / suppression / console-fallback paths.

Neither cadence-skip path is Sentry-captured — they're expected operator preferences.

Email body now includes a one-line cadence footer:
- `daily` → "You are receiving daily activity summaries."
- `weekly` → "You are receiving weekly activity summaries."

### Re-enable a venue from SQL (still supported)

```sql
update public.subscriptions
set metadata = (metadata - 'digest_disabled' - 'digest_disabled_at')
            || jsonb_build_object('digest_cadence', 'daily')
where id = '<subscription_id>';
```

The admin POST endpoint does the same operation atomically; SQL is the operator-of-last-resort path.

## 7y. Short audit search optimization (Phase 8T)

Trigram indexes (Phase 8S `tour_status_events_metadata_text_trgm_idx`) need ≥ 3 character selectivity to win over a Seq Scan. For 1–2 char `?q=` values the planner would still execute a bitmap probe that returns most of the table — pure overhead.

Phase 8T short-circuits this:

| `q` length | Path | Searches metadata | Log `qMode` |
|---|---|---|---|
| absent | PostgREST chain, no `q` filter | n/a | `none` |
| 1 or 2 chars | PostgREST chain + scalar `.or()` over `actor_id` / `action` / `previous_status` / `new_status` / `reason` / `source_ip` / `user_agent` | **no** | `scalar_short` |
| ≥ 3 chars | `search_tour_status_events` RPC (Phase 8R/8S, indexed via the trigram GIN) | **yes** | `metadata_rpc` |

Examples:

```bash
# Short query — scalar columns only, no metadata search, no RPC call
GET /api/admin/tours/status-events?q=AI
GET /api/admin/tours/status-events?q=ab

# Long query — full search including metadata::text via the RPC
GET /api/admin/tours/status-events?q=past_due_7_days
GET /api/admin/tours/status-events?q=stripe_event
```

JSON, CSV, and streamed CSV all honor the same short-circuit. Cursor pagination + every other filter combine normally.

The completion log line `admin.tours_status_events.completed` carries `filters.q_mode` so operators can grep for path attribution:

```bash
# any short-query that DID get a metadata match would be a bug
grep 'admin.tours_status_events.completed' <log source> | grep 'scalar_short'
```

## 7z. Per-user digest preferences (Phase 8U)

Phase 8T shipped venue-level digest cadence on `subscriptions.metadata`. Phase 8U promotes it to per-user preferences on `venue_members.metadata` so each admin/owner controls their own digest independently.

### Effective-preference priority

For each (venue, member) pair the cron resolves cadence by walking the chain in order:

1. **Member preference** — `venue_members.metadata.digest_cadence` (per-user, set via the billing-page card).
2. **Venue fallback** — `subscriptions.metadata.digest_cadence` (set via the Phase 8T admin POST or SQL).
3. **Legacy disabled flag** — `subscriptions.metadata.digest_disabled === true` → effective `'off'`.
4. **Default** — `'daily'`.

Weekly day-of-week (when cadence resolves to `'weekly'`) follows the same source chain: member-level `digest_weekly_day` if present, else subscription-level, else `'mon'`.

### Metadata examples

**Member opted into Wednesday weekly:**
```jsonc
// venue_members.metadata
{ "digest_cadence": "weekly", "digest_weekly_day": "wed" }
```

**Member opted fully out (even if venue fallback says daily):**
```jsonc
// venue_members.metadata
{ "digest_cadence": "off", "digest_disabled_at": "2026-05-19T08:00:00.000Z" }
```

**Member explicitly opted IN (overrides legacy venue-level disabled flag):**
```jsonc
// venue_members.metadata
{ "digest_cadence": "daily" }

// subscriptions.metadata
{ "digest_disabled": true, "digest_disabled_at": "2026-05-01T..." }
```
→ Member receives daily digests; the legacy venue flag is bypassed because the member set their own preference.

### Endpoints — `/api/admin/digest/preferences`

**`GET ?venue_id=<uuid>`** returns the caller's effective preference + raw fallback info:

```json
{
  "venue_id": "<uuid>",
  "user_id": "<uuid>",
  "subscription_id": "<uuid|null>",
  "cadence": "daily|weekly|off",
  "weekly_day": "sun|mon|tue|wed|thu|fri|sat|null",
  "source": "member|subscription|legacy_disabled|default",
  "member_metadata": {
    "digest_cadence": "weekly",
    "digest_weekly_day": "wed",
    "digest_disabled_at": null
  },
  "subscription_fallback": {
    "digest_cadence": "daily",
    "digest_weekly_day": null,
    "digest_disabled": false,
    "digest_disabled_at": null
  }
}
```

**`POST`** with body:

```json
{ "venue_id": "<uuid optional>", "cadence": "daily|weekly|off", "weekly_day": "sun|mon|tue|wed|thu|fri|sat (optional)" }
```

Rules:
- `cadence === 'weekly'` and `weekly_day` absent → defaults to `'mon'`.
- `cadence` ≠ `'weekly'` → `weekly_day` is ignored / removed.
- Writes target `venue_members` row for the authenticated user (NOT the subscription row). The venue-level Phase 8T POST is preserved for venue-wide defaults but is now legacy; the UI uses the per-user POST.

Response on success:
```json
{ "success": true, "venue_id": "<uuid>", "user_id": "<uuid>", "cadence": "weekly", "weekly_day": "wed" }
```

Failure modes (HTTP 400 / 404 / 500):
- `validation_failed` — bad body shape.
- `member_not_found` (404) — caller isn't a `venue_members` row for the target venue (rare; usually cross-tenant with legacy `owner_user_id`-only access).
- `unexpected_error` (500, Sentry-captured) — DB error during lookup or update.

Both methods: `requireAdmin()` + optional cross-tenant `requireVenueRole(ADMIN_ROLES)`, rate-limited, `X-Request-Id` on every response.

### Cron fan-out behavior

For each venue with ≥ 1 event in the lookback window:

1. Load the venue's subscription metadata once (the fallback).
2. Build the venue-level unsubscribe URL once (signed with `DIGEST_UNSUBSCRIBE_SECRET`).
3. `findDigestRecipients` loads all `venue_members` rows where role ∈ `{owner, admin}`, capped at `MAX_RECIPIENTS_PER_VENUE = 10`, ordered by `created_at` (deterministic). For each, resolve email via `auth.admin.getUserById`; members without an email are dropped silently.
4. For each recipient:
   - `resolveEffectiveDigestPreference({memberMetadata, subscriptionMetadata, now})` returns `{cadence, weeklyDay, shouldSend, reason, source}`.
   - If `shouldSend === false`:
     - `reason === 'off'` → log `operator_digest.skipped_disabled`, increment `skipped`.
     - `reason === 'weekly_wrong_day'` → log `operator_digest.skipped_cadence`, increment `skipped`.
   - Else: per-recipient idempotency probe via `digestAlreadySentToRecipientToday` (keys on `tour_digest_date` + `tour_digest_recipient_user_id`). Already-sent → log `operator_digest.skipped_duplicate`, increment `skipped`.
   - Else: build body (HTML + plaintext), send via `sendEmail`, log success.
5. After the per-recipient loop, if no recipient was actually sent (all skipped), log `jobs.operator_activity_digest.venue_all_skipped` (informational, not an error).

Skip log vocabulary:

| Log event | Cause |
|---|---|
| `operator_digest.skipped_disabled` | Effective cadence is `off` for the recipient |
| `operator_digest.skipped_cadence` | Weekly cadence + today isn't the chosen day |
| `operator_digest.skipped_no_email` | Venue has no owner/admin members with emails (logged at venue level) |
| `operator_digest.skipped_duplicate` | Same recipient already received today's digest |
| `jobs.operator_activity_digest.skipped_suppressed` | Resend reported the address as suppressed |
| `jobs.operator_activity_digest.console_fallback` | No Resend config (dev) |

### Per-recipient idempotency

`outbound_messages` probe now keys on:

```sql
where venue_id           = $1
  and related_table      = 'tour_status_events'
  and metadata->>'tour_digest_date'                = $today_utc
  and metadata->>'tour_digest_recipient_user_id'   = $userId
```

The Phase 8R `tour_digest_date` marker still goes on every row; Phase 8U adds the recipient marker so a multi-owner venue's parallel sends are de-duped independently. The Phase 8T venue-wide probe `digestAlreadySentToday` is preserved in the codebase for any future caller but is no longer invoked by the cron.

### Venue-level unsubscribe compatibility

The Phase 8K-style `GET /api/digest/unsubscribe?venue_id=…&token=…` link still works exactly as before — it flips:

```jsonc
// subscriptions.metadata
{
  "digest_cadence":     "off",
  "digest_disabled":    true,
  "digest_disabled_at": "<iso>"
}
```

Individual admins can still re-enable their own digest from the billing-page card; the per-user `member.metadata.digest_cadence = 'daily'|'weekly'` overrides the venue-level off (effective-preference priority order, item #1 above).

The success page copy now reads:

> This disables venue-level summaries. Individual admins can re-enable their own digest from Billing Settings.

## 7aa. Search coverage hint (Phase 8U)

When operators type a 1- or 2-char search term in the billing-page activity feed (`q.length < 3`), Phase 8T's server-side `?q=` short-circuits to scalar columns only — metadata is not searched. Phase 8U adds a small UI hint so the gap is visible:

> Searching core fields only. Type 3+ characters to include metadata.

The pill renders only while `qInput.trim().length` is 1 or 2; it disappears as soon as the operator reaches the 3-char threshold (which then routes through the `search_tour_status_events` RPC and searches metadata). Pure client-side; no API change.

Examples:
- `?q=ai` → pill shown, scalar-only search.
- `?q=ab` → pill shown.
- `?q=anthropic` → pill hidden, full RPC search.

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
