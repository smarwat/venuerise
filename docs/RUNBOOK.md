# VenueRise — Operations Runbook

Last reviewed: Phase 7B.

Pager-friendly playbook. Each section: how to verify the system is working, then what to do when it isn't. Pair this with:
- [SECURITY.md](./SECURITY.md) for secrets handling and the trust-boundary model.
- [DEPLOYMENT.md](./DEPLOYMENT.md) for first-time setup and the post-deploy checklist.
- [STAGING-CHECKLIST.md](./STAGING-CHECKLIST.md) for setting up a parallel staging stack.
- [LAUNCH-DAY.md](./LAUNCH-DAY.md) for the 72-hour launch-window playbook (alert wiring, baselines, pause/rollback thresholds).

Convention used throughout:
- `$APP` = canonical production URL (e.g. `https://app.venuerise.com`).
- `$VENUE` = a real production venue id (cross-reference Supabase `venues` table).

---

## 0. Automated smoke tests (Phase 7B)

Run these from a laptop or CI against any environment. Both are zero-dependency Node 18+ scripts.

```bash
# End-to-end: health → readiness → auth → widget → DB rows
npm run smoke:prod

# Widget POST load + latency percentiles
npm run load:widget
```

Full env var docs: [DEPLOYMENT.md §6](./DEPLOYMENT.md) and [STAGING-CHECKLIST.md §10](./STAGING-CHECKLIST.md).
Baseline percentile capture is part of [LAUNCH-DAY.md §5](./LAUNCH-DAY.md).

If `smoke:prod` is failing, the failure message names the step (e.g. `[db.ai_actions.appear] timed out`) — jump to the relevant section in §2 below.

---

## 1. Smoke tests — happy-path verification

### 1.1 Widget submission → lead → AI reply

```bash
curl -i -X POST $APP/api/widget \
  -H "Content-Type: application/json" \
  -H "Origin: $APP" \
  -d '{"venue_id":"'"$VENUE"'","name":"Runbook Test","email":"runbook@example.com","guest_count":150}'
```

Pass criteria:
- HTTP **201** with `{ "success": true, "lead_id": "…", "conversation_id": "…" }`.
- Within 30s, Inngest function `lead.created` shows a green run.
- Supabase `leads` row exists with `ai_active=true`, `lead_score>0` after qualification.
- Resend dashboard shows a `welcome` email sent to the lead.

### 1.2 AI qualification (re-run)

```bash
curl -i -X POST $APP/api/ai/qualify \
  -H "Content-Type: application/json" \
  -H "Cookie: <sb-…-auth-token=…>" \
  -d '{"lead_id":"<LEAD_ID>"}'
```

Pass criteria: HTTP **200** with a `score`, `summary`, and `next_action`. The orchestrator logs `ai.qualify.completed` with the request id.

### 1.3 Email delivery

Two paths to verify:

1. **Live send via Resend** — trigger a follow-up by visiting `/dashboard/leads`, opening a lead, scheduling a follow-up. Within ~30s the row in `follow_up_schedules` flips to `status=sent` and the address receives the email.
2. **Console fallback** — if `RESEND_API_KEY` is intentionally absent (preview env), follow-ups flip to `status=skipped`, and the email body is logged at `info` with `email.send.console_fallback`.

### 1.4 Team invite end-to-end

```bash
curl -i -X POST $APP/api/team/invitations \
  -H "Content-Type: application/json" -b "<auth cookie>" \
  -d '{"email":"teammate@example.com","role":"coordinator"}'
```

Pass criteria: HTTP **201** with `email_sent: true`. Recipient gets an email with `/onboarding/accept?token=…`. Visiting the URL while signed in returns success and adds a `venue_members` row with `role=coordinator`.

---

## 2. Incident playbooks

### 2.1 Widget returns 500

1. Hit `$APP/api/readiness`. If `ready: false`, fix the missing dep first (see RUNBOOK §3).
2. Search Sentry for `route:/api/widget` in the last 15 min.
3. If the error is `widget.venue_lookup.failed` → Supabase health is the actual problem. Check Supabase status page.
4. If the error is `widget.lead.insert_failed` with a `42501` (permission) code → service-role key isn't actually service role. Re-fetch from Supabase dashboard and redeploy.
5. If the error is `widget.origin_not_allowed` → someone changed `NEXT_PUBLIC_APP_URL` without restarting; trigger a fresh deploy to repopulate env into the edge runtime.

### 2.2 AI does not respond

Symptoms: lead created, conversation_id returned, but no AI message in the inbox after 60s.

1. Check Inngest dashboard for the `lead.created` function. If it's red, click into the most recent failure — Anthropic 429s are the usual culprit during launch traffic spikes.
2. If green: query Supabase `ai_actions` for that lead_id. If empty, the orchestrator never started — restart by:
   ```bash
   curl -X POST $APP/api/ai/qualify \
     -H "Content-Type: application/json" -b "<auth>" \
     -d '{"lead_id":"<LEAD>"}'
   ```
3. If the orchestrator started but stalled, check `ai_actions.error_message`. Common values:
   - `anthropic_retry_exhausted` → see Anthropic status; reduce concurrency in Inngest if traffic is spiky.
   - `Knowledge base empty for venue` → ask the venue to add at least one KB row in Settings → Knowledge Base.

### 2.3 Follow-ups aren't sending

1. `select * from follow_up_schedules where status='pending' and scheduled_for < now() order by scheduled_for limit 20;` — there should be ≤ 1 row pending (the cron runs every minute).
2. If many pending: the Inngest cron `follow_up.scan` is failing. Check Inngest → Functions → `followUpScan` → last run.
3. If Inngest shows `success` but rows aren't flipping: check Sentry for `job.followUpScan.failed` events. Most often the issue is a malformed `RESEND_FROM_EMAIL` (e.g. wrong domain).
4. If rows are flipping to `skipped` instead of `sent`: Resend isn't configured. Verify env vars and redeploy.

### 2.4 Resend webhook failing

Symptoms: bounces in Resend dashboard aren't reflected in Supabase `outbound_messages.status` or `suppressions`.

1. Visit Resend → Webhooks → your endpoint → "Recent attempts". If status is 401, `RESEND_WEBHOOK_SECRET` is wrong or missing.
2. Hit `$APP/api/health` — `resend_webhook` should report `configured`. If `missing`, set the env and redeploy.
3. If 200 but no DB update: search Sentry for `route:/api/resend/webhook`. The signature verification helper logs `webhook.resend.signature_mismatch` on token rotation problems.
4. Rotation procedure: in Resend, generate a new signing secret; deploy with the new value FIRST, then click "Rotate" in Resend to invalidate the old. There's a ~30s gap where both work — coordinate.

### 2.4b Billing gate returning 402 unexpectedly (Phase 7D, expanded in 7E)

Symptoms: a logged-in admin clicks "Add lead" or runs an AI requalify and gets HTTP 402 `subscription_required`.

The canonical entitlement matrix is in [docs/BILLING-QA.md](./BILLING-QA.md). Read that first — it tells you the expected response for every route under every state.

1. Hit `$APP/api/health` and check `billing.gate`. If `enabled` and you expected `disabled`, an operator flipped `BILLING_GATE_ENABLED=1` — confirm intent or unset.
2. If the gate is intentionally enabled, inspect the caller's venue subscription state via service-role SQL:
   ```sql
   select status, current_period_end, trial_end, canceled_at, created_at, metadata
   from public.subscriptions where venue_id='<venue id>'
   order by created_at desc limit 5;
   ```
   The helper's priority order is `active > trialing > past_due > incomplete > unpaid > paused > canceled > incomplete_expired` (ties broken by `created_at` desc). Only `active` and `trialing` clear the gate.
3. Common causes:
   - **Trial expired**: the onboarding trial row has `status='trialing'` and `trial_end < now()`. Stripe doesn't auto-update — the user must check out. To extend a trial manually:
     ```sql
     update public.subscriptions
     set trial_end = now() + interval '14 days'
     where venue_id='<venue id>' and stripe_subscription_id is null;
     ```
   - **Webhook lag**: customer just paid but `subscriptions` hasn't synced yet. Re-deliver the latest `customer.subscription.updated` event from Stripe → Webhooks → Recent attempts.
   - **Orphan subscription**: the venue has a Stripe customer but no `billing_customers` row (e.g. data was deleted manually). Recreate the mapping, then re-deliver events.
4. **Quick gate disable** (single rollback step):
   - Vercel → Environment Variables → Production → set `BILLING_GATE_ENABLED=0` (or delete the variable).
   - Trigger a redeploy. Within ~60s, gated routes flip back to 2xx. No data is lost; subscription state is unchanged.
5. **Reproduce in staging before re-enabling**:
   ```bash
   SEED_SUBSCRIPTION_SUPABASE_URL=$STAGING_SUPABASE_URL \
     SEED_SUBSCRIPTION_SERVICE_ROLE_KEY=$STAGING_SERVICE_KEY \
     SEED_SUBSCRIPTION_VENUE_ID=$STAGING_TEST_VENUE \
     SEED_SUBSCRIPTION_STATUS=past_due \
     npm run billing:seed

   BILLING_MATRIX_APP_URL=$STAGING_URL \
     BILLING_MATRIX_SUPABASE_URL=$STAGING_SUPABASE_URL \
     BILLING_MATRIX_SUPABASE_ANON_KEY=$STAGING_ANON \
     BILLING_MATRIX_SUPABASE_SERVICE_ROLE_KEY=$STAGING_SERVICE_KEY \
     BILLING_MATRIX_TEST_USER_EMAIL=$STAGING_USER \
     BILLING_MATRIX_TEST_USER_PASSWORD=$STAGING_PASS \
     BILLING_MATRIX_VENUE_ID=$STAGING_TEST_VENUE \
     BILLING_MATRIX_EXPECT_GATE=1 \
     npm run billing:matrix
   ```
   The seed script ONLY touches rows tagged `metadata.source='billing_gate_test'`. **Never run it in production** — there's no production guardrail beyond operator discipline.
6. Once the matrix script passes against the desired state, restore production-trial state with `SEED_SUBSCRIPTION_STATUS=trialing` and re-enable the gate.

### 2.4c Stripe billing event audit log (Phase 7F)

Every event Stripe sends us is persisted to `public.billing_events_log` before dispatch. Use it for "what did Stripe tell us, and did we cope?".

**Inspect recent events for a venue**:
```sql
select stripe_event_id, event_type, handled, handler_error,
       duplicate_count, received_at
from public.billing_events_log
where venue_id='<venue id>'
order by received_at desc
limit 20;
```

**Find recent failures across all tenants** (operator surface — bypass RLS via service role):
```sql
select stripe_event_id, event_type, handler_error, venue_id, received_at
from public.billing_events_log
where handled = false
  and handler_error is not null
  and received_at > now() - interval '24 hours'
order by received_at desc
limit 50;
```

**Spot Stripe redeliveries** (anything > 0 means Stripe retried us):
```sql
select stripe_event_id, event_type, duplicate_count, received_at
from public.billing_events_log
where duplicate_count > 0
order by duplicate_count desc, received_at desc
limit 20;
```

**Events for a specific Stripe customer** (when you only have the Stripe id, not the venue):
```sql
select stripe_event_id, event_type, handled, venue_id, received_at
from public.billing_events_log
where stripe_customer_id='cus_...'
order by received_at desc limit 20;
```

**Customer reports billing weirdness, Stripe dashboard shows event delivered**:
1. Find the event in our log:
   ```sql
   select * from public.billing_events_log
   where stripe_event_id='evt_...';
   ```
2. If `handled = false` and `handler_error` is populated → look the error up in Sentry (`webhook.stripe.handler_failed`).
3. **Replay the event from Stripe**: Dashboard → Developers → Webhooks → your endpoint → click the event → "Resend". Our handler is idempotent on `stripe_subscription_id`; the audit row will bump `duplicate_count` and the subscription sync will replay.
4. After replay, re-check: `handled` should flip to `true` and `handler_error` should clear (next replay overwrites).

**If the audit log itself is failing** (e.g. table missing, RLS misconfig): hit `/api/readiness` and look for `billing_events_log: "missing"` in `failed[]`. The webhook handler keeps running — losing audit coverage doesn't take down billing — but the operator surface goes dark. Re-apply migration 008.

**Admin API (Phase 7G)** — inspect the audit log over HTTP without SQL.

List recent events for your venue:
```bash
curl -H "Cookie: sb-...-auth-token=..." \
  "$APP/api/admin/billing-events?handled=false&limit=20"
```

Inspect a single event including the full Stripe payload:
```bash
curl -H "Cookie: sb-...-auth-token=..." \
  "$APP/api/admin/billing-events/<row-id>"
```

The list endpoint **never** returns `payload`. The detail endpoint does — use it sparingly and don't paste responses into shared channels (Stripe payloads contain customer PII; see [SECURITY.md §10e](./SECURITY.md)).

Common filters on the list endpoint:
| Filter | Example | Meaning |
|---|---|---|
| `handled=false` | `?handled=false` | webhook delivered, our handler failed |
| `event_type=...` | `?event_type=invoice.payment_failed` | all events of a single type |
| `venue_id=<uuid>` | `?venue_id=...` | admin of multiple venues, target a specific one (you must hold ADMIN_ROLES on it) |
| `limit=<N>` | `?limit=200` | max 200; default 50 |

### 2.4d Trial reminder didn't send (Phase 7H)

The trial reminder is an Inngest cron (`billing-trial-reminder`) on schedule `0 14 * * *` (daily 2pm UTC). It selects venues whose `trial_end` falls on (now + 3 days, UTC) and emails the owner once. Idempotency lives on `subscriptions.metadata.reminders_sent` — no new tables.

**Symptom**: a venue reports they didn't get a trial-ending email.

1. **Is the function even registered?**
   - `curl $APP/api/health | jq .billing.trial_reminder` → should be `"mounted"`.
   - Inngest dashboard → Apps → your app → Functions → confirm `billing-trial-reminder` appears with schedule `0 14 * * *`.
2. **Did today's run fire?**
   - Inngest dashboard → Functions → `billing-trial-reminder` → Runs. The most recent successful run was today at 14:00 UTC.
   - If no run today: check `INNGEST_SIGNING_KEY` / app sync (covered in §2.6).
3. **Did the venue match the candidate query?**
   ```sql
   select id, venue_id, status, trial_end, metadata
   from public.subscriptions
   where status='trialing'
     and trial_end::date = (now() + interval '3 days')::date;
   ```
   - If empty: the venue's `trial_end` isn't exactly 3 days out (UTC). Stripe trials shift +/- a day around DST/timezones; consider extending manually via `update subscriptions set trial_end = ... where id = ...`.
4. **Was the reminder already recorded as sent?**
   ```sql
   select id, venue_id, metadata->'reminders_sent' as reminders_sent
   from public.subscriptions
   where venue_id='<venue id>' and metadata ? 'reminders_sent';
   ```
   Each row in `reminders_sent` has shape `{ kind, key, sent_at, provider, message_id? }`. The key is `trial_3d:<venue_id>:<trial_end YYYY-MM-DD>` — if it's present for today's trial_end, the cron has already sent (probably to the email below).
5. **Does the owner have a usable email?**
   ```sql
   select vm.user_id
   from public.venue_members vm
   where vm.venue_id='<venue id>' and vm.role='owner'
   order by vm.created_at asc limit 1;
   ```
   Then look up that user's email in `auth.users` via Supabase dashboard. If null, the cron logs `jobs.billing_trial_reminder.skip_no_owner_email`.
6. **Is Resend configured?**
   - `curl $APP/api/health | jq .email` → should be `"configured"` in prod. If `"console-fallback"`, the cron logged the email to stdout and did NOT mark the reminder as sent (so it will retry once Resend is configured).
7. **Manually retrigger** from Inngest UI: Functions → `billing-trial-reminder` → "Invoke". The function will scan again and pick up anyone missed.

**To force a fresh send to a venue that's already received the reminder** (rare — usually you don't want this): delete that row's `reminders_sent` entry:
```sql
update public.subscriptions
set metadata = metadata - 'reminders_sent'
where id='<subscription id>';
```
Next cron run will re-send. ONLY do this when an operator has confirmed the original email genuinely didn't arrive (Resend bounce, etc.).

### 2.4e How to replay a missed Stripe event (Phase 7I)

When a webhook handler failed transiently (Supabase blip, downstream Anthropic timeout, etc.) the audit row in `billing_events_log` is left with `handled=false`. Two recovery paths:

| Path | When to use | Side effects |
|---|---|---|
| Stripe dashboard → Webhooks → endpoint → click event → **Resend** | You suspect Stripe-side data changed since the original delivery, OR you want to verify the signature path is healthy | Insert hits the UNIQUE on `stripe_event_id` → audit helper bumps `duplicate_count` and the dispatcher short-circuits. You'll see `received: true, duplicate: true` in our response. The row's `handled`/`handler_error` is NOT updated. |
| Our `/api/admin/billing-events/[id]/replay` | You want the same audit row to flip green and you want a single click | Re-fetches the event from Stripe (`stripe.events.retrieve`), re-dispatches via the shared dispatcher, updates the SAME audit row in place. Does NOT increment `duplicate_count`. |

Most of the time, use our endpoint. The Stripe button is the right call only when the operator specifically needs to test the signature path or wants Stripe to re-prove its end.

**Curl recipe**:
```bash
# Find a failed event id from the audit log:
curl -H "Cookie: sb-...-auth-token=..." \
  "$APP/api/admin/billing-events?handled=false&limit=10" | jq '.items[].id'

# Replay one:
curl -X POST -H "Cookie: sb-...-auth-token=..." \
  "$APP/api/admin/billing-events/<id>/replay"
# → { "replayed": true, "handled": true, "ignored": false, "handler_error": null }
```

**Verify**:
```sql
select id, stripe_event_id, handled, handler_error, handled_at
from public.billing_events_log
where id = '<id>';
```

`handled` should now be `true`, `handler_error` `null`, and `handled_at` updated to the replay time.

**Failure modes**:
- 401 — operator not signed in.
- 404 — row missing, row's `venue_id` is null (forensic-only), or operator isn't admin of the row's venue.
- 429 — replay rate limit per caller (`admin:billing-event-replay:{userId}`).
- 502 `stripe_retrieve_failed` — Stripe API rejected our `events.retrieve` call (event purged, or invalid id). Replay can't proceed without Stripe.
- 503 `billing_not_configured` — `STRIPE_SECRET_KEY` missing in this env.
- 500 `unexpected_error` — anything else; Sentry-captured.

