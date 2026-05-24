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

## 7ab. Digest preview (Phase 8V)

Operators previously had to wait until the next 8am UTC cron tick to verify a cadence change produced the right email. Phase 8V adds a sync preview surface.

### Endpoint

```
POST /api/admin/digest/preview
```

Body (all fields optional):

```json
{ "venue_id": "<uuid optional>" }
```

Behavior:
1. `requireAdmin()` + optional cross-tenant `requireVenueRole(ADMIN_ROLES)`.
2. 422 `no_email_on_account` when the caller's `auth.users.email` is null.
3. 429 rate-limited per caller via `admin:digest-preview:{userId}`.
4. Aggregates the last 24h of `tour_status_events` for the target venue (zero-event venues still get a sample with empty-state copy).
5. Resolves the caller's effective preference (Phase 8U resolver — member > subscription > legacy > default).
6. Sends the same HTML + plaintext body the cron would produce.
7. Outbound metadata tagged so the cron ignores it on the next tick:
   ```jsonc
   {
     "tour_digest_preview": "true",
     "tour_digest_preview_user_id": "<user uuid>",
     "tour_digest_cadence": "daily|weekly|off",
     "tour_digest_weekly_day": "sun..sat|<empty>",
     "tour_digest_total": "<int as string>"
   }
   ```
   Crucially, the preview does NOT write `tour_digest_recipient_user_id` — the cron's idempotency probe keys on that field. So tomorrow's 8am UTC run still sends the real digest to the same user.

### Response

```json
{
  "success": true,
  "venue_id": "<uuid>",
  "sent_to": "operator@example.com",
  "event_count": 12,
  "cadence": "daily",
  "weekly_day": null
}
```

Console fallback (no Resend config in dev) returns 200 with:
```json
{ "success": false, "reason": "console_fallback", … }
```

Failure modes:
- `409 suppressed` — recipient address is on the `email_suppressions` list.
- `500 email_failed` — Resend provider error (Sentry-captured).

### Manual verification SQL

After clicking Send sample:

```sql
select created_at, status, provider, error,
       metadata->>'tour_digest_preview'         as is_preview,
       metadata->>'tour_digest_preview_user_id' as preview_user,
       metadata->>'tour_digest_cadence'         as cadence
from public.outbound_messages
where venue_id = '<uuid>'
  and related_table = 'tour_status_events'
  and metadata->>'tour_digest_preview' = 'true'
order by created_at desc
limit 5;
```

Expect a row with `is_preview = 'true'`, `provider = 'resend'`, `status = 'queued'` (or `'delivered'` after the Resend webhook lands).

## 7ac. Member digest preference backfill (Phase 8V)

Long-time owner/admin members predate Phase 8U's per-user preference column — their `venue_members.metadata = '{}'` and the effective-preference resolver falls through to `'default'`. The billing card then shows a "Using default" source badge that surprises operators who'd expected to see their own preference reflected.

The optional Phase 8V backfill writes explicit `digest_cadence='daily'` onto every owner/admin row that lacks one, flipping those badges to "Using your preference" and creating a clean per-member audit trail for future opt-outs.

### Triggering

```ts
// Inngest dashboard → send event:
{ name: 'admin/member-digest-preferences.backfill' }
```

Env gate:

```env
SEED_MEMBER_DIGEST=1
```

Without the flag, the function short-circuits with `{ skipped: true, reason: 'disabled' }`. No cron schedule — manual trigger only.

### Idempotency rule

Candidate query filters via `is.null` on `metadata->>'digest_cadence'`. Re-running is a no-op for already-backfilled rows. The per-row update also defensive-checks the key isn't set, so a race between the candidate fetch + a parallel admin POST mid-batch can't accidentally overwrite a freshly-set preference.

### Expected return

```json
{
  "scanned": 850,
  "updated": 850,
  "skipped": 0,
  "failed": 0
}
```

Or when disabled:

```json
{ "skipped": true, "reason": "disabled" }
```

Per-row failures NEVER abort the batch — they increment `failed` and the loop continues. Cap of 1000 rows per run; deployments with > 1000 candidate members need multiple invocations.

### Validation SQL

Before backfill:

```sql
select count(*) filter (where metadata->>'digest_cadence' is null) as missing,
       count(*) filter (where metadata->>'digest_cadence' is not null) as set
from public.venue_members
where role in ('owner', 'admin');
```

After backfill: `missing` should be 0 (or close to it; any remainder are members updated between the candidate fetch and a per-row failure, surfaced via `summary.failed`).

## 7ad. Self-serve digest resubscribe + cron idempotency hardening + preview suppression UX (Phase 8W)

Three additive surfaces, no new env vars, no migrations.

### Public resubscribe route

`GET /api/digest/resubscribe?venue_id=<uuid>&user_id=<uuid>&token=<signed>` is the per-user counterpart to Phase 8S's venue-level `/api/digest/unsubscribe`. On a verified resubscribe-action token + matching URL params, it writes `digest_cadence = 'daily'` onto the `venue_members.metadata` row for the (venue_id, user_id) pair and renders a confirmation HTML page.

Security posture mirrors the Phase 8S unsubscribe route:

- HMAC-signed token via `DIGEST_UNSUBSCRIBE_SECRET` (≥16 chars enforced). Same secret as unsubscribe — a rotation invalidates every token of either kind.
- Token payload carries `action: 'resubscribe'` (Phase 8W). A leaked Phase 8S unsubscribe token (no `action` field, defaults to `'unsubscribe'`) presented at this route returns the neutral 400 "link not valid" page via `action_mismatch`.
- URL `venue_id` AND `user_id` must match the signed payload exactly. Defends against an attacker swapping query params to re-enable a different user.
- Role-gated to `owner` / `admin`. A viewer / coordinator membership returns 404 (same shape as "no membership exists") so the route can't be used to enumerate per-role distribution.
- Per-IP rate-limit via `digest-resubscribe:<ip>`; scoped separately from `digest-unsubscribe:<ip>` so a noisy resubscribe loop doesn't push the unsubscribe limiter into deny-all.
- `X-Robots-Tag: noindex, nofollow` on every response.
- Logs use `redactDigestUnsubscribeToken()`; raw token values never appear in Sentry context.

The route writes ONLY to `venue_members.metadata`; it leaves `subscriptions.metadata.digest_disabled` (the legacy venue-level flag) untouched. This is intentional — per the Phase 8U effective-preference resolver, a member-level `digest_cadence='daily'` wins over the venue-level legacy flag, so an individual admin can re-enable themselves even when the venue is opted-out at the subscription level.

Audit breadcrumb: each successful flip stamps `venue_members.metadata.digest_resubscribed_at = <ISO>` alongside the cadence write — same shape as `digest_disabled_at` on the unsubscribe side.

Generate a resubscribe URL from server code (e.g. when embedding in an ops email):

```ts
import { createDigestResubscribeUrl } from '@/lib/integrations/digest-unsubscribe-token'

const url = createDigestResubscribeUrl({
  venueId: '<uuid>',
  userId: '<uuid>',
  // ttlMs optional; defaults to 30 days
})
```

### Cron idempotency: `tour_digest_send_kind` discriminator

Phase 8W formalizes the implicit "preview-marker-absence" pattern from Phase 8V into an explicit `metadata.tour_digest_send_kind` field on every outbound digest row:

| Source | `send_kind` value |
|---|---|
| `operator-activity-digest` cron | `'cron'` |
| `POST /api/admin/digest/preview` | `'preview'` |
| (reserved) future operator manual send | `'manual'` |

The cron's per-recipient idempotency probe now filters on `send_kind = 'cron'` so a preview sent earlier today can NEVER block the day's scheduled digest:

```ts
.filter('metadata->>tour_digest_date', 'eq', todayUtc)
.filter('metadata->>tour_digest_recipient_user_id', 'eq', userId)
.filter('metadata->>tour_digest_send_kind', 'eq', 'cron')
```

The Phase 8V `tour_digest_preview = 'true'` back-compat marker is still written by the preview route for one release cycle so any audit query built between 8V and 8W keeps working. New audit queries should prefer `send_kind`.

Inspect today's rows by kind:

```sql
select metadata->>'tour_digest_send_kind' as kind, count(*)
from public.outbound_messages
where related_table = 'tour_status_events'
  and metadata->>'tour_digest_date' = to_char(now() at time zone 'utc', 'YYYY-MM-DD')
group by 1;
```

Expected after a normal day (cadence='daily' venue, one preview clicked):

```
kind     | count
---------+------
cron     | 1
preview  | 1
```

### Preview suppression UX

`POST /api/admin/digest/preview` returns HTTP 409 with `{ error: 'suppressed' }` when Resend has the caller's email on its suppression list (typically from a prior hard bounce or complaint).

Pre-8W: the card rendered `Couldn't send sample: suppressed` — accurate but cryptic.

Phase 8W: the card detects the (status 409, error 'suppressed') tuple and renders the friendlier amber-toned copy:

> This email address is currently suppressed by our email provider, so we can't send a sample digest to it. Contact support to re-enable delivery for this address.

Other non-200 responses (rate_limit, validation_failed, console_fallback, generic `email_failed`) still render the original red-toned `Couldn't send sample: <code>` line — only the suppression branch was specialized.

To verify locally, drop the caller's email into Resend's suppression list via the dashboard and click "Send sample" on `/dashboard/settings/billing` — the friendly amber copy should appear in place of the red error.

## 7ae. Digest footer links + manual sends (Phase 8X)

### Send-kind matrix

Every outbound digest row carries an explicit `metadata.tour_digest_send_kind`:

| Surface | `send_kind` | Idempotency probe match? | Footer unsubscribe | Footer resubscribe |
|---|---|---|---|---|
| `operator-activity-digest` cron | `'cron'` | Yes (filters on `send_kind='cron'`) | Yes (venue-level, when secret set) | No (cadence is never 'off' on a cron send) |
| `POST /api/admin/digest/preview` | `'preview'` | No | Yes | Yes |
| `POST /api/admin/digest/send` (Phase 8X manual) | `'manual'` | No | Yes | Yes |

The cron probe is strict: legacy rows without `tour_digest_send_kind` do NOT match either. Documented as acceptable in the §7w/§7ad operational notes — a freshly-deployed cron may send once more to a recipient who already received today's digest under a pre-8W row, then resume normal dedup the following day.

### Metadata examples

Cron row:

```json
{
  "tour_digest_date": "2026-05-18",
  "tour_digest_total": "12",
  "tour_digest_recipient_user_id": "<uuid>",
  "tour_digest_cadence": "daily",
  "tour_digest_weekly_day": "",
  "tour_digest_send_kind": "cron"
}
```

Preview row:

```json
{
  "tour_digest_preview": "true",
  "tour_digest_preview_user_id": "<uuid>",
  "tour_digest_cadence": "weekly",
  "tour_digest_weekly_day": "tue",
  "tour_digest_total": "0",
  "tour_digest_send_kind": "preview"
}
```

