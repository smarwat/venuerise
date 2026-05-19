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