**Warning**:
- Replay re-runs the full handler against the freshest event payload. For `customer.subscription.updated`, it overwrites `subscriptions` with current Stripe state. For `invoice.payment_*`, it re-pulls + syncs the subscription. Don't spam replay if the event is already healthy — the response body will tell you (`handler_error: null` + `handled: true`).
- Replay does NOT trigger downstream emails or in-app notifications. It's a state-sync operation only.

**Phase 7J — replay attribution** (`replayed_at` / `replayed_by` / `replay_count` on `billing_events_log`).

Every successful replay records who triggered it. The atomic increment is done by the `public.record_billing_event_replay(p_event_id, p_user_id)` SECURITY DEFINER function so concurrent replays can't race the counter. Only the service role can EXECUTE it; the replay endpoint is the only caller.

Find recently replayed events (the partial index makes this cheap):
```sql
select id, stripe_event_id, event_type, handled, handler_error,
       replay_count, replayed_at, replayed_by
from public.billing_events_log
where replay_count > 0
order by replayed_at desc
limit 50;
```

Who replayed what for a venue:
```sql
select e.id, e.stripe_event_id, e.event_type,
       e.replay_count, e.replayed_at, e.replayed_by,
       u.email as replayed_by_email
from public.billing_events_log e
left join auth.users u on u.id = e.replayed_by
where e.venue_id='<venue id>' and e.replay_count > 0
order by e.replayed_at desc;
```

A handler-failed replay still counts: `replay_count` increments any time dispatch FINISHES (success or failure). Only Stripe-retrieve failures (502 from the replay route) skip the counter — those aborts happen before dispatch.

### 2.4i How to clear dunning attempts safely (Phase 7N)

When a customer reports "I keep getting dunning emails even though I paid" or "you sent me three reminders but only one charge actually failed", we need an operator escape hatch to clear out the recorded attempts without invasive SQL.

**Tool**: `POST /api/admin/billing-events/[id]/clear-dunning`. Owner/admin only. The `id` in the path is any billing event log row id that belongs to the same venue as the subscription we're modifying — typically the most recent `customer.subscription.updated` event for the customer.

**Curl**:
```bash
# Clear ONE period's attempts on a subscription.
curl -X POST -H "Cookie: sb-...-auth-token=..." \
     -H "Content-Type: application/json" \
     -d '{"subscription_id":"<uuid>","period_date":"2026-06-01","reason":"customer-claim charge was successful but we kept sending"}' \
     "$APP/api/admin/billing-events/<event id>/clear-dunning"

# Clear ALL periods' attempts for a venue.
curl -X POST -H "Cookie: sb-...-auth-token=..." \
     -H "Content-Type: application/json" \
     -d '{"subscription_id":"<uuid>","reason":"full reset after data migration"}' \
     "$APP/api/admin/billing-events/<event id>/clear-dunning"
```

Response:
```json
{
  "success": true,
  "subscription_id": "...",
  "cleared_prefix": "dunning:VENUE_ID:2026-06-01",
  "metadata": { "dunning_sent": [...remaining entries...] }
}
```

**Before/after metadata** — capture both via the Phase 7G detail endpoint:
```bash
# Before:
curl -H "Cookie: ..." "$APP/api/admin/billing-events/<event id>" \
  | jq '.item.payload // empty, .item // {}'

# Run clear-dunning (above).

# After:
curl -H "Cookie: ..." "$APP/api/admin/billing-events/<event id>" \
  | jq '.item // {}'
```