(Note: preview deliberately omits `tour_digest_recipient_user_id` for belt-and-suspenders coverage of any audit query built before Phase 8W's `send_kind` discriminator. The Phase 8V `tour_digest_preview='true'` back-compat marker stays for one release cycle.)

Manual row:

```json
{
  "tour_digest_send_kind": "manual",
  "tour_digest_recipient_user_id": "<uuid>",
  "tour_digest_cadence": "daily",
  "tour_digest_weekly_day": "",
  "tour_digest_total": "12",
  "tour_digest_manual_initiator_user_id": "<uuid>"
}
```

`tour_digest_manual_initiator_user_id` is the auth.users id of the operator who clicked "Send manual digest" (or POSTed the endpoint). Useful for audit queries — "who keeps sending Sara manual digests at 2am?".

### Manual endpoint contract

`POST /api/admin/digest/send`

Request body (all fields optional):

```json
{
  "venue_id": "<uuid>",
  "user_id": "<uuid>",
  "respect_cadence": false
}
```

- `venue_id` — target venue. Defaults to caller's primary venue. Cross-tenant requires ADMIN_ROLES via `requireVenueRole`; forbidden collapses to 404.
- `user_id` — target recipient. Defaults to caller. Must be an `owner` or `admin` member of the resolved venue; viewer/coordinator/sales_manager memberships collapse to 404.
- `respect_cadence` — when `true`, honors the recipient's effective cadence preference (cron-style skip on `'off'` or weekly-wrong-day). When `false` (default), bypasses cadence entirely. Cron idempotency is ALWAYS bypassed.

Success response (`200`):

```json
{
  "success": true,
  "sent": true,
  "venue_id": "<uuid>",
  "recipient_user_id": "<uuid>",
  "sent_to": "operator@example.com",
  "event_count": 12,
  "cadence": "daily",
  "weekly_day": null,
  "send_kind": "manual"
}
```

`sent_to` is only populated when the caller IS the recipient. Cross-user sends return `sent_to: null` to prevent admins from enumerating other admins' email addresses.

Cadence-skip response (`200`, only when `respect_cadence: true`):

```json
{
  "success": true,
  "sent": false,
  "skipped": true,
  "reason": "off|cadence_mismatch",
  "venue_id": "<uuid>",
  "recipient_user_id": "<uuid>",
  "event_count": 12,
  "cadence": "off|weekly",
  "weekly_day": null,
  "send_kind": "manual"
}
```

Error responses:

| Status | Body | Cause |
|---|---|---|
| 400 | `{ "error": "validation_failed", "detail": ... }` | Body failed Zod parse |
| 400 | `{ "error": "recipient_email_missing" }` | Target user has no auth.users.email |
| 401 | `{ "error": "unauthorized" }` | No session |
| 403 | `{ "error": "forbidden" }` | Not an admin/owner anywhere |
| 404 | `{ "error": "not_found" }` | Cross-tenant denied OR target not an admin/owner member |
| 409 | `{ "error": "suppressed" }` | Resend has the address on its suppression list |
| 429 | `{ "error": "rate_limit_exceeded", ... }` | `admin:digest-send:<userId>` budget exhausted |
| 500 | `{ "error": "email_failed" }` | Provider error (Sentry-captured) |
| 500 | `{ "error": "unexpected_error" }` | DB or Auth admin lookup failure |

### Footer link behavior

Every digest body (plaintext + HTML) now renders:

1. "Manage your digest preferences from Billing Settings" pointer at `${appUrl}/dashboard/settings/billing` — always present.
2. Unsubscribe link (`createDigestUnsubscribeUrl`) — present when `DIGEST_UNSUBSCRIBE_SECRET` is set.
3. Resubscribe link (`createDigestResubscribeUrl`) — present when `DIGEST_UNSUBSCRIBE_SECRET` is set AND `send_kind !== 'cron'`.

The send-kind gating is intentional: cron-driven digests reach a recipient whose effective cadence is `'daily'` or `'weekly'` (off would have been skipped upstream), so the re-enable link would just add clutter. Preview and manual sends always include the resubscribe link because they're operator-initiated and the recipient may need either action.

### Missing-secret behavior

When `DIGEST_UNSUBSCRIBE_SECRET` is unset or shorter than 16 chars:

- All three surfaces (cron / preview / manual) still send the email body.
- Both unsubscribe and resubscribe footer lines are omitted (plaintext + HTML).
- A single structured warn `jobs.operator_activity_digest.no_unsubscribe_secret` fires once per process — shared module-level flag across the cron + preview + manual handlers, so a noisy day doesn't produce one warn per recipient.

### Cron idempotency contract (Phase 8X reiteration)

The cron's per-recipient probe must match strictly:

```sql
metadata->>'tour_digest_send_kind'         = 'cron'
metadata->>'tour_digest_recipient_user_id' = $userId
metadata->>'tour_digest_date'              = $today
```

It must NOT match:

- `send_kind = 'preview'` (Phase 8V/8W)
- `send_kind = 'manual'` (Phase 8X)
- Legacy rows without `tour_digest_send_kind` (pre-8W)

Acceptable side effect: a freshly-deployed cron may send one extra digest to a recipient who already received today's digest under a pre-8W row, then resume normal dedup the following day.

## 7af. Digest member picker + send audit feed (Phase 8Y)

Two new admin endpoints + a new card on `/dashboard/settings/billing` make manual digests usable for operators and surface digest delivery history as a first-class audit feed.

### Member endpoint contract

`GET /api/admin/digest/members?venue_id=<optional uuid>`

Auth: `requireAdmin()` + cross-tenant `requireVenueRole(ADMIN_ROLES)` (collapses to 404 on miss).

Rate-limit: `admin:digest-members:{userId}`.

Response (`200`):

```json
{
  "venue_id": "<uuid>",
  "items": [
    {
      "user_id": "<uuid>",
      "role": "owner",
      "email": "owner@example.com",
      "can_receive_digest": true,
      "is_current_user": true
    }
  ]
}
```

Members with missing emails are returned with `email: null` and `can_receive_digest: false` rather than omitted — the picker shows them disabled so the operator sees the gap. Hard cap of 10 members per venue (matches the Phase 8U cron fan-out cap); the first 10 owner/admin members by `created_at` are returned. Only roles in `('owner', 'admin')` ever appear — viewer/coordinator/sales_manager are excluded structurally.

### Sends endpoint contract

`GET /api/admin/digest/sends`

Auth: `requireAdmin()` + cross-tenant `requireVenueRole(ADMIN_ROLES)` (collapses to 404 on miss).

Rate-limit: `admin:digest-sends:{userId}`.

Query params (all optional):

- `venue_id` — defaults to caller's primary venue
- `send_kind` ∈ `cron | preview | manual | all`, default `all`
- `recipient_user_id` — filter by recipient
- `since` — ISO datetime; `created_at >= since`
- `limit` — 1..200, default 50
- `format` ∈ `json | csv`, default `json`

Reads `outbound_messages` rows where `related_table = 'tour_status_events'` AND `metadata->>'tour_digest_send_kind' IS NOT NULL`. Legacy pre-8W rows (no `send_kind`) are excluded — they can't be classified accurately as `cron` vs `preview` vs `manual`.

JSON response (`200`):

```json
{
  "items": [
    {
      "id": "<outbound_messages id>",
      "venue_id": "<uuid>",
      "recipient_user_id": "<uuid|null>",
      "recipient_email": "o***@example.com",
      "send_kind": "cron",
      "status": "queued|delivered|bounced|complained|failed|suppressed",
      "provider": "resend|null",
      "event_count": 14,
      "cadence": "daily|weekly|off|null",
      "weekly_day": "mon|null",
      "manual_initiator_user_id": "<uuid|null>",
      "error": "<string|null>",
      "created_at": "<iso>",
      "delivered_at": "<iso|null>"
    }
  ]
}
```

CSV branch (`?format=csv`):

- `Content-Type: text/csv; charset=utf-8`
- `Content-Disposition: attachment; filename="digest-sends-YYYY-MM-DD.csv"`
- UTF-8 BOM (Excel auto-detect)
- Explicit column allowlist:
  `id, venue_id, send_kind, status, recipient_user_id, recipient_email_masked, provider, event_count, cadence, weekly_day, manual_initiator_user_id, error, created_at, delivered_at`
- Cells escaped per RFC 4180 (comma / quote / newline → quoted, embedded `"` doubled)

### PII / masking posture

- `recipient_email` is **always masked** in the audit feed: `o***@example.com`. The members endpoint exposes raw emails because the picker needs a human-readable label; the audit feed deliberately doesn't, so a CSV download doesn't scatter raw addresses across an operator's hard drive.
- The feed never returns `subject`, `body` (text or html), `provider_message_id`, or the full `metadata` jsonb. Only the allow-listed metadata keys above are surfaced.
- `error` is returned as-is so operators can triage suppressions and provider failures.

### Manual-send `respect_cadence` behavior

`POST /api/admin/digest/send` with `{ respect_cadence: true }`:

- If the recipient's effective cadence is `'off'`:
  ```json
  { "success": true, "sent": false, "skipped": true, "reason": "off", ... }
  ```
- If the recipient's effective cadence is `'weekly'` and today UTC isn't the scheduled day:
  ```json
  { "success": true, "sent": false, "skipped": true, "reason": "weekly_wrong_day", ... }
  ```
- Otherwise sends normally with `sent: true`.

The DigestPreferencesCard maps `reason: 'off'` → "Skipped because this recipient's cadence is off." and `reason: 'weekly_wrong_day'` → "Skipped because this recipient's weekly digest is not scheduled today." Other values render the generic red error line.

Cron idempotency is ALWAYS bypassed regardless of `respect_cadence`.

### Audit feed behavior

`DigestAuditFeed` on `/dashboard/settings/billing` (admins/owners only):

- Initial load: last 25 sends.
- Filter chips: `All / Cron / Preview / Manual` — only one active at a time. Changing the chip refetches.
- Manual refresh button + CSV export link in the card header.
- CSV export honors the current chip — operators get a CSV of what they're looking at, not the full unfiltered feed. The endpoint caps at 200 rows; chain with `?since=<ISO>` for wider windows.
- Status pill colors mirror the existing billing-page activity feed conventions: emerald for delivered, amber for suppressed, red for bounced/complained/failed, slate for in-flight (queued, etc.).
- Empty state: "No digest sends recorded yet."

### Known limitation — outbound_messages, not Resend webhooks

The feed reads `outbound_messages` rows. The `status` column updates when `/api/resend/webhook` receives a delivery event. So a row may show `status: 'queued'` for a few seconds after the send before the webhook flips it to `delivered`. Triage steps for any send appearing stuck at `queued`:

1. Confirm Resend webhook is configured (`/api/health` → `resend_webhook: 'configured'`).
2. Inspect the Resend dashboard's delivery log directly for the same `to_address`.
3. If the webhook confirms delivery but the row is still `queued`, suspect a webhook signature mismatch — see RUNBOOK §4.

## 7ag. Digest audit pagination + realtime + suppression triage (Phase 8Z)

### Sends endpoint pagination contract

`GET /api/admin/digest/sends` now accepts:

```
?occurred_before=<ISO datetime>
```

Strict `<` cursor on `created_at`. Preserves all existing filters: `venue_id`, `send_kind`, `recipient_user_id`, `since`, `limit` (cap 200), `format ∈ json | csv`.

JSON response shape (additive — older 8Y clients still parse):

```json
{
  "items": [...],
  "next_cursor": "2026-05-19T08:00:00Z",
  "has_more": true
}
```

- `next_cursor` = `created_at` of the last returned row when `has_more === true`, otherwise `null`.
- `has_more = rows.length === limit`. A short page implies the operator reached the end.

CSV branch (`?format=csv`):

- All existing columns + headers unchanged.
- New response headers:
  ```
  X-Has-More: true|false
  X-Next-Cursor: <iso>     // only when has_more=true
  ```
- Chain manually by reading `X-Next-Cursor` and re-issuing with `&occurred_before=<value>`.

PII masking is unchanged from Phase 8Y — `recipient_email` is always masked in both JSON and CSV.

### Realtime layer

`RealtimeDigestSendsLayer` (mounted on `/dashboard/settings/billing` for admins/owners only):

- Channel: `digest-sends:venue:${venueId}`
- Postgres filter: `event=INSERT, schema=public, table=outbound_messages, filter=venue_id=eq.${venueId}`
- Handler-side narrowing:
  ```ts
  if (row.related_table !== 'tour_status_events') return
  if (!row.metadata?.tour_digest_send_kind) return
  ```
- Toast on every qualifying INSERT: "New digest send recorded".
- `router.refresh()` debounced 1000ms trailing — cron bursts coalesce into one rebuild while every event still produces a visible toast.

PREREQ — `outbound_messages` must be in the `supabase_realtime` publication. Migration 001 publishes only leads / messages / conversations / tours; this table is NOT in by default. Apply out-of-band (not a migration file):

```sql
alter publication supabase_realtime add table public.outbound_messages;
```

Without the publication entry, the channel subscribes successfully but receives no events.

### Suppression endpoint contract

`GET /api/admin/digest/suppressions?venue_id=<optional uuid>`

Auth: `requireAdmin()` + cross-tenant `requireVenueRole(ADMIN_ROLES)` (404 on miss).

Rate-limit: `admin:digest-suppressions:{userId}`.

Behavior:

1. Resolve owner/admin members of the target venue (cap 10, matches cron fan-out + picker).
2. Resolve each member's `auth.users.email` (bounded concurrency 5).
3. Intersect against `public.email_suppressions` (the existing migration-003 table; NOT a new `suppressions` table).
4. Return rows that belong to receivers of THIS venue's digest, with masked emails.

Response:

```json
{
  "venue_id": "<uuid>",
  "items": [
    {
      "user_id": "<uuid>",
      "role": "owner",
      "email_masked": "o***@example.com",
      "reason": "bounce|complaint|manual|unknown",
      "created_at": "<iso|null>"
    }
  ]
}
```

Reason mapping:

| email_suppressions.reason | response.reason |
|---|---|
| `bounce_hard` | `bounce` |
| `complaint` | `complaint` |
| `manual` | `manual` |
| `unsubscribe` | `unknown` (deliberately — see below) |
| anything else | `unknown` |

The `unsubscribe` reason is intentionally collapsed to `unknown`. A member who unsubscribed via the Phase 8S link flipped a digest-cadence preference, not a delivery suppression. Surfacing `unsubscribe` here would conflate two distinct opt-out paths.

### PII masking posture

- Response NEVER returns raw email — always `o***@example.com`.
- Logs include user_id, venue_id, count only — no email at any verbosity.
- Cross-tenant lookups collapse to 404 to prevent venue enumeration.
- Email-lookup failures are warned by user_id only; the raw email never reaches Sentry context.

### Suppression callout UI

`DigestSuppressionsCallout`:

- Mounted on `/dashboard/settings/billing` between `DigestPreferencesCard` and `DigestAuditFeed`.
- Fetches `/api/admin/digest/suppressions` lazily on mount.
- Renders NOTHING in the happy path (empty items / loading / error).
- Otherwise renders an amber banner with:
  - Pluralized headline ("1 admin email is currently suppressed." / "3 admin emails are currently suppressed.").
  - List of masked emails + reasons + dates.
  - Pointer to "Resolve from your Resend dashboard or the admin suppressions list."
- No remove action in this phase — direct operators to existing tools.

### Audit feed "Load older"

`DigestAuditFeed` extensions:

- Initial fetch unchanged (last 25 rows; `?limit=25`).
- Stores `{ items, nextCursor, hasMore, loadingMore, loadMoreError }` in state.
- "Load older" button appears below the table when `hasMore === true`.
- Click: fetches `?occurred_before=<nextCursor>&limit=25&send_kind=<filter>` and APPENDS rows. Cursor advances; `hasMore` updates from the response.
- Filter chip change RESETS the feed to page 1 (the existing useEffect dependency on `filter` rebuilds the initial load).
- Inline error keeps the table visible if a load-more fetch fails ("Couldn't load older sends: <code>").
- CSV export link deliberately does NOT carry the cursor — it always exports the current filter at `limit=200` ("export what I'm looking at, plus headroom").

### Per-recipient mini-summary

Above the table, the audit feed renders a one-line top-3-recipients summary over the currently loaded slice:

```
Last loaded sends: y***@example.com 8 · a***@example.com 3 · unknown 1
```

Pure derived state — no extra fetch. Helps operators spot a single recipient absorbing all the failures.

### Known limitation — Realtime vs Resend webhook ordering

Realtime INSERTs fire when the `outbound_messages` row is created (typically `status='queued'`). The Resend webhook handler at `/api/resend/webhook` updates the row to `delivered` / `bounced` / etc seconds later. The audit feed will repaint with `status='queued'` first and the final status arrives via the next `router.refresh()` (debounced).

This is acceptable — the Realtime layer's job is "tell the operator a send happened", not "report final delivery state". For forensic confirmation use the Resend dashboard directly.

## 7ah. Digest suppression removal + send search (Phase 8AA)

Three additive surfaces close the operator loop on digest delivery: admins can resolve suppressions inline, search the audit feed, and see suppression banners refresh in real time.

### Suppression remove endpoint contract

`POST /api/admin/digest/suppressions/remove`

Auth: `requireAdmin()` + cross-tenant `requireVenueRole(ADMIN_ROLES)` (404 on miss).

Rate-limit: `admin:digest-suppressions-remove:{userId}`.

Body:

```json
{
  "venue_id": "<optional uuid>",
  "user_id": "<uuid>",
  "reason": "<optional string, max 240>"
}
```

The body NEVER carries an email. The server re-resolves the target's address from `venue_members` + Supabase Auth admin, then deletes by the resolved address from `public.email_suppressions`. This defends against:

- A malicious client mass-clearing suppressions for unrelated accounts.
- A stale UI sending a previously-correct email after the user changed it in Auth.
- A tampered DOM POSTing an email it never displayed.

The optional `reason` is a free-text breadcrumb the operator can pass (e.g. "verified with recipient" / "domain reconfigured"). Capped at 240 chars; logged but never displayed back to the client.

Success response — suppression existed and was removed:

```json
{
  "success": true,
  "removed": true,
  "venue_id": "<uuid>",
  "user_id": "<uuid>",
  "email_masked": "o***@example.com"
}
```

Success response — no suppression row matched the resolved email (idempotent, treats "already removed" as success):

```json
{
  "success": true,
  "removed": false,
  "reason": "not_suppressed",
  "venue_id": "<uuid>",
  "user_id": "<uuid>",
  "email_masked": "o***@example.com"
}
```

Error responses:

| Status | Body | Cause |
|---|---|---|
| 400 | `{ "error": "validation_failed", "detail": ... }` | Body failed Zod parse (missing user_id, invalid uuid, etc.) |
| 400 | `{ "error": "recipient_email_missing" }` | Target user has no `auth.users.email` |
| 401 | `{ "error": "unauthorized" }` | No session |
| 403 | `{ "error": "forbidden" }` | Not admin/owner anywhere |
| 404 | `{ "error": "not_found" }` | Cross-tenant denied OR target not owner/admin member of venue |
| 429 | `{ "error": "rate_limit_exceeded", ... }` | `admin:digest-suppressions-remove:<userId>` budget exhausted |
| 500 | `{ "error": "unexpected_error" }` | DB or Auth admin lookup failure |

### Audit trail

No new audit table — `billing_events_log` (migration 008) is reserved for Stripe webhook events and overloading it would muddy the existing schema's `provider` / `event_type` semantics. The forensic trail is structured log lines on every outcome:

```
op=admin.digest_suppression_remove
event=admin.digest_suppression_remove.completed
requestId=<uuid>
venueId=<uuid>
targetUserId=<uuid>
removed=true|false
removedCount=<int>
operatorReason=<string|null>
```

A future phase can introduce a dedicated `digest_audit_events` table if frequency justifies it.

### Server-side email resolution rationale

Even though the operator already sees the masked email via the audit feed / callout, the remove endpoint deliberately does NOT accept an email parameter. Rationale:

1. **Defense in depth.** A compromised admin session could otherwise pass any address.
2. **Source-of-truth coherence.** If the operator changed their email in Auth after the suppression was created (rare but possible), the suppression row still keys on the old address; resolving from current Auth state could miss it. Mitigation: a future phase can add a `resolved_email_history` lookup if this becomes a real problem.
3. **Audit-log clarity.** Every removal log line ties to a `(venue_id, user_id)` pair — never an email — so log searches respect the same PII boundary as the feed UI.

### Search query contract

`GET /api/admin/digest/sends?q=<string, max 120>`

Search fields by length:

| Term length | Searched fields |
|---|---|
| 1-2 chars (short) | `status`, `provider`, `error`, `to_address`, `metadata->>tour_digest_send_kind` |
| 3+ chars (full) | All short fields, plus `metadata->>tour_digest_cadence`, `metadata->>tour_digest_weekly_day`, `metadata->>tour_digest_recipient_user_id`, `metadata->>tour_digest_manual_initiator_user_id` |

Mirrors the Phase 8U short-query short-circuit on `/api/admin/tours/status-events`. The threshold exists because the broader metadata-key allowlist produces noisy matches under 3 chars (e.g. searching `m` would match `metadata->>tour_digest_cadence='daily'` rows incidentally through the recipient_user_id column).

Internal-only ILIKE on `to_address` is permitted — operators frequently remember the local-part of an admin email. Responses still mask `recipient_email`; the search is server-side only.

Search composes with every other filter (`venue_id`, `send_kind`, `recipient_user_id`, `since`, `occurred_before`, `limit`, `format`). Pagination's strict `<` cursor preserves the active `q` across "Load older" clicks.

### CSV search behavior

`GET /api/admin/digest/sends?q=manual&format=csv` produces the same CSV columns + UTF-8 BOM as the unfiltered export, but only includes matching rows. Headers behave per Phase 8Z:

```
X-Has-More: true|false
X-Next-Cursor: <iso>     // only when has_more=true
```

### Realtime suppression refresh

`RealtimeDigestSendsLayer` already toasts + debounces `router.refresh()` on every digest INSERT (Phase 8Z). Phase 8AA adds one more side effect: when the new row carries `status === 'suppressed'`, dispatch:

```ts
window.dispatchEvent(
  new CustomEvent('venuerise:digest-suppression-refresh')
)
```

`DigestSuppressionsCallout` listens via `window.addEventListener` and refetches its own data. No shared state store; a single CustomEvent is enough for one consumer.

Cleanup: the listener is removed on unmount. Multiple billing-page tabs each see their own dispatch (events don't cross window contexts).

### PII posture

- Suppression remove endpoint: body never accepts email; response only masked email; logs never include raw email at any verbosity.
- Sends search: matches `to_address` server-side; responses still mask `recipient_email`. The CSV export columns are unchanged from Phase 8Y (always masked).
- Realtime CustomEvent: carries no payload — just signals "something happened; please refetch."

## 7ai. Digest audit retention + cron health + bulk suppression removal (Phase 8AB)

### Retention job behavior

`digest-audit-retention` — weekly Inngest cron, schedule `0 9 * * 1` (Monday 9am UTC). Env-gated by `DIGEST_AUDIT_RETENTION_ENABLED=1`. With the flag absent or any other value, the cron short-circuits to `{ skipped: true, reason: 'disabled' }` before any DB read.

Retention window: `DIGEST_AUDIT_RETENTION_DAYS` (default 365). Clamped to `[30, 3650]`.

Behavior:
1. Select up to 500 `outbound_messages` rows where:
   - `related_table = 'tour_status_events'`
   - `metadata->>'tour_digest_send_kind' IS NOT NULL` (digest rows only)
   - `created_at < now() - retentionDays`
   - `metadata->>'digest_archived' IS NULL OR != 'true'` (skip already-archived)
2. For each row, merge into `metadata`:
   ```json
   {
     "digest_archived": true,
     "digest_archived_at": "<iso>",
     "digest_archived_reason": "retention_policy",
     "digest_retention_days": 365
   }
   ```
3. Return `{ scanned, archived, failed, retentionDays }`.

Per-row failures NEVER abort the batch. Soft-archive only — rows are NEVER deleted. Existing metadata keys (`tour_digest_send_kind`, `tour_digest_recipient_user_id`, etc.) are preserved.

### Archived metadata shape

```json
{
  "tour_digest_send_kind": "cron",
  "tour_digest_recipient_user_id": "<uuid>",
  "tour_digest_total": "12",
  "tour_digest_cadence": "daily",
  "tour_digest_weekly_day": "",
  "tour_digest_date": "2025-05-19",
  "digest_archived": true,
  "digest_archived_at": "2026-05-19T09:00:00Z",
  "digest_archived_reason": "retention_policy",
  "digest_retention_days": 365
}
```

### `?include_archived=true`

`GET /api/admin/digest/sends?include_archived=true|false` (default `false`):

- Default path filters out archived rows via:
  ```
  metadata->>'digest_archived' IS NULL OR metadata->>'digest_archived' != 'true'
  ```
- Set the flag to `true` to surface archived rows alongside live ones. Useful for forensic queries on incidents older than the retention window.

JSON `items[]` now carry a boolean `archived` field. CSV adds an `archived` column (`true`/`false`).

### Cron health endpoint contract

`GET /api/admin/digest/cron-health?venue_id=<optional uuid>`

Auth: `requireAdmin()` + cross-tenant `requireVenueRole(ADMIN_ROLES)` (404 on miss).
Rate-limit: `admin:digest-cron-health:{userId}`.

Reads the most-recent `cron`-tagged outbound digest row inside a 72-hour lookback window. Returns:

```json
{
  "venue_id": "<uuid>",
  "ok": true,
  "last_run_at": "<iso|null>",
  "lag_minutes": 830,
  "status": "ok|stale|no_data",
  "expected_schedule": "daily 8am UTC",
  "last_summary": {
    "status": "delivered|queued|failed|suppressed|bounced|complained|null",
    "event_count": 12,
    "recipient_user_id": "<uuid|null>",
    "cadence": "daily|weekly|off|null",
    "weekly_day": "mon|null"
  }
}
```

Status logic:

| Last cron row | Status |
|---|---|
| None within 72h | `no_data` (`ok: true`) |
| Created < 30h ago | `ok` (`ok: true`) |
| Created > 30h ago | `stale` (`ok: false`) |

### Why health is delivery-derived, not Inngest-derived

The endpoint infers cron health from `outbound_messages` rows, NOT by probing Inngest's run history. Trade-offs:

- **Pro:** no Inngest API token required, no new integration; works against any deployment that ships outbound digest rows.
- **Con:** a venue with NO tour activity in the last 24h won't get a digest (the cron skips zero-event venues), producing `status: 'no_data'`. That's not a cron failure — just a quiet venue. The card UI says so explicitly.
- For unambiguous cron run telemetry, point operators at the Inngest dashboard. That's the source of truth.

### Bulk remove endpoint contract

`POST /api/admin/digest/suppressions/remove-all`

Auth: `requireAdmin()` + cross-tenant `requireVenueRole(ADMIN_ROLES)` (404 on miss).
Rate-limit: `admin:digest-suppressions-remove-all:{userId}`.

Body:

```json
{
  "venue_id": "<optional uuid>",
  "reason": "<optional string, max 240>"
}
```

Behavior:
1. Resolve owner/admin members for the venue (cap 10).
2. Resolve emails server-side (bounded concurrency 5).
3. Per-member delete from `email_suppressions` by resolved email.

Response (`200`):

```json
{
  "success": true,
  "venue_id": "<uuid>",
  "removed_count": 3,
  "details": [
    {
      "user_id": "<uuid>",
      "email_masked": "o***@example.com",
      "removed": true
    },
    {
      "user_id": "<uuid>",
      "email_masked": null,
      "removed": false,
      "reason": "email_missing"
    },
    {
      "user_id": "<uuid>",
      "email_masked": "a***@example.com",
      "removed": false,
      "reason": "not_suppressed"
    }
  ]
}
```

`reason` ∈ `'email_missing' | 'not_suppressed' | 'unexpected_error'`.

`DigestSuppressionsCallout` surfaces a single "Remove all suppressions" button when `items.length >= 3`. Confirms via `window.confirm` before POSTing.

### Search highlight behavior

`DigestAuditFeed` wraps matched substrings in `<mark>` when the active search term is non-empty. Implementation notes:

- Case-insensitive matching via `String.toLowerCase().indexOf(...)`.
- No `dangerouslySetInnerHTML`; React tree is built piecewise so any `<` in the source becomes plain text. A search for `<script>` matches the literal substring and renders it inside `<mark>` — never executed.
- Highlighted cells: send kind label, recipient email, status pill, cadence, weekly day. NOT highlighted: timestamps (formatted client-side; not user-facing search data) and event count (numeric).
- Hidden metadata that isn't rendered visually isn't highlighted — search may match a row via `metadata->>tour_digest_manual_initiator_user_id` server-side but the cell wouldn't reflect that. This is intentional; the existing recipient summary already exposes who manual sends went to.

### PII posture summary

- Retention job: only mutates metadata; never reads `to_address` into the response surface.
- Cron health: `last_summary.recipient_user_id` is a uuid (no email exposure).
- Bulk remove: same masked-email contract as Phase 8AA per-row remove; body never carries email; logs never include raw email.

## 7aj. Digest audit events + archived toggle + cron-health realtime (Phase 8AC)

### `digest_audit_events` schema (migration 017)

```sql
create table public.digest_audit_events (
  id                  uuid primary key default gen_random_uuid(),
  venue_id            uuid not null references public.venues(id) on delete cascade,
  actor_user_id       uuid references auth.users(id) on delete set null,
  actor_kind          text not null check (actor_kind in ('operator', 'cron', 'system')),
  action              text not null,
  target_user_id      uuid references auth.users(id) on delete set null,
  target_email_masked text,
  reason              text,
  metadata            jsonb not null default '{}'::jsonb,
  occurred_at         timestamptz not null default now()
);
```

Indexes: `(venue_id, occurred_at desc)`, `(action, occurred_at desc)`, `(actor_kind, occurred_at desc)`.

RLS: SELECT for owner/admin via `has_venue_role(venue_id, auth.uid(), array['owner','admin'])`. No INSERT/UPDATE/DELETE policies — writes flow exclusively through `recordDigestAuditEvent` (service role).

### Audit write paths

| Caller | `actor_kind` | `action` | Notes |
|---|---|---|---|
| `POST /api/admin/digest/suppressions/remove` (Phase 8AA) | `operator` | `suppression_remove` or `suppression_remove_noop` | One row per call. `metadata.route='single'`. |
| `POST /api/admin/digest/suppressions/remove-all` (Phase 8AB) | `operator` | `suppression_remove_all` (summary) + one `suppression_remove` per actually-removed target | Summary `metadata = { removed_count, attempted_count, route: 'bulk' }`. Per-target rows skipped for `email_missing` / `not_suppressed` outcomes — the summary carries those counts. |
| `lib/jobs/functions/digest-audit-retention.ts` (Phase 8AB) | `cron` | `digest_retention_archive` | One row per venue represented in the archived batch. `metadata = { archived_count, failed_count, retention_days, batch_limit }`. NOT written in dry-run mode. |

`recordDigestAuditEvent` is best-effort: failures log + Sentry-capture and the caller continues. HTTP responses never depend on audit-write success.

### Audit endpoint contract

`GET /api/admin/digest/audit-events`

Auth: `requireAdmin()` + cross-tenant `requireVenueRole(ADMIN_ROLES)` (404 on miss).
Rate-limit: `admin:digest-audit-events:{userId}`.

Query params:

```
venue_id?:           uuid
action?:             string (max 80, exact match)
actor_kind?:         operator | cron | system | all   (default all)
target_user_id?:     uuid
since?:              ISO datetime
occurred_before?:    ISO datetime   (descending cursor, strict `<`)
limit?:              1..200, default 50
format?:             json | csv
```

JSON response:

```json
{
  "items": [
    {
      "id": "<uuid>",
      "venue_id": "<uuid>",
      "actor_user_id": "<uuid|null>",
      "actor_kind": "operator|cron|system",
      "action": "<string>",
      "target_user_id": "<uuid|null>",
      "target_email_masked": "o***@example.com|null",
      "reason": "<string|null>",
      "metadata": { ... },
      "occurred_at": "<iso>"
    }
  ],
  "next_cursor": "<iso|null>",
  "has_more": false
}
```

### CSV format

- `Content-Type: text/csv; charset=utf-8`
- `Content-Disposition: attachment; filename="digest-audit-events-YYYY-MM-DD.csv"`
- UTF-8 BOM, CRLF line terminators, RFC-4180-quoted cells
- Columns:
  ```
  id, venue_id, actor_kind, actor_user_id, action, target_user_id,
  target_email_masked, reason, occurred_at, metadata_json
  ```
- `metadata_json` is a compact JSON serialization of the row's metadata jsonb. Quoted when the cell contains `"`, `,`, or newlines.
- `X-Has-More` + `X-Next-Cursor` response headers mirror the digest-sends route (Phase 8Z).

### Dry-run behavior

`DIGEST_AUDIT_RETENTION_DRY_RUN=1` (alongside `DIGEST_AUDIT_RETENTION_ENABLED=1`) puts the retention cron into preview mode. Returns:

```json
{
  "dry_run": true,
  "candidate_count": 123,
  "sample_ids": ["<uuid>", "<uuid>", "..."],
  "retention_days": 365
}
```

`sample_ids` is capped at 25 entries so a 500-row batch doesn't dump a half-megabyte of UUIDs into Inngest's run history. Operators wanting the full set can query directly. No `outbound_messages.metadata` is mutated. No `digest_audit_events` row is written.

With `DIGEST_AUDIT_RETENTION_ENABLED` unset / not `'1'`, the dry-run flag is ignored — the cron short-circuits at the enabled gate before the dry-run check.

### `Show archived` behavior

DigestAuditFeed (`/dashboard/settings/billing`):

- Checkbox above the chip strip labeled "Show archived".
- Default `false`; persisted in `localStorage['venuerise:digest-audit-feed:include-archived:v1']`.
- When `true`, threads `?include_archived=true` into:
  - Initial fetch
  - Load older requests
  - CSV export URL
- Archived rows render with an additional slate `Archived` tag beside the Kind badge so operators can tell archived from live at a glance.
- Toggle change triggers a page-1 refetch (via the existing `useEffect` dependency on `includeArchived`).

### Cron-health realtime behavior

`RealtimeDigestSendsLayer` (Phase 8Z, extended in 8AC):

- On every qualifying INSERT (`related_table='tour_status_events'` AND `metadata.tour_digest_send_kind` present), still:
  - Toasts "New digest send recorded"
  - Debounces `router.refresh()` by 1000ms
  - Dispatches `venuerise:digest-suppression-refresh` if `status === 'suppressed'` (Phase 8AA)
- NEW: also dispatches `venuerise:digest-cron-fired` when `metadata.tour_digest_send_kind === 'cron'`.

`DigestCronHealthCard` registers a window-level `addEventListener` for `venuerise:digest-cron-fired` on mount, refetches health snapshot on every event, removes listener on unmount.

### Known caveat — audit helper is best-effort

`recordDigestAuditEvent` is intentionally fire-and-forget for the caller. Suppression delete commits; the audit row attempts to write; the HTTP response returns regardless. This means:

- A storage / network blip during the audit insert produces a `digest_audit_events.insert_failed` warn + Sentry capture, but the operator sees a successful UI response.
- An operator reviewing the audit log later may not see EVERY suppression removal — the structured log `digest_audit_events.recorded` (info-level) is the authoritative ledger. Logs > audit table when they disagree.
- Bulk remove writes one summary row even if the per-target writes that follow it fail (or vice versa). The summary's `removed_count` is the canonical totals.

If audit fidelity becomes a hard requirement, a future phase can move the helper into the same transaction as the suppression delete using a Postgres function.

## 7ak. Digest audit search, pagination, action families, and cron-send audit events (Phase 8AD)

### Endpoint query contract

`GET /api/admin/digest/audit-events` now accepts:

| Param | Type | Default | Notes |
|---|---|---|---|
| `venue_id` | uuid | caller's primary | Cross-tenant requires ADMIN_ROLES; collapse to 404 |
| `action` | string (max 80) | — | Exact match; wins over `action_family` |
| `action_family` | `suppression \| retention \| cron \| all` | `all` | Server-side fan-out (see mapping) |
| `actor_kind` | `operator \| cron \| system \| all` | `all` | Exact match |
| `target_user_id` | uuid | — | Exact match (indexed) |
| `since` | ISO datetime | — | `occurred_at >= since` |
| `occurred_before` | ISO datetime | — | Strict `<` cursor for pagination |
| `q` | string (max 120) | — | Trimmed; ILIKE across allowlist (see below) |
| `limit` | int 1..200 | 50 | |
| `format` | `json \| csv` | `json` | |

JSON response (unchanged from Phase 8AC):

```json
{
  "items": [...],
  "next_cursor": "<iso|null>",
  "has_more": false
}
```

`next_cursor = items[items.length-1].occurred_at` when `has_more === true`, else `null`.

### Action-family mapping

```ts
suppression  → ['suppression_remove', 'suppression_remove_noop', 'suppression_remove_all']
retention    → ['digest_retention_archive']
cron         → ['digest_send_cron']               // populated only when DIGEST_AUDIT_LOG_CRON_SENDS=1
all          → no family filter
```

Implementation is a single `IN (...)` clause against `digest_audit_events.action` — the `(action, occurred_at desc)` index from migration 017 handles it natively. `action` exact filter wins when both are supplied.

### `q` search allowlist

Server-side `q` (case-insensitive ILIKE) matches:
- `action`
- `reason`
- `target_email_masked`

`metadata::text` is NOT searched — no trigram index on `digest_audit_events.metadata` (the Phase 8R/8S pg_trgm index is `tour_status_events` only); a full scan would be expensive enough to justify a separate phase. Operators needing deep metadata search should hit the SQL editor directly.

UUID columns (`actor_user_id`, `target_user_id`) are also out of the search allowlist — PostgREST's `.or()` parser can't cast and ILIKE on a uuid column requires `::text`. Use the indexed `?target_user_id=` exact filter instead.

User term escapes `\`, `%`, `_` (defangs ILIKE wildcards inside the literal) and strips `,`, `(`, `)` (prevents `.or()` syntax escape). Mirrors the Phase 8AA pattern on `/api/admin/digest/sends`.

### Cron-send audit env behavior

`DIGEST_AUDIT_LOG_CRON_SENDS=1` enables per-recipient audit writes from the operator-activity-digest cron:

```json
{
  "actor_kind": "cron",
  "action": "digest_send_cron",
  "target_user_id": "<uuid>",
  "target_email_masked": "o***@example.com",
  "metadata": {
    "venue_id": "<uuid>",
    "event_count": 12,
    "cadence": "daily",
    "weekly_day": null,
    "outbound_message_id": "<uuid|null>",
    "send_kind": "cron"
  }
}
```

Defaults off because a busy multi-venue deployment can produce one audit row per recipient per day (≈ MAX_RECIPIENTS_PER_VENUE × venue_count × 365). Operators who need forensic per-send coverage flip on per environment.

Writes happen on the success branch only (after `sendEmail` returns `delivered: true`). Suppressed / failed / console-fallback paths do NOT write audit rows — those branches already surface via structured cron logs.

The audit helper is best-effort: a failure logs + Sentry-captures and never throws. A cron send that succeeded but failed to audit still counts as `summary.sent` and the operator's mailbox still receives it.

### CSV behavior

The CSV branch (`?format=csv`) honors all new filters (`q`, `occurred_before`, `action_family`). Columns are unchanged:

```
id, venue_id, actor_kind, actor_user_id, action, target_user_id,
target_email_masked, reason, occurred_at, metadata_json
```

Response headers `X-Has-More` + `X-Next-Cursor` mirror the Phase 8Z digest-sends pagination.

### Known caveat — metadata search omitted

The `q` search does NOT cover `metadata::text`. An operator searching for `"outbound_message_id":"abc"` won't find the row via `?q=`. Workarounds:

1. **Use the existing `?target_user_id=` or `?actor_user_id=` exact filters** when you know the user uuid.
2. **Drop to SQL:** `select * from public.digest_audit_events where metadata::text ilike '%abc%' order by occurred_at desc limit 50;`
3. **Future:** add a generated `metadata_text` column + GIN trigram index (same pattern as migration 015 for `tour_status_events`). Deferred until volume justifies it.

### Example curl calls

```bash
# Recent suppression removals
curl -s -H "Cookie: <session>" \
  'http://localhost:3000/api/admin/digest/audit-events?action_family=suppression&limit=10' \
  | jq '.items[] | {when: .occurred_at, target: .target_email_masked, action}'

# Find rows mentioning "Sara" (might be a reason breadcrumb or
# a masked email starting with "S")
curl -s -H "Cookie: <session>" \
  'http://localhost:3000/api/admin/digest/audit-events?q=Sara&limit=25' \
  | jq '.items[] | {action, reason, target_email_masked}'

# Cron-send audit rows from yesterday (only populated when
# DIGEST_AUDIT_LOG_CRON_SENDS=1 was set when the cron fired)
curl -s -H "Cookie: <session>" \
  'http://localhost:3000/api/admin/digest/audit-events?action_family=cron&since=2026-05-18T00:00:00Z&limit=200'

# Paginate: read X-Next-Cursor from the previous page and chain
curl -s -H "Cookie: <session>" \
  'http://localhost:3000/api/admin/digest/audit-events?limit=25&occurred_before=2026-05-19T08:00:00.000Z'

# CSV with filter
curl -s -H "Cookie: <session>" \
  'http://localhost:3000/api/admin/digest/audit-events?format=csv&action_family=retention&limit=200' \
  -o digest-retention-events.csv
```

## 7al. Digest audit URL state, metadata search, and preview audit rows (Phase 8AE)

### URL query param contract

`DigestAuditLogCard` syncs the following params to the billing-page URL (`/dashboard/settings/billing`):

| Param | When set | When cleared |
|---|---|---|
| `digest_audit_family` | Chip click (any value except `all`) | Chip click → `all`; Reset |
| `digest_audit_q` | Debounced 300ms after every keystroke (non-empty) | Empty input; Reset |
| `digest_audit_cursor` | Load older click → `next_cursor` from the previous response | Chip / search change; Reset |

`router.replace` (not `push`) — the browser back button still exits the billing page on first click rather than walking through filter history.

URL precedence: URL > localStorage > defaults. On page mount the initial render reads `searchParams` synchronously, so the first fetch already targets the right filter (no double-fetch).

### localStorage key

`venuerise:digest-audit-log:family:v1`

Holds the most-recent non-`all` family chip. Read only when the URL has no `digest_audit_family` param. Cleared on Reset.

`q` is **URL-only** — typed search terms aren't persisted across page reloads. A stuck filter survives a tab refresh only when the operator deliberately bookmarked or shared the URL.

### `q_mode` table

| Term length | `q_mode` | Searched fields |
|---|---|---|
| 0 (empty after trim) | `none` | — |
| 1-2 chars | `scalar_short` | `action`, `reason`, `target_email_masked` |
| 3+ chars | `metadata_indexed` | `action`, `reason`, `target_email_masked`, **`metadata_text`** |

Mirrors the Phase 8T short-query short-circuit on `/api/admin/tours/status-events`. UUID columns (`actor_user_id`, `target_user_id`) remain out of the search allowlist — PostgREST `.or()` can't compose a casted ILIKE expression. Use the indexed `?target_user_id=` / `?actor_user_id=` exact filters when you know the uuid.

Log line includes `qMode` + `qLen` so operators can confirm which path served their query.

### `metadata_text` index explanation

Migration 018:

```sql
create extension if not exists pg_trgm;

alter table public.digest_audit_events
add column if not exists metadata_text text
generated always as (coalesce(metadata::text, '')) stored;

create index if not exists digest_audit_events_metadata_text_trgm_idx
on public.digest_audit_events
using gin (metadata_text gin_trgm_ops);
```

- `metadata_text` is a generated **stored** column (write cost amortized over reads; pgvector-style "compute once, scan many").
- `coalesce(..., '')` keeps the index entry for rows whose `metadata` is null (rare on this table since the column defaults to `'{}'::jsonb`).
- The GIN trigram index makes `metadata_text ILIKE '%term%'` planner-eligible at ≥ 3 chars. Below 3 chars Postgres won't use the trigram index, so the route deliberately skips the clause.

Pre-existing rows are backfilled automatically — Postgres re-evaluates the generation expression on the next read after the column is added.

### Action family mapping (including preview)

```ts
suppression  → ['suppression_remove', 'suppression_remove_noop', 'suppression_remove_all']
retention    → ['digest_retention_archive']
cron         → ['digest_send_cron']            // only when DIGEST_AUDIT_LOG_CRON_SENDS=1
preview      → ['digest_send_preview']         // only when DIGEST_AUDIT_LOG_CRON_SENDS=1 (Phase 8AE)
all          → no family filter
```

`action` exact filter still wins over `action_family` when both are supplied. `DigestAuditLogCard` chip strip now reads `All / Suppression / Retention / Cron / Preview`.

### Preview audit row behavior

`POST /api/admin/digest/preview` writes one `digest_audit_events` row after a successful send when `DIGEST_AUDIT_LOG_CRON_SENDS=1`:

```json
{
  "actor_kind": "operator",
  "actor_user_id": "<caller uuid>",
  "action": "digest_send_preview",
  "target_user_id": "<caller uuid>",
  "target_email_masked": "o***@example.com",
  "metadata": {
    "venue_id": "<uuid>",
    "event_count": 12,
    "cadence": "daily",
    "weekly_day": null,
    "outbound_message_id": "<uuid|null>",
    "send_kind": "preview"
  }
}
```

`target_user_id` equals `actor_user_id` because preview always targets the caller. Best-effort write — failure to audit never turns a successful preview into a 5xx. The audit row only fires on the success path; failure / suppression / console-fallback branches don't write.

### Why the feature is gated behind `DIGEST_AUDIT_LOG_CRON_SENDS`

The Phase 8AE preview audit reuses the Phase 8AD cron-send audit env gate rather than introducing `DIGEST_AUDIT_LOG_PREVIEW_SENDS`. Rationale:

1. Operators flip one knob to enable "every per-recipient digest send is auditable" coverage.
2. Volume profile stays predictable — both paths log only when the operator opts in.
3. Operators wanting just preview audits can filter via `?action_family=preview` after the fact; no env-level granularity buys much.

If a future deployment needs to log preview but not cron (or vice versa), introducing a separate flag at that point is straightforward and backward-compatible.

### Example curl calls

```bash
# Metadata-indexed search (3+ chars: searches metadata_text too)
curl -s -H "Cookie: <session>" \
  'http://localhost:3000/api/admin/digest/audit-events?q=retention_policy&limit=10' \
  | jq '.items[] | {action, reason, metadata}'

# Scalar-short search (1-2 chars: scalar columns only)
curl -s -H "Cookie: <session>" \
  'http://localhost:3000/api/admin/digest/audit-events?q=ab&limit=10'

# Preview family
curl -s -H "Cookie: <session>" \
  'http://localhost:3000/api/admin/digest/audit-events?action_family=preview&limit=25'
```

## 7am. Digest audit drawer and URL-synced sends feed (Phase 8AF)

### Audit log URL params

`DigestAuditLogCard` (Phase 8AE/8AF):

| Param | When set | When cleared |
|---|---|---|
| `digest_audit_family` | Chip click != `all` | Chip → `all`; Reset; Jump to latest never clears (preserved) |
| `digest_audit_q` | Debounced 300ms after non-empty input | Empty input; Reset |
| `digest_audit_cursor` | Load older click | Chip / search / Reset / Jump to latest |

Cursor URL state is now read+written: on initial mount the value is parsed (must be a valid ISO datetime; garbage is silently ignored), threaded into the first fetch as `?occurred_before=`, and surfaces an amber "Viewing an earlier audit page." banner with a Jump to latest button. Jump to latest clears the cursor in memory + URL but preserves family + search.

### Send feed URL params

`DigestAuditFeed` (Phase 8AF):

| Param | When set | When cleared |
|---|---|---|
| `digest_send_kind` | Chip click != `all` | Chip → `all`; Reset |
| `digest_send_recipient` | Recipient-summary click (or external deep-link) | Click again (toggle); Reset |
| `digest_send_q` | Debounced 300ms; URL-only (never persisted) | Empty input; Reset |
| `digest_send_cursor` | Load older click | Chip / search / recipient / archived / Reset / Jump to latest |
| `digest_send_archived` | Show archived toggle on | Toggle off; Reset |

Same cursor-read pattern + earlier-page banner as the audit log.

localStorage keys (Phase 8AF):
```
venuerise:digest-send-feed:kind:v1
venuerise:digest-send-feed:recipient:v1
venuerise:digest-send-feed:include-archived:v1
```

Plus the Phase 8AC legacy archived key (`venuerise:digest-audit-feed:include-archived:v1`) is still honored for one release cycle — an operator who enabled Show archived before the rename keeps the preference after upgrade. Reset clears both.

### Cursor-read behavior

Both cards: a hand-edited / non-ISO `?digest_audit_cursor=garbage` or `?digest_send_cursor=garbage` is silently ignored (treated as no cursor). Valid cursors are passed through as `?occurred_before=` on the next fetch.

### Jump to latest behavior

- Clears the in-memory `initialCursor` + the URL param.
- Refetches page 1 with current family / search / recipient / archived intact.
- Earlier-page banner disappears.

### Drawer fields

`DigestAuditEventDrawer` renders:
- Header: action badge, actor label, occurred timestamp
- Field grid (3-col):
  - Event ID (with Copy audit ID button)
  - Venue ID
  - Actor kind
  - Actor user ID
  - Target user ID
  - Target email (masked)
  - Reason (full row span)
- Pretty-printed `metadata` JSON in a scrollable `<pre>` block (Copy metadata JSON button)
- "View related digest send" affordance — only when `metadata.outbound_message_id` is present

No `dangerouslySetInnerHTML`. Metadata renders as `<pre>{JSON.stringify(...)}</pre>` so any `<script>` payload stays inert text. Copy buttons fall back to a "Copy failed" inline state when `navigator.clipboard` isn't available (insecure context / older browser).

### Related outbound row link behavior

Clicking "View related digest send" in the drawer:
1. Reads `metadata.outbound_message_id` from the audit row.
2. Sets `?digest_send_q=<outbound_message_id>` on the billing page URL (via `router.replace` so the back button still exits the page on first click).
3. Clears any stale `?digest_send_cursor=` to start the search at page 1.
4. Closes the drawer.

`DigestAuditFeed`'s debounced search settles on the next render and the matching outbound row appears at the top of the table. The audit row's family / q / cursor are preserved — the operator can re-open the drawer for adjacent audit rows without losing the deep-link.

### Optional unique index behavior

Migration 019 adds:

```sql
create unique index digest_audit_events_cron_send_daily_unique_idx
  on public.digest_audit_events
  (venue_id, target_user_id, action, ((occurred_at at time zone 'utc')::date))
  where action = 'digest_send_cron';
```

Belt-and-suspenders against duplicate `digest_send_cron` rows from cron retries. The outbound_messages send_kind probe (Phase 8W) already prevents the underlying duplicate delivery; this index hedges against a future audit-write-only retry path.

When the helper hits the index, it returns `{ ok: false, error: 'duplicate' }` and logs `digest_audit_events.duplicate_skipped` at info level. The cron treats this as success and continues. Other action families (`suppression_*`, `digest_retention_archive`, `digest_send_preview`) are NOT covered — those legitimately produce multiple rows per (venue, target, day) under normal operator usage.

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

---

## §8au — Revenue OS digest reframe (Phase 8AU)

The operator activity digest body now leads with Revenue OS
sections (leakage / speed-to-lead / recovery / tour booking). The
old tour-status-events tables still render — they're moved to a
quieter "operator activity log" container at the bottom of the
email.

### Smoke checks

1. **Preview**: from `/dashboard/settings/billing`, click **Send
   sample Revenue OS digest**. Inspect the inbox.
   - Subject: `Your VenueRise Revenue OS summary`
   - HTML body contains the Revenue leakage opening, three metric
     tiles, follow-up recovery rows, tour booking rows, the three
     CTAs, and the demoted operator activity log section.
   - Plaintext fallback contains the same sections.
   - Footer still carries the cadence sentence + manage-preferences
     link + unsubscribe + resubscribe (when configured).
2. **Manual send**: same card, **Send manual Revenue OS digest**.
   The outbound row's `metadata.tour_digest_send_kind` is still
   `manual`. The cron's per-recipient idempotency probe (`= 'cron'`)
   continues to ignore manual sends.
3. **Cron**: trigger the Inngest function manually
   (`operator-activity-digest`). For any venue with ≥1
   tour_status_event in the 24h window, the body should include the
   Revenue OS sections + the demoted log. For a venue with zero
   events the cron still SKIPS (existing 8R gating behavior;
   reframing didn't change cadence).

### Behavior preserved

- Cadence (daily / weekly / off) per recipient
- Idempotency probe + audit feed compatibility
- Suppression handling
- Send kind discriminator (`cron` / `preview` / `manual`)
- Per-user opt-out via member metadata + venue subscription metadata
- Unsubscribe / resubscribe token links
- Preview suppression UX (409 → friendly inline copy)
- Sample sent / Manual digest sent inline acknowledgement

### Fallback posture

If the Revenue OS probe (`fetchRevenueOsDigestSummary`) fails for
any reason — a transient DB hiccup, a venue without leads, etc. —
the body builder falls back to the legacy tour-status-events-only
template. The digest still goes out; the operator activity log is
the only content. Log line:
`jobs.operator_activity_digest.revenue_os_fetch_failed`.

---

## §8av — Brand Voice confidence + escalation gate (Phase 8AV)

### Smoke checks

1. **Regenerate produces confidences.**
   - Open a lead drawer with an existing AI draft. Click
     **Regenerate** (variant_count: 3).
   - Network tab: `POST /api/ai/draft` response includes
     `confidences: [n, n, n]` parallel to `drafts`.
   - DB:
     `select id, metadata->'variant_confidences', metadata->'min_confidence' from public.ai_actions order by created_at desc limit 1;`
     — confidences are persisted alongside the variants.

2. **Drawer chip surfaces in three states.**
   - Above-floor: pill reads `Awaiting review · 82/100` (blue).
   - Below-floor: pill reads `Low confidence · 58/100` (amber).
   - Mid-regenerate: pill reads `Regenerating`.

3. **Escalation mode behaves per setting.**
   - `off`: chip renders; Approve & send stays enabled, no extra
     status line.
   - `warn` (default): chip renders + amber "Operator approval
     recommended" status line above the action footer; Approve &
     send stays enabled.
   - `block`: chip renders + red status line; Approve & send is
     disabled until the operator regenerates, saves an edit, or
     picks a higher-confidence variant.

4. **AIDraftAuditCard filter + badge work.**
   - Pick the **Low confidence** chip. Card narrows to rows where
     `min_confidence < brandVoiceConfidenceFloor`.
   - Each flagged row shows the amber `Low conf · {N}` badge.
   - CSV export with `?low_confidence=true` returns the narrowed
     slice; `min_confidence` + `low_confidence` columns present.

### Behavior preserved

- Variant catalog persistence (Phase 8AM) still works; we just
  added two fields to the same metadata block.
- Approve & send still tags `messages.metadata.ai_action_id +
  selected_variant_index` (Phase 8AM) so the audit join keeps
  working.
- VariantReplayDrawer (Phase 8AN) renders unchanged — its data
  source is the same `ai_actions` row.
- Stale guard (Phase 8AL teammate + 8AM lead-replied) composes
  with the new gate: Approve disabled if EITHER teammate-stale OR
  block-mode-low-confidence.
- DigestAuditFeed / DigestAuditLogCard untouched.

### Fallback posture

- **Model forgot `CONFIDENCE:` line** → text heuristic (length +
  hedging + CTA presence + first-name) supplies a score in the
  same 0..100 scale. No silent unrated variants.
- **Pre-8AV ai_actions rows** (no `variant_confidences` field) →
  `min_confidence: null`, `low_confidence: false`. Not retroactively
  flagged.
- **Venue settings probe failure** → drawer keeps using
  `DEFAULT_REVENUE_OS_SETTINGS` (floor 70, mode `warn`). The chip
  + gate still work against the default.

---

## §8aw — Brand Voice calibration telemetry (Phase 8AW)

### Smoke checks

1. **Regenerate persists split confidences.**
   - Open a lead drawer with an existing AI draft. Click
     **Regenerate** (variant_count: 3).
   - DB check:
     `select metadata->'variant_confidences', metadata->'model_variant_confidences', metadata->'heuristic_variant_confidences', metadata->'confidence_adjustment_deltas', metadata->>'confidence_source' from public.ai_actions order by created_at desc limit 1;`
     — all four arrays present (lengths match `variant_count`).
     `confidence_source` is `model_and_heuristic` when the model
     emitted CONFIDENCE; `heuristic_fallback` when every variant
     fell back to heuristic. Existing `variant_confidences` still
     carries the FINAL (capped) scores so 8AV readers keep working.

2. **Approve & send writes operator_outcome.**
   - Approve a draft as-is. DB:
     `select metadata->>'operator_outcome', metadata->>'edit_distance_bucket', metadata->>'selected_variant_was_low_confidence' from public.ai_actions where id = '<the ai_action_id>';`
     — `operator_outcome='sent_as_is'`, `edit_distance_bucket='none'`.
   - Approve another after editing the body materially. The same
     row updates to `sent_after_edit` + bucket `minor|moderate|
     major` depending on edit volume.

3. **Regenerate marks the prior draft.**
   - Generate a draft. Without sending, click **Regenerate**.
   - DB: the PRIOR row's `operator_outcome` is `regenerated`,
     `operator_outcome_at` is set. The new row stays open.

4. **Calibration panel renders.**
   - Visit `/dashboard/settings/billing` as an admin.
   - **Brand Voice Calibration** panel sits ABOVE the AIDraftAuditCard.
   - Four tiles populate (low-confidence rate, avg confidence,
     regenerate rate, edit-before-send rate). Two signal cards
     (Overconfidence + Venue context) show low/medium/high +
     healthy/needs_more_context based on the loaded page slice.
   - Panel refreshes when a new draft fires (same realtime event
     the AIDraftAuditCard listens to).

5. **Per-row detail line on the AIDraftAuditCard.**
   - Each row with 8AW data shows a muted "Final 68 · Model 84 ·
     Heuristic 58" line under the existing chips, plus the
     operator outcome chip when one is recorded.
   - Pre-8AW rows do NOT render the line (no visual noise on
     historical data).

### Behavior preserved

- `confidences` API response from `/api/ai/draft` (8AV) unchanged.
- `variant_confidences` field name (8AV) unchanged.
- AIDraftAuditCard filter chips + CSV export + "Low confidence"
  badge still work; new fields are additive on the same payload.
- Approve & send still tags `messages.metadata.ai_action_id`. The
  outcome write to `ai_actions` is BEST-EFFORT and never blocks
  the send — if the source row read fails, the message still
  reaches the lead.
- VariantReplayDrawer untouched (same row, additional metadata
  keys it doesn't read).

### Fallback posture

- **Source ai_actions row missing or cross-tenant** → outcome
  write is silently skipped. Log line:
  `conversations.messages.outcome_mark_failed`.
- **Outcome already set** (e.g. operator regenerated before the
  late send landed) → terminal-once; we don't overwrite the
  earlier signal.
- **Pre-8AW rows** → `page_summary` treats them as
  `operator_outcome: 'unknown'`. They show up in the
  `unknownOutcome` count and don't inflate sent/regenerate rates.
- **page_summary computation failure** → the JSON branch still
  returns `items + has_more + next_cursor`. The panel renders an
  error and exposes Retry; the card below keeps working.

---

## §8ax — Safe Autopilot Guardrails + Draft Approval Mode (Phase 8AX)

### Smoke checks

1. **Regenerate produces autopilot decisions.**
   - Open a lead drawer with an existing AI draft. Click
     **Regenerate** (variant_count: 3).
   - Network tab: `POST /api/ai/draft` response includes
     `autopilot_decisions: [{mode, label, helper, reasons,
     confidence}, …]` parallel to `drafts[]`.
   - DB check:
     `select metadata->'autopilot_decisions', metadata->'variant_risk_flags' from public.ai_actions order by created_at desc limit 1;`
     — both arrays present, length matches `variant_count`.

2. **Drawer pill renders + updates with variants.**
   - Regenerate with 3 variants. Under the existing confidence
     chip, an **Autopilot** label + decision pill appears with a
     one-sentence helper.
   - Click variant pill option 2 / option 3 — the autopilot pill
     + helper line update to the new variant's decision.
   - The pill is hidden while regenerating / editing / rejected
     (transient states; nothing stale).

3. **Pricing / policy / availability force Blocked.**
   - In the regenerate flow, send an instruction like "Add
     pricing for the Garden package" so the draft mentions
     `price` / `package` / `deposit`.
   - The decision pill renders **Autopilot blocked** (red).
   - DB: `metadata->'autopilot_decisions'->0->>'mode' = 'blocked'`
     and `metadata->'variant_risk_flags'->0->>'has_pricing_question'
     = 'true'`.

4. **No autonomous send.**
   - Approve & send still requires manual click.
   - There is no auto-send button anywhere in the drawer.
   - `select count(*) from public.messages where venue_id = '<id>'
     and role = 'human' and created_at > now() - interval '5 minutes';`
     — count only grows when an operator clicks.

5. **AIDraftAuditCard detail line shows autopilot + risk.**
   - On `/dashboard/settings/billing`, the per-row detail line
     now reads "Final 82 · Model 88 · Heuristic 76 · Eligible"
     (or `· Review required · pricing risk`, `· Blocked · policy
     risk`, etc.) for 8AX+ rows. Pre-8AX rows omit the autopilot
     suffix.
   - Hovering the line shows the reason codes in the tooltip.

6. **BrandVoiceCalibrationPanel readiness breakdown.**
   - Above the AIDraftAuditCard, the panel now shows an
     **Autopilot readiness** block: three pills (Eligible /
     Review required / Blocked) with percentages over the
     page slice's scored rows.
   - The disclaimer "This does not enable autonomous sending"
     is visible.
   - Pre-8AX rows surface as an "X pre-8AX row(s) excluded" note.

7. **CSV export carries autopilot columns.**
   - Click Export CSV from the AIDraftAuditCard.
   - Open in a spreadsheet: `autopilot_mode` + `risk_flags`
     columns are present. `risk_flags` is `|`-joined (e.g.
     `pricing|availability`) so each row stays one cell.

8. **`/api/health` shows the 5 new flags.**
   - `brand_voice_autopilot_guardrails`,
     `draft_risk_detection`, `lead_drawer_autopilot_decision`,
     `draft_audit_autopilot_breakdown`,
     `autonomous_sending_still_disabled` all return `'mounted'`.

### Behavior preserved

- API response from `/api/ai/draft` still includes `draft`,
  `drafts[]`, `confidences[]`, `ai_action_id` unchanged.
- Persisted metadata field names (`variant_confidences`,
  `min_confidence`, `model_variant_confidences`,
  `heuristic_variant_confidences`, `confidence_adjustment_deltas`,
  `confidence_source`, `operator_outcome`, `edit_distance_bucket`)
  all unchanged. 8AX adds two new fields and nothing else.
- AIDraftAuditCard filters + CSV + realtime layer untouched.
- VariantReplayDrawer untouched.
- The brand voice escalation gate from 8AV still works
  independently — `block` mode still hard-blocks Approve & send
  on a low-confidence variant; 8AX's decision pill is informational.

### Fallback posture

- **`detectDraftRiskFlags` on empty / non-string input** →
  returns all-false. Never throws.
- **`computeAutopilotDecision` with `finalConfidence: null`** →
  emits `review_required` (the safe middle), never `eligible` or
  `blocked` based on missing signal.
- **Pre-8AX rows** → `autopilot_mode: null`, `risk_flags: []` on
  the audit response. The card detail line hides the autopilot
  suffix; the readiness breakdown counts them as `unknown` and
  excludes them from percentages.
- **Server build pre-8AX (no `autopilot_breakdown` in response)** →
  the panel renders the calibration tiles normally and just omits
  the autopilot readiness card.

---

## §8ay — Autopilot Simulation Mode (Phase 8AY)

### Smoke checks

1. **`/api/admin/ai/autopilot-simulation` unauthenticated → 401.**
   - `curl -i http://localhost:3000/api/admin/ai/autopilot-simulation`
     returns 401 `unauthorized` (no session cookie).

2. **Authenticated admin → returns summary.**
   - From `/dashboard/settings/billing`, open DevTools and run
     `fetch('/api/admin/ai/autopilot-simulation?venue_id=<id>')`.
     The response carries `{venue_id, window_days, summary,
     buckets, recent_rows}`. `summary.readiness` is one of
     `not_ready` / `watch` / `promising`.

3. **`days=7` narrows the window.**
   - `?days=7` returns `window_days: 7` and a smaller scored
     count than `?days=30`. `?days=0` or `?days=91` returns 400
     `validation_failed`.

4. **Cross-tenant venue_id denied as 404.**
   - As an admin of venue A, hit
     `?venue_id=<venue B uuid>` — returns 404 `not_found` (NOT
     403, so the route doesn't leak whether B exists).

5. **AutopilotSimulationPanel renders.**
   - On `/dashboard/settings/billing` it sits between the
     BrandVoiceCalibrationPanel and the AIDraftAuditCard.
     Header reads "Would the AI have been safe to send?";
     subtitle reinforces "Simulation only. No autonomous
     messages are sent."
   - Four tiles (Would send / Review required / Would block /
     Estimated time saved) populate.

6. **No-data state.**
   - On a venue with no 8AX+ draft_regenerate rows, the panel
     shows "No simulation data yet. Regenerate and approve a
     few drafts to build a safety profile."

7. **Regenerate + approve updates the panel.**
   - Generate a draft → approve & send.
   - Refresh `/dashboard/settings/billing`. The Would-send
     tile increments (if the autopilot decision was
     `eligible`); the bucket section's Eligible.sent_as_is
     row increments; `Estimated time saved` grows.
   - Realtime: the next regenerate fires
     `venuerise:ai-draft-audit-fired`, which refreshes the
     panel automatically (no manual reload).

8. **AIDraftAuditCard still renders.**
   - The card below the simulation panel renders unchanged.
     Per-row detail line still shows the 8AW/8AX suffixes.

9. **CSV export from draft audit carries 8AY columns.**
   - Click Export CSV from the AIDraftAuditCard.
   - Open in a spreadsheet: `simulation_mode`,
     `operator_alignment`, `estimated_time_saved_minutes`
     columns are present alongside the 8AW/8AX columns.

10. **`/api/health` shows new flags + bumped count.**
    - `autopilot_simulation_mode`, `autopilot_simulation_summary`,
      `autopilot_operator_alignment`, `autopilot_simulation_panel`
      all return `'mounted'`.
    - `autonomous_sending_still_disabled` is STILL `'mounted'`
      (carried forward from 8AX; not duplicated).
    - `admin.endpoints` returned 31 in 8AX; now returns 32.

11. **No autonomous send occurs.**
    - Sanity check:
      `select count(*) from public.messages where venue_id = '<id>'
       and role = 'human' and created_at > now() - interval '1 hour';`
      count only grows from operator clicks. Nothing on this
      panel calls a write route.

### Behavior preserved

- Existing `/api/admin/ai/draft-audit` JSON branch shape: every
  field from 8AV/8AW/8AX still present. 8AY only adds fields.
- AIDraftAuditCard filters + CSV + realtime layer untouched.
- BrandVoiceCalibrationPanel + RevenueOsSettingsCard untouched.
- The 8AV escalation gate still hard-blocks Approve & send on a
  low-confidence variant in `block` mode; 8AY's simulation
  numbers are informational and never gate the button.

### Fallback posture

- **Pre-8AX rows** (no `autopilot_decisions` in metadata) →
  `simulation_mode: 'would_require_review'` (safe default —
  never `would_send`), `operator_alignment: 'unknown'`,
  `estimated_time_saved_minutes: null`. They land in the
  `summary.unknown` bucket and are EXCLUDED from `total_scored`.
- **Operator hasn't acted yet** → outcome is null →
  `operator_alignment: 'unknown'`. Counted in `summary.unknown`,
  not in readiness.
- **`operator_outcome_at` missing on an eligible+sent_as_is row** →
  `estimateTimeSavedMinutes` falls back to a flat 3-minute
  credit per row (rather than null, so the time-saved tile
  isn't entirely zero for venues that pre-date the outcome-at
  write).
- **Window load failure** → route returns 500
  `unexpected_error`; the panel renders the error banner with
  Retry; the AIDraftAuditCard + calibration panel below keep
  working independently.
- **MAX_ROWS_PER_WINDOW (1000) ceiling** → on pathological
  venues the route returns the most recent 1000 rows. The
  summary block is still correct over THAT sample; the panel's
  "X drafts scored" footer makes the sample size visible.

---

## §8az — Autopilot Shadow Evaluation + Review Queue (Phase 8AZ)

### Smoke checks

1. **Migration 024 applies cleanly.**
   - `select count(*) from public.ai_action_reviews;` returns 0
     on a fresh DB; the table exists with the unique constraint
     on `ai_action_id`.
   - `select policyname from pg_policies where tablename =
     'ai_action_reviews';` returns
     `ai_action_reviews_select_venue_admin`.
   - Three indexes exist: `ai_action_reviews_venue_reviewed_idx`,
     `ai_action_reviews_state_reviewed_idx`,
     `ai_action_reviews_action_idx`.

2. **Unauthenticated GET → 401.**
   - `curl -i http://localhost:3000/api/admin/ai/autopilot-reviews`
     returns 401 `unauthorized`.

3. **Authenticated admin GET returns queue.**
   - From `/dashboard/settings/billing`, open DevTools and run
     `fetch('/api/admin/ai/autopilot-reviews?venue_id=<id>')`.
     Response carries `{items, next_cursor, has_more, summary}`.
   - `summary` includes the 8AZ fields:
     `total_disagreements`, `reviewed_disagreements`,
     `reviewed_disagreements_pct`, per-state counts, and
     `rule_signals`.

4. **Admin POST label writes/upserts the review row.**
   - From the AutopilotReviewQueue, click any row's "Guardrail
     too strict" button.
   - DB check:
     `select review_state, note, reviewer_user_id from
     public.ai_action_reviews where ai_action_id = '<id>';`
     returns the labeled state + your `auth.users.id`.
   - The row's badge updates to "Too strict" immediately
     (optimistic), and the summary strip's "Too strict" count
     increments after the post-write refresh.

5. **Relabeling the same ai_action updates, doesn't duplicate.**
   - Click "Guardrail correct" on the same row.
   - DB:
     `select count(*) from public.ai_action_reviews where
     ai_action_id = '<id>';` is still 1. `review_state` is now
     `confirmed_guardrail_correct`. `reviewed_at` advanced.
   - The unique constraint enforces this at the storage layer.

6. **Cross-tenant ai_action_id returns 404.**
   - As an admin of venue A, hit
     `POST /api/admin/ai/autopilot-reviews/<ai_action_id from
     venue B>`. Returns 404 `not_found` (NOT 403, so existence
     of B's actions isn't leaked).

7. **AutopilotReviewQueue renders below the simulation panel.**
   - On `/dashboard/settings/billing`, the order top-to-bottom
     is: BrandVoiceCalibrationPanel →
     AutopilotSimulationPanel → AutopilotReviewQueue →
     AIDraftAuditCard.

8. **Row label buttons update UI.**
   - Click any of the four label buttons. The row's state badge
     updates immediately. On error the badge reverts and an
     inline "Couldn't save label" error renders.

9. **Simulation panel rule signals update after labeling.**
   - Label a few rows that fired `pricing` risk.
   - Refresh `/dashboard/settings/billing`. The
     "Guardrail rule signals" card on AutopilotSimulationPanel
     shows `pricing risk · N reviewed · X% false positive`.

10. **`/api/health` shows new flags + bumped count.**
    - `autopilot_review_queue`, `autopilot_review_labels`,
      `autopilot_rule_signal_summary`,
      `autopilot_shadow_evaluation` all return `'mounted'`.
    - `autonomous_sending_still_disabled` is STILL `'mounted'`
      (carried from 8AX through 8AY through 8AZ; not duplicated).
    - `admin.endpoints` returned 32 in 8AY; now returns 34.

11. **No autonomous send occurs.**
    - `select count(*) from public.messages where role = 'human'
       and created_at > now() - interval '1 hour';` count only
      grows from operator clicks. Nothing in 8AZ writes to
      `messages`.

### Behavior preserved

- 8AY simulation endpoint response shape preserved. Every
  existing field still ships; 8AZ only added new ones.
- 8AX guardrails, 8AW calibration telemetry, 8AV escalation
  gate all unchanged. A `confirmed_guardrail_too_strict` label
  does NOT change any threshold or rule output.
- Approve & send still requires a manual operator click.
- AIDraftAuditCard, BrandVoiceCalibrationPanel,
  RevenueOsSettingsCard, VariantReplayDrawer untouched.

### Fallback posture

- **No reviews yet** → every state count is 0; `rule_signals`
  is empty; `reviewed_disagreements_pct` is `null`. The queue
  empty-state copy nudges the operator.
- **Pre-8AX rows in the window** → excluded from the queue
  entirely (they have no `autopilot_decisions` metadata, so
  the alignment helper returns `unknown`, which the queue
  endpoint filters out).
- **Server build pre-8AZ** → the simulation panel's "Guardrail
  rule signals" card reads `rule_signals: []` and renders the
  empty-state copy; everything else stays functional.
- **Reviews lookup fails on the simulation endpoint** →
  best-effort; the route logs
  `admin.ai.autopilot_simulation.review_lookup_failed` and
  ships the simulation response with zero review counts. The
  panel renders normally.

---

## §8ba — Autopilot Safety Scorecard + Readiness Gate (Phase 8BA)

### Smoke checks

1. **Unauthenticated GET → 401.**
   - `curl -i http://localhost:3000/api/admin/ai/autopilot-readiness`
     returns 401 `unauthorized`.

2. **Authenticated admin GET returns the verdict.**
   - From `/dashboard/settings/billing`, open DevTools and run
     `fetch('/api/admin/ai/autopilot-readiness?venue_id=<id>')`.
     Response carries `{venue_id, window_days, readiness,
     inputs, generated_at}`.
   - `readiness.verdict` is one of `not_eligible` / `watch` /
     `eligible`. `readiness.gates` lists six gates with
     `passed`, `currentValue`, `threshold`, `severity`,
     `nextStep`.

3. **`days=7` narrows the window.**
   - `?days=7` returns `window_days: 7` and typically a lower
     `inputs.total_scored`. `?days=0` or `?days=91` returns
     400 `validation_failed`.

4. **Cross-tenant `venue_id` denied as 404.**
   - As an admin of venue A, hit
     `?venue_id=<venue B uuid>` — returns 404 `not_found`
     (NOT 403, so the route doesn't leak whether B exists).

5. **Scorecard renders ABOVE the simulation panel.**
   - On `/dashboard/settings/billing`, the order is:
     BrandVoiceCalibrationPanel → **AutopilotReadinessScorecard** →
     AutopilotSimulationPanel → AutopilotReviewQueue →
     AIDraftAuditCard.
   - Card header reads "Autopilot readiness" and the title
     matches the verdict (e.g. "Autopilot is not eligible for
     this venue").

6. **Failing gates show next-step copy.**
   - On a fresh venue with no drafts, every gate fails. Each
     failing gate row shows a "Next step: …" line with copy
     like "Collect 50 more scored drafts.", "Review 6 more
     disagreements.", "Investigate pricing_risk. False-positive
     rate is 42%.", or "Wait for 4 more active days of data."

7. **Eligible state still says autonomous sending is
   disabled.**
   - If the venue qualifies, the verdict banner shows
     "Eligible (read-only)" with an emerald card.
   - The card subtitle ALWAYS reads "Autonomous sending is
     still disabled. This scorecard only measures whether a
     future opt-in could be considered."
   - The emerald caveat box appears with the persistent
     "Autonomous sending is still disabled" sentence.
   - The italic footer "No messages are sent automatically.
     This scorecard cannot enable autopilot." renders on every
     state.

8. **No toggle exists.**
   - Inspect the card: there is no "Enable autopilot" button,
     no checkbox, no submit form. The card is purely
     informational.

9. **AutopilotSimulationPanel points up to the scorecard.**
   - The italic line below the readiness card on the
     simulation panel reads "Readiness gate: see the Autopilot
     Readiness Scorecard above for the full eligibility
     checklist."

10. **`/api/health` shows new flags + bumped count.**
    - `autopilot_safety_scorecard`,
      `per_venue_autonomy_readiness_gate`,
      `autonomy_eligibility_signal` all return `'mounted'`.
    - `autonomous_sending_still_disabled` is STILL `'mounted'`
      (carried from 8AX through 8AY/8AZ/8BA; not duplicated).
    - `admin.endpoints` returned 34 in 8AZ; now returns 35.

11. **No autonomous messages are sent.**
    - `select count(*) from public.messages where role = 'human'
       and created_at > now() - interval '1 hour';` count only
      grows from operator clicks. The readiness endpoint
      reads `ai_actions` + `ai_action_reviews` and writes
      nothing.

### Behavior preserved

- 8AY simulation endpoint response shape preserved.
- 8AZ review queue endpoint response shape preserved.
- 8AX guardrails, 8AW calibration telemetry, 8AV escalation
  gate all unchanged.
- BrandVoiceCalibrationPanel, AutopilotReviewQueue,
  AIDraftAuditCard, RevenueOsSettingsCard, VariantReplayDrawer
  untouched (beyond the simulation panel's one-line pointer).
- No migration. No schema change.

### Fallback posture

- **Zero scored drafts** → every gate fails; the scorecard
  shows a "No scored drafts yet" line above the gate list
  and the verdict banner reads "Autopilot is not eligible
  for this venue."
- **Pre-8AX rows in the window** → excluded from
  `total_scored` and `windowDaysWithData` (they have no
  autopilot decision metadata). They're invisible to the
  readiness math, which is intentional.
- **Reviews lookup fails inside the readiness endpoint** →
  best-effort warn (`admin.ai.autopilot_readiness.review_lookup_failed`);
  review-coverage gates collapse to "no data" (i.e. they
  fail safe — the route never silently passes a venue
  because the review join failed).
- **Server build pre-8BA** → the simulation panel pointer
  still renders (it's static copy). Anyone hitting the
  scorecard URL gets 404 from Next.js — no harm done.
- **MAX_ROWS_PER_WINDOW (1000) ceiling** → the readiness
  numbers are accurate over the 1000 most recent rows. The
  scorecard's "Window: last 30 days" footer makes the
  sample bound explicit; future tightening can surface a
  truncation chip if it becomes a real problem.

---

## §8bd — Reactivation Outreach Cadence + Won/Lost Reason Library (Phase 8BD)

### Smoke checks

1. **Migration 026 applies cleanly.**
   - DB:
     `select column_name, data_type from information_schema.columns
        where table_schema='public' and table_name='leads'
          and column_name='metadata';`
     returns `metadata · jsonb`.
   - The GIN index `leads_metadata_gin_idx` exists.

2. **Lost reason prompt fires on stage transition.**
   - Open a lead at any non-lost stage. Click "Move to · Lost"
     in the drawer footer. An inline prompt appears with a
     reason select, optional note input, Save, and Skip.
   - The stage change itself completes BEFORE the prompt
     opens (the lead is already `lost` in the DB).

3. **Save persists, merges, and is retrievable.**
   - Pick `Ghosted`, type a 1-line note, click Save.
   - DB:
     `select metadata->'lost_reason' from public.leads
        where id = '<id>';`
     returns `{reason, note, recorded_at, recorded_by}`.
   - Refresh the drawer: the "Lost reason" display panel
     under the badge row shows the recorded reason + note +
     date.

4. **Skip leaves the lead lost-but-reasonless.**
   - Repeat with Skip instead of Save.
   - DB: `metadata` is `{}`. The lead is still `lost`.

5. **Allowlist enforcement on the PATCH route.**
   - `curl -X PATCH /api/leads/<id> -d '{"metadata":{"foo":"bar"}}'`
     — the `metadata` field is dropped (Zod only knows
     `lost_reason`); the PATCH succeeds for any other
     allowlisted fields it carries.
   - `curl -X PATCH /api/leads/<id> -d '{"lost_reason":{"reason":"not_a_real_reason"}}'`
     — returns 400 `validation_failed`.

6. **`lost_reason: null` clears the block.**
   - `curl -X PATCH /api/leads/<id> -d '{"lost_reason":null}'`
     — `metadata` no longer contains `lost_reason`. Other
     keys (if any) are preserved.

7. **ReactivationQueueCard renders on Overview.**
   - On `/dashboard`, the card sits under
     `TourConfirmationQueueCard`. With no qualifying leads
     it shows "No reactivation candidates right now."
   - With a `ghosted` lead whose last inbound is > 30 days
     ago, the card shows that lead with a "Strong candidate"
     pill + rationale + Open lead CTA.

8. **`/dashboard/leads?leakage=reactivation` filter.**
   - URL pill reads "Revenue OS filter · Showing: Reactivation
     queue".
   - Only lost-stage candidates from the helper appear.
   - DnD is suppressed (operator can't drag-and-drop while
     the filter is active).

9. **Reactivation suggestion in drawer.**
   - On a qualifying lost lead, the `ReactivationPanel`
     renders below the existing "Lost reason" panel.
   - "Use reactivation suggestion in draft" sets the pending
     instruction + flips to the Conversation tab. The
     operator still has to click Regenerate.

10. **Admin endpoint contract.**
    - `curl /api/admin/leads/reactivation-queue?venue_id=<id>&limit=5`
      as an admin returns `{venue_id, items:[...]}` with up
      to 5 entries. Unauthenticated returns 401.
    - Cross-tenant `venue_id` returns 404 (not 403 — same
      posture as the rest of the admin surface).

11. **Digest section renders.**
    - In a venue with at least one qualifying candidate, the
      operator digest body now includes a "REACTIVATION
      CANDIDATES THIS WEEK" section + a link to
      `/dashboard/leads?leakage=reactivation`.
    - With zero candidates: "(No reactivation candidates this
      week — nothing cooled long enough yet.)"

12. **No autonomous outreach.**
    - `select count(*) from public.messages where venue_id='<id>'
        and role='human' and created_at > now() - interval '1 hour';`
      only grows from operator clicks. Phase 8BD never writes
      a message.

13. **`/api/health` shows the 4 new flags + bumped count.**
    - `lost_reason_taxonomy`, `reactivation_queue`,
      `reactivation_leads_filter`, `reactivation_digest_section`
      all return `'mounted'`.
    - `autonomous_sending_still_disabled` is STILL `'mounted'`
      (carried from 8AX).
    - `admin.endpoints` returned 35 in 8BA; now returns 36.

### Behavior preserved

- Existing `/api/leads/[id]` PATCH fields all still work —
  `lost_reason` is purely additive on the schema.
- Recovery + tour-booking surfaces unchanged.
- Brand voice / autopilot safety stack unchanged.
- Reactivation drafts go through the same Regenerate +
  Approve & send path as every other reply.

### Fallback posture

- **No lost reason recorded** → the reactivation helper
  surfaces the lead as `possible_candidate` after the longer
  60-day cooling window, never as `strong`.
- **`picked_competitor` / `not_a_fit`** → never surfaced.
  Operator already said no.
- **Reactivation queue fetch fails** → card shows
  "Couldn't load reactivation candidates right now."; the
  rest of the Overview keeps rendering.
- **Lost-lead messages probe fails on the digest cron** →
  reactivation section ships as zero counts. The rest of
  the digest body is unaffected.
- **Pre-8BD venues with no `metadata` column** → can't
  happen. Migration 026 made the column NOT NULL with a
  `'{}'::jsonb` default; rows that pre-date 8BD now have
  `metadata: {}`.

## §9A — Enterprise audit log + EnterpriseAuditEventsCard

### What it surfaces
- `public.audit_events` rows (migration 027) for the caller's venue.
  Admin/owner only — both the route and the page-level `isAdmin`
  check enforce the gate.
- List view fields: when, action, actor (kind + short user id),
  target (table + truncated id), request id correlator, IP
  fingerprint, user-agent.
- Drawer view: full row + sanitized `before_snapshot` /
  `after_snapshot` jsonb + `metadata`.

### What it does NOT surface
- Raw IP addresses — only the salted-SHA-256 fingerprint.
- Sensitive keys in snapshots — the helper recursively drops
  password, secret, token, api_key, authorization, cookie,
  webhook_payload, raw_body, stripe_secret, anthropic_api_key
  before storage.
- Operator message bodies — the operator message send route
  records `body_length` only.

### QA checklist
1. Send a lead update (stage change in the drawer). Refresh the
   card. A new row with `action=lead_update` should appear within
   seconds. `before_snapshot.stage` + `after_snapshot.stage`
   should reflect the change.
2. Click "View" on any row. The drawer opens and fetches the row
   via `?id=<uuid>&include_snapshots=1`. The before/after JSON
   panes render the sanitized snapshots.
3. Filter by `action=lead_delete`. The list narrows to deletes
   only. Clear the filter; the list resets.
4. Click CSV. The download contains BOM-prefixed UTF-8 CSV with
   every column including the JSON snapshots.
5. Cross-tenant: hand-edit `?venue_id=<foreign uuid>` on the URL.
   The route returns 404 (collapsed from 403) for a venue the
   caller isn't an admin on.
6. Audit row write failures must NEVER fail the business action.
   Temporarily revoke the service-role insert on `audit_events`
   (in a sandbox) — the lead PATCH still returns 200 and the
   stage still moves. Restore the policy.

## §9B — Audit coverage matrix + drawer polish

### What changed for QA
- The card drawer now collapses `before_snapshot` /
  `after_snapshot` / `metadata` by default. Each JSON pane shows
  a top-level key preview + an "Expand (N fields)" toggle.
- Copy buttons sit next to: the audit row id (header), actor
  user id, target id, request id. Tap → clipboard write +
  green check feedback for 1.5s.
- A new admin npm script — `npm run check:audit-coverage` —
  scans `app/api` for mutating route files without
  `recordAuditEvent` or an exemption marker. Wired into
  `npm run verify`.

### QA additions
1. Click "Expand" on the after_snapshot of a `lead_update` row.
   The JSON should render with stage, lead_score, urgency, etc.
   Click "Collapse" — pane returns to preview.
2. Click the copy button next to the audit id. Verify:
   - The clipboard now contains the uuid.
   - The icon swaps to a green check for ~1.5s then reverts.
3. Repeat for request id — paste into another tab's
   `?digest_send_q=<paste>` URL parameter to verify the value
   round-trips cleanly.
4. Run `npm run check:audit-coverage` locally.
   - Expected: `✓ Audit coverage clean — 41 mutating routes, 0 missing`.
   - If you've just added a new mutating route and the scanner
     fails: see `docs/AUDIT-COVERAGE.md` for the policy.
5. Run `npm run verify` end-to-end:
   - `next build` — 0 TS errors.
   - `check:no-console-server` — no console statements in
     server code.
   - `check:audit-coverage` — coverage clean.
6. Send a manual digest (`/api/admin/digest/send`). Expect TWO
   audit rows to land:
   - `digest_send` row in `digest_audit_events` (Phase 8AC
     surface — DigestAuditLogCard).
   - `digest_manual_send` row in `audit_events` (Phase 9A
     surface — EnterpriseAuditEventsCard).
   Same operator-initiated event, two distinct forensic feeds.
   This dual-record pattern is deliberate; see
   `docs/AUDIT-COVERAGE.md`.
7. Revoke a team invitation. Expect a `team_invitation_revoke`
   audit row with the invitation id as `target_id`. Open the
   drawer — `metadata.revoked: true` should be visible after
   expanding.
8. Change a team member's role (admin → coordinator). Expect a
   `team_member_role_update` audit row with
   `after.role = "coordinator"` and `metadata.self_role_change`
   reflecting whether the caller targeted themselves.

## §9C — Audit mirror + cross-tenant probe

### What changed for QA
- A second table `public.audit_event_mirror` receives a copy of
  every successful `audit_events` insert when
  `AUDIT_MIRROR_ENABLED=1`. Owner-only SELECT. No write
  policies — REST surface cannot mutate.
- The `EnterpriseAuditEventsCard` shows a mirror indicator line:
  `Mirror: best-effort enabled` (green) or `Mirror: disabled`
  (slate). The state comes from the server-rendered billing
  page reading `AUDIT_MIRROR_ENABLED`.
- New npm script `npm run check:cross-tenant-rbac` —
  operator-run smoke harness for the 403→404 collapse posture.

### QA checklist

1. **Mirror disabled (default state).**
   - Confirm `AUDIT_MIRROR_ENABLED` is unset or `0`.
   - Open `/dashboard/settings/billing`. The Enterprise audit log
     card should show `Mirror: disabled`.
   - Patch a lead (e.g. drag in the Kanban). Confirm the new
     `audit_events` row appears within ~1s. Query
     `audit_event_mirror` directly via Supabase SQL editor —
     no row should appear.

2. **Mirror enabled.**
   - Set `AUDIT_MIRROR_ENABLED=1` in `.env.local`; restart the
     dev server.
   - Confirm the card now shows `Mirror: best-effort enabled`.
   - Patch a lead again. Run:
     ```sql
     select id, action, mirrored_at - created_at as lag
     from public.audit_event_mirror
     order by mirrored_at desc limit 5;
     ```
     The latest row should appear with sub-second lag. The `id`
     must MATCH the primary `audit_events.id`.

3. **Mirror failure does NOT block the business action.**
   - Temporarily break the mirror by renaming the table in a
     sandbox: `alter table public.audit_event_mirror rename to
     audit_event_mirror_broken;`
   - Patch a lead. The HTTP response should still be 200; the
     stage change should still apply.
   - Check the logs for `audit_mirror.insert_failed`.
   - Restore the table name: `alter table
     public.audit_event_mirror_broken rename to
     audit_event_mirror;`

4. **Owner vs admin SELECT on the mirror.**
   - As an admin user (NOT owner) in venue X, query the mirror
     via PostgREST: `GET /rest/v1/audit_event_mirror?venue_id=eq.<X>`.
     Expected: empty array (RLS hides the rows from admin).
   - As the owner of venue X, run the same query. Expected:
     rows visible. This is the stricter posture vs the primary
     `audit_events` (owner OR admin).

5. **Cross-tenant probe.**
   - See `docs/RUNBOOK.md` → "How do I run the cross-tenant
     probe?" for the env setup.
   - Run `npm run check:cross-tenant-rbac`. Expected:
     `Summary: 16 pass / 0 fail`. Exit code 0.
   - Force a regression by temporarily editing one admin route
     to return 403 instead of 404 on cross-tenant denial. Run
     the probe again — should fail with a clear diagnostic
     pointing at the offending route. Restore the route.

6. **Audit coverage still passes.**
   - `npm run check:audit-coverage` — `✓ 41 mutating routes,
     0 missing`. The 9C audit-mirror helper has no mutating
     route surface; it's called from `recordAuditEvent`, not
     from a route handler directly.

## §9D — Data lifecycle (export, PII redaction, retention)

### What changed for QA
- New admin section on `/dashboard/settings/billing` —
  **DataLifecycleCard**. Three sections:
  - Venue export button + include-audit-events toggle.
  - Lead PII redaction info (points to the endpoint).
  - Retention posture summary (audit mirror, digest retention,
    audit log, PII redaction availability).
- New routes:
  - `POST /api/admin/data-export` returns JSON inline (capped
    8 MB) and emits `data_export_requested` audit row.
  - `POST /api/admin/leads/[leadId]/redact-pii` soft-redacts
    one lead's PII and emits `lead_pii_redacted` audit row.
- `ADMIN_ENDPOINT_COUNT` bumped 37 → 39.

### QA checklist
1. **Export as owner/admin.** Open the billing page, click
   "Export venue data" (don't tick the audit checkbox). A JSON
   file downloads named
   `venuerise-export-<venueIdPrefix>-<date>.json`. Open it —
   verify the top-level `sections.venue.id` matches your venue.
2. **Export with audit events.** Tick the toggle, click export
   again. The downloaded file should include
   `sections.auditEvents` as an array; without the toggle it
   should be absent.
3. **Cross-tenant export refusal.** Make a manual POST to
   `/api/admin/data-export` with `{"venue_id":"<foreign uuid>"}`.
   Expected: 404 not_found.
4. **Audit row written.** After step 1, query the
   EnterpriseAuditEventsCard for the `data_export_requested`
   action. Open the drawer — verify
   `metadata.section_counts`, `metadata.estimated_bytes`,
   `metadata.include_audit_events` are present.
5. **Redact a lead.** From the lead drawer or a direct POST:
   ```bash
   curl -X POST http://localhost:3000/api/admin/leads/<leadId>/redact-pii \
     -H 'Content-Type: application/json' \
     -H "cookie: <session>" \
     -d '{"reason":"customer_request","note":"verified via ticket #1234"}'
   ```
   Expected: 200 `{"success":true,"lead_id":"...","redacted_at":"..."}`.
6. **Verify the lead row.** Query Supabase:
   ```sql
   select name, email, phone, notes, metadata->>'pii_redacted' as redacted
   from public.leads where id = '<leadId>';
   ```
   Expected: name = "Redacted Lead", email starts with
   "redacted+", phone null, notes null, redacted "true".
7. **Verify operational rows survive.** Same lead's
   conversations + messages + tours should still exist with
   their original content. The redaction doesn't cascade.
8. **Audit row carries the before-snapshot.** Open the
   EnterpriseAuditEventsCard drawer for the
   `lead_pii_redacted` row. Expand "Before snapshot" — the
   original `name`, `email`, `phone`, `notes` should be
   visible. This is the forensic record of what was redacted;
   it lives in `audit_events` (and `audit_event_mirror` when
   `AUDIT_MIRROR_ENABLED=1`), not in the lead row.
9. **Re-redact idempotency.** Run the same curl twice. Both
   should return 200. The second response should include
   `"already_redacted": true`. Two audit rows exist with the
   second carrying `metadata.already_redacted: true`.
10. **Retention posture line items match env.** With
    `AUDIT_MIRROR_ENABLED=1` the card shows
    "Audit mirror: enabled". With
    `DIGEST_AUDIT_RETENTION_ENABLED=1` it shows
    "Digest retention: enabled". Flipping either env without
    restarting Next.js leaves the card showing the boot-time
    state.
11. **Audit coverage still passes.** Run
    `npm run check:audit-coverage`. Expected output:
    `✓ Audit coverage clean — 43 mutating routes, 0 missing`.

## §9E — Security headers, CSP report-only, secrets rotation

### What changed for QA
- `next.config.js` ships `Content-Security-Policy-Report-Only` +
  `Report-To` on every non-widget response. Violations land at
  `/api/security/csp-report`.
- `Permissions-Policy` now disables `bluetooth=()` (in addition to
  the existing camera / microphone / geolocation / payment / usb).
- New anonymous endpoint `POST /api/security/csp-report` —
  per-IP rate-limited (60/min via `vr:csp`), returns 204, logs
  one structured `security.csp_report.received` line per parsed
  report.
- Secrets rotation table added to RUNBOOK with per-secret
  cadence + blast radius + rollback note.

### Security smoke checklist
1. **Dashboard headers (non-prod).**
   ```bash
   curl -I http://localhost:3000/dashboard
   ```
   Expected headers present:
   - `x-content-type-options: nosniff`
   - `referrer-policy: strict-origin-when-cross-origin`
   - `permissions-policy: camera=(), microphone=(), geolocation=(), payment=(), usb=(), bluetooth=(), fullscreen=(self)`
   - `x-frame-options: SAMEORIGIN`
   - `content-security-policy: frame-ancestors 'self'`
   - `content-security-policy-report-only: default-src 'self'; ...; report-uri /api/security/csp-report; report-to csp-endpoint`
   - `report-to: {"group":"csp-endpoint",...}`
   - **Absent:** `strict-transport-security` (production-only)

2. **Production headers smoke.** Same `curl -I` against the
   prod hostname; expect `strict-transport-security:
   max-age=63072000; includeSubDomains; preload`.

3. **Widget still embeddable.**
   ```bash
   curl -I http://localhost:3000/widget/<venueId>
   ```
   Expected:
   - `content-security-policy: frame-ancestors *`
   - `x-frame-options` either ABSENT or carried over from the
     catch-all as SAMEORIGIN (modern browsers prefer the CSP
     `frame-ancestors` directive when both are present, so the
     carried-over XFO is harmless)

4. **CSP report endpoint accepts level-2 reports.**
   ```bash
   curl -i -X POST http://localhost:3000/api/security/csp-report \
     -H 'Content-Type: application/csp-report' \
     --data '{"csp-report":{"document-uri":"http://localhost:3000/dashboard","violated-directive":"script-src","blocked-uri":"inline"}}'
   ```
   Expected: HTTP 204. Check the server logs for one
   `security.csp_report.received` line with
   `violatedDirective: "script-src"`,
   `blockedUri: "inline"`.

5. **CSP report endpoint accepts Reports-API batch.**
   ```bash
   curl -i -X POST http://localhost:3000/api/security/csp-report \
     -H 'Content-Type: application/reports+json' \
     --data '[{"type":"csp-violation","body":{"documentURL":"http://localhost:3000/dashboard","violatedDirective":"img-src","blockedURL":"https://example.com/foo.png"}}]'
   ```
   Expected: 204; log line with `violatedDirective: "img-src"`.

6. **CSP report endpoint rejects floods.** Issue 100 rapid
   POSTs from the same IP. After ~60, expect 429 (the standard
   `rateLimitedResponse` shape) — NOT 204. Logs include a
   `rate_limit.blocked` line.

7. **CSP report endpoint never logs cookies.** Set a
   non-existent cookie and POST:
   ```bash
   curl -i -X POST http://localhost:3000/api/security/csp-report \
     -H 'Content-Type: application/csp-report' \
     -H 'Cookie: session=DO_NOT_LOG_ME' \
     --data '{"csp-report":{"document-uri":"x","violated-directive":"y"}}'
   ```
   Grep the server log for `DO_NOT_LOG_ME` — must return zero
   matches. The endpoint deliberately never reads cookies.

8. **Supabase realtime still connects from the dashboard.** Open
   `/dashboard/settings/billing`, watch the browser network tab
   for the `wss://<supabaseHost>` connection — should establish
   without CSP errors in the console.

9. **Stripe checkout still works.** Click "Start subscription"
   (or "Manage billing"); the Stripe Checkout page should load
   in the same browser without `Refused to frame` errors. The
   report-only CSP allows Stripe frames; the enforced CSP only
   touches `frame-ancestors`.

10. **Audit coverage still clean.** Run
    `npm run check:audit-coverage`. Expected:
    `✓ 44 mutating routes, 0 missing` (was 43; +1 for the new
    csp-report endpoint, which is `AUDIT_EXEMPT` with marker).

## §9F — Rate-limit + abuse monitoring

### What changed for QA
- New table `public.abuse_events` (migration 029) — receives one
  row per rate-limit block. Owner/admin SELECT scoped to venue
  (when `venue_id` set); public-route rows (venue_id NULL) are
  not visible via PostgREST.
- New admin endpoint `GET /api/admin/security/abuse-events`
  (admin-only, cross-tenant 404 collapse).
- New AbuseMonitorCard mounted on `/dashboard/settings/billing`
  showing top-3 routes/reasons/limiter keys + recent rows + CSV.
- 9 sensitive write routes that previously had no rate limit now
  do: leads PATCH/DELETE, tours POST/PATCH, venues PATCH,
  availability POST/PATCH/DELETE, blackouts POST/DELETE, team
  invitation revoke DELETE.
- `ADMIN_ENDPOINT_COUNT` bumped 39 → 40.

### QA checklist
1. **Coverage scanner clean.** Run
   `npm run check:rate-limit-coverage`. Expected:
   `✓ Rate-limit coverage clean — 65 mutating + sensitive routes,
   0 missing`.
2. **CSP report burst → 429.** With a dev server running:
   ```bash
   for i in {1..80}; do
     curl -s -o /dev/null -w "%{http_code}\n" \
       -X POST http://localhost:3000/api/security/csp-report \
       -H 'Content-Type: application/csp-report' \
       --data '{"csp-report":{"document-uri":"http://x","violated-directive":"y","blocked-uri":"z"}}'
   done | sort | uniq -c
   ```
   Expected: ~60 of `204` then the rest `429`.
3. **abuse_events populated for public route burst.** After step
   2, query Supabase SQL editor:
   ```sql
   select route, reason, count(*)
   from public.abuse_events
   where created_at > now() - interval '5 minutes'
     and route = '/api/security/csp-report'
   group by route, reason;
   ```
   Expected: at least one row with
   `reason = 'rate_limited'`. `venue_id IS NULL` because the
   endpoint is anonymous.
4. **Venue-scoped block → AbuseMonitorCard visible.** Log in as
   an admin. Open the lead drawer, then mash a PATCH-issuing
   button > 30 times in a minute (the AI Approve & send, or
   stage change). Expect 429 in the browser network tab. Open
   `/dashboard/settings/billing` → AbuseMonitorCard. The new
   row should appear within seconds (refresh button forces it).
5. **Cross-tenant abuse-events read returns 404.** Hand-edit URL:
   `GET /api/admin/security/abuse-events?venue_id=<foreign uuid>`.
   Expected: 404 `not_found`.
6. **CSV export works.** Click CSV on the card. Downloaded file
   should be UTF-8 BOM CSV with rows for the current slice. No
   `ip_hash` should contain anything other than the
   `maskIpForAudit` shape (lowercase hex, ~32 chars).
7. **Raw IPs are NEVER persisted.** Sanity check the abuse rows:
   ```sql
   select ip_hash from public.abuse_events
   where ip_hash is not null limit 5;
   ```
   Every value should be a fixed-length hex string. Anything
   resembling an IPv4/IPv6 address is a bug — fail the QA.
8. **Audit + rate-limit coverage both clean simultaneously.**
   ```bash
   npm run check:audit-coverage && npm run check:rate-limit-coverage
   ```
   Expected: both report `✓ ... 0 missing`.

## §9G — Enterprise SSO readiness

### What changed for QA
- Two new tables (`sso_connections`, `sso_login_events`) via
  migration 030.
- Two new admin cards on `/dashboard/settings/billing`:
  SsoConnectionsCard + SsoLoginEventsCard.
- 5 new admin endpoints (3 added to `ADMIN_ENDPOINT_COUNT`
  — sso-connections file, sso-connections/[id] file,
  sso-login-events file; counted by FILE not by method).
- 2 new anonymous auth routes — initiate + callback — that
  return structured placeholder errors.

### QA checklist
1. **Coverage scanners still clean.**
   ```bash
   npm run check:audit-coverage && npm run check:rate-limit-coverage
   ```
   Expected: `✓ 48 mutating routes` (audit) +
   `✓ 71 mutating + sensitive routes` (rate-limit).
2. **Owner can create a draft connection.** As an owner, open
   the SsoConnectionsCard, click "New draft", enter
   `acme.com`, provider `workos`, protocol `saml`. Expected:
   row appears in the table with status `draft`.
3. **Admin (non-owner) cannot create.** As an admin (not
   owner), attempt the same. Expected: `forbidden` error
   surfaced inline. The list view still works.
4. **Domain normalization.** Try `@Acme.COM` and
   `https://acme.com/login` — both should normalize to
   `acme.com` server-side. The displayed row's domain is
   lowercase.
5. **Unique constraint.** Try creating a second connection with
   the same domain on the same venue. Expected: HTTP 409
   `conflict — A connection already exists for this domain.`
6. **Initiate against unknown domain.**
   ```bash
   curl -X POST http://localhost:3000/api/auth/sso/initiate \
     -H 'Content-Type: application/json' \
     -d '{"email":"someone@unknown-domain.example"}'
   ```
   Expected: HTTP 404 with `code: "SSO_NOT_CONFIGURED"`.
   Refresh SsoLoginEventsCard — row appears with
   `outcome=blocked`, `reason=domain_not_configured`.
7. **Initiate against active connection (placeholder path).**
   Create a draft, PATCH status to `active`, then call
   initiate with `email=user@acme.com`. Expected: HTTP 503
   with `code: "SSO_PROVIDER_NOT_CONFIGURED"`. Event row shows
   `outcome=blocked`, `reason=SSO_PROVIDER_NOT_CONFIGURED`.
8. **Callback POST.**
   ```bash
   curl -X POST http://localhost:3000/api/auth/sso/callback \
     -H 'Content-Type: application/json' -d '{}'
   ```
   Expected: HTTP 503 `SSO_CALLBACK_NOT_CONFIGURED`. Event row
   shows `outcome=failed`, `reason=callback_not_configured`.
9. **Callback GET 405.**
   ```bash
   curl -i http://localhost:3000/api/auth/sso/callback
   ```
   Expected: HTTP 405 with `Allow: POST` header.
10. **Initiate rate-limit.** Burst 20 POSTs from the same IP/domain
    pair. Expected: ~10 reach the route, the rest get 429. The
    AbuseMonitorCard shows the abuse rows; the SsoLoginEventsCard
    shows the `outcome=blocked, reason=rate_limited` rows.
11. **No raw IP anywhere.** Sample a few rows:
    ```sql
    select ip_hash from public.sso_login_events
    where ip_hash is not null limit 5;
    ```
    Every value should look like a fixed-length hex fingerprint
    — anything resembling an IP address is a bug.
12. **Audit rows for connection mutations.** Create, then
    PATCH, then DELETE a draft. Open EnterpriseAuditEventsCard
    and filter on `sso_connection_create` / `_update` / `_delete`.
    All three rows visible; before/after snapshots on PATCH +
    DELETE.
13. **Cross-tenant 404 collapse.** Hand-edit URL to
    `?venue_id=<foreign uuid>`. Expected: 404 not 403.
14. **No secrets in DB.** Check `sso_connections.metadata` for
    any of the candidates that would be wrong to store:
    ```sql
    select metadata from public.sso_connections;
    ```
    Should be `{}` for all 9G-era rows. A future phase
    populating WorkOS connection ids is fine; raw signing
    certs / client secrets are not.

## §9H — Backup posture + disaster recovery

### What changed for QA
- Two new admin cards on `/dashboard/settings/billing`:
  BackupPostureCard (read-only) + RestoreIntentCard (owner-only;
  audit-only).
- Two new admin endpoints:
  - `GET /api/admin/security/backup-posture` — read-only.
  - `POST /api/admin/security/restore-intents` — audit-only.
- New audit actions: `restore_intent_recorded`,
  `restore_intent_cancelled`, `restore_completed_outside_app`.
- New scanner script: `npm run check:backup-posture`.
- `ADMIN_ENDPOINT_COUNT` bumped 43 → 45.

### QA checklist
1. **Posture card renders.** Sign in as admin/owner. Open
   `/dashboard/settings/billing`. BackupPostureCard appears
   with overall status (likely `unknown` in dev), four policy
   target cells (RTO/RPO/Retention/Dry-run), and a list of
   per-check rows.
2. **Restores explicitly never execute.** Subtitle should say
   "Restores are never executed from VenueRise..." and the
   footer should point at `docs/DISASTER-RECOVERY.md`. Confirm
   the card has no Restore button.
3. **Refresh works.** Click Refresh. Card re-fetches; the
   `lastCheckedAt` timestamp moves forward.
4. **Owner files an intent.** Open RestoreIntentCard. Pick
   scope `lead`, type a reason ("QA smoke"), submit. Expected:
   green success message saying the intent was recorded.
5. **Audit row landed.** Open EnterpriseAuditEventsCard, filter
   on `restore_intent_recorded`. The new row appears; drawer
   shows `metadata.scope = "lead"`, `metadata.reason = "QA smoke"`,
   `metadata.restore_executed_by_product = false`.
6. **Admin (non-owner) is rejected.** As an admin (not owner),
   POST to `/api/admin/security/restore-intents`. Expected:
   `forbidden` error code surfaced in the card.
7. **Cross-tenant intent → 404.** Owner of venue A files an
   intent with `affected_venue_id` = venue B uuid. Expected:
   HTTP 404 `not_found`.
8. **Scanner clean.** Run `npm run check:backup-posture`.
   Expected (without Management API env): success line +
   `Supabase Management API probe skipped`.
9. **Scanner with env.** Set `SUPABASE_PROJECT_REF` +
   `SUPABASE_ACCESS_TOKEN` to valid values, re-run scanner.
   Expected: success line + `Supabase Management API probe
   (HTTP 200)`. Posture card now shows
   `MANAGEMENT_API_CONFIGURED = healthy` after Refresh.
10. **Scanner with bad token.** Set `SUPABASE_ACCESS_TOKEN` to
    `bad_token`, re-run scanner. Expected: exit 1 with
    "Management API live probe failed: HTTP 401".
11. **Audit + rate-limit coverage still clean.** Run both
    coverage scanners. Expected:
    `✓ 49 mutating routes, 0 missing` (audit) +
    `✓ 73 mutating + sensitive routes, 0 missing` (rate-limit).
12. **No raw token in any response.** Sample the
    backup-posture response body:
    ```bash
    curl -s -H "cookie: <session>" \
      http://localhost:3000/api/admin/security/backup-posture | jq .
    ```
    Body should never contain `SUPABASE_ACCESS_TOKEN` or any
    bearer string. The only Management API surface is the
    short `providerMetadata` object (project_ref + region +
    name).

## §9I — SOC 2 / enterprise evidence packaging

### What changed for QA
- New admin card SecurityEvidenceCenter on
  `/dashboard/settings/billing`.
- New admin endpoint `GET /api/admin/security/evidence-report`
  with JSON / Markdown / CSV branches.
- New local script `npm run build:evidence-pack` that writes
  `artifacts/evidence/{md,csv,json}`.
- New regression scanner
  `npm run check:evidence-packaging`.
- New audit actions `evidence_report_exported` +
  `evidence_pack_generated`.
- `ADMIN_ENDPOINT_COUNT` bumped 45 → 46.

### QA checklist
1. **Evidence center renders.** Admin/owner opens
   `/dashboard/settings/billing` → SecurityEvidenceCenter
   appears with 5 summary chips (Total / Implemented / Partial /
   Manual / Unknown), grouped controls by category, and a
   disclaimer block.
2. **Honesty check.** The summary chips should match
   `EVIDENCE_CONTROLS` reality. Implemented count > 0;
   `partial` includes SSO readiness + audit-event mirror;
   `manual` includes DR runbook + secrets rotation; `unknown`
   includes backup posture when Management API env is unset.
3. **Markdown export.**
   ```bash
   curl -s -H "cookie: <session>" \
     'http://localhost:3000/api/admin/security/evidence-report?format=markdown' \
     -o test-evidence.md
   ```
   File should start with `# VenueRise Security Evidence Report`,
   include the disclaimer in the first 10 lines, and have
   per-category sections.
4. **CSV export.** Same URL with `format=csv` returns a UTF-8
   BOM CSV with the expected 8 columns
   (id, title, category, soc2_categories, status,
   artifact_count, limitation_count, recommended_next_count).
5. **Export audited.** After step 3 or 4, open
   EnterpriseAuditEventsCard, filter on
   `evidence_report_exported`. New row appears with
   `metadata.format = "markdown"` (or `"csv"`) and
   `metadata.control_count` matching the summary.
6. **JSON refresh NOT audited.** Click the Refresh button on
   the card. The JSON branch hits the endpoint but should NOT
   write an audit row — confirm no new
   `evidence_report_exported` rows landed.
7. **Local pack generator.**
   ```bash
   npm run build:evidence-pack
   ```
   Expected: success line + three files created in
   `artifacts/evidence/`. The markdown's summary block should
   match the live endpoint's summary block.
8. **Scanner clean.** Run
   `npm run check:evidence-packaging`. Expected:
   `✓ Evidence packaging scaffolding clean` + a list of
   verified files / docs / scripts.
9. **No secrets in any response.** Sample the JSON branch:
   ```bash
   curl -s -H "cookie: <session>" \
     'http://localhost:3000/api/admin/security/evidence-report?format=json' \
     | jq . | grep -iE 'SUPABASE_ACCESS|secret|api_key|bearer'
   ```
   Expected: no matches. The disclaimer + backup posture
   snapshot don't leak any provider credentials.
10. **All Phase 9 scanners green.**
    ```bash
    npm run check:audit-coverage \
      && npm run check:rate-limit-coverage \
      && npm run check:backup-posture \
      && npm run check:evidence-packaging
    ```
    Expected: all four print `✓ ... clean`.

## §9J — Enterprise sales readiness + security questionnaire automation

### What changed for QA
- Four new admin cards on `/dashboard/settings/billing`:
  SecurityQuestionnaireCard, BuyerSecuritySummaryCard,
  DemoModeCard, EnterpriseReadinessCard.
- Three new admin routes:
  - `GET /api/admin/security/questionnaire-response`
  - `GET /api/admin/security/buyer-security-summary`
  - `GET/PATCH /api/admin/security/demo-mode`
- One layout-level addition: DemoModeBanner below the topbar
  when demo mode is enabled.
- Migration 031 added demo mode columns to `venues`.
- Three new audit actions: questionnaire_response_exported,
  buyer_security_summary_exported, demo_mode_updated.
- Two new scripts: build:questionnaire-pack +
  check:sales-readiness.
- `ADMIN_ENDPOINT_COUNT` bumped 46 → 49.

### QA checklist
1. **Questionnaire card renders.** Admin/owner opens
   `/dashboard/settings/billing` → SecurityQuestionnaireCard
   visible. Pick CAIQ-Lite. Summary chips show > 0 questions.
2. **Markdown export.**
   ```bash
   curl -s -H "cookie: <session>" \
     'http://localhost:3000/api/admin/security/questionnaire-response?format=caiq-lite&download=markdown' \
     -o test-q.md
   ```
   File starts with `# VenueRise Security Questionnaire Response`,
   has the review-before-sending disclaimer, and one section
   per question family.
3. **Export audited.** After step 2, open
   EnterpriseAuditEventsCard, filter on
   `questionnaire_response_exported`. New row appears with
   `metadata.format = "caiq-lite"`,
   `metadata.download = "markdown"`,
   plus per-status counts.
4. **JSON refresh NOT audited.** Click the card's format
   tabs to trigger refreshes. No new
   `questionnaire_response_exported` rows should appear.
5. **Buyer summary card renders.** Refresh — sections
   visible, known limitations chip with ≥ 8 items.
6. **Buyer summary markdown export audited.** Click Download
   Markdown. Audit row `buyer_security_summary_exported`
   appears with `metadata.section_count`.
7. **Demo mode toggle (owner).** Owner flips demo mode on
   with a label. DemoModeCard shows `enabled` chip + label.
   Navigate to any dashboard page — "DEMO MODE — Label"
   banner appears below the topbar.
8. **Demo mode toggle (admin non-owner).** As admin (not
   owner), attempt to toggle. Inline error: "Owner role
   required to toggle demo mode."
9. **Demo mode audited.** After step 7, open the audit feed,
   filter on `demo_mode_updated`. Row shows before/after.
10. **Local pack generator.**
    ```bash
    npm run build:questionnaire-pack
    ```
    Three files in
    `artifacts/evidence/questionnaires/`. Markdown summary
    matches the live endpoint's section count.
11. **Sales readiness scanner.**
    ```bash
    npm run check:sales-readiness
    ```
    Expected: `✓ Sales readiness scaffolding clean` with the
    list of verified files / scripts / doc references.
12. **All Phase 9 scanners green.**
    ```bash
    npm run check:audit-coverage \
      && npm run check:rate-limit-coverage \
      && npm run check:backup-posture \
      && npm run check:evidence-packaging \
      && npm run check:sales-readiness
    ```
    Expected: all five print `✓ ... clean`.
13. **EnterpriseReadinessCard renders.** Server-rendered
    section appears with 12 checklist items, summary chips.
    Ready / Partial / Missing counts honest.

## §9K — Vendor risk + subprocessor disclosure

1. **Vendor risk card loads.** On `/dashboard/settings/billing`,
   the "Vendor risk + assurance" card renders summary stats
   (total / production / critical / manual-review-required /
   unknown) + a table of every vendor row.
2. **Subprocessor disclosure card loads.** The sibling
   "Subprocessor disclosure" card renders only the
   buyer-disclosable rows (currently 8: Supabase, Anthropic,
   Stripe, Resend, Upstash, Inngest, Vercel, Sentry) — internal
   tooling like `stripe-cli` is filtered out.
3. **Markdown export downloads.** `Download Markdown` on
   VendorRiskCard returns
   `venuerise-vendor-risk-YYYY-MM-DD.md` with the full
   disclaimer, summary, and per-vendor section.
4. **CSV export downloads.** `Download CSV` on VendorRiskCard
   returns `venuerise-vendor-risk-YYYY-MM-DD.csv` with the
   row-per-vendor shape.
5. **Subprocessor markdown export.** `Download Markdown` on
   SubprocessorDisclosureCard returns
   `venuerise-subprocessors-YYYY-MM-DD.md` and contains NO
   evidence references (no env vars, no package names).
6. **Audit row on export.** After clicking either download on
   either card, the EnterpriseAuditEventsCard shows a row with
   action `vendor_risk_report_exported` or
   `subprocessor_disclosure_exported`.
7. **No audit on JSON refresh.** Clicking Refresh on either
   card produces NO new audit rows — JSON preview is operator-
   internal.
8. **Rate-limit headroom.** Refreshing each card rapidly stays
   under the 30/min userAction budget; no abuse-event rows
   appear in AbuseMonitorCard.
9. **Static pack matches live.** Run
   `npm run build:vendor-risk-pack` and compare the
   `artifacts/evidence/vendor-risk/` outputs to the
   markdown/CSV exports — vendor count + criticality + risk
   tier match.
10. **Scanner gates on missing files.** Delete
    `components/dashboard/settings/VendorRiskCard.tsx` and run
    `npm run check:vendor-risk` — should exit non-zero with the
    missing file listed.
11. **Scanner gates on new SDK without registry row.** Add a
    bogus `"@sendgrid/mail"` dependency to package.json and add
    a corresponding entry to `KNOWN_VENDOR_PACKAGES` in the
    scanner — should exit non-zero with `registry is missing a
    row for package "@sendgrid/mail"` (then revert).
12. **No public route exposed.** Hitting
    `/security/subprocessors` (unauthenticated, no admin
    session) returns 404 — Phase 9K does not ship a public
    page.
13. **Honesty disclaimer present.** Both markdown exports +
    both card UIs surface the identical disclaimer string
    starting "This disclosure is for security review and
    procurement support..."

## §9L — Incident response

1. **IncidentResponseCard loads.** On `/dashboard/settings/billing`,
   the "Incident response" card renders summary stats (open /
   investigating / sev1+2 / resolved 30d / total) and an empty
   table on a fresh tenant.
2. **New incident form.** Clicking `+ New Incident` reveals a
   form. Submitting with title + SEV3 + category=security and
   `notify=false` creates an incident; the row appears in the
   table and the EnterpriseAuditEventsCard shows an
   `incident_created` row.
3. **Status transitions stamp timestamps.** Open the new row →
   change status to `mitigated` → `mitigated_at` appears in the
   detail panel. Change to `resolved` → `resolved_at` and
   `resolved_by` populate; audit row is `incident_resolved`.
4. **Note appends timeline.** Adding a free-form note via the
   detail panel produces a `note_added` timeline event without
   changing status; audit row is `incident_updated`.
5. **Post-incident review appends timeline.** Pasting markdown
   into the PIR field appends a `postmortem_added` timeline
   event; audit row is `incident_updated`.
6. **Detect candidates preview.** Clicking `Detect Candidates`
   → `Preview` runs the four detectors. With no recent abuse /
   SSO activity, the panel shows "No candidates above
   threshold." The EnterpriseAuditEventsCard shows an
   `incident_candidates_detected` row.
7. **Detect candidates create.** Seed abuse events to cross
   the threshold, then click `Create all (N)`. N incidents
   land in the table with source=`abuse_events`; the audit feed
   shows one `incident_candidates_detected` plus N
   `incident_created` rows.
8. **Alert routing — env absent.** With no
   `INCIDENT_ALERTS_ENABLED` env var, clicking `Send alert` in
   a detail panel returns a `skipped_disabled` outcome per
   channel. The audit feed shows NO `incident_alert_sent` rows
   (skipped outcomes are not audited).
9. **Alert routing — env present but webhook missing.** Set
   `INCIDENT_ALERTS_ENABLED=true` and leave Slack/PagerDuty
   env vars unset. `Send alert` returns `skipped_unconfigured`.
10. **Alert routing — env present + valid webhook.** Set
    `INCIDENT_SLACK_WEBHOOK_URL` to a real Slack incoming
    webhook. `Send alert` posts a message AND writes an
    `incident_alert_sent` audit row + `alert_sent` timeline
    event. Webhook URL never appears anywhere.
11. **CSV export.** `Download CSV` returns
    `venuerise-incidents-YYYY-MM-DD.csv` with one row per
    incident. The audit feed shows an `incident_report_exported`
    row.
12. **Cross-tenant 404.** Authenticated as a different venue,
    `GET /api/admin/security/incidents/[other-venue-incident-id]`
    returns 404 (NEVER 403).
13. **Rate-limit headroom.** Refreshing the card rapidly stays
    under the 30/min userAction budget; no `abuse_events` rows
    appear in the AbuseMonitorCard.
14. **No autonomous remediation.** Confirm that after firing
    detection + alerts, no automatic mitigation occurs — no
    rate-limit overrides, no auto-resolves, no auto-emails to
    customers. Only operator-initiated changes appear in the
    audit trail.
15. **Scanner gates.** Delete `components/dashboard/settings/IncidentResponseCard.tsx`
    and run `npm run check:incident-response` — exits non-zero
    with the missing file listed.

## §9M — Privacy + DSR readiness

1. **PrivacyReadinessCard loads.** Stats render (categories /
   high+restricted / export-ready / deletion-ready /
   manual-review / retention rows / open DSRs / overdue DSRs).
   Data inventory table + retention policy list appear.
2. **Markdown export.** `Download Markdown` returns
   `venuerise-privacy-readiness-YYYY-MM-DD.md` with the full
   inventory + retention policy + disclaimer. Audit feed shows
   `privacy_readiness_exported`.
3. **Inventory + retention CSV exports.** Both `Inventory CSV`
   and `Retention CSV` download row-per-row exports.
4. **DsrRequestsCard loads.** Stats (Open / Awaiting legal /
   Fulfilled / Overdue) + table render. Empty table on fresh
   tenant.
5. **New DSR form.** `+ New DSR` reveals form. Create with
   type=access, risk=medium, subject email, due date next
   week → row appears with status `received`; audit row
   `dsr_request_created`.
6. **Status transitions stamp timestamps.** PATCH to
   `mitigated`-equivalent path: move status to `triage` →
   `in_progress` → `awaiting_legal_review`. Each writes
   `dsr_request_updated`. Set status `fulfilled` → stamps
   `fulfilled_at` + `closed_by`; audit row is
   `dsr_request_fulfilled`.
7. **Identity verification button.** `Mark identity verified`
   stamps `identity_verified_at` + writes `identity_verified`
   timeline event. Button label changes to "Identity verified"
   on next render.
8. **Export preview (metadata-only).** Click `Export preview` →
   returns category count. Timeline shows `export_prepared`;
   audit feed shows `dsr_export_previewed`. No subject data is
   fetched (verify via network tab — response carries only
   `items[]` with category metadata, no row data).
9. **Deletion review (non-destructive).** Click
   `Deletion review` → returns checklist count. Timeline shows
   `deletion_reviewed`; audit feed shows
   `dsr_deletion_reviewed`. Verify nothing is deleted (lead
   counts unchanged).
10. **Add legal review note.** Append a legal note via the
    detail panel → timeline shows `legal_review_added` event;
    audit row is `dsr_request_updated` with
    `legal_review_added=true` in metadata.
11. **CSV export.** `Download CSV` on DsrRequestsCard returns
    `venuerise-dsr-requests-YYYY-MM-DD.csv`. Audit feed shows
    `dsr_report_exported`.
12. **Cross-tenant 404.** Authenticated as a different venue,
    `GET /api/admin/privacy/dsr-requests/[other-venue-dsr-id]`
    returns 404 (NEVER 403).
13. **Restricted categories excluded from export preview.** In
    the preview response, verify `excludedRestricted` contains
    `audit_metadata`, `abuse_security_metadata`,
    `sso_security_metadata`, `incident_metadata`,
    `auth_security_metadata`, `system_logs`.
14. **Retention exception flags in deletion review.** Verify
    `retentionExceptionApplies: true` on `audit_metadata`,
    `abuse_security_metadata`, `sso_security_metadata`,
    `incident_metadata`, `billing_metadata`, and
    `auth_security_metadata` rows in the deletion review
    response.
15. **No automatic DSR fulfillment.** After running export
    preview + deletion review, confirm the DSR status remains
    `in_progress` (or whatever the operator last set). Nothing
    auto-resolves.
16. **Honesty disclaimer present.** Both card UIs + the
    markdown export carry the identical disclaimer string
    starting "Privacy readiness is not a legal compliance
    attestation."
17. **Rate-limit headroom.** Rapid refresh on either card stays
    under 30/min userAction budget; no `abuse_events` rows
    appear.
18. **Scanner gates.** Delete
    `components/dashboard/settings/DsrRequestsCard.tsx` and
    run `npm run check:privacy-readiness` — exits non-zero
    with the missing file listed.

## §9N — Trust Center

1. **Public page renders.** Hit `/trust` (unauthenticated) →
   page loads with curated sections + public subprocessor list
   + known limitations + standard disclaimer. No internal-only
   vendors visible. No env / package names visible.
2. **TrustCenterCard loads** on `/dashboard/settings/billing`.
   Select scope `standard_packet`, click Preview manifest → 7
   artifacts listed with `included` chip on the 7 standard
   ones; `evidence_report` / `vendor_risk_report` /
   `soc2_evidence_map` carry `excluded` chip.
3. **Download admin packet markdown.** `Download Markdown`
   returns `venuerise-trust-packet-standard_packet-YYYY-MM-DD.md`.
   Audit feed shows `trust_packet_exported`.
4. **TrustAccessGrantsCard loads** with empty table.
5. **Create grant.** `+ New grant` → fill buyer email / scope
   `standard_packet` / 14-day expiry → submit. Green panel
   appears with the bearer URL + warning text. Audit feed
   shows `trust_access_grant_created`.
6. **Bearer URL grants access.** Open the URL (logged out or
   incognito) → gated page loads with grant scope label +
   artifact list + expiry. `trust_access_events` row shows
   `grant_accessed`.
7. **Artifact download.** Click `MARKDOWN` next to "Buyer
   security summary" → downloads. `trust_access_events` row
   shows `artifact_downloaded` with `artifactType` +
   `format`.
8. **CSV download** on a CSV-capable artifact (e.g. subprocessor
   disclosure) → downloads CSV.
9. **Out-of-scope artifact returns 404.** Manually hit
   `/api/trust/access/${TOKEN}/artifact?type=evidence_report&format=markdown`
   with a `standard_packet` token → 404 / `not_available_in_scope_or_format`.
10. **Internal-only artifact never emits.** Hit
    `?type=custom&format=markdown` → renders the "internal
    only" stub markdown body (no leak).
11. **Revoke grant.** Click `Revoke` on the row → confirm →
    table shows `revoked`. Audit feed shows
    `trust_access_grant_revoked`. Trying the URL again returns
    a generic "Access unavailable" page + `access_denied`
    event.
12. **Expired grant.** Create a grant with `expires_in_days=1`,
    fast-forward the DB row (or wait) → status flips to
    `expired` on first denied validation; URL shows the same
    generic denial page.
13. **Rate limit on gated download.** Hit the artifact URL
    repeatedly → public widget bucket throttles; subsequent
    requests return rate-limited response. abuse_events row
    appears with limiter key prefix `trust-token:`.
14. **CSV access-events export.** `?format=csv` on
    `/api/admin/security/trust-center/access-events` → returns
    `venuerise-trust-access-events-YYYY-MM-DD.csv`. Audit
    feed shows `trust_access_events_exported`.
15. **Cross-tenant 404.** Authenticated as a different venue,
    `PATCH /api/admin/security/trust-center/grants/[other-venue-grant-id]`
    returns 404 (NEVER 403).
16. **Plaintext never returned twice.** GET on grants list
    returns rows without a `token` field — only `tokenHash`
    metadata. Refresh the create response → impossible to
    re-derive the URL.
17. **Static pack matches live.** Run
    `npm run build:trust-center-pack` → 4 files in
    `artifacts/evidence/trust-center/`. Open
    `standard-trust-packet.md` → manifest matches admin
    Preview manifest counts.
18. **Scanner gates.** Delete
    `app/(marketing)/trust/page.tsx` and run
    `npm run check:trust-center` → exits non-zero with the
    missing file listed.

## §9O — Compliance operations calendar

1. **Card loads.** `/dashboard/settings/billing` →
   ComplianceCalendarCard renders stats (Total / Upcoming /
   Due / Overdue / Completed 30d / Stale areas) + table +
   per-area freshness details summary. Empty table on fresh
   tenant.
2. **Seed missing.** Click `Seed missing` → 17 upcoming
   events appear in the table (one per policy item). Audit
   feed shows `compliance_events_seeded` row with
   `inserted: 17`.
3. **Re-seed is idempotent.** Click `Seed missing` again →
   `inserted: 0, skipped: 17`. No duplicate rows in the table.
4. **Complete review.** Open a row → paste notes + evidence
   URL → click `Mark completed`. Row flips to `completed`,
   stamps `completed_at`. Audit row is
   `compliance_review_completed`.
5. **Update notes.** Open a row → edit notes → click `Update
   notes`. Audit row is `compliance_review_updated`.
6. **Waive review.** Open a row → type reason → click
   `Waive`. Status flips to `waived`, stamps `waived_at` +
   `waiver_reason`. Audit row is `compliance_review_waived`.
7. **Custom review.** `Custom review` → fill title + due
   date + area + cadence → submit. New `operator_created`
   row appears with `policy_id` starting `custom:`. Audit
   row is `compliance_review_created`.
8. **Calendar CSV.** `Calendar CSV` returns
   `venuerise-compliance-calendar-YYYY-MM-DD.csv`. Audit row
   is `compliance_calendar_exported`.
9. **Freshness markdown.** `Freshness MD` returns
   `venuerise-compliance-freshness-YYYY-MM-DD.md`. Audit row
   is `compliance_freshness_exported`.
10. **Stale flag.** Backdate a `completed_at` (or wait past
    a policy item's `staleAfterDays`) → freshness summary
    flips `stale: true` for that policy row + the staleAreas
    count increments.
11. **Per-area freshness table.** Click
    `Per-area freshness (17 policy items)` disclosure → table
    expands with last completed + status + stale per row.
12. **Cross-tenant 404.** Authenticated as a different venue,
    `PATCH /api/admin/security/compliance/calendar/[other-venue-event-id]`
    returns 404 (NEVER 403).
13. **No DELETE.** Confirm there is no Delete button on the
    card and no DELETE method on the route — operators waive
    instead.
14. **Static pack matches policy.** Run
    `npm run build:compliance-ops-pack` → 4 files in
    `artifacts/evidence/compliance-ops/`. Open
    `compliance-review-policy.md` → 17 sections matching the
    policy module.
15. **No autonomous side-effects.** After completing /
    waiving reviews, confirm: no trust artifact rebuild
    happens automatically, no vendor registry row was
    mutated, no external alert was sent.
16. **Honesty disclaimer.** Card footer + freshness export +
    static pack all carry the identical disclaimer string
    starting "The compliance operations calendar tracks
    operator-initiated reviews…".
17. **Scanner gates.** Delete
    `components/dashboard/settings/ComplianceCalendarCard.tsx`
    and run `npm run check:compliance-ops` → exits non-zero
    with the missing file listed.

## §9P — Contract commitments register

1. **Cards load.** `/dashboard/settings/billing` →
   CommitmentsRegisterCard + CommitmentsReadinessCard render
   on an empty tenant with no rows.
2. **Record a commitment.** `+ New commitment` → fill buyer
   company + email + source=msa + area=security + title +
   description + status=draft + risk=medium → submit. Row
   appears in the table. Audit feed shows
   `commitment_created`.
3. **Status transition stamps audit.** Open the row → Set
   status `active`. Audit feed shows
   `commitment_status_changed` with `from`/`to` metadata.
4. **Mark fulfilled.** Click `Mark fulfilled` on an active
   row. Status flips to `fulfilled`, `fulfilled_at` stamped.
   Audit feed shows `commitment_fulfilled`. Timeline shows
   `fulfilled` + `status_changed` events.
5. **Mark reviewed.** Click `Mark reviewed`. Timeline shows
   `reviewed` event. Audit feed shows
   `commitment_reviewed`.
6. **Risk change.** Set risk `critical`. Audit feed shows
   `commitment_status_changed` (or `_updated`); timeline shows
   `risk_changed` event.
7. **Evidence URL.** Paste an https:// URL → `Save URL`. Row
   metadata updated.
8. **Append note.** Type into Add note → click. Timeline
   shows `note_added`.
9. **Filter chips.** Set status filter to `active` → only
   active rows show. Clear filters → all rows show.
10. **Readiness summary loads.** CommitmentsReadinessCard
    shows counts (Total / Active / High+critical / Unsupported
    flags). Warnings list shows overdue / due-soon / unsupported
    counts.
11. **Unsupported-risk flag surfaces.** Record a commitment
    with area=scim. CommitmentsReadinessCard surfaces the flag
    with reason "SCIM provisioning is NOT live in any
    environment today…".
12. **Critical-risk security flag.** Record a commitment with
    area=security, risk=critical. The unsupported-risk panel
    surfaces a "Critical-risk commitment in a sensitive area"
    flag.
13. **Markdown export.** `Download Markdown` on the readiness
    card returns
    `venuerise-commitments-readiness-YYYY-MM-DD.md`. Audit
    feed shows `commitments_readiness_exported`.
14. **CSV exports.** `Download CSV` on register card →
    `venuerise-commitments-YYYY-MM-DD.csv` (audited:
    `commitments_exported`). `Download CSV` on readiness card
    → `venuerise-commitments-readiness-YYYY-MM-DD.csv` (also
    audited).
15. **Cross-tenant 404.** As a different venue, `PATCH
    /api/admin/security/commitments/[other-venue-id]` returns
    404 (NEVER 403).
16. **No DELETE.** Confirm there is no Delete button on the
    card and no DELETE method on the route — operators move
    to status `withdrawn`.
17. **No autonomous parsing.** After recording commitments,
    confirm: no trust artifact rebuild, no vendor registry
    mutation, no external alert.
18. **Honesty disclaimer.** Register card footer + readiness
    card footer + markdown export all carry the identical
    disclaimer starting "This register tracks operator-recorded
    commitments…".
19. **Scanner gates.** Delete
    `components/dashboard/settings/CommitmentsRegisterCard.tsx`
    and run `npm run check:commitments` → exits non-zero with
    the missing file listed.

---

## Phase 8BE — Omnichannel inbox foundation QA

In `/dashboard/settings/billing` (admin or owner) confirm:

- [ ] **Channel connections** card renders the full
      capability matrix (website, instagram, facebook,
      meta_lead_ads, email, sms, the_knot, weddingwire,
      manual). Channels with `manualReplyRequired = true`
      carry the amber "Manual reply" pill.
- [ ] `Add manual connection` on any unconnected channel
      opens the inline form and POST succeeds (status
      `draft`). The new row appears under "Active
      connections".
- [ ] `Save label` and `Mark disconnected` PATCHes succeed
      and the row status flips to `Disconnected` with the
      red tone.
- [ ] `Reactivate` flips a disconnected row back to `Draft`.
- [ ] Footer carries the autonomous-sending disabled
      disclaimer.

In the inbox + lead drawer:

- [ ] Conversations with `channel_type` metadata render the
      `ChannelSourceBadge` next to the lead email in the
      list and inside the bubble in the thread.
- [ ] Legacy conversations with no channel metadata render
      WITHOUT a badge (graceful hide).
- [ ] Manually-sent human messages render the
      `Sent manually` pill alongside the badge.

Regression scanner: `npm run check:audit-coverage` +
`check:rate-limit-coverage` should remain at 0 missing.

---

## Phase 8BE-2 — Omnichannel activation QA

Inbox + drawer end-to-end:

- [ ] Inject (or normalize via lead-forwarding routes) a
      conversation on Instagram / WeddingWire / The Knot.
      Confirm the badge appears next to the lead email in
      `/dashboard/inbox` ConversationList AND on
      `/dashboard/inbox/[leadId]` sidebar.
- [ ] Open the lead drawer for that conversation. Confirm
      the channel badge renders next to email/phone in the
      drawer header.
- [ ] Draft an AI reply (Regenerate). Confirm
      `ManualChannelReplyBanner` mounts inside the draft
      footer above the Edit/Regenerate/Reject/Approve row.
- [ ] The Approve & send button label reads
      **Manual reply only**, is disabled, and hover-tooltip
      points to the banner.
- [ ] Click **Copy reply** → toast flips to **Copied** and
      the clipboard contains the draft body.
- [ ] Click **Mark sent manually** → loading spinner,
      button switches to **Marked sent**, the draft clears
      from the composer, and a new `human` message appears
      in the thread with the channel badge + a
      **Sent manually** pill.
- [ ] In a fresh window, hit
      `GET /api/admin/audit-events?action=channel_reply_marked_sent_manually`
      — the row exists for that conversation.
- [ ] In Supabase, the `external_messages` row for that
      message has `delivery_status='marked_sent_manually'`.
- [ ] Website conversations (no `manualReplyRequired`)
      continue to render the standard Approve & send button
      and the banner does NOT mount.

---

## Phase 8BG — Lead-forwarding parser QA

Public inbound:

- [ ] POST a structured payload (no raw body) to
      `/api/integrations/lead-forwarding/the-knot`. Response
      includes `parse_confidence` >= 75 and
      `parse_needs_review: false` when name + email + message
      + event date are present.
- [ ] POST a raw forwarded email body (no payload) to the same
      route with minimal headers. Response includes a
      lower confidence + `parse_needs_review: true` when name
      or event date are missing.
- [ ] WeddingWire route mirrors the same behaviour.

Inbox / drawer surface:

- [ ] Open the resulting conversation. ConversationList row
      shows the channel badge + amber warning dot when the
      latest message needs review.
- [ ] ConversationThread bubble shows the "Needs parse review"
      pill on the inbound message. Hover surfaces the
      confidence score + signal reasons.
- [ ] LeadDetailDrawer renders the "Source parse review"
      panel with extracted event date / guests / budget + a
      missing-signals line.

Admin QA:

- [ ] `POST /api/admin/integrations/lead-forwarding/test-parse`
      with a structured payload returns the parsed shape +
      confidence + reasons WITHOUT creating a lead.
- [ ] Audit log shows a `lead_forwarding_test_parse` row
      with only parser-output metadata (no raw body).
- [ ] Rate-limit blocks repeated test calls per user.

ChannelConnectionsCard:

- [ ] The Knot + WeddingWire rows display "Lead forwarding
      parser active" + the "Outbound reply: manual · Parse
      confidence review: active" sub-line.

---

## Phase 8BF — Meta connector QA

Env + verification:

- [ ] With env unset, `GET /api/integrations/meta/webhook`
      returns 503 `placeholder_only`.
- [ ] With env unset, `POST /api/integrations/meta/webhook`
      returns 503 `webhook_not_configured`.
- [ ] With env set, `GET` with matching `hub.verify_token`
      returns 200 + raw `hub.challenge` body.
- [ ] `GET` with non-matching verify token returns 403.
      Token never appears in logs.

Signed POST:

- [ ] POST with valid `X-Hub-Signature-256` + Instagram
      messaging payload returns 200; if a venue has a
      matching `instagram_business_account_id` connection
      the message lands in the inbox with the Instagram
      badge.
- [ ] POST with valid signature but no matching connection
      returns 200 with `events_ignored: 1` and
      `per_event[0].status: 'ignored_no_connection'`.
- [ ] POST with invalid signature returns 401; no
      normalization happens; nothing is logged about the
      body.
- [ ] POST with leadgen payload + matching Page-id
      connection creates a placeholder lead/message with
      `metadata.requires_graph_hydration: true` and
      `parse_needs_review: true`; ConversationThread shows
      the "Needs parse review" pill; LeadDetailDrawer shows
      the Source parse review panel.

ChannelConnectionsCard:

- [ ] Instagram / Facebook / Meta lead ad rows show the
      "Meta identifiers" editor with four allowlisted
      fields. Saving merges into existing metadata.
- [ ] Attempting to save a metadata key containing
      `token` / `secret` (via direct API call) returns 400
      `forbidden_metadata_key` with the rejected key
      named.
- [ ] Card copy explicitly states tokens / secrets are
      server-side only.

Admin QA:

- [ ] `POST /api/admin/integrations/meta/test-parse` with
      a sample Instagram payload returns `events_parsed: 1`
      + parsed event detail. No DB writes. Audit row is
      `meta_webhook_test_parse` with parser-output
      metadata only (no raw payload).

---

## Phase 8BH — Attribution QA

Widget intake:

- [ ] POST `/api/widget` with a payload that includes
      `attribution: { utm_source: 'google', utm_medium:
      'cpc', utm_campaign: 'venue-spring', gclid: '…' }`.
      The created lead's `metadata.attribution.source_label`
      should be `Google Ads`.
- [ ] POST the same shape with `fbclid` instead — should be
      `Meta Ads`.
- [ ] POST with no `attribution` field at all — the lead
      should still be created and its `source_label` should
      be `Website` (the widget intake stamps `channel_type:
      'website'` as a fallback).
- [ ] Submit a payload with a forbidden-shaped key inside
      `attribution` (e.g. `access_token`). The Zod schema is
      strict — it returns 400.

Omnichannel attribution:

- [ ] POST a verified Meta Instagram webhook — the resulting
      lead's `source_label` should be `Instagram`.
- [ ] POST a WeddingWire lead-forwarding payload — should be
      `WeddingWire`.

UI surfaces:

- [ ] Open Overview — AttributionPerformanceCard groups
      recent leads by source with leads / tours / booked /
      estimated pipeline columns.
- [ ] Open `/dashboard/analytics` — attribution breakdown
      table renders below the funnel chart.
- [ ] Open any lead drawer with attribution metadata — the
      AttributionPanel renders source label + campaign +
      landing page + referrer + click-ID badges.
- [ ] Open any lead drawer WITHOUT attribution metadata —
      panel hides gracefully.
- [ ] KanbanCard rows show the compact source badge next
      to the lead email for attributed leads; unbadged for
      legacy / unknown rows.

Honesty copy:

- [ ] Card footer reads "Attribution is best-effort … Ad
      spend is not connected — pipeline values are estimated
      from operator-entered budgets, not true ROAS."

---

## Phase 8BI — Booked revenue attribution QA

- [ ] With no booked leads in the venue,
      `BookedRevenueAttributionCard` on `/dashboard`
      renders the honest empty state.
- [ ] After flipping a lead's stage to `booked` (with a
      budget set + an `attribution.source_label` present),
      the card surfaces that source with the booked count
      and estimated booked value.
- [ ] `/dashboard/analytics` "Booked revenue by source"
      table includes L→Tour and L→Booked rate columns
      that render `—` for buckets with no denominator.
- [ ] In LeadDetailDrawer, opening a booked lead shows
      the "Booked source" panel header + an
      "Est. booked ~$X" pill next to the source badge.
- [ ] In LeadDetailDrawer, opening a non-booked lead
      still shows the "Attribution" header (no booked
      pill).
- [ ] KanbanCard rows where the lead is booked label
      the Budget row as "Est. booked" in emerald.
- [ ] Card / table footers include the disclaimer:
      "Estimated booked value uses the operator-entered
      lead budget. Ad spend is not connected — this is
      not true ROAS."

---

## Phase 8BJ — Source-level revenue leakage QA

- [ ] With no attributed leads in the venue,
      `SourceRevenueLeakageCard` on `/dashboard` renders
      the honest empty state ("Source leakage will appear
      once attributed leads enter the pipeline").
- [ ] After submitting a widget inquiry with UTM
      parameters, the card surfaces that source within
      seconds + an at-risk count if a Revenue OS signal is
      active.
- [ ] Clicking the per-row "Open source" CTA navigates to
      `/dashboard/leads?source=<SourceLabel>&leakage=<key>`
      and BOTH filter pills render (amber source above
      blue leakage).
- [ ] Clearing the source pill leaves the leakage filter
      intact; clearing the leakage pill leaves the source
      filter intact.
- [ ] Drag-and-drop is disabled while either filter is
      active; clearing both re-enables DnD.
- [ ] AttributionPerformanceCard + BookedRevenueAttributionCard
      each show a "View leads →" CTA per row that lands on
      the leads board pre-filtered to that source.
- [ ] `/dashboard/analytics` "Source leakage breakdown"
      table renders with the expected Slow reply / No tour /
      Recovery / Reactivation / Top leak / At-risk columns
      and a per-row CTA.
- [ ] LeadDetailDrawer Attribution panel shows the
      "This lead is part of the X source cohort." line +
      (when active) the "Current source leakage signal: Y."
      line. Both lines are read-only; no new actions.
- [ ] Card / table footers carry the disclaimer:
      "Source leakage is based on captured attribution
      and Revenue OS signals. It is not ROAS …"

---

## Phase 9Q — Payment Methods card + Stripe Billing Portal QA

- [ ] On `/dashboard/settings/billing`, the **Payment methods** card
      renders directly below the **Subscription** card.
- [ ] Header reads "Cards and bank details are managed securely by
      Stripe. VenueRise never stores full payment details."
- [ ] No card number, no last4, no expiry, no payment method id
      appears anywhere in the card UI.
- [ ] Footer reads "Payment details are processed by Stripe.
      VenueRise stores billing status and audit records, not full
      card data. Billing actions are recorded in the enterprise
      audit log."
- [ ] With an active subscription (Stripe customer connected):
      primary CTA is **Manage payment method**; clicking redirects
      to a `billing.stripe.com/...` URL.
- [ ] With no subscription (`status.kind === 'none'` or
      `'incomplete'` / `'trialing'`): primary CTA is **Set up
      billing**; clicking redirects to a `checkout.stripe.com/...`
      URL.
- [ ] As a non-admin (sales / coordinator / viewer): the CTA is
      disabled and an inline notice reads "Only venue owners and
      admins can manage billing."
- [ ] Forcing the route call as a non-admin returns the existing
      `tenant_access_*` forbidden code; PaymentMethodActions
      humanises it to "Only venue owners and admins can manage
      billing."
- [ ] With `STRIPE_SECRET_KEY` unset locally:
      `POST /api/billing/portal` returns 503
      `{ error: 'billing_not_configured' }`; the card shows
      "Stripe is not configured for this deploy. Contact support."
- [ ] With a venue that has no Stripe customer yet, calling the
      portal returns 404 `billing_customer_not_found`; the inline
      error reads "Stripe customer missing. Start checkout first
      to set up billing."
- [ ] After a successful portal session creation, a
      `billing_portal_session_create` row appears in
      `EnterpriseAuditEventsCard` with metadata:
      `{ session_url_returned: true, stripe_customer_present: true,
        subscription_status: '<kind>', source: 'payment_methods_card' }`.
- [ ] The audit row contains **no** card number, payment method
      id, Stripe raw payload, client secret, or customer email.
- [ ] Rate limit: hammering the portal endpoint 6× in 60s as one
      user returns 429 with `Retry-After`; PaymentMethodActions
      humanises to "Too many billing requests. Wait a moment and
      try again."
- [ ] Existing **Subscription** card still renders + functions; no
      regressions in BillingActions.

---

## Phase 9R — Subscription Plans QA

- [ ] On `/dashboard/settings/billing`, **Subscription plans** card
      renders below **Payment methods**. Shows all 4 tiers
      (Starter / Growth / Elite / Enterprise) in that order.
- [ ] Growth is highlighted with a **Recommended** chip.
- [ ] Each paid plan shows price, tagline, 5–7 bullets, limits
      (Venues / Leads-per-mo / Admin seats / Team seats), and an
      expandable "Included features (N)" list.
- [ ] Enterprise shows **Custom** price, "Contact sales" CTA that
      opens `mailto:sales@venuerise.com?subject=…`.
- [ ] Header shows "Current plan: Not set" when the venue has no
      plan metadata and no recognised price id.
- [ ] After a successful Stripe Checkout, the page shows
      "Current plan: Growth" with the matching interval suffix
      (e.g. "Active · monthly").
- [ ] Admin clicks the Growth **Start plan** / **Upgrade** CTA:
      POST `/api/billing/checkout` is sent with
      `{ plan_id: 'growth', interval: 'monthly', source:
      'subscription_plans_card' }`; response includes a Stripe
      Checkout URL; browser hard-redirects.
- [ ] Audit row `billing_checkout_session_create` appears in
      EnterpriseAuditEventsCard with metadata:
      `{ plan_id: 'growth', interval: 'monthly',
        stripe_price_configured: true,
        source: 'subscription_plans_card',
        session_url_returned: true, used_default_price: false }`.
- [ ] With `STRIPE_PRICE_GROWTH_MONTHLY` unset:
      route returns 422 `stripe_price_not_configured`; UI shows
      "Stripe price for growth is not configured. Ask the operator
      who runs deploys to set the matching STRIPE_PRICE_GROWTH_*
      env var."
- [ ] Selecting Enterprise → mailto opens; **no** Stripe checkout
      is initiated; route is never called.
- [ ] If somehow `plan_id: 'enterprise'` reaches the route:
      returns 400 `enterprise_contact_required`.
- [ ] As a non-admin, plan CTAs are disabled and a
      "Only venue owners and admins can change the plan." notice
      shows under the disabled button.
- [ ] Existing **Subscription** (BillingStatusCard) and
      **Payment methods** (PaymentMethodsCard) keep working with
      no regressions.
- [ ] Stripe webhook (`/api/stripe/webhook`) still receives + syncs
      events; `subscriptions.metadata.plan_id` is populated for any
      subscription created via the plan-aware checkout.
- [ ] No card number, last4, brand, payment method id, client
      secret, or raw Stripe payload appears in audit metadata, API
      response, or UI.
- [ ] Plan limits are NOT enforced anywhere yet — a venue on
      Starter can still create more than 500 leads/month.

---

## Phase 9T-alt — Knowledge Base CRUD QA

This isn't a billing surface but the audit + rate-limit posture
mirrors the billing routes, so the checks live near the rest of
the operator-write QA notes.

- [ ] On `/dashboard/settings` → Knowledge Base tab, "Add entry"
      opens the inline form. Save is disabled until both title
      (1–160) and content (1–8,000) have non-whitespace input.
- [ ] After a successful POST, the new entry appears at the top
      of the list and the form resets.
- [ ] Edit pencil opens inline edit mode for that row; Save sends
      a PATCH with only changed fields; Cancel reverts without a
      network call.
- [ ] Toggle icon flips `is_active`; audit row is
      `knowledge_entry_toggled` (NOT `_updated`).
- [ ] Delete prompts a native confirm; on confirm sends DELETE;
      row disappears; audit row is `knowledge_entry_deleted`.
- [ ] As a non-SALES role (viewer): the route returns the
      `tenant_access_*` forbidden family and the inline error
      reads "Only owners, admins, sales managers, or
      coordinators can edit knowledge."
- [ ] Cross-tenant probe (PATCH with a knowledge id from a
      different venue) returns 404 `not_found`.
- [ ] Rate-limit probe (6 rapid POSTs as one user) returns 429
      with `Retry-After`; UI shows "Too many edits in a short
      window."
- [ ] Audit metadata never contains the entry's `content` field;
      only `title`, `category`, `priority`, `is_active`,
      `content_length`.
- [ ] Refreshing the Settings page shows persisted state.
- [ ] AI orchestrator continues to read updated rows on the next
      conversation turn (smoke-tested via a real reply path).

---

## Phase 9T — Runtime QA coverage notes

Billing surfaces now have a Playwright smoke test in
`tests/e2e/inbox-tours-smoke.spec.ts` ("Billing settings smoke"):

- [ ] `/dashboard/settings/billing` mounts without crashing.
- [ ] **Payment methods** card heading is visible.
- [ ] **Subscription plans** card heading is visible.
- [ ] (Opt-in) When `E2E_ALLOW_STRIPE=1`, clicking **Manage
      payment method** issues a real `/api/billing/portal` POST.
      Skipped by default to avoid hammering Stripe in CI.

Things still verified by manual QA only (per existing
BILLING-QA checklists above):

- Stripe Checkout completion (we never follow the redirect in
  the suite).
- Per-card refresh / CSV export buttons on enterprise cards.
- Stripe webhook → subscription sync (out of scope for runtime
  QA; covered by existing webhook integration tests).

---

## GTM-0A — Revenue Recovery Demo seed QA

This lives on the billing settings page but is a sales/demo
surface, not a billing surface. Full QA checklist in
`docs/DEMO-REVENUE-RECOVERY.md`. Highlights:

- [ ] As admin/owner, the **Revenue Recovery demo mode** card
      renders on `/dashboard/settings/billing` next to the
      existing **Demo mode** (visual banner) card.
- [ ] Click **Seed demo data** with reset OFF → result counter
      shows 24 leads, ~14 conversations, ~25 messages, 7–8
      tours, 5 channel connections, optional KB/availability/
      blackout rows. `EnterpriseAuditEventsCard` gains one
      `revenue_recovery_demo_seeded` row.
- [ ] Re-click with **Reset previous demo seed first** ON →
      reset counter for `leads` matches the previous create
      counter; create counter is again 24. No duplicate Kanban
      cards.
- [ ] Re-click again with reset OFF → second
      `revenue_recovery_demo_seeded` audit row appears.
      `knowledge_base`, `tour_availability`, `tour_blackouts`
      now show in `skipped` (existing rows preserved).
- [ ] As a non-admin (sales/coordinator/viewer), the seed button
      either is not visible (admin-gated mount) OR clicking the
      route returns the `requireAdmin` 401/403 family and the
      card shows the friendly error.
- [ ] Result JSON never includes the seeded lead names / message
      content — counts + warnings only.
- [ ] No Stripe call. No Anthropic call. No external send.

---

## GTM-0B — Marketing reposition QA

Public-page-only checks. No billing surface changes in GTM-0B —
this lives here because billing-QA is the running marketing/sales
QA log too.

- [ ] `/` loads with the new hero ("Stop losing weddings in the
      follow-up gap.") and no `#audit` dead anchor.
- [ ] Navbar shows: Revenue leaks · How it works · Operator
      control · Pilot · FAQ. CTA: Book a demo → `/demo`.
- [ ] PainPoints section renders 5 cards (Slow replies, Qualified
      no tour, Cold follow-up, Unconfirmed tours, Source blind
      spots).
- [ ] HowItWorks renders 4 numbered steps (Unify → Detect → Draft
      → Track).
- [ ] DemoPreview shows the static mock with `$124k pipeline at
      risk` + the 4 leak buckets + Booked revenue by source table.
- [ ] Differentiation section uses operator-control framing; the
      "Honest scope" pill at the bottom says we DO NOT claim SOC 2
      / GDPR / PCI.
- [ ] ROI / Pilot section uses "Pilot packages available" — no
      specific price.
- [ ] FAQ renders 7 questions, first one open by default.
- [ ] FinalCTA / AuditForm copy reads "Apply for a pilot" —
      submission still writes to `audit_leads`.
- [ ] `/demo` renders, mailto fallback present, form submits.
- [ ] No console errors or runtime overlays on `/` or `/demo`.
- [ ] No marketing surface fetches from the dashboard data layer.

---

## GTM-0A.2 — Load / Stress Demo card QA

- [ ] Admin sees "Revenue Recovery load / stress demo" card on `/dashboard/settings/billing`.
- [ ] Non-admin (coordinator/sales_manager) does NOT see the card.
- [ ] Lead count + profile selectors are enabled when idle, disabled during submit.
- [ ] Submit with 250 leads + `balanced` completes in under 15 seconds and shows distribution breakdown.
- [ ] Submit with 1000 leads completes within 60 seconds; `durationMs` is reported.
- [ ] Submit with reset checkbox ON shows `Reset leads: N` row in the success panel.
- [ ] Hand-crafted GTM-0A demo rows remain on the same venue (reset is isolated).
- [ ] Generated lead emails all end in `@venuerise-demo.test`.
- [ ] Distribution shows non-zero counts in stages, sources, channels, leakage signals.
- [ ] Audit feed (`EnterpriseAuditEventsCard`) shows a `revenue_recovery_load_demo_seeded` row with `profile`, `lead_count_clamped`, `duration_ms` in metadata.

---

## Phase GTM-ILR — Instant Lead Response QA

- [ ] InstantResponseTrainingCard renders on /dashboard/settings/billing (admin-only).
- [ ] Default voice tone = `warm_concierge`, formality = `polished`, autoSendEnabled = OFF, autoSendMinConfidence = 85.
- [ ] Save persists per-field via POST /api/admin/revenue-os/settings (settings.instantResponse partial).
- [ ] New widget submission generates an AI message on its conversation within ~15s.
- [ ] AI message `metadata.source === 'instant_lead_response'` with `confidence`, `needs_human_review`, `auto_send_eligible`, `reasons`, `model`, `latency_ms`.
- [ ] When venue KB has no pricing rows, a lead asking about pricing generates a draft with `needs_human_review=true` and at least one reason in `pricing_discussed_without_kb` / `model_flagged_review`.
- [ ] When KB has zero rows and the lead asks about availability, draft does NOT guarantee the date.
- [ ] Sample replies entered on the card visibly shape the draft tone (manual smoke).
- [ ] Sending a duplicate `lead.created` event for the same lead does NOT produce a second AI message (orchestrator idempotency).
- [ ] With ANTHROPIC_API_KEY unset, lead creation still succeeds and the AI message persists as the fallback draft (`fallback_used=true`).
- [ ] With autoSendEnabled=ON + high confidence + safe content, audit row carries `auto_send_eligible: true` but no actual send happens (scaffold-only).
- [ ] EnterpriseAuditEventsCard shows `instant_lead_response.generated` (or `.fallback_created`) action.

---

## Phase GTM-0C — Sales asset pack QA

- [ ] `docs/gtm/` directory exists with 12 files (README + 11 assets)
- [ ] Every CTA in the sales scripts routes to a real destination
      (`/demo`, mailto, calendar link placeholder) — no broken refs
- [ ] No sales script claims "SOC 2", "GDPR", "guaranteed revenue",
      "fully autonomous", or "official partner" anywhere
- [ ] Pricing in `docs/gtm/PILOT-OFFER.md` is marked INTERNAL only
- [ ] The "one-extra-wedding" framing appears in DEMO-SCRIPT, COLD-CALL,
      ROI-FRAMING, and PILOT-OFFER — consistent across all four
- [ ] `docs/GTM-POSITIONING.md` is updated with a pointer to the sales
      asset pack
- [ ] No admin routes added, `ADMIN_ENDPOINT_COUNT` unchanged
- [ ] Build clean

## Phase 8BN — Composer-direct email delivery (informational)

Email outbound from the inbox composer is now wired via Resend
when `OUTBOUND_EMAIL_DELIVERY_ENABLED=1` + Resend config. Sends
flow through the existing `outbound_messages` table the digest
and tour-notification surfaces already use — billing-side
suppression rules apply unchanged.

QA-side notes:

- Suppressed recipients still appear on
  `DigestPreferencesCard` / suppression admin surfaces.
  Composer sends to a suppressed address surface as
  `delivery_status: 'skipped'` with reason `suppressed`.
- No billing gate change. The composer route already enforces
  `requireActiveSubscription`; the new delivery wrapper does
  not bypass it.
- Health flag `outbound_email_delivery` reports `'mounted'` or
  `'disabled'` based on the kill switch + Resend config — a
  useful at-a-glance signal during pilot rollouts.

See `docs/OUTBOUND-EMAIL-DELIVERY.md` for the full spec.

## Phase 8BP — Email lifecycle + retry (informational)

Composer email sends now expose a full lifecycle pill on
every bubble (Sending / Accepted by Email / Delivered /
Bounced / Marked as spam / Failed / Manual fallback) plus
inline Retry + Mark handled manually actions.

Billing-side notes:

- The Resend webhook continues to populate
  `outbound_messages.status` (queued/delivered/bounced/
  complained); existing billing surfaces are unchanged.
- New retry attempts increment
  `messages.metadata.delivery_retry_count`; existing
  `outbound_messages` rows are not duplicated on retry —
  a new outbound row is created per attempt for audit, but
  it points to the same `messages.id` via `related_id`.
- Suppression list interactions: hard bounces still add to
  `email_suppressions`. A retry on a now-suppressed address
  surfaces as `skipped` with reason `suppressed` (the
  composer pill shows "Saved in VenueRise" softly).

See `docs/EMAIL-DELIVERY-STATUS-AND-RETRY.md`.

## Phase 8BQ — Unmatched inbound email queue (informational)

8BQ adds a persistent dead-letter table (`inbound_email_orphans`)
for inbound email replies the matcher can't tie to a
conversation. Three new operator routes (list / link / dismiss).
No billing impact — orphan creation runs on the webhook hot
path (service role), linking inserts an existing-conversation
`role:'lead'` message which uses no API budget, dismissing only
mutates the orphan row.

Suppression / abuse interactions: unchanged. The webhook still
applies the existing inbound rate limit; orphan rows from
suppressed addresses (auto-responders / bounce loops) can be
mass-dismissed via the dropdown reason `auto_responder`.

See `docs/UNMATCHED-INBOUND-EMAIL-QUEUE.md`.

## Phase 8BR-alt — Orphan picker (informational)

Picker completes the 8BQ surface. No new routes, no new
audit actions, no new rate-limit buckets. Filtering happens
client-side over the inbox's already-loaded conversation
list. Server (link route) still enforces all venue/ownership
checks; the picker is purely a UX affordance. No billing
impact.

See `docs/UNMATCHED-INBOUND-EMAIL-QUEUE.md`.

## Phase 8BR — Outbound SMS delivery (informational)

Twilio-backed direct SMS from the inbox composer. New env
vars (`OUTBOUND_SMS_DELIVERY_ENABLED`, `TWILIO_*`,
`OUTBOUND_SMS_FROM`). No new admin routes, no new audit
actions (reuses `operator_message_send` audit row with
`delivery_channel:'sms'`), no new rate-limit buckets (reuses
existing operator message route limiter).

Billing-side notes:

- No usage / dunning impact — Twilio is billed direct to
  the venue's Twilio account, not via VenueRise billing.
- The kill switch is platform-wide; per-venue Twilio
  numbers are deferred.
- SMS failures still save the operator's message (8BP
  fallback button works for SMS too).

See `docs/OUTBOUND-SMS-DELIVERY.md`.