**Prefix-targeting rules**:
- `period_date` provided → prefix is `dunning:<venue>:<period_date>` (filters out the matching period's attempts; other periods preserved).
- `period_date` omitted → prefix is `dunning:<venue>:` (wipes EVERY period for the venue — use sparingly).

**When NOT to use it**:
- The dunning cron is doing its job and the customer is genuinely past_due. Clearing attempts will cause the cron to start fresh + send up to 3 more emails.
- A previous attempt actually bounced and you want to retry — instead, fix the bounce reason (clear suppressions, see RUNBOOK §2.4) and the cron will send attempt 2 within 48h.
- "Just to be safe." Trust the dunning state machine until the customer reports a real issue.

**Safe-use criteria**:
- Customer confirms they were charged AND they kept receiving dunning emails (rare; usually the recovery email fires when the charge clears — see §2.4h).
- Data migration / Stripe id swap left orphan `dunning_sent` entries pointing at periods that no longer exist.
- Test fixtures in staging — never use this in staging without re-asserting `BILLING_MATRIX_APP_URL` is the staging URL.

**SQL fallback** (when the API is unavailable):
```sql
update public.subscriptions
   set metadata = jsonb_set(
     metadata,
     '{dunning_sent}',
     (select coalesce(jsonb_agg(e), '[]'::jsonb)
        from jsonb_array_elements(metadata->'dunning_sent') e
       where not (e->>'key' like 'dunning:<venue id>:<period>%'))
   )
 where id = '<subscription id>';
```

The SQL is functionally equivalent to the RPC. Prefer the HTTP route — it carries `requestId` + operator id through to Pino + Sentry so the action is auditable.

**Failure modes**:
- 401 — operator not signed in.
- 404 — billing event id missing / `venue_id IS NULL` / cross-tenant / subscription doesn't belong to the event's venue.
- 400 `validation_failed` — body schema failure (e.g. `period_date` not `YYYY-MM-DD`).
- 429 — clear-dunning rate limit per caller.
- 500 — RPC threw (Sentry captures the underlying Postgres error).

### 2.4h Customer paid but never got recovery email (Phase 7M)

Symptom: a customer's subscription transitioned from `past_due` back to `active`/`trialing` but they didn't receive the "Payment received — your VenueRise account is active" email.

The recovery email is a webhook-driven side effect (no cron). The Stripe event dispatcher inspects the result of `syncSubscriptionFromStripeSubscription`; when it sees `previousStatus === 'past_due'` and the new status in `{active, trialing}`, it calls `sendPaymentRecoveryEmail`. Idempotent on `subscriptions.metadata.recovery_sent`.

1. **Did the subscription actually transition?**
   ```sql
   select id, venue_id, status, current_period_end, updated_at
   from public.subscriptions
   where venue_id='<venue id>'
   order by updated_at desc limit 5;
   ```
   - The current `status` must be `active` or `trialing`.
   - The transition is detected only by comparing the PREVIOUS local row's status to the new one — so we need the row to have actually been `past_due` just before the webhook. The Phase 7F audit log proves this: look for the latest `customer.subscription.updated` event for the venue and inspect its `payload.data.previous_attributes.status` (Stripe sends this on updates).
2. **Was the webhook delivered + handled?**
   - Stripe dashboard → Webhooks → endpoint → recent attempts (look for the `customer.subscription.updated` for that subscription).
   - Our audit:
     ```sql
     select stripe_event_id, event_type, handled, handler_error, received_at
     from public.billing_events_log
     where venue_id='<venue id>' and event_type like 'customer.subscription.%'
     order by received_at desc limit 10;
     ```
   - If `handled=false`, the recovery hook never ran. Fix the handler error, then `POST /api/admin/billing-events/<id>/replay` (Phase 7I) to re-dispatch — the dispatcher re-checks the transition and fires the email if eligible.
3. **Did the dispatcher try?**
   - The webhook response body now includes `recovery_email: { sent, skipped, reason? }` when the dispatcher attempted one. Find the request id from the webhook response, grep Pino: `vercel logs $APP --since=1h | grep '"op":"billing.payment_recovery"'`.
   - If the log says `skip_already_sent`, the customer already received it (idempotency is doing its job).
   - If `skip_no_owner_email`, the venue's owner row has no email in `auth.users`. Fix and re-trigger.
4. **Recovery key already present?**
   ```sql
   select id, venue_id, metadata->'recovery_sent' as recovery_sent
   from public.subscriptions
   where venue_id='<venue id>';
   ```
   Each entry has shape `{ kind, key, sent_at, provider, message_id }`. The key is `recovery:<venue_id>:<current_period_end YYYY-MM-DD>`. Same-period recoveries are deliberately de-duped — a customer who bounces past_due → active → past_due → active within one billing period gets one email.
5. **To force a re-send** (rare): clear the matching entry:
   ```sql
   update public.subscriptions
   set metadata = jsonb_set(
     metadata,
     '{recovery_sent}',
     (select coalesce(jsonb_agg(e), '[]'::jsonb)
        from jsonb_array_elements(metadata->'recovery_sent') as e
       where e->>'key' <> 'recovery:<venue_id>:<YYYY-MM-DD>')
   )
   where id='<subscription id>';
   ```
   Then trigger a fresh `customer.subscription.updated` event (toggle metadata on the Stripe-side subscription) so the dispatcher re-runs.
6. **Resend configured?**
   - `/api/health` → `email: "configured"` in prod. If `"console-fallback"`, the helper logs the email body and does NOT append the recovery entry — next valid webhook with the same transition retries once Resend is wired.
7. **Helper returned `metadata_append_failed`?**
   - The email already went out; we just couldn't record it. Sentry captures the underlying error. Same recovery posture as Phase 7L crons — next eligible transition may double-send.

### 2.4g0 Cron metadata append failed (Phase 7L)

Symptom: trial-reminder or dunning cron summary reports `failed > 0` and the log line is `jobs.billing_*.metadata_append_failed`.

Phase 7L moved both crons' metadata writes from read-modify-write to an atomic Postgres RPC, `public.append_subscription_metadata_array(p_subscription_id uuid, p_array_key text, p_entry jsonb)`. A `failed` count from a metadata append means the RPC errored — the email DID send, we just couldn't record it.

1. **Verify the function still exists**:
   ```sql
   select proname, pg_get_function_arguments(oid), pg_get_function_result(oid)
   from pg_proc
   where proname = 'append_subscription_metadata_array';
   ```
2. **Common causes**:
   - Subscription row was hard-deleted between the cron's `select` and the RPC call (the RPC raises `subscription not found`).
   - Migration 010 was rolled back; re-apply.
   - Service-role key rotation in progress; the GRANT on the function targets `service_role` — if the role identity shifted, the RPC EXECUTE fails with permission denied.
3. **Sentry captures every RPC error** via `billing.metadata.append_rpc_error` (or `…_threw` for network errors). Search Sentry for those tags + the `subscriptionId` from the log line.
4. **Recovery**: the email already sent. Next cron run will see the stale metadata, skip the idempotency check, and may re-send. That's expected — losing one append should not cascade. If two emails for the same window arrive, the operator can confirm + apologize.

### 2.4g Dunning didn't fire (Phase 7K)

The dunning workflow is an Inngest cron (`billing-dunning`) on schedule `0 16 * * *` (daily 4pm UTC). For every `past_due` subscription, it sends the venue owner a "update your payment method" email with a Stripe Customer Portal link. Caps at 3 attempts per `current_period_end`; 48h spacing between attempts.

**Symptom**: a customer in `past_due` reports they haven't received any payment-update emails.

1. **Is the function registered?**
   - `curl $APP/api/health | jq .billing.dunning` → must be `"mounted"`.
   - Inngest dashboard → Apps → your app → Functions → confirm `billing-dunning` with schedule `0 16 * * *`.
2. **Did today's run fire?**
   - Inngest dashboard → Functions → `billing-dunning` → Runs. Most recent successful run today at 16:00 UTC.
   - If no run: check `INNGEST_SIGNING_KEY` / app sync (§2.6).
3. **Is the venue actually `past_due`?**
   ```sql
   select id, venue_id, status, current_period_end, metadata->'dunning_sent' as dunning_sent
   from public.subscriptions
   where venue_id='<venue id>'
   order by created_at desc limit 5;
   ```
   - Status flipped back to `active`? Webhook arrived → no email needed.
   - `current_period_end` null? Cron filters it out — wait for Stripe to populate or replay the latest `customer.subscription.updated` event (see §2.4e).
4. **Already at 3 attempts?**
   - The cron logs `jobs.billing_dunning.escalation_needed` + Sentry-captures with severity warning when a venue hits the cap.
   - Human intervention: reach out to the customer directly, OR clear out the attempts for this period to re-arm (rare; only do this after confirming the original emails didn't actually arrive):
     ```sql
     -- Remove this period's attempts only. Other periods' entries preserved.
     update public.subscriptions
     set metadata = jsonb_set(
       metadata,
       '{dunning_sent}',
       (select coalesce(jsonb_agg(e), '[]'::jsonb)
          from jsonb_array_elements(metadata->'dunning_sent') as e
         where not (e->>'key' like 'dunning:<venue_id>:<current_period_end YYYY-MM-DD>:%'))
     )
     where id='<subscription id>';
     ```
5. **Latest attempt < 48h ago?**
   - The 48h spacing rule blocks rapid retries even when a manual operator invokes the cron. `jobs.billing_dunning.skip_too_recent` log line names the hours since the last send.
6. **Owner has an email?**
   - Same SQL as Phase 7H §2.4d step 5. `jobs.billing_dunning.skip_no_owner_email` log line.
7. **Stripe portal session creatable?**
   - The cron calls `createBillingPortalSession`. Fails with `billing_customer_not_found` if no `billing_customers` row exists for the venue — happens when a sub was created out-of-band. Backfill `billing_customers` mapping, then re-run.
   - Other Stripe failures log `jobs.billing_dunning.portal_failed` + Sentry-capture.
8. **Resend configured?**
   - `/api/health` → `email: "configured"` in prod. If `"console-fallback"`, the cron logs the email + does NOT consume an attempt slot. Once Resend is wired, the NEXT cron run will send.
9. **Manually retrigger** from Inngest UI: Functions → `billing-dunning` → "Invoke". The function will scan again, respecting the 48h + 3-attempt guards.

### 2.5 Stripe webhook failing or checkout returns 503

Symptoms: clicking "Subscribe" returns 503, OR Stripe → Webhooks → "Recent attempts" shows 401s/5xxs.

1. Hit `$APP/api/health` and confirm `billing.stripe = "configured"` and `billing.webhook = "configured"`. If either is `missing`, set the env var and redeploy.
2. Hit `$APP/api/readiness` — `stripe`, `stripe_webhook`, `stripe_price` must all be `configured`. A missing default price id makes checkout 400 (not 503), so confirm `STRIPE_DEFAULT_PRICE_ID` is set if checkout returns `price_id_missing`.
3. If webhook attempts are 401: the signing secret rotated or is wrong. Re-copy from Stripe → Webhooks → endpoint → Signing secret. Deploy with the new value FIRST, then click "Rotate" in Stripe to invalidate the old. There's a brief overlap window where both work.
4. If webhook attempts are 200 but `subscriptions` rows aren't updating: check Sentry for `webhook.stripe.handler_failed` events. The most common cause is a missing `venue_id` in subscription metadata — fixable by retrying the most recent `customer.subscription.updated` event from Stripe (the route is idempotent), or by manually upserting the `billing_customers` row to map the customer to the venue, then re-syncing.

To **rotate the secret safely**:
1. Stripe → Webhooks → endpoint → "Roll secret". Stripe shows the new value AND keeps the old one valid for ~24h.
2. Update `STRIPE_WEBHOOK_SECRET` in Vercel; redeploy.
3. After the deploy is live, click "Stop accepting old secret" in Stripe.

### 2.6 Inngest jobs not running

1. Check Inngest dashboard → Apps → your app → "Sync status". A failed sync means Inngest can't reach `$APP/api/inngest`. Most common: missing or wrong `INNGEST_SIGNING_KEY`.
2. Trigger a manual sync from the dashboard.
3. If syncs are green but functions still aren't firing: ensure `INNGEST_EVENT_KEY` matches the project. Test:
   ```bash
   curl -i -X POST $APP/api/widget -H "Content-Type: application/json" \
     -H "Origin: $APP" -d '{"venue_id":"'"$VENUE"'","name":"sync","email":"sync@example.com"}'
   ```
   The `lead.created` event should appear in Inngest's event stream within seconds.

### 2.7 Rate limiting misfires

Symptoms: legitimate users seeing 429 from `/api/widget` or `/api/ai/*`.

1. Hit `$APP/api/health` — `upstash` should be `configured`.
2. Open Upstash dashboard → Metrics → throughput. Sudden spike + 0 errors means real traffic — bump the limit in `lib/rate-limit.ts` (rebuild + redeploy).
3. If Upstash itself is failing, `lib/rate-limit.ts` is fail-open: requests are allowed and a `rate_limit.disabled` warning logs once. Verify the warning is the only sign of disablement before assuming it's just slow.

---

## 3. Health vs readiness — when to use which

- `/api/health` — answers "is the process alive?". 200 unless Supabase is wholly down. Use for uptime pingers running every 60s.
- `/api/readiness` — answers "is the deployment configured to take production traffic?". 503 in production if ANY of: Supabase down, Anthropic key missing, Inngest keys missing, Resend keys missing, Upstash missing, Sentry missing, `INTERNAL_API_SECRET` missing-or-short, or `NEXT_PUBLIC_APP_URL` missing/invalid. Use for load-balancer in-rotation checks (5-minute interval).

The `failed` array in the readiness response names exactly which checks need attention. Don't dig further until that's empty.

### 3.1 Uptime / readiness pinger configuration

Pick any tool that can do HTTP probes with body assertions. Recommended baseline:

| Probe | URL | Interval | Pass criteria | On fail |
|---|---|---|---|---|
| Liveness | `$APP/api/health` | 60s | HTTP 200 | Email after 3 consecutive fails |
| Readiness | `$APP/api/readiness` | 5 min | HTTP 200 AND body contains `"ready":true` | Page on-call after 2 consecutive fails |
| Dashboard auth | `$APP/dashboard` | 5 min | HTTP 307 | Email ops after 3 fails |

Full alert wiring (Sentry / Inngest / Resend) is in [LAUNCH-DAY.md §4](./LAUNCH-DAY.md).

---

## 4. Rotating secrets

| Secret | Frequency | Procedure |
|---|---|---|
| `SUPABASE_SERVICE_ROLE_KEY` | On suspected leak only | Generate a new one in Supabase dashboard → API. Deploy. Old key still works for ~5 min during propagation. |
| `ANTHROPIC_API_KEY` | On leak; otherwise annual | Create new key in Anthropic console, deploy, then delete the old key. |
| `INTERNAL_API_SECRET` | Annual | `openssl rand -hex 32`. After deploy, any in-flight unsubscribe links signed with the old secret will return 401; this is acceptable. |
| `INNGEST_EVENT_KEY` + `INNGEST_SIGNING_KEY` | On leak | Generate new pair in Inngest. Deploy. Re-sync from Inngest dashboard. |
| `RESEND_API_KEY` | On leak | Create new key in Resend. Deploy. Delete old key after Vercel reports the new deploy as ready. |
| `RESEND_WEBHOOK_SECRET` | On leak; otherwise on Resend's prompt | See "Rotation procedure" in §2.4. |
| `STRIPE_SECRET_KEY` | On leak | Stripe → API Keys → Roll. Deploy the new key first; the old key keeps working until you click "Reveal and delete" on the old one. Switch test/live carefully. |
| `STRIPE_WEBHOOK_SECRET` | On leak or every 90 days | See §2.5 "rotate the secret safely". |
| `UPSTASH_REDIS_REST_TOKEN` | On leak | Rotate in Upstash; deploy. Brief window where requests fail open is acceptable. |
| `SENTRY_AUTH_TOKEN` | Annual / on org change | Build-time only; rotate in CI without touching runtime. |

### Verification after rotation

After any rotation:

```bash
curl -s $APP/api/readiness | jq .checks
```

Every check should still pass. If `sentry: missing` flickered to `configured` then back to `missing` during the deploy, you rotated the wrong project's DSN — re-check.

---

## 5. Reading logs & Sentry

### 5.1 Sentry

- All API failures are tagged `layer=api` with `route` and `requestId`.
- All job failures are tagged `layer=job` with `job` name.
- All webhook failures are tagged `layer=webhook` with `provider`.
- AI failures additionally tag the orchestrator step (`stage`, `lead_id`).

Search recipe: `layer:api route:/api/widget` for widget incidents; `layer:job job:followUpScan` for follow-up scan failures.

### 5.2 Vercel logs (or local stdout)

Pino emits JSON. Pipe through `pino-pretty` for human reading:

```bash
vercel logs $APP --follow | npx pino-pretty
```

Every log line in a request scope includes `requestId`. Grab the `X-Request-Id` header from a failing response and grep:

```bash
vercel logs $APP --since=15m | grep '"requestId":"<id>"' | npx pino-pretty
```

### 5.3 Inngest

The Inngest dashboard is the source of truth for job state. Each run links back to the event that triggered it; the event payload includes `request_id`, which links back to Sentry + logs.

---

## 6. Common diagnostic queries

Top errors in the last hour:
```sql
select error_message, count(*)
from ai_actions
where created_at > now() - interval '1 hour' and error_message is not null
group by 1 order by 2 desc;
```

Follow-up backlog:
```sql
select status, count(*) from follow_up_schedules
where scheduled_for < now() group by 1;
```

Suppressed emails (Resend bounces + complaints):
```sql
select reason, count(*) from suppressions
where created_at > now() - interval '7 days' group by 1 order by 2 desc;
```

Recent invitations (verify a teammate didn't get spammed):
```sql
select email, role, status, expires_at, accepted_at
from venue_invitations order by created_at desc limit 20;
```

## 7. Tour auto-pause + auto-resume + re-arm (Phase 8F + 8G + 8H)

Two billing-driven side effects touch the `tours` table:

- **Auto-pause cron** (`billing-tour-auto-pause`, daily 6pm UTC) — when a subscription is `past_due` for >7 days AND `metadata.tours_paused_at` is unset, it bulk-cancels every future `scheduled|confirmed` tour for that venue and stamps `tours_paused_at` / `tours_paused_reason='past_due_7_days'` / `tours_paused_count`.
- **Auto-resume** (synchronous, inside the Stripe webhook dispatcher) — when a subscription transitions `past_due` → `active`/`trialing`, the dispatcher stamps `tours_resumed_at` + `tours_resumed_reason='payment_recovered'`. **It does NOT resurrect cancelled tours.** The audit pair "paused on X, resumed on Y" is preserved.
- **Auto-pause re-arm** (Phase 8H) — if a venue paused, recovered, then lapses back to `past_due`, the cron archives the prior pause/resume tuple into `metadata.tour_pause_history` (append-only jsonb array) and stamps a fresh pause. Decision rule: the existing pause is "stale" iff `tours_resumed_at` predates `current_period_end`.

### Triage flow when a customer says "my tours disappeared"

1. Check the subscription metadata:
   ```sql
   select id, status, current_period_end,
          metadata->>'tours_paused_at'      as paused_at,
          metadata->>'tours_paused_count'    as paused_count,
          metadata->>'tours_resumed_at'     as resumed_at,
          jsonb_array_length(metadata->'tour_pause_history') as history_len
   from public.subscriptions
   where venue_id = '<venue uuid>';
   ```
2. If `paused_at` is set and `resumed_at` is null → the auto-pause cron fired. Have them update payment in `/dashboard/settings/billing`. The next Stripe webhook should flip status back and stamp `resumed_at`.
3. If `paused_at` and `resumed_at` are both set AND `resumed_at < current_period_end` → the venue recovered and then lapsed again. The cron should re-arm on its next nightly run (`history_len` will increment by 1). If 24h+ have passed without re-arm, check `jobs.billing_tour_auto_pause.*` logs for that subscription id.
4. After recovery, manually recreate any tours the venue needs back (see DEMO-RUNBOOK §13.2 — never bulk `UPDATE status='scheduled'`, that bypasses the lead notification email + leaves stale `outcome` text behind).

### "Venue became past_due again but tours were not cancelled"

This is the Phase 8H re-arm flow. Diagnostic sequence:

1. Confirm the venue is currently `past_due`:
   ```sql
   select status, current_period_end
   from public.subscriptions
   where venue_id = '<uuid>';
   ```
2. Confirm `current_period_end` is more than 7 days in the past (the grace window). If not, the cron correctly skipped — wait.
3. Inspect the pause/resume metadata:
   ```sql
   select metadata->>'tours_paused_at'      as paused_at,
          metadata->>'tours_resumed_at'     as resumed_at,
          metadata->>'tours_paused_reason'   as paused_reason,
          metadata->'tour_pause_history'     as history,
          current_period_end
   from public.subscriptions
   where venue_id = '<uuid>';
   ```
4. Apply the decision rule:
   - `resumed_at` missing → the cron believes it's still paused. Check whether the venue actually has any future `scheduled|confirmed` tours; if zero, the previous pause did its job and there's nothing new to cancel.
   - `resumed_at >= current_period_end` → the resume happened during/after this past-due window (i.e. you're inside the current pause window with a resume that hasn't been observed by the dispatcher yet). Wait for the next webhook.
   - `resumed_at < current_period_end` → re-arm should fire on the next nightly cron run. Force a run via the Inngest dashboard if you don't want to wait.
5. If the cron has clearly run since the recovery and still didn't re-arm, search for the structured event `jobs.billing_tour_auto_pause.history_archived` / `jobs.billing_tour_auto_pause.rearmed` for the subscription id. Absence of both with non-zero `scanned` in the run summary indicates the candidate query is excluding this row — usually because `current_period_end` isn't `< now() - 7 days`.

### "Venue is still showing tour pause banner after recovery"

**Symptom**: customer says Stripe processed their payment but the amber banner on `/dashboard/tours` is still showing, and any new tour they try to schedule is rejected by the billing gate.

1. Confirm Stripe actually transitioned the subscription:
   ```sql
   select id, status, current_period_end, updated_at
   from public.subscriptions
   where venue_id = '<uuid>'
   order by created_at desc
   limit 1;
   ```
   - If `status` is still `past_due`, the recovery hasn't landed yet on our side. Wait for the next webhook, or trigger a re-sync from the Stripe dashboard (Developers → Webhooks → "Resend" the latest `customer.subscription.updated`).
   - If `status` is now `active` / `trialing` but the banner is still there, continue to step 2.
2. Inspect the pause metadata + recovery stamp:
   ```sql
   select metadata->>'tours_paused_at'      as paused_at,
          metadata->>'tours_resumed_at'     as resumed_at,
          metadata->>'tours_pause_cleared_at' as cleared_at
   from public.subscriptions
   where venue_id = '<uuid>'
   order by created_at desc
   limit 1;
   ```
   - `paused_at` set, `resumed_at` set → the dispatcher DID stamp recovery. The banner should be off. Hard-refresh the dashboard tab; if still visible, check whether the user has a stale RSC cache by navigating away + back.
   - `paused_at` set, `resumed_at` NULL → the dispatcher missed it. Continue to step 3.
3. Manually clear the pause via the admin endpoint:
   ```bash
   curl -i -X POST http://localhost:3000/api/admin/tours/clear-pause \
     -H "Cookie: <admin session>" \
     -H "Content-Type: application/json" \
     -d '{ "reason": "Stripe webhook lost — payment confirmed via Stripe dashboard" }'
   ```
   Expected response:
   ```json
   { "success": true, "changed": true, "venue_id": "...", "subscription_id": "..." }
   ```
   `changed: false` with `reason: "not_paused"` means the pause was already cleared between steps 2 and 3 — refresh and the banner should be gone.
4. Verify the banner is gone:
   - Reload `/dashboard/tours` — the amber strip is gone.
   - `select metadata ->> 'tours_paused_at' from public.subscriptions where venue_id = '<uuid>'` returns NULL.
   - `select metadata -> 'tour_pause_history' from public.subscriptions where venue_id = '<uuid>'` is unchanged (cleared pauses are not archived to history — only auto-resumed pauses are, by the Phase 8H cron).
5. If you're an admin/owner, you can also do steps 2–4 from the UI: `/dashboard/settings/billing` → scroll to the "Tour pause history" card → click **Clear pause**.

### Bulk-cancel notification troubleshooting

`POST /api/admin/tours/bulk-cancel` (Phase 8F + 8H) returns:

```json
{
  "success": true,
  "cancelled_count": <int>,
  "notification_summary": {
    "attempted": <int>,
    "queued":    <int>,
    "skipped":   <int>,
    "failed":    <int>
  }
}
```

If a lead complains they didn't get a cancellation email after a bulk-cancel:

1. Verify the tour was actually cancelled:
   ```sql
   select id, status, outcome, updated_at
   from public.tours
   where lead_id = '<lead uuid>'
     and scheduled_at between '<from_date>'::timestamptz and '<to_date>'::timestamptz + interval '1 day';
   ```
2. Verify an outbound row exists:
   ```sql
   select created_at, kind, provider, message_id, error,
          metadata->>'tour_notification_kind' as kind_tag
   from public.outbound_messages
   where lead_id = '<lead uuid>'
     and related_table = 'tours'
   order by created_at desc;
   ```
   - A row with `error IS NULL` + `provider='resend'` → handed to Resend successfully. Pivot to Resend webhook logs for actual delivery.
   - A row with `error LIKE 'suppressed:%'` → the lead is in `public.email_suppressions`. Check `reason`. If they want to opt back in, manually delete the suppression row.
   - No row at all → the lead probably had no `email` on file at the time of bulk-cancel. Inspect `public.leads`.
3. If the API response `notification_summary.failed > 0`, search logs for `admin.tours_bulk_cancel.notify_threw` keyed to the request id (returned in the `X-Request-Id` response header).

### Listing every currently-paused venue

```bash
curl -s http://localhost:3000/api/admin/tours/paused-venues \
  -H "Cookie: <admin session>" | jq '.items'
```

Returns `venue_id`, `subscription_id`, `status`, `tours_paused_at`, `tours_paused_count`. No PII; auth = `requireAdmin()`.

### Notification email failures

Tour notification emails (created / rescheduled / confirmed / cancelled) are best-effort. If a lead complains they didn't get a notification:

```sql
-- audit log of outbound emails for one lead
select created_at, kind, provider, message_id, error
from public.outbound_messages
where lead_id = '<lead uuid>'
  and related_table = 'tours'
order by created_at desc;
```

Common reasons for skips:
- Lead has no email on file → silent skip (never an error).
- Lead in `email_suppressions` → `error: 'suppressed:<reason>'`.
- Resend down / not configured → console-fallback in dev, `error: '<provider message>'` in prod.

In every case the tour write itself succeeded — the email failure is a delivery issue, not a data issue.

### Tour notification emails not sending (Phase 8J)

If a customer says their leads aren't getting tour confirmations or reminders, walk through the layers from outermost (DB intent) to innermost (provider acceptance).

1. Confirm the tour record exists and the lead has an email:
   ```sql
   select t.id, t.status, t.scheduled_at,
          t.reminder_24h_sent, t.reminder_2h_sent,
          l.name, l.email
   from public.tours t
   left join public.leads l on l.id = t.lead_id
   where t.venue_id = '<uuid>'
     and t.scheduled_at > now() - interval '7 days'
   order by t.scheduled_at desc
   limit 20;
   ```
   - `l.email IS NULL` → the helper / cron silently skips (no email to send to). Capture the lead's email and update them in the dashboard.
   - `t.reminder_24h_sent = false` 25+ hours BEFORE `scheduled_at` → reminder hasn't fired yet (selection window is [scheduled_at - 24h, scheduled_at - 22h] — 15 min cadence). Wait or trigger the cron manually.
2. Check whether an outbound row was ever written:
   ```sql
   select created_at, provider, status, error,
          metadata->>'tour_notification_kind' as kind
   from public.outbound_messages
   where venue_id = '<uuid>'
     and related_table = 'tours'
     and related_id = '<tour uuid>'
   order by created_at desc;
   ```
   - **No rows at all** → the cron / route never attempted a send. Check `ai_actions` for `tour_reminder_*_failed/skipped` rows OR application logs for `tour.notification.*` events.
   - **Row with `status = 'suppressed'`** → the lead is in `public.email_suppressions`. Inspect `reason`. If they want to opt back in, delete the suppression row manually.
   - **Row with `status = 'failed'` / `'bounced'` / `'complained'`** → Resend rejected or the recipient bounced. Check `error` text + the Resend dashboard.
   - **Row with `status = 'queued'`** → handed to Resend but the delivery webhook hasn't landed yet. Wait 30s and re-check; if still `queued` after a few minutes, check `/api/health` for `resend_webhook: 'configured'`.
3. For reminders specifically, the cron writes an `ai_actions` row on EVERY outcome (delivered / suppressed / console_fallback / failed):
   ```sql
   select created_at, action, success, error_message, output_summary
   from public.ai_actions
   where venue_id = '<uuid>'
     and agent = 'tour-scheduler'
     and action like 'tour_reminder_%'
     and created_at > now() - interval '24 hours'
   order by created_at desc;
   ```
   This is the fastest way to see what the cron decided + why. Look for:
   - `tour_reminder_24h_sent` → success path, lead got the email.
   - `tour_reminder_24h_skipped` with `error_message = 'console_fallback'` → no Resend key configured; restore `RESEND_API_KEY` + `RESEND_FROM_EMAIL`.
   - `tour_reminder_24h_skipped` with `error_message = 'missing_email'` → the lead row had no email.
   - `tour_reminder_24h_failed` → real provider error; `error_message` carries the Resend response.
4. Pivot to aggregate counts via the admin endpoint:
   ```bash
   curl -s "http://localhost:3000/api/admin/tours/notification-stats?days=7" \
     -H "Cookie: <admin session>" | jq .totals
   ```
   - `attempted` low → cron / routes aren't firing at all (Inngest unhealthy? Check `/api/health` for `jobs: 'inngest'`).
   - `suppressed` high → the venue's lead list contains a lot of unsubscribed addresses; lead-list hygiene needed.
   - `failed` high → Resend health issue; check the Resend status page + escalate.
5. Confirm Resend webhook delivery confirmations are flowing back:
   ```sql
   select count(*), max(created_at)
   from public.outbound_messages
   where status = 'delivered'
     and created_at > now() - interval '24 hours';
   ```
   - Zero `delivered` rows in 24 hours of activity → the Resend webhook isn't reaching us. Check `RESEND_WEBHOOK_SECRET` is set, verify the webhook URL in the Resend dashboard points to `/api/resend/webhook`, and look for 4xx responses in the Resend webhook logs.

### Tour action link failed (Phase 8K)

When a lead reports that the confirm/cancel link in their email doesn't work, walk these checks in order. Each one maps to a specific outcome page the lead might be seeing.

1. **"This link is no longer valid."** — token rejected.
   ```bash
   grep -E 'tour\.action\.(invalid_signature|token_rejected|action_mismatch)' <log source>
   ```
   - `invalid_signature` → tamper. Sentry will also alert. If the same source IP appears repeatedly, the lead's email client may be re-encoding the URL (some corporate gateways re-write query params). Ask the lead to copy-paste the full URL into a browser address bar instead of clicking.
   - `expired` → 7-day TTL elapsed. Send a fresh email (any Phase 8G lifecycle action regenerates the links).
   - `malformed_token` → URL was truncated mid-token. Common with screen-reader copy-paste; ask the lead to forward the original email.
   - `action_mismatch` → token was for `cancel` but the lead opened `/tour/confirm` (or vice versa). Usually a bookmarked URL from a prior email; just send a fresh email.
2. **"This tour has already passed."** — `scheduled_at <= now`.
   - Confirm in `tours` table:
     ```sql
     select scheduled_at, status from public.tours where id = '<tour uuid>';
     ```
   - If the lead wants to schedule a new tour, the operator uses the inbox TourLifecycleStrip → "Re-schedule cancelled tour" (Phase 8I) or "Schedule another tour".
3. **"This tour is already handled."** — terminal status reached.
   - The status column tells you which terminal state. Confirm what action the lead actually wanted:
     ```sql
     select status, updated_at from public.tours where id = '<tour uuid>';
     ```
   - If they expected the OPPOSITE action (clicked confirm but tour says cancelled), check `ai_actions` or the new admin endpoint:
     ```bash
     curl -s "http://localhost:3000/api/admin/tours/recent-token-actions?limit=20" \
       -H "Cookie: <admin session>" | jq '.items[] | select(.tour_id == "<tour uuid>")'
     ```
4. **"We couldn't find that tour."** — `tours.id` doesn't resolve.
   - Either the tour was deleted out-of-band (`DELETE` from SQL — bypasses the route's idempotency) or the token references a non-existent UUID (extremely unlikely with HMAC).
   - Confirm whether the tour ever existed:
     ```sql
     select id from public.tours where id = '<tour uuid>';
     ```
   - Pivot to `ai_actions` history for the lead if the tour is missing — the cron may have generated reminders for it before it was deleted.
5. **Lead says they clicked but nothing happened (no page loaded).**
   - Verify `TOUR_ACTION_SECRET` is configured in production:
     ```bash
     curl -s http://localhost:3000/api/health | jq .demo.tour_action_links
     ```
     The flag says `'mounted'` based on CODE presence, not secret configuration. To verify the secret is live, look for the once-per-process structured warn `tour.notification.no_action_secret` — if it's absent in recent logs, the secret is configured and the helper has been emitting links.
   - If `TOUR_ACTION_SECRET` is missing, every tour notification email since startup has been sent without action links. Fix the env var, restart the process, and re-send.
   - Verify `NEXT_PUBLIC_APP_URL` matches the deployed URL — if it points to `http://localhost:3000` in production, leads in their browser will land on a 404.

### Tour action audit table (Phase 8L)

`public.tour_action_events` is the canonical record of every redeemed tour action token. Use it when the question is "did this lead actually click the link?" or "what's been happening to this venue's tours lately?".

```sql
-- recent activity for a venue (mirrors what the admin endpoint returns)
select e.occurred_at, e.action, e.source_ip, e.user_agent,
       e.tour_id, e.lead_id, l.name as lead_name, l.email as lead_email
from public.tour_action_events e
left join public.leads l on l.id = e.lead_id
where e.venue_id = '<venue uuid>'
order by e.occurred_at desc
limit 20;

-- replay attempts blocked by the unique constraint won't appear here
-- (the INSERT failed), but the application log records each one:
--   grep 'tour.action.single_use_replay_blocked' <log source>

-- everything that happened to one specific tour
select occurred_at, action, source_ip
from public.tour_action_events
where tour_id = '<tour uuid>'
order by occurred_at asc;
```

If a customer says "the lead says they confirmed, but the dashboard shows the tour as still scheduled":

1. Check `tour_action_events` for any row matching the tour.
2. If a row exists with `action='confirm'` AND the tour status is still `scheduled`, the status UPDATE failed AFTER the audit row landed. Look for `tour.action.update_failed` in logs (extremely rare — Sentry-captured if so).
3. If no row exists, the lead never clicked, OR they clicked a tampered/expired link (check `tour.action.invalid_signature` / `tour.action.token_rejected` warns).

The audit table is append-only from the dashboard's perspective (no RLS INSERT policy for authenticated callers). Service-role writes are the only path, and they come exclusively from the Phase 8K handler. There is no public-route way to inject a fake row.

### Unified tour status events (Phase 8M)

`public.tour_status_events` records EVERY tour status change, regardless of write path. Use it when the question is "who changed this tour, when, and how?" — broader than the Phase 8L lead-token audit.

```sql
-- full history for one tour
select occurred_at, actor_kind, actor_id, action,
       previous_status, new_status, reason, metadata
from public.tour_status_events
where tour_id = '<tour uuid>'
order by occurred_at asc;

-- last 24h of bulk cancels with the operator who pressed the button
select occurred_at, actor_id, venue_id, tour_id, reason
from public.tour_status_events
where action = 'bulk_cancel'
  and occurred_at > now() - interval '24 hours'
order by occurred_at desc;

-- find every cron auto-pause cancellation for a venue
select occurred_at, tour_id, metadata->>'subscription_id' as sub_id
from public.tour_status_events
where venue_id = '<venue uuid>'
  and actor_kind = 'cron'
  and action = 'auto_pause_cancel'
order by occurred_at desc;
```

For the same data via the admin HTTP API:

```bash
curl -s "http://localhost:3000/api/admin/tours/status-events?tour_id=<uuid>" \
  -H "Cookie: <admin session>" | jq .items
```

Filters: `venue_id`, `tour_id`, `lead_id`, `actor_kind` (`lead_token|operator|cron|system|all`), `action`, `limit` (1..200, default 50). See BILLING-QA §7o for full examples.

The Phase 8K/8L `recent-token-actions` endpoint is now deprecated (same data via `?actor_kind=lead_token` on the new endpoint) but still mounted. Responses include `Deprecation: true` + `Link: rel="successor-version"` headers so client SDKs can migrate gracefully.

### "Who cancelled my July bookings?"

A common operator question that the Phase 8M audit answers in one query:

```sql
select e.occurred_at,
       e.actor_kind,
       e.actor_id,
       e.action,
       e.reason,
       e.tour_id,
       t.scheduled_at,
       l.name as lead_name
from public.tour_status_events e
left join public.tours t on t.id = e.tour_id
left join public.leads l on l.id = e.lead_id
where e.venue_id = '<uuid>'
  and e.new_status = 'cancelled'
  and t.scheduled_at >= '2026-07-01'
  and t.scheduled_at <  '2026-08-01'
order by e.occurred_at asc;
```

`actor_kind` tells you whether it was a lead (`lead_token`), the operator dashboard (`operator`), or the auto-pause cron (`cron`). `actor_id` is the operator's user uuid (resolve via `auth.users` if needed) or the cron's function id.

### Operator UI for tour audit (Phase 8N)

Three in-product surfaces over the same `tour_status_events` data — admins/owners get them automatically, other roles see nothing (silent 401/403 fall-through on the client surfaces, server-side role gate on the billing feed):

- `/dashboard/tours` — every Upcoming Tour row has an **Audit** button that opens a per-tour drawer with the last 50 events + expandable metadata + Copy event id.
- `/dashboard/inbox/<leadId>` — `TourLifecycleStrip` shows a "Recent tour activity" panel (last 5 events) with a **View full audit** button that opens the same drawer.
- `/dashboard/settings/billing` — admins see a compact "Tour status activity" table (last 25 venue-wide events) below the pause history card.

Common triage shortcuts (no SQL needed):

| Scenario | Where to look |
|---|---|
| "Why did this tour cancel?" | `/dashboard/tours` → Audit button → look for the most recent `Cancelled` row |
| "Did the lead click my email link?" | Same drawer → look for `actor_kind = Lead` rows |
| "Who on my team rescheduled this?" | Same drawer → look for `actor_kind = Operator` rows; the `Actor id` in the Details expansion is the user uuid |
| "What did the auto-pause cron touch tonight?" | `/dashboard/settings/billing` → activity feed → filter by eye for `Auto-paused` action rows |

### Tour status realtime publication (Phase 8O)

`tour_status_events` was added to the `supabase_realtime` publication via a one-shot ops command (not a migration). The `RealtimeTourStatusLayer` mounted on `/dashboard/tours` and `/dashboard/settings/billing` subscribes to `postgres_changes` INSERT events on this table and refreshes the page automatically.

Verify the table is in the publication:

```sql
select tablename
from pg_publication_tables
where pubname = 'supabase_realtime' and schemaname = 'public'
order by tablename;
```

Expect to see `tour_status_events` alongside `leads`, `messages`, `conversations`, `tours`.

If it's missing (e.g. after a publication reset), the realtime subscription will silently succeed but receive no events. Re-apply with an idempotent guard:

```sql
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'tour_status_events'
  ) then
    alter publication supabase_realtime add table public.tour_status_events;
  end if;
end $$;
```

This is safe to run any number of times.

### CSV export of tour status events (Phase 8O)

For support tickets, compliance requests, or insurance claims that need an exportable audit trail:

```bash
APP=https://your-deploy.example.com
COOKIE="sb-...-auth-token=..."

# all recent events for the caller's primary venue (default JSON limit 50)
curl -s "$APP/api/admin/tours/status-events?format=csv" -b "$COOKIE" \
  > tour-audit-$(date -u +%F).csv

# narrow to one tour
curl -s "$APP/api/admin/tours/status-events?format=csv&tour_id=<uuid>" -b "$COOKIE"

# operator-driven changes in the last 200 events
curl -s "$APP/api/admin/tours/status-events?format=csv&actor_kind=operator&limit=200" -b "$COOKIE"
```

The endpoint caps at `limit=200` per request. For wider windows, paginate by `occurred_at` cursor manually OR query the DB directly:

```sql
copy (
  select id, venue_id, tour_id, lead_id, actor_kind, actor_id, action,
         previous_status, new_status, source_ip, user_agent, reason,
         occurred_at, metadata::text as metadata_json
  from public.tour_status_events
  where venue_id = '<uuid>'
    and occurred_at between '2026-01-01' and '2026-04-01'
  order by occurred_at asc
) to '/tmp/audit-q1.csv' with (format csv, header true);
```

### Paginated CSV pulls for wide audit windows (Phase 8P)

The Phase 8O CSV export caps at `limit=200` per request. Phase 8P adds `?occurred_before=<ISO>` so operators can chain pages for compliance / insurance exports.

```bash
APP=https://your-deploy.example.com
COOKIE="sb-...-auth-token=..."
OUT=/tmp/audit-$(date -u +%F).csv

# First page — newest first.
HDRS=$(mktemp)
curl -s -D "$HDRS" \
  "$APP/api/admin/tours/status-events?format=csv&limit=200" \
  -b "$COOKIE" > page-1.csv

# Concat header from page 1 plus body chunks.
head -1 page-1.csv > "$OUT"
tail -n +2 page-1.csv >> "$OUT"

# Loop pages while X-Has-More: true.
N=1
while grep -q '^x-has-more: true' "$HDRS"; do
  CURSOR=$(grep -i '^x-next-cursor:' "$HDRS" | awk '{print $2}' | tr -d '\r')
  N=$((N + 1))
  curl -s -D "$HDRS" \
    "$APP/api/admin/tours/status-events?format=csv&limit=200&occurred_before=$CURSOR" \
    -b "$COOKIE" > page-$N.csv
  # Skip the BOM-prefixed header row on follow-up pages; append the body only.
  tail -n +2 page-$N.csv >> "$OUT"
done

echo "Wrote $N pages to $OUT"
```

Notes:
- The `X-Has-More: false` header (or absence of `X-Next-Cursor`) is the loop stop signal.
- `<` is strict — no row appears in two consecutive pages.
- Each request goes through the same admin auth/rate-limit/tenant gates; the rate limiter applies per-caller, so spreading wide pulls across minutes avoids hitting it.

### URL state for the billing activity feed (Phase 8P)

The activity feed filters sync to `?actor` and `?action` query params. Copying the URL preserves filter state; the `Reset filters` button strips both params. Invalid values silently coerce to `all`, so a stale link with a typo'd `?actor=opertor` just opens the unfiltered view rather than 404'ing.

### Audit drawer deep linking (Phase 8P)

`/dashboard/tours?audit_tour=<uuid>` opens the audit drawer for that tour on initial render. Closing the drawer strips `audit_tour` but preserves `month=YYYY-MM` and any future siblings.

If a deep-linked drawer fails to open:
1. Confirm the UUID looks valid (8-4-4-4-12 hex characters).
2. Confirm the caller is an admin/owner — non-admins see the drawer's forbidden empty state.
3. Check application logs for `admin.tours_status_events.completed` filtered on `tour_id` — the drawer's fetch goes through the same endpoint as the rest of the audit surface.

### Single-shot streamed CSV export (Phase 8Q)

For exports up to 5000 rows, the Phase 8P paginated shell loop is no longer needed. The new stream mode emits the entire CSV in one response:

```bash
APP=https://your-deploy.example.com
COOKIE="sb-...-auth-token=..."

curl -L "$APP/api/admin/tours/status-events?format=csv&stream=1&limit=200&actor_kind=operator&action=cancel" \
  -b "$COOKIE" \
  -o cancels-by-operator-$(date -u +%F).csv
```

Cap is a hard 5000 rows. For wider windows, fall back to the Phase 8P paginated loop (the streamed mode honors the same filters + the `occurred_before` cursor, so you can chain TWO streamed requests to cover 10000 rows: one without `occurred_before`, one with the timestamp of the last row in the first file).

Verify the export was complete:

```bash
# count data rows (skip the header)
tail -n +2 cancels-by-operator-*.csv | wc -l

# also confirm the trailing line isn't an abort marker
tail -1 cancels-by-operator-*.csv
# → if it starts with "# stream aborted:", the stream was interrupted;
#   re-run with the last successful row's occurred_at as `?occurred_before=`.
```

### Audit search filter (Phase 8Q)

`/api/admin/tours/status-events?q=<term>` matches case-insensitive substrings against:
- `reason`
- `actor_id`
- `action`
- `previous_status`
- `new_status`

Not server-side: `metadata::text` (PostgREST limitation — see BILLING-QA §7s). The billing-page UI also searches metadata over the loaded slice as a client-side fallback.

Examples:

```bash
# all events where operator-supplied reason mentions "fire"
curl -s "$APP/api/admin/tours/status-events?q=fire" -b "$COOKIE" | jq '.items[] | {action, reason, actor_kind}'

# narrow further — operator-driven cancels with "maintenance" in reason
curl -s "$APP/api/admin/tours/status-events?actor_kind=operator&action=cancel&q=maintenance" \
  -b "$COOKIE" | jq .items
```

### Per-user filter persistence

The billing-page activity feed persists actor / action / search to `localStorage` under `venuerise:tour-status-feed:filters:v1`. URL params always win when present. To diagnose a stuck filter set on a colleague's browser:

```js
// in the operator's DevTools console
localStorage.getItem('venuerise:tour-status-feed:filters:v1')
// → '{"actor":"operator","q":"fire"}'

localStorage.removeItem('venuerise:tour-status-feed:filters:v1')
// then reload — defaults restore.
```

The in-app Reset filters button does this automatically and ALSO clears URL params.

### Audit search not finding metadata (Phase 8R)

If `?q=` works for scalar columns (action, reason, actor_id) but doesn't find rows where `metadata::text` contains the term:

1. **Confirm migration 014 ran.** The RPC must exist:
   ```sql
   select proname, prosecdef
   from pg_proc
   where proname = 'search_tour_status_events';
   ```
   Expect one row with `prosecdef = true`. Re-apply via Supabase MCP if missing.

2. **Confirm the RPC is GRANTed to service_role.**
   ```sql
   select has_function_privilege(
     'service_role',
     'public.search_tour_status_events(uuid, uuid, uuid, text, text, text, timestamptz, integer)',
     'execute'
   ) as can_execute;
   ```
   Should return `true`. If false, re-grant:
   ```sql
   grant execute on function public.search_tour_status_events(
     uuid, uuid, uuid, text, text, text, timestamptz, integer
   ) to service_role;
   ```

3. **Verify the route is using the RPC path.** Application log line `admin.tours_status_events.completed` includes `filters.q_mode`:
   - `'rpc_metadata'` → route dispatched to the RPC (Phase 8R).
   - `'standard'` → route used the PostgREST chain (no metadata search). Should never happen when `q` is set.
   ```bash
   grep 'admin.tours_status_events.completed' <log source> | grep '"q_mode":"standard"' | grep '"q":"[^n]'
   ```
   A non-null `q` with `q_mode=standard` is the bug signal.

4. **Reproduce against the DB directly.** Bypass the route entirely:
   ```sql
   select id, action, metadata
   from public.search_tour_status_events(
     p_venue_id := '<venue uuid>',
     p_q := 'past_due_7_days',
     p_limit := 20
   );
   ```
   If this returns rows but the API doesn't, the route's RPC integration is the bug. If this returns no rows but the data is there, the predicate (`metadata::text ILIKE '%term%'`) doesn't match — check whether the metadata value is wrapped in quotes (`"past_due_7_days"` vs `past_due_7_days`) and adjust the search term accordingly.

### Operator activity digest did not send (Phase 8R)

If the daily digest cron isn't reaching venue owners:

1. **Env flag.** `OPERATOR_DIGEST_ENABLED` must be exactly `'1'`. Anything else (unset, `'true'`, `'yes'`, `'0'`) short-circuits with `{ skipped: true, reason: 'disabled' }`. Check the deployed env:
   ```bash
   # locally / staging via the deploy platform's env inspector
   echo "OPERATOR_DIGEST_ENABLED=$OPERATOR_DIGEST_ENABLED"
   ```

2. **Inngest registration.** Confirm `operator-activity-digest` appears in the Inngest dashboard's function list. If absent, the build didn't include `lib/jobs/functions/operator-activity-digest.ts` in `allJobFunctions` — re-deploy.

3. **Events in the last 24h.** A venue with zero activity gets no digest:
   ```sql
   select venue_id, count(*) as n
   from public.tour_status_events
   where occurred_at >= now() - interval '24 hours'
   group by 1 order by 2 desc;
   ```

4. **Owner email lookup.** Each venue's earliest owner-role member must have a resolvable email:
   ```sql
   select vm.venue_id, vm.user_id
   from public.venue_members vm
   where vm.venue_id = '<uuid>' and vm.role = 'owner'
   order by vm.created_at asc
   limit 1;
   ```
   Cross-reference the returned `user_id` in `auth.users` (via Supabase dashboard) to confirm `email` is set.

5. **Outbound delivery.** Check whether the email was attempted:
   ```sql
   select created_at, status, provider, error,
          metadata->>'tour_digest_date' as digest_date
   from public.outbound_messages
   where venue_id = '<uuid>'
     and related_table = 'tour_status_events'
   order by created_at desc
   limit 5;
   ```
   - `status='queued'` + `provider='resend'` → handed to Resend; check Resend dashboard for delivery state.
   - `status='suppressed'` → owner unsubscribed; manually delete from `email_suppressions` if intentional.
   - `provider='console'` → Resend not configured in the runtime environment.
   - No rows → the cron didn't send (env flag off, no events, owner lookup failed, etc.). Check application logs for `jobs.operator_activity_digest.*`.

6. **Force a manual run.** From a Node REPL with service-role creds:
   ```ts
   import { runDigestScan } from '@/lib/jobs/functions/operator-activity-digest'
   console.log(await runDigestScan())
   ```
   Returns either `{ skipped: true, reason: 'disabled' }` or `{ scannedVenues, sent, skipped, failed }`.

### Audit metadata search is slow (Phase 8S)

If `?q=` over metadata feels sluggish or runs hot on the DB:

1. **Verify `pg_trgm` is installed**:
   ```sql
   select extname from pg_extension where extname = 'pg_trgm';
   ```
   Expect one row. Re-apply migration 015 if missing.

2. **Verify the generated column exists**:
   ```sql
   select column_name, data_type, generation_expression
   from information_schema.columns
   where table_schema='public' and table_name='tour_status_events'
     and column_name='metadata_text';
   ```
   Expect one row with `generation_expression = COALESCE((metadata)::text, ''::text)`.

3. **Verify the index exists**:
   ```sql
   select indexname, indexdef from pg_indexes
   where schemaname='public' and tablename='tour_status_events'
     and indexname='tour_status_events_metadata_text_trgm_idx';
   ```
   Expect `CREATE INDEX … USING gin (metadata_text gin_trgm_ops)`.

4. **Run EXPLAIN ANALYZE** for a representative search term:
   ```sql
   explain analyze
   select * from public.search_tour_status_events(
     p_venue_id := '<venue uuid>',
     p_q        := 'past_due_7_days',
     p_limit    := 50
   );
   ```
   Look for `Bitmap Index Scan tour_status_events_metadata_text_trgm_idx` in the plan. If you see a `Seq Scan` on `tour_status_events` with a filter on `metadata_text`, the planner decided the term wasn't selective enough — trigram indexes need ≥ 3 characters to win. Try a longer term.

5. **If the column or index is missing**, re-apply migration 015 via Supabase MCP — both ALTER + CREATE INDEX statements are idempotent (`if not exists` guards).

### Operator digest unsubscribe not working (Phase 8S)

If the unsubscribe link in a digest email doesn't flip the opt-out flag:

1. **Verify `DIGEST_UNSUBSCRIBE_SECRET` is set on both the signing side (cron) AND the verifying side (route)**. They share one secret; rotating one without the other invalidates every outstanding link.
   - Look for `jobs.operator_activity_digest.no_unsubscribe_secret` in logs — fires once per process when the cron tried to sign a link but the env was missing.
   - Look for `digest.unsubscribe.secret_missing` in logs — fires when the route tried to verify but the env was missing.

2. **Verify the token hasn't expired**. Default TTL is 30 days. Old digest emails past 30 days return `"This link has expired."` Operators receiving a fresh digest should always have a valid link.

3. **Verify the subscription metadata is being written**:
   ```sql
   select id, metadata->>'digest_disabled' as flag,
          metadata->>'digest_disabled_at' as flipped_at
   from public.subscriptions
   where venue_id = '<uuid>'
   order by created_at desc
   limit 1;
   ```
   - `flag = 'true'` → opt-out succeeded; next morning's cron will skip.
   - `flag IS NULL` → click never landed OR the route hit an error; check application logs for `digest.unsubscribe.*` events.

4. **Confirm the route is hitting the LATEST subscription row.** The opt-out logic orders by `created_at desc LIMIT 1`. A venue with a cancelled+new subscription pair gets the opt-out flipped on the most recent row — confirm that's the one the cron also reads (it uses the same priority order).

5. **Common causes of `400 "Link not valid"`**:
   - `invalid_signature` → tamper attempt OR the secret was rotated.
   - `expired` → > 30 days old.
   - URL `venue_id` doesn't match the token's `venue_id` payload (defense against cross-venue replay).
   - Token shape malformed (corporate email gateway re-wrote the URL).

### Re-enable operator digest for a venue (Phase 8S)

After an unsubscribe, the venue is permanently opted out until the flag is manually cleared. To re-enable:

```sql
update public.subscriptions
set metadata = (metadata - 'digest_disabled' - 'digest_disabled_at')
where id = '<subscription_id>';
```

The next morning's cron run will include the venue again. No re-signup email is sent — the venue owner gets the digest naturally on the next eligible day.

### Digest is off but should be on (Phase 8T)

Customer says they're not getting the daily digest and they didn't unsubscribe:

1. **Inspect cadence + legacy flag** via the admin API:
   ```bash
   curl -s "$APP/api/admin/digest/preferences?venue_id=<uuid>" \
     -b "$COOKIE" | jq .
   ```
   - `cadence: "off"` AND `digest_disabled: true` → opt-out is in effect (Phase 8S unsubscribe OR Phase 8T admin POST).
   - `cadence: "weekly"` AND today isn't Monday UTC → expected skip.
   - `cadence: "daily"` AND `digest_disabled: false` → cron SHOULD be sending; investigate via the §7 "Operator activity digest did not send" subsection.

2. **Re-enable via admin POST** (atomic, preserves all other metadata):
   ```bash
   curl -s -X POST "$APP/api/admin/digest/preferences" \
     -b "$COOKIE" \
     -H "Content-Type: application/json" \
     -d '{"venue_id":"<uuid>","cadence":"daily"}' | jq .
   ```
   Confirms with `{"success":true,"venue_id":…,"subscription_id":…,"cadence":"daily"}`.

3. **Verify metadata cleanly flipped**:
   ```sql
   select id,
          metadata->>'digest_cadence' as cadence,
          metadata->>'digest_disabled' as legacy_flag,
          metadata->>'digest_disabled_at' as legacy_flipped_at
   from public.subscriptions
   where venue_id = '<uuid>'
   order by created_at desc
   limit 1;
   ```
   Expect `cadence='daily'`, `legacy_flag IS NULL`, `legacy_flipped_at IS NULL`.

4. The next morning's cron will pick the venue back up.

### Digest cadence wrong (Phase 8T)

| Cadence | Sends on | Skip log when not sending |
|---|---|---|
| `daily` | every morning 8am UTC | (sends always) |
| `weekly` | Monday UTC only | `operator_digest.skipped_cadence` |
| `off` | never | `operator_digest.skipped_disabled` |

If a customer expects weekly but is getting daily (or vice versa):

```sql
-- raw cadence + legacy flag
select metadata->>'digest_cadence'     as cadence,
       metadata->>'digest_disabled'    as legacy_flag,
       metadata->>'digest_disabled_at' as legacy_flipped_at
from public.subscriptions
where venue_id = '<uuid>'
order by created_at desc
limit 1;
```

Remember: `digest_disabled === true` overrides cadence and forces `off`. If you want weekly and the flag is set, POST to `/api/admin/digest/preferences` with `{cadence:"weekly"}` — the writer strips the legacy flag for you.

### Audit search short query not finding metadata (Phase 8T)

If `?q=` returns rows that match scalar columns but DOESN'T find rows whose `metadata` jsonb contains the term:

1. **Check the term length.** Terms shorter than 3 characters skip the metadata RPC and only search scalar columns (`actor_id`, `action`, `previous_status`, `new_status`, `reason`, `source_ip`, `user_agent`). This is intentional — trigram indexes need ≥ 3 chars to outperform a Seq Scan.

2. **Use a longer search term.** `?q=AI` won't find metadata matches; `?q=anthropic_event_id` will.

3. **Verify the log line** says which path served the request:
   ```bash
   grep 'admin.tours_status_events.completed' <log source> | grep 'q":"<term>"'
   ```
   The `filters.q_mode` value distinguishes:
   - `none` → no `q` filter applied
   - `scalar_short` → `q.length < 3`, scalar-only path
   - `metadata_rpc` → `q.length >= 3`, full RPC path (searches metadata)

### Admin says they stopped receiving digests (Phase 8U)

An admin reports the daily/weekly digest stopped arriving. Walk the layers:

1. **Check the caller's effective preference** via the admin GET (run as the affected user, not as another admin):
   ```bash
   curl -s "$APP/api/admin/digest/preferences" -b "$COOKIE" | jq .
   ```
   - `cadence: "off"` AND `source: "member"` → the user opted themselves out via the billing card. They can re-enable from the same card.
   - `cadence: "off"` AND `source: "subscription"` → venue-level cadence was set to off. The user can override with their own preference.
   - `cadence: "off"` AND `source: "legacy_disabled"` → the Phase 8K unsubscribe link was clicked. Same fix — POST a member-level `daily` preference.
   - `cadence: "weekly"` → today must be the chosen weekly day (UTC).

2. **Inspect raw member metadata** to confirm:
   ```sql
   select user_id,
          metadata->>'digest_cadence'     as cadence,
          metadata->>'digest_weekly_day'   as weekly_day,
          metadata->>'digest_disabled_at' as disabled_at
   from public.venue_members
   where venue_id = '<uuid>' and user_id = '<user uuid>';
   ```

3. **Inspect outbound_messages** for the recipient on a recent UTC date:
   ```sql
   select created_at, status, error,
          metadata->>'tour_digest_cadence'         as cadence,
          metadata->>'tour_digest_weekly_day'      as weekly_day,
          metadata->>'tour_digest_recipient_user_id' as user_id
   from public.outbound_messages
   where venue_id = '<uuid>'
     and related_table = 'tour_status_events'
     and (metadata->>'tour_digest_recipient_user_id')::uuid = '<user uuid>'
   order by created_at desc
   limit 5;
   ```
   - Rows with `status='queued'` / `'delivered'` → digest IS being sent to that user; their mail client might be filtering.
   - No rows at all in the last 24h → confirm cadence permits today (daily, or weekly + matching UTC day).

4. **Re-enable via POST** (writes member metadata atomically):
   ```bash
   curl -s -X POST "$APP/api/admin/digest/preferences" \
     -b "$COOKIE" -H "Content-Type: application/json" \
     -d '{"cadence":"daily"}' | jq .
   ```

### Weekly digest sent on wrong day (Phase 8U)

If the digest fires on a day other than what the operator expected:

1. **Confirm the chosen day**:
   ```sql
   select metadata->>'digest_weekly_day' as day
   from public.venue_members
   where venue_id = '<uuid>' and user_id = '<user uuid>';
   ```
   Values are 3-letter UTC codes: `sun mon tue wed thu fri sat`.

2. **Confirm the matching day in UTC**:
   ```sql
   select to_char((now() at time zone 'UTC')::date, 'dy') as utc_day_3letter;
   ```
   Expect lowercase 3-letter codes. `'mon'` matches `digest_weekly_day = 'mon'`.

3. **Remember: weekly day is UTC, not local time.** A venue owner in California expecting a Monday email might see it land Sunday night local time when the cron fires at 8am Monday UTC. Documented in the UI as "(UTC)" on the day picker.

4. If the value is wrong, fix via POST `{cadence:'weekly',weekly_day:'tue'}` or directly:
   ```sql
   update public.venue_members
   set metadata = jsonb_set(
     metadata,
     '{digest_weekly_day}',
     '"wed"'::jsonb,
     true
   )
   where venue_id = '<uuid>' and user_id = '<user uuid>';
   ```

### Search hint showing unexpectedly (Phase 8U)

If an operator reports the amber "Searching core fields only…" pill appearing for queries they think should include metadata:

- The pill renders whenever `qInput.trim().length` is 1 or 2.
- It's the UI signal for Phase 8T's `?q=` short-circuit: 1-2 char terms skip the metadata RPC because the trigram index needs ≥ 3 chars to win.
- **Fix**: type a longer search term. `?q=AI` → pill shown; `?q=anthropic` → pill hidden + metadata searched.

### Send sample digest failed (Phase 8V)

An admin clicks Send sample on the billing-page DigestPreferencesCard and sees an inline error or "Couldn't send sample: …" message:

1. **Verify the caller has an email on file.**
   ```sql
   select id, email from auth.users where id = '<user uuid>';
   ```
   `email IS NULL` → the route returns 422 `no_email_on_account`. Operator needs to set an email on their auth.users row.

2. **Verify Resend is configured in the runtime environment.** A console-fallback response surfaces as `Couldn't send sample: console_fallback` in the UI:
   ```bash
   # in the deploy platform's env inspector
   echo "RESEND_API_KEY=$RESEND_API_KEY"
   echo "RESEND_FROM_EMAIL=$RESEND_FROM_EMAIL"
   ```
   Both must be set. The preview reuses the same Resend stack as every other email path.

3. **Check whether the preview row landed in `outbound_messages`** — succeeded but inbox didn't:
   ```sql
   select created_at, status, error, provider, message_id,
          metadata->>'tour_digest_preview' as is_preview
   from public.outbound_messages
   where venue_id = '<uuid>'
     and metadata->>'tour_digest_preview' = 'true'
   order by created_at desc
   limit 5;
   ```
   - `is_preview = 'true'` + `status='queued'` + `provider='resend'` → Resend accepted. Check the Resend dashboard / your spam folder.
   - `status='suppressed'` → the address is in `email_suppressions`. Manually delete if intentional.
   - No matching row at all → the route never reached `sendEmail`. Check application logs for `admin.digest_preview.*` events.

4. **Rate-limited?** The endpoint uses `admin:digest-preview:{userId}` (30/min via Upstash). Operators QAing the UI shouldn't hit this; if they do, wait a minute and retry.

5. **A preview send does NOT block tomorrow's real digest.** The cron's per-recipient idempotency probe keys on `tour_digest_recipient_user_id`, which the preview deliberately does not set. Confirm via:
   ```sql
   select count(*)
   from public.outbound_messages
   where venue_id = '<uuid>'
     and metadata->>'tour_digest_recipient_user_id' = '<user uuid>'
     and metadata->>'tour_digest_date' = (now() at time zone 'utc')::date::text;
   ```
   Preview rows should NOT match (they're missing `tour_digest_recipient_user_id`). The cron rows DO match — and only one of those means today's real digest already went out.

### Backfill did not update members (Phase 8V)

The Phase 8V `seed-member-digest-preferences` Inngest job returned `{ updated: 0 }` or `{ skipped: true, reason: 'disabled' }`:

1. **Verify the env flag.** The deployment must have `SEED_MEMBER_DIGEST=1`. Without it the job short-circuits before any DB work.

2. **Verify candidate row count.** The backfill only touches owner/admin rows whose `metadata->>'digest_cadence'` is null. If your venue has already-backfilled rows OR no owner/admin members:
   ```sql
   select role,
          count(*) filter (where metadata->>'digest_cadence' is null) as needs_backfill,
          count(*) filter (where metadata->>'digest_cadence' is not null) as already_set
   from public.venue_members
   group by role
   order by role;
   ```

3. **Inspect rows that should have been touched but weren't.**
   ```sql
   select venue_id, user_id,
          metadata->>'digest_cadence' as cadence,
          jsonb_typeof(metadata) as meta_type
   from public.venue_members
   where role in ('owner', 'admin')
     and metadata->>'digest_cadence' is null
   limit 20;
   ```
   `meta_type` should be `object`. If a row has `meta_type = null` (column was somehow set to JSON null instead of `{}`), the PostgREST `is.null` filter still catches it — the row should appear in the candidate set.

4. **Per-row update failures** increment `failed` in the run summary and are Sentry-captured (`jobs.seed_member_digest_preferences.update_failed`). Inspect Sentry for the venue/user that failed.

### Digest recipient lookup slow (Phase 8V)

Phase 8V switched the cron's per-member email resolution from serial to bounded concurrency (5). This typically halves wall-clock time for a venue with 10 admins/owners.

Real Supabase Auth admin doesn't expose a clean batch-by-id endpoint in the SDK version we're pinned to, so the cron still issues N HTTP calls — they're just parallelized. If the cron is still slow:

1. **Inspect run logs** for `operator_digest.recipient_lookup_failed` events. Each failure adds a retry delay if Supabase Auth is rate-limiting our service key.

2. **Confirm `MAX_RECIPIENTS_PER_VENUE = 10` is enough** for the venue. A venue with 11+ admins silently drops members past the cap (ordered by `created_at`); raising the cap requires a code change.

3. **Confirm `RECIPIENT_LOOKUP_CONCURRENCY = 5`** matches your tenant size. Larger venues may benefit from raising it; small SaaS deployments are fine at 5.

### Resubscribe link returns "Link not valid" (Phase 8W)

Three common causes, in order of likelihood:

1. **Operator clicked an unsubscribe link at the resubscribe route (or vice versa).** Phase 8W tokens carry an explicit `action` field; presenting an `unsubscribe`-action token at `/api/digest/resubscribe` (or a `resubscribe`-action token at `/api/digest/unsubscribe`) is rejected with the typed `action_mismatch` error and collapses to the neutral 400 "link not valid" page. Re-issue the correct link from the `createDigestResubscribeUrl` / `createDigestUnsubscribeUrl` helpers (or the digest cron's next send).

2. **URL `venue_id` or `user_id` doesn't match the signed payload.** Both must exactly match what was signed. Look for `digest.resubscribe.param_mismatch` in structured logs:

   ```
   level=warn op=digest.resubscribe urlVenue=<a> tokenVenue=<b> urlUser=<x> tokenUser=<y>
   ```

   This is benign in development if you hand-edited the URL; in production it indicates either a token replay attempt or a copy-paste error.

3. **Token expired** (default TTL 30 days). The route returns a friendlier "Link expired" page pointing the operator at `/dashboard/settings/billing` for manual re-enable. If the operator can sign in, that's the canonical resolution.

If none of the above match, check `DIGEST_UNSUBSCRIBE_SECRET` — a recently rotated secret invalidates every in-flight token of either kind. The `digest.resubscribe.secret_missing` log line + a Sentry capture will both fire for the misconfigured branch.

### Resubscribed user still not receiving digests (Phase 8W)

`/api/digest/resubscribe` only writes to `venue_members.metadata.digest_cadence`. If the operator was added at a non-admin role (`viewer` / `coordinator` / `sales_manager`), the route silently 404s — the digest cron only delivers to `owner` / `admin` members. Confirm role:

```sql
select role from public.venue_members
where venue_id = '<uuid>' and user_id = '<uuid>';
```

If the role is non-admin, promote via the team admin surface; the cadence write will then take effect on the next scheduled tick.

If the role is correct but the next cron run still skips, inspect the structured logs for `operator_digest.skipped_*` reasons:

- `operator_digest.skipped_disabled` — effective cadence resolved to `'off'`. Verify the per-user write landed by reading the row back:

  ```sql
  select metadata
  from public.venue_members
  where venue_id = '<uuid>' and user_id = '<uuid>';
  ```

  Should contain `{"digest_cadence":"daily", "digest_resubscribed_at":"<iso>"}`.

- `operator_digest.skipped_cadence` — cadence is `'weekly'` and today isn't the scheduled day. The Phase 8W resubscribe write sets `'daily'`, but a subsequent per-user POST to `/api/admin/digest/preferences` may have flipped it back.

- `operator_digest.skipped_duplicate` — the cron's per-recipient probe found a row with `send_kind = 'cron'` for today. This is the expected idempotency behavior; the digest already fired today.

### Preview duplicates the day's digest (Phase 8W)

If an operator clicks "Send sample" on `/dashboard/settings/billing` and then the 8am UTC cron skips their venue with `operator_digest.skipped_duplicate`, that is a Phase 8W bug — the cron's per-recipient probe is supposed to filter previews out via `metadata->>'tour_digest_send_kind' = 'cron'`.

Triage:

1. Inspect the outbound row tags for the user's preview:

   ```sql
   select metadata
   from public.outbound_messages
   where venue_id = '<uuid>'
     and metadata->>'tour_digest_preview_user_id' = '<uuid>'
     and metadata->>'tour_digest_date' = to_char(now() at time zone 'utc', 'YYYY-MM-DD')
   order by created_at desc
   limit 5;
   ```

2. Confirm the row carries `"tour_digest_send_kind":"preview"`. If it instead carries `"tour_digest_send_kind":"cron"`, the preview route is mis-tagging — re-deploy and re-run.

3. If the preview row is correct, confirm the cron's probe is filtering on `send_kind = 'cron'`. The expected probe SQL (via PostgREST) is:

   ```sql
   select id from public.outbound_messages
   where venue_id = $1
     and related_table = 'tour_status_events'
     and metadata->>'tour_digest_date' = $2
     and metadata->>'tour_digest_recipient_user_id' = $3
     and metadata->>'tour_digest_send_kind' = 'cron'
   limit 1;
   ```

   If `tour_digest_send_kind` is absent from the probe, a stale deployment is running — re-deploy the cron with the Phase 8W changes from `lib/jobs/functions/operator-activity-digest.ts`.

### "Send sample" shows "address suppressed" copy (Phase 8W)

Expected behavior — the operator's email is on Resend's suppression list, typically from a prior hard bounce or complaint. The DigestPreferencesCard renders an amber explanatory block instead of a red error:

> This email address is currently suppressed by our email provider, so we can't send a sample digest to it. Contact support to re-enable delivery for this address.

Resolution:

1. Sign into Resend dashboard → Suppressions → search the operator's email.
2. If the address is listed, click "Remove" if the cause has been resolved (e.g. the operator confirmed their mailbox is now active).
3. Re-click "Send sample" — the friendly amber copy should clear and the sample should deliver.

If the address is NOT in Resend's suppression list but the route still returns `409 suppressed`, our local `lib/integrations/email.ts` may have a separate suppression cache — inspect by request id.

### Manual digest did not send (Phase 8X)

Click "Send manual digest" on `/dashboard/settings/billing` and the button toasts an error. Triage in this order:

1. **Check response shape.** Open DevTools → Network → POST `/api/admin/digest/send`. Map the status to the table in BILLING-QA §7ae "Manual endpoint contract":
   - `404 not_found` — target user_id (defaults to caller) isn't an owner/admin member of the resolved venue, OR cross-tenant denied. Verify with `select role from public.venue_members where user_id = '<caller>' and venue_id = '<venue>'`.
   - `400 recipient_email_missing` — the target's `auth.users.email` is null. Hit Supabase Auth Admin and re-verify the user's primary email; SSO-only accounts can land in this state.
   - `409 suppressed` — Resend has the caller's address on the suppression list. Same triage path as the preview suppression entry above.
   - `429 rate_limit_exceeded` — `admin:digest-send:<userId>` budget exhausted. Wait the `retryAfterMs` shown in headers, or audit who else is sharing this auth identity.
   - `500 email_failed` — provider error. Inspect Sentry by `request_id` (returned in `X-Request-Id`).

2. **Console-fallback dev path.** The response is `{ success: true, sent: false, reason: 'console_fallback' }`. Means Resend isn't configured — set `RESEND_API_KEY` + `RESEND_FROM_EMAIL` and retry. The card surfaces this as `Couldn't send manual digest: console_fallback` (red), distinguishable from real errors.

3. **`respect_cadence: true` blocked it.** If the operator POSTed with `respect_cadence: true` and the target's effective cadence is `'off'` or weekly-wrong-day, the response is `{ success: true, sent: false, skipped: true, reason }`. This is the dry-run "would today's cron actually send to this person?" branch — re-POST with `respect_cadence: false` (the card UI always omits the flag → defaults to false).

### Digest links missing from email (Phase 8X)

Operator reports: "I got my daily digest but the Unsubscribe and Re-enable links aren't there."

Root cause is almost always `DIGEST_UNSUBSCRIBE_SECRET` unset or shorter than 16 chars on the deploy environment. The cron / preview / manual handlers all skip the link build and emit the email anyway. Triage:

1. **Confirm secret presence.** `/api/health` does NOT explicitly surface this — it's not a readiness blocker. Check Vercel env vars (or your deploy target's equivalent) for `DIGEST_UNSUBSCRIBE_SECRET`. Minimum 16 chars; anything shorter is treated as missing.

2. **Confirm structured warn fired.** The cron logs `jobs.operator_activity_digest.no_unsubscribe_secret` ONCE per process when the secret is missing — search recent logs. The same warn is shared (via the once-per-process flag) with the preview + manual handlers, so a recent click on "Send sample" or "Send manual digest" also surfaces it.

3. **Generate a new secret** and roll it:

   ```bash
   openssl rand -hex 32
   ```

   Set `DIGEST_UNSUBSCRIBE_SECRET=<output>` in the deploy environment and redeploy. The cron's next tick should emit links again. Rotating invalidates every Phase 8S/8W token currently in flight.

4. **Send-kind-specific check.** If a CRON digest is missing only the resubscribe link but unsubscribe is present, that's CORRECT — cron sends omit the resubscribe link by design (recipient cadence is never 'off' on a successful cron send). The link should always appear on preview + manual sends when the secret is set.

### Cron sent again after Phase 8X (legacy rows without `send_kind`)

A recipient who received their digest yesterday under a pre-8W code path reports receiving today's digest twice (or the cron logs `operator_digest.sent` for them despite an apparent prior send).

This is expected and acceptable behavior. The Phase 8W per-recipient idempotency probe filters strictly on `metadata->>'tour_digest_send_kind' = 'cron'`. Legacy rows written before Phase 8W don't carry the `send_kind` field, so the probe doesn't match them. A freshly-deployed cron may send one extra digest in the first 24 hours after the Phase 8W rollout.

If the issue persists past 24 hours:

1. **Inspect the most-recent row for the recipient:**

   ```sql
   select metadata->>'tour_digest_date' as date,
          metadata->>'tour_digest_send_kind' as kind,
          created_at
   from public.outbound_messages
   where venue_id = '<uuid>'
     and related_table = 'tour_status_events'
     and metadata->>'tour_digest_recipient_user_id' = '<uuid>'
   order by created_at desc
   limit 5;
   ```

2. If `kind` is `cron` on a row from today AND the cron sent another one with the same date, the probe SQL itself is stale — confirm the deployed `lib/jobs/functions/operator-activity-digest.ts` includes the three-filter probe:

   ```ts
   .filter('metadata->>tour_digest_date', 'eq', todayUtc)
   .filter('metadata->>tour_digest_recipient_user_id', 'eq', userId)
   .filter('metadata->>tour_digest_send_kind', 'eq', 'cron')
   ```

3. If `kind` is `manual` or `preview` and the cron correctly skipped it as a non-match, no action needed — that's the contract.

One-shot remediation (optional) — backfill `send_kind='cron'` onto pre-8W rows so they're treated as dedup candidates going forward. Run from psql or the Supabase SQL editor:

```sql
update public.outbound_messages
set metadata = metadata || jsonb_build_object('tour_digest_send_kind', 'cron')
where related_table = 'tour_status_events'
  and metadata ? 'tour_digest_date'
  and metadata ? 'tour_digest_recipient_user_id'
  and not (metadata ? 'tour_digest_send_kind');
```

Idempotent; one-time fix. After this runs, the probe stops missing legacy rows.

### Manual digest sent to wrong recipient (Phase 8Y)

Operator reports: "I clicked Send manual digest and it went to me, not the colleague I picked." Three causes in order of likelihood:

1. **Picker selection didn't stick.** The card POSTs `user_id` from `selectedRecipientId`, which is populated by the `/api/admin/digest/members` fetch. If the fetch failed (rate-limited, network, 401), the picker shows "Couldn't load recipients" and the button falls back to no `user_id` → the API defaults to caller. Verify in DevTools → Network the GET request returned `200` with the expected `items[]`.

2. **Browser cached an old client bundle.** The picker logic is client-side; an operator who hadn't reloaded since before Phase 8Y will see the Phase 8X button (no picker, always self). Hard-reload (Cmd-Shift-R / Ctrl-Shift-R) and confirm the picker `<select>` element is present.

3. **`venue_members.metadata` hasn't propagated yet.** The picker shows the venue's owner/admin members at request time — a freshly invited member who hasn't been promoted to owner/admin yet won't appear. Verify with:

   ```sql
   select user_id, role, created_at
   from public.venue_members
   where venue_id = '<uuid>' and role in ('owner', 'admin')
   order by created_at asc;
   ```

   Cron + manual fan-out is capped at 10 members per venue by `MAX_RECIPIENTS_PER_VENUE` — the 11th admin won't appear in the picker. Lower-priority admins (later `created_at`) drop out first.

### Digest audit feed missing a send (Phase 8Y)

Operator triggered a send (cron / preview / manual) and it doesn't appear in `DigestAuditFeed` on `/dashboard/settings/billing`. Triage:

1. **Filter chip excluded it.** The feed defaults to the most-recently-selected chip; if "Cron" is active and you just triggered a Manual, the row is filtered out. Click "All" or the appropriate chip and refresh.

2. **Legacy row without `send_kind`.** The endpoint deliberately filters out rows where `metadata->>'tour_digest_send_kind' IS NULL` — pre-Phase 8W rows can't be classified accurately. Verify by querying the database directly:

   ```sql
   select id, metadata->>'tour_digest_send_kind' as kind, created_at
   from public.outbound_messages
   where venue_id = '<uuid>'
     and related_table = 'tour_status_events'
   order by created_at desc
   limit 10;
   ```

   If the row exists but `kind` is null, run the one-shot backfill SQL from the "Cron sent again after Phase 8X" entry above to retro-tag it.

3. **Limit hit.** The feed loads the last 25 rows by default; if the venue is high-volume, the row is past the window. Pass `?limit=200` directly to the API or chain via `?since=<ISO>` for older windows.

4. **Email path didn't reach `outbound_messages` at all.** A console-fallback dev environment (no `RESEND_API_KEY`) logs the email but doesn't create the row. Confirm with `/api/health` → `email: 'configured'` or check for `admin.digest_preview.console_fallback` / `admin.digest_send.console_fallback` log lines.

### Recipient picker missing a member (Phase 8Y)

Operator says: "I expected to see Sara in the picker but she's not there."

1. **Sara isn't an owner/admin.** The picker structurally excludes viewer / coordinator / sales_manager. Promote in the team admin surface, then reload the card.

2. **Sara has no resolvable `auth.users.email`.** The picker shows her row with the option disabled (`— no email` suffix) instead of dropping her silently. If she's missing entirely, the auth admin lookup threw — search logs for `admin.digest_members.email_lookup_failed userId=<sara>`.

3. **Venue has > 10 admins.** The picker (and the underlying cron fan-out) cap at 10 members by `created_at` ascending. Sara was invited 11th and gets dropped. If she genuinely needs to receive digests, demote an older inactive admin or wait for the cap to be lifted.

4. **`/api/admin/digest/members` cached.** The card fetches once on mount; if Sara was promoted after the card loaded, hard-reload the page.

### Digest CSV export failed (Phase 8Y)

Click "Export CSV" on the audit feed and the browser shows an error / blank tab. Triage:

1. **401 / 403** — session expired or the operator lost their admin role. Re-sign-in.

2. **429 rate-limit** — `admin:digest-sends:{userId}` budget exhausted. The CSV URL inherits the same rate-limit budget as the JSON endpoint; rapid clicks share the limit. Wait the `retryAfterMs` from the response headers.

3. **Empty CSV body** — the filter is too narrow. The endpoint always writes the header row + UTF-8 BOM even on zero items; if the operator's browser shows "Empty file" they likely picked a date `since` in the future or filtered to a `send_kind` with no rows. Drop the filter and re-export.

4. **CSV opens with garbled columns in Excel** — Excel ignored the UTF-8 BOM. Open via `Data → Get External Data → From Text/CSV` and explicitly choose UTF-8. (The BOM is RFC-compliant but some Excel locales need the explicit hint.)

5. **The export hangs / never returns** — endpoint cap is 200 rows. The export should complete near-instantly for that volume. A genuine hang implies the underlying query is slow; check the `outbound_messages_venue_created_idx` index exists (migration 003) and that `metadata->>'tour_digest_send_kind'` filter isn't producing a full table scan.

### Digest audit feed not updating live (Phase 8Z)

A new digest send (cron / preview / manual) lands in the database but `DigestAuditFeed` on `/dashboard/settings/billing` doesn't show it without a manual reload. The realtime layer subscribed successfully but is silent. Triage:

1. **Confirm `outbound_messages` is in the realtime publication.** Migration 001 only publishes leads / messages / conversations / tours. Run from the Supabase SQL editor:

   ```sql
   select schemaname, tablename
   from pg_publication_tables
   where pubname = 'supabase_realtime'
   order by tablename;
   ```

   If `outbound_messages` is missing, add it:

   ```sql
   alter publication supabase_realtime add table public.outbound_messages;
   ```

   Idempotent — re-running on an already-published table is a no-op.

2. **Confirm the toast subsystem is mounted.** Open DevTools console and look for `RealtimeToast` mount logs on page load. If the toast component itself is missing the realtime layer can fire but the visual signal will be invisible.

3. **Confirm the handler isn't filtering everything out.** The handler narrows to `related_table === 'tour_status_events'` AND `metadata.tour_digest_send_kind` present. A pre-Phase 8W row missing the send_kind tag will be silently ignored. If a recently-created row is missing the discriminator, deployment is stale — re-deploy the cron / preview / send routes (see RUNBOOK "Cron sent again after Phase 8X" for the one-shot backfill SQL).

4. **Confirm browser tab is in foreground.** Supabase Realtime channels are scoped to the page; a background tab still receives events but `router.refresh()` is throttled by the browser. Bring the tab to focus and trigger a fresh send to verify.

5. **Confirm RLS lets the operator see the row.** `outbound_messages` RLS (migration 005) requires venue membership. Realtime respects RLS — a non-member never receives the event. Admins/owners always do; verify with:

   ```sql
   select role from public.venue_members
   where venue_id = '<uuid>' and user_id = '<caller uuid>';
   ```

### "Load older" does not show expected sends (Phase 8Z)

Operator clicks "Load older" and the appended rows are wrong (missing entries, duplicates, or no new rows). Triage in this order:

1. **Filter chip changed between fetches.** The "Load older" cursor is the `created_at` of the LAST row in the currently visible slice. If the operator clicked "Cron" → loaded 25 rows → clicked "Manual" → clicked "Load older", the cursor came from the Cron slice but the next fetch filters on Manual. Expected behavior: filter change resets pagination to page 1. If you're seeing mixed results, the chip click didn't trigger a reset; hard-reload the page.

2. **Cursor is on a future-dated row.** A row with `created_at` set to the future (manually-inserted demo seed?) will sit at the top of the descending order; the cursor's strict `<` then skips every row at or before the present, returning none. Verify:

   ```sql
   select created_at
   from public.outbound_messages
   where venue_id = '<uuid>'
     and related_table = 'tour_status_events'
     and metadata->>'tour_digest_send_kind' is not null
   order by created_at desc
   limit 5;
   ```

   Re-time any future-dated rows or drop them from the demo seed.

3. **Duplicate rows in appended page.** The pagination uses strict `<` so duplicates are structurally impossible. If you see one, two sends must share the exact same `created_at` to microsecond precision — extremely rare. Migrate to `(created_at, id)` composite cursor in a future phase if this ever occurs in production.

4. **"Load older" button missing.** The button only renders when the most recent fetch reported `has_more: true` (page came back full). If the venue has fewer than 25 digest sends total, the button never appears. Verify by counting:

   ```sql
   select count(*) from public.outbound_messages
   where venue_id = '<uuid>'
     and related_table = 'tour_status_events'
     and metadata->>'tour_digest_send_kind' is not null;
   ```

### Admin email is suppressed (Phase 8Z)

The `DigestSuppressionsCallout` banner shows "1 admin email is currently suppressed." Triage + resolution:

1. **Confirm which address.** The callout lists masked emails (`o***@example.com`). Cross-reference with `select user_id, role from venue_members where venue_id='<uuid>' and role in ('owner','admin')` + Supabase Auth admin to identify the operator.

2. **Find the suppression entry:**

   ```sql
   select email, reason, source, created_at
   from public.email_suppressions
   where email = '<raw email>';
   ```

3. **Resolve based on `reason`:**
   - `bounce_hard` — the mailbox actively rejected the mail. Confirm the address is now valid (test from a personal email); ask the operator to whitelist `RESEND_FROM_EMAIL` in their mail provider; then remove the suppression.
   - `complaint` — the recipient hit "report as spam" in their mail client. Talk to them BEFORE removing the suppression — otherwise the next send will get re-reported and the sending domain reputation will erode.
   - `manual` — someone added the entry via ops tooling. Find the `source` field for context.
   - `unsubscribe` — this maps to `unknown` in the callout. The recipient unsubscribed via the Phase 8S digest link; their `venue_members.metadata.digest_cadence` is also `'off'`. They can re-enable via Phase 8W's resubscribe link OR the in-app DigestPreferencesCard.

4. **Remove the suppression** (when safe):

   ```sql
   delete from public.email_suppressions where email = '<raw email>';
   ```

   The callout will clear on the next billing-page load.

### Digest suppression endpoint returns empty but send is suppressed (Phase 8Z)

Operator reports: "I tried to send a sample digest, got `409 suppressed`, but `DigestSuppressionsCallout` shows no entries." Several possible mismatches:

1. **Caller is not in the venue's owner/admin member set.** The suppression endpoint only checks members with `role in ('owner', 'admin')` for THIS venue. A caller who is admin somewhere else but a viewer here won't surface their own suppression. Confirm:

   ```sql
   select role from public.venue_members
   where venue_id = '<uuid>' and user_id = '<caller uuid>';
   ```

   If not admin/owner, that's expected behavior — the callout is venue-scoped, not user-scoped.

2. **Email case mismatch.** `email_suppressions.email` is `citext` (case-insensitive), but the comparison in the route uses `.in('email', [...])` with the case-as-resolved-from-auth. The route lowercases both sides client-side for the intersection step, so a casing mismatch shouldn't drop hits — but if you suspect it has, query directly:

   ```sql
   select email from public.email_suppressions
   where lower(email) = lower('<auth email>');
   ```

3. **Member cap dropped them.** The endpoint resolves up to 10 owner/admin members by `created_at` ascending. The 11th+ admin won't appear, even if they're the suppressed one. Lower-priority admins drop out first.

4. **Auth email lookup failed.** The endpoint warns `admin.digest_suppressions.email_lookup_failed userId=<…>` on transient Supabase Auth failures. A failed lookup means the member is silently dropped from the intersection. Search recent logs.

5. **Different suppression backend.** The `409 suppressed` response from `/api/admin/digest/send` comes from `lib/integrations/email.ts`'s pre-flight check. That helper may consult both `email_suppressions` AND a process-local cache. If only the cache says suppressed, the database is clean and the callout will correctly show empty. Restart the server / process to clear any stale cache.

### Remove suppression button failed (Phase 8AA)

Operator clicks "Remove suppression" in `DigestSuppressionsCallout`, gets an inline red error. Triage by mapping the error code:

1. **`not_found`** — target user isn't an owner/admin member of this venue (collapse from cross-tenant 403 OR role demotion). Verify:

   ```sql
   select role from public.venue_members
   where venue_id = '<uuid>' and user_id = '<uuid>';
   ```

   Re-promote to owner/admin and retry. If the operator IS still admin, confirm `venue_id` resolution by inspecting `X-Request-Id` in DevTools → Network → response headers, then grep recent logs for `admin.digest_suppression_remove` with that request id.

2. **`recipient_email_missing`** — target user has no `auth.users.email`. Confirm in Supabase Auth dashboard; this typically indicates an SSO account where the email field was never populated. Resolve at the auth provider, then retry. SQL fallback (use ONLY after verifying the email belongs to the right user via the Auth dashboard):

   ```sql
   -- resolve email FIRST from auth.users (server-side authorities only;
   -- never trust the operator's memory):
   select email from auth.users where id = '<user uuid>';

   -- then remove the suppression by that exact address:
   delete from public.email_suppressions
   where email = '<resolved-email>';
   ```

3. **`rate_limit_exceeded`** — `admin:digest-suppressions-remove:<userId>` budget exhausted. Wait the `retryAfterMs` shown in the response.

4. **`unexpected_error`** — DB write failed (delete or Auth admin lookup threw). Inspect Sentry by `X-Request-Id`. The structured log line `admin.digest_suppression_remove.delete_failed` carries `err`, `venueId`, `targetUserId`.

5. **Button says "removing…" forever** — network failed silently or component is stuck in `removing: true`. Hard-reload the billing page; the callout refetches on mount and the per-row state resets. If the same row keeps hanging, re-trigger via SQL fallback above.

### Digest send search missing expected row (Phase 8AA)

Operator types `?q=manual` (or uses the search input) and expects a row to appear that doesn't. Triage:

1. **Search-length short-circuit.** Terms 1-2 chars match only `status`, `provider`, `error`, `to_address`, `metadata->>tour_digest_send_kind`. A 2-char search for `we` won't match `weekly_day = wed` because `weekly_day` is only included at 3+ chars. Add a character and retry; the audit feed surfaces the amber hint banner for sub-3-char terms.

2. **Field not in the allowlist.** The search covers a narrow set of fields by design. Notably:
   - `cadence` (3+ chars): matches `metadata->>tour_digest_cadence`.
   - Recipient / initiator UUIDs (3+ chars): exact prefix substrings work.
   - `subject`, `body`, full metadata JSON: NOT searched. Use a direct SQL query if needed.

3. **Search escapes wildcards.** Server escapes `%` and `_` in the user term so `100%` matches the literal `100%` substring. If the row contains a literal SQL wildcard you're searching for, the result will be a match — that's intentional. If you're confused why an apparent ILIKE wildcard doesn't act as one, that's also intentional.

4. **`to_address` matches but result masked.** A search for the local-part fragment of an admin email returns the row, but the displayed `recipient_email` is `o***@example.com`. This is the PII posture working as designed — the server matches on the raw address; the response masks it.

5. **Pagination boundary.** Search applies BEFORE the cursor. If "Load older" returned 0 rows but you can see matching rows in the database, the cursor passed the last matching row. Drop the cursor by re-running the initial search with no `occurred_before`.

6. **Row pre-dates Phase 8W discriminator.** Legacy `outbound_messages` rows without `metadata->>tour_digest_send_kind` are EXCLUDED from the sends endpoint entirely (Phase 8Y filter `not.is.null`). The search can't find them. Use the one-shot backfill SQL from "Cron sent again after Phase 8X" above to retro-tag them.

### Suppression callout did not refresh after suppressed send (Phase 8AA)

Operator triggers a manual digest send to a suppressed address (or a fresh bounce lands). The audit feed row appears via the realtime toast, but `DigestSuppressionsCallout` doesn't update. Triage:

1. **`outbound_messages` not in realtime publication.** Same prereq as "Digest audit feed not updating live" above. Check:

   ```sql
   select schemaname, tablename
   from pg_publication_tables
   where pubname = 'supabase_realtime' and tablename = 'outbound_messages';
   ```

   If empty, re-apply:

   ```sql
   alter publication supabase_realtime add table public.outbound_messages;
   ```

2. **Inserted row's status was NOT `suppressed`.** The callout-refresh dispatch only fires for rows where `status === 'suppressed'`. A row that starts at `queued` then transitions to `suppressed` via UPDATE won't trigger the refresh — only INSERTs with the suppressed status at write time. Confirm by inspecting the new row:

   ```sql
   select id, status, created_at
   from public.outbound_messages
   where venue_id = '<uuid>'
   order by created_at desc limit 1;
   ```

3. **Callout already showed the row.** The callout shows ADMIN emails on the global suppression list. If the suppressed address was already in `email_suppressions` BEFORE this send, the callout was already correct — the refresh is a no-op. New suppression entries from Resend webhooks land in `email_suppressions` asynchronously; if the entry hasn't been written yet, the refetch will find nothing.

4. **CustomEvent listener not registered.** The component's `useEffect` adds the listener on mount and removes on unmount. If you opened DevTools mid-page and want to confirm:

   ```js
   // In DevTools console:
   window.dispatchEvent(new CustomEvent('venuerise:digest-suppression-refresh'))
   ```

   Should trigger an immediate refetch (visible in Network tab). If nothing happens, the component isn't mounted — confirm `isAdmin` is true and the parent gates didn't fail.

5. **Background tab.** Supabase Realtime delivers events to background tabs, but `router.refresh()` is throttled. The CustomEvent itself still fires; the callout fetch still runs. The audit feed table just won't visually update until the tab comes to focus.

### Digest audit rows disappeared from default feed (Phase 8AB)

Operator reports: "I had 200 digest sends in the feed yesterday; today the feed only shows 30." Likely the Phase 8AB retention cron ran and archived rows older than `DIGEST_AUDIT_RETENTION_DAYS`.

Triage:

1. **Confirm the cron ran.** Inngest dashboard → `digest-audit-retention` → recent runs. Last successful run should be within the last week.

2. **Confirm rows are archived, not deleted.** Soft-archive only — rows are NEVER deleted by the cron. Inspect:

   ```sql
   select id, created_at, metadata
   from public.outbound_messages
   where related_table = 'tour_status_events'
     and metadata->>'digest_archived' = 'true'
   order by created_at desc
   limit 25;
   ```

   Should return rows tagged with `digest_archived: true`, `digest_archived_at`, `digest_archived_reason: 'retention_policy'`, `digest_retention_days: <N>`.

3. **Surface archived rows in the feed.** Re-fetch with the flag:

   ```
   GET /api/admin/digest/sends?include_archived=true&limit=200
   ```

   The JSON `items[]` carry a new `archived: true|false` boolean per row; the CSV branch adds an `archived` column.

4. **Extend the retention window if needed.** Set `DIGEST_AUDIT_RETENTION_DAYS=730` (or any value up to 3650) and re-deploy. The next cron tick will respect the new window. Note: already-archived rows STAY archived — the cron is one-way. To unarchive in bulk, run:

   ```sql
   update public.outbound_messages
   set metadata = metadata
       - 'digest_archived'
       - 'digest_archived_at'
       - 'digest_archived_reason'
       - 'digest_retention_days'
   where related_table = 'tour_status_events'
     and metadata->>'digest_archived' = 'true'
     and created_at > now() - interval '<new retention days> days';
   ```

5. **Disable retention entirely.** Set `DIGEST_AUDIT_RETENTION_ENABLED=0` (or unset). Next cron tick logs `jobs.digest_audit_retention.skipped_disabled` and returns `{ skipped: true, reason: 'disabled' }`.

### Digest cron health says no_data (Phase 8AB)

`DigestCronHealthCard` on the billing page shows amber "No recent digest send found." Usually NOT a cron failure. Triage:

1. **Was there tour activity in the last 24h?** The Phase 8R cron skips zero-event venues. If `select count(*) from public.tour_status_events where venue_id = '<uuid>' and occurred_at > now() - interval '24 hours'` returns 0, that's why — no row to send.

2. **Confirm cron actually ran via Inngest dashboard.** The card's `no_data` is delivery-derived. The cron ran but skipped this venue (zero events, cadence='off' for every admin, etc). Inngest's run history is authoritative.

3. **Confirm the venue has admin/owner members.** Cron only fans out to owner/admin members. Verify:

   ```sql
   select count(*) from public.venue_members
   where venue_id = '<uuid>' and role in ('owner', 'admin');
   ```

   Zero members → no recipients → no rows → `no_data`.

4. **Confirm `OPERATOR_DIGEST_ENABLED=1`** on the deploy. With the flag absent, the cron short-circuits and never inserts rows.

5. **Confirm `metadata.tour_digest_send_kind` is being written.** The cron-health probe filters strictly on `send_kind = 'cron'`. A pre-Phase 8W deployment that lost the tag (regression / stale build) would produce `no_data` even with successful sends. Inspect the latest row:

   ```sql
   select metadata->>'tour_digest_send_kind' as kind, created_at
   from public.outbound_messages
   where venue_id = '<uuid>' and related_table = 'tour_status_events'
   order by created_at desc limit 1;
   ```

   If `kind` is null on a recent row, re-deploy `lib/jobs/functions/operator-activity-digest.ts`.

### Bulk remove suppressions failed (Phase 8AB)

Operator clicks "Remove all suppressions" in `DigestSuppressionsCallout` and the callout-level red error appears. Triage:

1. **`429 rate_limit_exceeded`** — `admin:digest-suppressions-remove-all:<userId>` budget exhausted. Wait the `retryAfterMs` shown in the response.

2. **`404 not_found`** — cross-tenant venue access denied. Confirm the caller is owner/admin on the target venue.

3. **Some `details[]` rows show `removed: false, reason: 'email_missing'`** — those members have no `auth.users.email`. Resolve at the Auth provider, then re-run the bulk (or use the per-row remove for the addressable members).

4. **All `details[]` rows show `removed: false, reason: 'not_suppressed'`** — the suppression list was already empty for the venue's admins. The callout will hide on the next refetch.

5. **`500 unexpected_error`** — DB write failed. Inspect Sentry by `X-Request-Id`. The structured log `admin.digest_suppression_remove_all.delete_failed` carries `err`, `userId`, `venueId` (per-member detail) or `admin.digest_suppression_remove_all.member_lookup_failed` for the top-level fetch.

SQL fallback when the endpoint can't complete (e.g. Supabase Auth admin is down):

```sql
-- list candidates first
select vm.user_id, au.email, es.reason
from public.venue_members vm
join auth.users au on au.id = vm.user_id
join public.email_suppressions es on es.email = au.email
where vm.venue_id = '<uuid>' and vm.role in ('owner', 'admin');

-- bulk delete (run after eyeballing the candidate list)
delete from public.email_suppressions
where email in (
  select au.email
  from public.venue_members vm
  join auth.users au on au.id = vm.user_id
  where vm.venue_id = '<uuid>' and vm.role in ('owner', 'admin')
);
```

### Search highlight looks wrong (Phase 8AB)

Search input is showing matches in cells you didn't expect, OR not showing matches you DID expect. Reference behavior:

- **Highlight wraps visible cells only.** Send kind label, recipient email (masked), status pill text, cadence, weekly day. NOT timestamps; NOT event count.
- **Hidden metadata isn't highlighted.** A search for a UUID matches the row via the server's `?q=` predicate (which searches `metadata->>tour_digest_recipient_user_id` etc), but the recipient email cell will only highlight if the UUID happens to appear inside the masked email string — which it never does. This is intentional; the existing recipient summary calls out who manual sends went to.
- **Highlight is case-insensitive.** Searching `Manual` highlights `manual` and `MANUAL` alike.
- **`<script>` searches are safe.** The highlight helper builds the React tree piecewise with `String.indexOf` — no regex injection, no `dangerouslySetInnerHTML`. A search for `<script>` matches a row containing the literal substring and renders it as plain text inside `<mark>`.
- **No partial highlight across React tree boundaries.** If a cell renders the search term across two React nodes (e.g. cadence `weekly · mon` rendered as two `highlight()` calls separated by `·`), the highlight matches each chunk independently. Searching `ekly · m` won't span the gap. Acceptable trade-off; matches operator mental model ("each cell highlights its own text").
- **Empty / whitespace-only searches don't highlight.** The helper trims `q` before searching; a 1-char `q` of just a space matches nothing.

### Who removed this suppression? (Phase 8AC)

Operator reports: "A bounce came back two weeks ago and now the address is fine. Who cleared the suppression?"

1. **Check the digest audit log.** On the billing page, scroll to the `DigestAuditLogCard`, click the "Suppression" chip. Each removal shows actor + target (masked) + when.

2. **Query directly via SQL** if you need a wider window than the card surfaces (25 rows / family):

   ```sql
   select *
   from public.digest_audit_events
   where venue_id = '<venue_id>'
     and action in ('suppression_remove', 'suppression_remove_all')
   order by occurred_at desc
   limit 50;
   ```

   - `actor_user_id` — the operator (or null for cron actions).
   - `target_user_id` — the user whose suppression was removed.
   - `target_email_masked` — masked at write time; reverse-resolve through `auth.users` if you need the real address.
   - `metadata.route` — `'single'` (per-row endpoint) or `'bulk'` (remove-all).
   - `reason` — optional operator-supplied breadcrumb.

3. **CSV export.** Filter the card to "Suppression" and click Export CSV — downloads `digest-audit-events-YYYY-MM-DD.csv` with the columns documented in BILLING-QA §7aj.

4. **Audit row missing.** The audit helper is best-effort — a row could be missing if the helper failed at write time. Search logs for `digest_audit_events.insert_failed` or `digest_audit_events.insert_threw`. The structured log line `digest_audit_events.recorded` (info-level) is the authoritative ledger; if you see the recorded line but no DB row, file a ticket because the helper signaled success but the row vanished.

### Retention archived rows but I need to inspect them (Phase 8AC)

Operator says: "I need to look at a digest send from 14 months ago for an incident investigation."

1. **Confirm the row exists but is archived:**

   ```sql
   select id, status, created_at, metadata->>'digest_archived' as archived
   from public.outbound_messages
   where related_table = 'tour_status_events'
     and metadata->>'tour_digest_recipient_user_id' = '<user>'
     and created_at < now() - interval '12 months'
   order by created_at desc
   limit 25;
   ```

2. **Surface in the audit feed UI.** Toggle "Show archived" above the chip strip in `DigestAuditFeed` — the toggle is persisted in localStorage so the operator stays in archived-inclusive mode until they uncheck it. Archived rows render with an extra slate `Archived` tag beside the Kind badge.

3. **CSV with archived rows.** With the toggle on, the CSV export link inherits `?include_archived=true`. Download produces the standard 14-column schema plus the `archived` boolean per row (Phase 8AB).

4. **Direct JSON fetch** for forensic queries beyond the 25-row card window:

   ```bash
   curl -H "Cookie: <session>" \
     'http://localhost:3000/api/admin/digest/sends?include_archived=true&since=2025-01-01T00:00:00Z&limit=200'
   ```

5. **Unarchive in bulk** if you need archived rows to be visible by default again (rare):

   ```sql
   update public.outbound_messages
   set metadata = metadata
       - 'digest_archived'
       - 'digest_archived_at'
       - 'digest_archived_reason'
       - 'digest_retention_days'
   where related_table = 'tour_status_events'
     and metadata->>'digest_archived' = 'true'
     and created_at > now() - interval '<new retention window> days';
   ```

   Update `DIGEST_AUDIT_RETENTION_DAYS` first so the next cron tick doesn't immediately re-archive.

### Retention dry run before enabling (Phase 8AC)

Operator wants to know what the next real retention run will touch, before flipping `DIGEST_AUDIT_RETENTION_ENABLED=1`.

1. **Set both flags:**
   ```
   DIGEST_AUDIT_RETENTION_ENABLED=1
   DIGEST_AUDIT_RETENTION_DRY_RUN=1
   ```
2. **Trigger the cron** via the Inngest dashboard → `digest-audit-retention` → "Send event" with no payload (or wait for the next Monday 9am UTC tick).
3. **Inspect the response:**
   ```json
   {
     "dry_run": true,
     "candidate_count": 123,
     "sample_ids": ["<uuid>", "..."],
     "retention_days": 365
   }
   ```
   `sample_ids` is capped at 25. For the full set:
   ```sql
   select id, venue_id, created_at
   from public.outbound_messages
   where related_table = 'tour_status_events'
     and metadata->>'tour_digest_send_kind' is not null
     and created_at < now() - interval '<retention_days> days'
     and (metadata->>'digest_archived' is null
          or metadata->>'digest_archived' != 'true')
   order by created_at asc
   limit 500;
   ```
4. **Confirm no rows mutated.** The dry-run path writes neither `outbound_messages.metadata.digest_archived` nor a `digest_audit_events` row.
5. **Flip live.** Set `DIGEST_AUDIT_RETENTION_DRY_RUN=0` (or unset). Next cron tick runs for real, archives up to 500 rows, and writes one `digest_retention_archive` audit event per venue represented in the batch.

### Cron health card did not update live (Phase 8AC)

Operator triggers a manual cron run (via Inngest dashboard) but `DigestCronHealthCard` still shows "no recent send" / stale lag. Triage:

1. **Confirm `outbound_messages` is in the realtime publication.** Same prereq as the audit feed realtime path:

   ```sql
   select tablename
   from pg_publication_tables
   where pubname = 'supabase_realtime' and tablename = 'outbound_messages';
   ```

   If empty, apply:

   ```sql
   alter publication supabase_realtime add table public.outbound_messages;
   ```

2. **Confirm the inserted row was actually tagged `send_kind='cron'`.** Preview / manual sends don't fire the `venuerise:digest-cron-fired` event. The card only refetches on cron-kind inserts.

3. **Confirm the listener is registered.** Open DevTools console and dispatch the event by hand:

   ```js
   window.dispatchEvent(new CustomEvent('venuerise:digest-cron-fired'))
   ```

   Network tab should show an immediate GET `/api/admin/digest/cron-health`. If nothing fires, the component isn't mounted — confirm `isAdmin` is true and the parent gate didn't fail.

4. **Browser tab in foreground?** Supabase Realtime delivers events to background tabs, but throttled. Bring the tab to focus and re-trigger.

5. **30h threshold for `stale`.** Even with a fresh cron row, the card may render `ok` only if the row is < 30h old. A run from yesterday morning + a missed-by-2-hours window today = `stale`. The endpoint's 30h threshold is documented in BILLING-QA §7ai.

6. **Manual fallback:** Click the card's Refresh button. Triggers an unconditional refetch.

### Find who removed suppressions (Phase 8AD)

Phase 8AC's RUNBOOK entry "Who removed this suppression?" covered the SQL path; Phase 8AD makes it a one-click operator query.

1. Open `/dashboard/settings/billing`. Scroll to `DigestAuditLogCard`.
2. Click the "Suppression" chip → server returns every row across `suppression_remove` / `suppression_remove_noop` / `suppression_remove_all` actions in a single round-trip.
3. Type the masked email fragment into the search input (e.g. `o***@example.com`'s local-part `o**`). 300ms debounce; results update without a page reload.
4. Click "Load older" if the operator pre-dates the 25-row window.
5. Click "Export CSV" to download the filtered set as `digest-audit-events-YYYY-MM-DD.csv`.

SQL fallback (always available):

```sql
select *
from public.digest_audit_events
where venue_id = '<venue_id>'
  and action in ('suppression_remove', 'suppression_remove_noop', 'suppression_remove_all')
order by occurred_at desc
limit 50;
```

### Audit log missing cron send rows (Phase 8AD)

Operator clicked the "Cron" chip on `DigestAuditLogCard` and got the empty state. Most likely cause: `DIGEST_AUDIT_LOG_CRON_SENDS` was never set to `'1'` on the deploy.

Triage:

1. **Confirm the env flag.** Cron-send audit writes are opt-in (high row volume). Check the deploy environment for `DIGEST_AUDIT_LOG_CRON_SENDS=1`. Anything else (unset / `"0"` / `"true"`) leaves the writer off.

2. **Confirm cron actually ran since the flag was flipped.** Audit writes happen on the success branch of every cron send. If the flag was flipped today and the cron runs at 8am UTC daily, results will show up after the next tick. Verify last cron run via:

   ```sql
   select created_at, metadata->>'tour_digest_send_kind' as kind
   from public.outbound_messages
   where venue_id = '<uuid>'
     and related_table = 'tour_status_events'
     and metadata->>'tour_digest_send_kind' = 'cron'
   order by created_at desc
   limit 5;
   ```

3. **Confirm the helper isn't silently failing.** Audit writes are best-effort — a failure logs `digest_audit_events.insert_failed` or `digest_audit_events.insert_threw`. Search recent logs filtered by `op=digest_audit_events`. A pattern of failures means the helper itself is broken; investigate Sentry by request id.

4. **SQL fallback** to confirm directly:

   ```sql
   select *
   from public.digest_audit_events
   where venue_id = '<venue_id>'
     and action = 'digest_send_cron'
   order by occurred_at desc
   limit 50;
   ```

   Empty result + recent cron sends = either the env flag is off OR the helper writes are failing silently.

### Digest audit search returns too many/few rows (Phase 8AD)

1. **Search term in unexpected column.** `?q=` ILIKE-matches `action`, `reason`, AND `target_email_masked`. A search for `o**` matches both rows where `o**` is in a reason breadcrumb AND rows where `o***@example.com` is the target. If the row count is suspiciously high, narrow with `?action_family=` or pair with `?target_user_id=`.

2. **Search term has a wildcard character.** `%` and `_` are escaped server-side so `100%` matches the literal substring. A search for `_` returns nothing (matches an escaped underscore in source data, which is rare).

3. **UUID search returns zero.** UUIDs are NOT in the search allowlist (PostgREST `.or()` can't cast). To find rows for a specific user, use `?target_user_id=<uuid>` or `?actor_user_id=...` instead. SQL fallback:

   ```sql
   select * from public.digest_audit_events
   where venue_id = '<venue>'
     and (actor_user_id::text ilike '%<partial>%'
       or target_user_id::text ilike '%<partial>%')
   order by occurred_at desc limit 50;
   ```

4. **Cursor not advancing.** "Load older" uses strict-`<` on `occurred_at`. Two rows with identical timestamps (rare; we'd need sub-microsecond collisions) could theoretically produce gaps. Composite `(occurred_at, id)` cursor is a future fix if it ever happens in production.

5. **Family chip mismatch.** "Cron" chip only matches `digest_send_cron` rows, which only exist when `DIGEST_AUDIT_LOG_CRON_SENDS=1` was set when the cron fired. Empty cron-chip result with a recent cron run usually means the env flag isn't set. See "Audit log missing cron send rows" above.

6. **`action` exact wins over `action_family`.** A request with both `?action=suppression_remove&action_family=retention` returns only `suppression_remove` rows. Intentional but easy to miss when copying URLs.

### Cron fired but card did not show toast (Phase 8AD)

`DigestCronHealthCard` should surface an auto-dismissing "Digest cron just ran." notice on every `venuerise:digest-cron-fired` event. If the lag minutes update but the toast doesn't appear:

1. **Confirm the listener is registered.** Open DevTools console:

   ```js
   window.dispatchEvent(new CustomEvent('venuerise:digest-cron-fired'))
   ```

   Should produce an immediate `Digest cron just ran.` notice AND a Network GET to `/api/admin/digest/cron-health`. If only the network fetch fires, the toast handler isn't wired — confirm the card is the Phase 8AD version (search for `CRON_FIRED_TOAST_MS`).

2. **Auto-dismiss timing.** The toast clears after ~4s (`CRON_FIRED_TOAST_MS`). If the operator looked away for 5s and missed it, that's expected. The Lag indicator + Last cron send timestamp persist.

3. **Multiple rapid events.** Each `digest-cron-fired` resets the dismiss timer — a burst of 5 events within 4s produces one continuous toast that clears 4s after the last event. Expected behavior.

4. **`status='suppressed'` cron send.** The dispatching layer (`RealtimeDigestSendsLayer`) fires `venuerise:digest-cron-fired` whenever a cron-tagged INSERT lands, regardless of status. A suppressed cron send still triggers the toast — that's correct (the cron DID just run; the recipient just happened to be suppressed).

5. **Browser background tab.** Supabase Realtime delivers to background tabs but `setState` updates may not paint until focus returns. Bring tab to focus and re-trigger.

### Share a digest audit investigation link (Phase 8AE)

Operator wants to send a teammate a link that opens the same chip + search they were looking at.

1. Open `/dashboard/settings/billing` → `DigestAuditLogCard`.
2. Click a family chip (e.g. "Suppression") and/or type a search term.
3. The URL updates via `router.replace` to include `?digest_audit_family=suppression&digest_audit_q=<term>` (cursor appears only after Load older).
4. Copy the URL from the address bar; paste to the teammate.
5. Teammate opens → URL params win over their localStorage → same chip + search restore.

Notes:
- `q` is URL-only. Operator who reloaded WITHOUT a URL-supplied `q` lands on an empty search (by design — typed terms don't usually deserve to follow you across reloads).
- `family` persists in `localStorage['venuerise:digest-audit-log:family:v1']` as a fallback for the no-URL case.
- Reset button (visible only when any filter is active) clears URL params + localStorage in one click.
- Cursor URL state is write-only at this layer — open a deep-linked URL with `?digest_audit_cursor=` and the first fetch ignores it (lands on page 1). Load older from there walks forward as normal.

### Digest audit metadata search is slow or missing rows (Phase 8AE)

Search returns nothing OR seems to time out. Triage:

1. **Confirm `metadata_text` column + index exist:**

   ```sql
   select column_name, generation_expression
   from information_schema.columns
   where table_schema = 'public'
     and table_name = 'digest_audit_events'
     and column_name = 'metadata_text';

   select indexname, indexdef
   from pg_indexes
   where schemaname = 'public'
     and tablename = 'digest_audit_events'
     and indexname = 'digest_audit_events_metadata_text_trgm_idx';
   ```

   The first returns one row with `generation_expression = COALESCE((metadata)::text, ''::text)`. The second returns one row using `gin (metadata_text gin_trgm_ops)`. Missing either = migration 018 didn't apply; re-run.

2. **Confirm pg_trgm is installed:**

   ```sql
   select extname, extversion from pg_extension where extname = 'pg_trgm';
   ```

   Empty result = run `create extension pg_trgm;`.

3. **Confirm the route is using the index.** The log line includes `qMode`. For terms ≥ 3 chars expect `qMode=metadata_indexed`; sub-3-char terms expect `qMode=scalar_short`. If a 5-char search is logging `scalar_short`, the deployed code is stale — re-deploy.

4. **EXPLAIN the query directly:**

   ```sql
   explain analyze
   select id from public.digest_audit_events
   where venue_id = '<uuid>'
     and metadata_text ilike '%retention_policy%'
   order by occurred_at desc limit 50;
   ```

   Expect `Bitmap Index Scan on digest_audit_events_metadata_text_trgm_idx`. A `Seq Scan` means either the index isn't being chosen (low row count → planner prefers seq) or the term is < 3 chars after escape.

5. **Search-escape ate the term.** `%`, `_`, `,`, `(`, `)` are stripped/escaped server-side (defangs ILIKE wildcards + `.or()` syntax). A search for `100%` matches the literal substring, not "anything".

### Preview send missing from audit log (Phase 8AE)

Operator clicked "Send sample" but no `digest_send_preview` row appears in `digest_audit_events`.

1. **Confirm env flag is set.** `DIGEST_AUDIT_LOG_CRON_SENDS=1` gates both preview AND cron audit writes (shared flag). Check the deploy env. Anything else (unset / `"0"` / `"true"`) leaves the writer off.

2. **Confirm the preview actually succeeded.** Audit row only fires after `sendEmail` returns delivered. Suppression / console-fallback / provider-failure branches return without auditing. Verify via:

   ```sql
   select * from public.outbound_messages
   where venue_id = '<uuid>'
     and related_table = 'tour_status_events'
     and metadata->>'tour_digest_send_kind' = 'preview'
   order by created_at desc limit 5;
   ```

   `status='delivered'` row = preview did succeed → audit should have fired.

3. **Helper failure (rare).** `recordDigestAuditEvent` is best-effort. Failures log `digest_audit_events.insert_failed` / `insert_threw` and Sentry-capture. Search recent logs by request id (returned in `X-Request-Id` on the preview response).

4. **SQL verification:**

   ```sql
   select *
   from public.digest_audit_events
   where action = 'digest_send_preview'
   order by occurred_at desc
   limit 20;
   ```

   Empty result + recent successful preview + flag set = file a bug.

### Preview family chip empty (Phase 8AE)

`DigestAuditLogCard` → click "Preview" chip → empty state "No digest audit events match these filters."

Same root causes as "Preview send missing from audit log" above. Most common: `DIGEST_AUDIT_LOG_CRON_SENDS` was never set to `'1'` on the deploy, so no preview audit rows have been written. Triage in this order:

1. Check env flag.
2. Confirm at least one preview send happened SINCE the flag was set (audit rows aren't backfilled — only new sends produce rows).
3. Check the SQL above directly.
4. If rows exist in SQL but the chip shows empty, the deployed `/api/admin/digest/audit-events` is missing the `?action_family=preview` mapping — re-deploy.

### Share a digest send investigation link (Phase 8AF)

`DigestAuditFeed` now syncs every filter to the URL, mirroring Phase 8AE's `DigestAuditLogCard`.

1. Open `/dashboard/settings/billing`. Click a chip (Cron/Preview/Manual), type a search term, optionally toggle Show archived, optionally click a recipient in the summary.
2. URL updates with the relevant params:
   ```
   ?digest_send_kind=cron&digest_send_q=delivered&digest_send_archived=1
   ```
3. Copy the URL; paste to a teammate.
4. Teammate opens → URL wins over their localStorage → same chips + search + recipient + archived restore.

Notes:
- `q` is URL-only. A teammate reloading without the URL `q` lands on an empty search.
- `recipient` and `kind` and `archived` persist in localStorage as a fallback.
- Reset clears every URL param + every localStorage key (including the Phase 8AC legacy archived key).
- After Load older, the URL gains `digest_send_cursor=<iso>`. Reload restores the page boundary; an amber "Viewing an earlier digest send page." banner + Jump to latest button surface.

### Open a digest audit event drawer (Phase 8AF)

Operator wants to inspect the full payload of an audit row without dropping to SQL.

1. Open `/dashboard/settings/billing`. Scroll to `DigestAuditLogCard`.
2. Click any row → slide-in drawer opens.
3. Drawer fields:
   - Event ID + Copy audit ID
   - Venue + actor + target IDs
   - Target email (masked)
   - Reason
   - Pretty-printed metadata JSON + Copy metadata JSON
   - "View related digest send" button (only when `metadata.outbound_message_id` is present)
4. Close the drawer to return — your filters and pagination position are preserved.

Drawer doesn't fetch independently — it renders whatever the audit row already contained. If the displayed `target_email_masked` is `—`, the row had no target (typical for cron/retention summary rows).

### Audit drawer cannot find related send (Phase 8AF)

"View related digest send" doesn't appear OR it appears but the sends feed shows zero matching rows.

1. **No `outbound_message_id` in metadata.** Suppression remove rows and retention summary rows don't carry an outbound message ID — there's no related outbound row to link to. Expected behavior; the button only renders when the field is present.

2. **`outbound_message_id` is set but `DigestAuditFeed` shows nothing.** The link uses `?digest_send_q=<id>` which the sends feed searches against `status`, `provider`, `error`, `to_address`, `metadata->>tour_digest_send_kind`. The outbound row's `id` column is NOT one of the searched fields — the match relies on the id ALSO appearing in one of the searched fields (rare). Verify directly:
   ```sql
   select id, status, to_address, metadata
   from public.outbound_messages
   where id = '<outbound id>';
   ```
   If the row exists, the link is conceptually correct — the operator can find it by changing the audit drawer's "View related" to use the recipient_user_id from the metadata instead. Future phase to consider: extend `/api/admin/digest/sends?q=` to match against `id` too.

3. **Outbound row was archived.** If `metadata.digest_archived = 'true'`, the default sends feed view (without Show archived) hides the row. Toggle Show archived on and retry.

4. **Wrong venue context.** Drawer opens on a cross-tenant audit row that the sends feed can't see (different venue). Confirm the audit row's `venue_id` matches the operator's current admin venue.

### Cron audit duplicate row blocked (Phase 8AF)

If migration 019 is applied, the cron's audit writer may log:

```
op=digest_audit_events
event=digest_audit_events.duplicate_skipped
action=digest_send_cron
venueId=<uuid>
targetUserId=<uuid>
```

This is non-fatal — the partial unique index caught what would have been a duplicate `digest_send_cron` audit row. The actual digest email still delivered (the `outbound_messages` send_kind probe prevented the duplicate delivery upstream). Triage steps:

1. **Confirm the underlying outbound row is correct:**
   ```sql
   select id, status, created_at, metadata
   from public.outbound_messages
   where venue_id = '<uuid>'
     and metadata->>'tour_digest_recipient_user_id' = '<uuid>'
     and metadata->>'tour_digest_send_kind' = 'cron'
     and created_at::date = current_date
   order by created_at desc limit 3;
   ```
   Should show exactly one row per recipient per day. Multiple = the Phase 8W idempotency probe regression — re-deploy the cron.

2. **Confirm the existing audit row exists:**
   ```sql
   select id, occurred_at, metadata
   from public.digest_audit_events
   where venue_id = '<uuid>'
     and target_user_id = '<uuid>'
     and action = 'digest_send_cron'
     and (occurred_at at time zone 'utc')::date = current_date
   order by occurred_at desc limit 3;
   ```
   Exactly one row = healthy. Two or more = the unique index isn't catching duplicates (deployment is missing migration 019 OR the index was dropped). Re-apply.

3. **Verify the index exists:**
   ```sql
   select indexname, indexdef
   from pg_indexes
   where schemaname = 'public'
     and tablename = 'digest_audit_events'
     and indexname = 'digest_audit_events_cron_send_daily_unique_idx';
   ```
   Empty = re-apply migration 019.

4. **Other actions hitting 23505.** Only `digest_send_cron` is covered by the partial index. A 23505 on `suppression_remove*` / `digest_retention_archive` / `digest_send_preview` would indicate a stale migration adding broader uniqueness — those are not in any in-tree migration. Check the schema directly.

### Backfilling legacy tours (Phase 8N)

A venue that's been on VenueRise since before Phase 8M will have tours with no audit events at all. The Audit drawer renders an empty state for those, which is technically correct but unhelpful. To seed a synthetic baseline:

1. Set `TOUR_STATUS_BACKFILL=1` in the deploy environment.
2. Inngest dashboard → find function `seed-tour-status-events` → send event `admin/tour-status-events.backfill`.
3. The job:
   - Pulls tours with `updated_at` in the last 90 days, batch of 500.
   - Skips any with an existing event row (idempotent).
   - Writes one row per tour: `actor_kind='system'`, `actor_id='backfill-8N'`, `action='legacy_status_snapshot'`, metadata includes `{ backfilled: true, source: 'phase_8n', tour_updated_at }`.
4. Run again as needed to cover the rest. With the env flag unset OR no manual event sent, the job is a no-op.

Verify after a backfill:

```sql
select count(*) as backfilled_rows
from public.tour_status_events
where actor_kind = 'system' and actor_id = 'backfill-8N';
```
