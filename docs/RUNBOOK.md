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

---

## Product thesis: AI Revenue OS (Phase 8AP)

VenueRise is positioned as an **AI Revenue Operating System** for
wedding venues — not a CRM, not an AI chatbot, not a marketing
automation tool. See `docs/PRODUCT-THESIS.md` for the full thesis and
`docs/AGENTIC-WORKFLOW-MAP.md` for the seven cooperating agents the
product is organized around.

### Operational implication

When evaluating future phases or feature requests, the operator should
ask:

1. Does this phase move one of the five core promises (more booked
   tours, faster lead response, fewer leads slipping, clearer operator
   accountability, on-brand AI follow-up)?
2. Does it strengthen one of the seven agents in the workflow map?
3. Does it surface revenue leakage instead of just status?

If the answer to all three is no, the phase is probably building a
generic CRM feature and should be reframed before any code is
written.

### Live surfaces that carry the thesis today

| Surface                                  | What it protects                  |
|------------------------------------------|-----------------------------------|
| `RevenueLeakageBrief` on `/dashboard`    | Visibility of revenue at risk     |
| `LeadDetailDrawer` multi-variant + stale | Speed + brand voice               |
| `CommandPalette` message search          | Find the lead moment fast         |
| `AIDraftAuditCard` + `VariantReplayDrawer` | Operator accountability         |
| Operator activity digest (Phase 8R+)     | Owner visibility                  |
| Tour status events + audit drawers       | Tour conversion + recovery        |

Future operator-facing surfaces that don't map to a row above are a
warning sign.

### Optional alter publication for the AI draft audit realtime layer

The Phase 8AO `RealtimeAIDraftAuditLayer` subscribes to
`public.ai_actions` inserts. If your environment doesn't have
`ai_actions` in the `supabase_realtime` publication, the layer is a
silent no-op and the AIDraftAuditCard still works via manual Refresh.

To enable the live "New draft activity recorded" banner:

```sql
alter publication supabase_realtime add table public.ai_actions;
```

Run once per environment via the Supabase SQL editor; no migration
file is required.

---

## Revenue OS settings and leakage scoring (Phase 8AQ)

The Revenue Leakage Watch on `/dashboard`, the leads-board `?leakage=`
filter, and the LeadDetailDrawer Speed-to-Lead chip all read from a
single per-venue settings block:

```sql
-- Inspect current settings
select id, name, metadata -> 'revenue_os' as revenue_os
  from public.venues
 where id = '<venue uuid>';
```

Storage shape:

```json
{
  "revenue_os": {
    "first_reply_sla_minutes": 60,
    "high_fit_threshold": 80,
    "stale_high_fit_hours": 24,
    "cold_lead_days": 14
  }
}
```

### Reset to defaults

The admin "Revenue OS thresholds" card on `/dashboard/settings/billing`
has a `Reset to defaults` button that writes the
`DEFAULT_REVENUE_OS_SETTINGS` values back. As a manual fallback:

```sql
update public.venues
   set metadata = metadata || jsonb_build_object(
     'revenue_os',
     jsonb_build_object(
       'first_reply_sla_minutes', 60,
       'high_fit_threshold',      80,
       'stale_high_fit_hours',    24,
       'cold_lead_days',          14
     )
   )
 where id = '<venue uuid>';
```

### What each threshold means

| Setting                 | Default | Drives                                      |
|-------------------------|---------|---------------------------------------------|
| First reply SLA minutes | 60      | "Slow first reply" leakage + Speed-to-Lead  |
| High-fit threshold      | 80      | "High-fit idle" + per-lead chip eligibility |
| Stale high-fit hours    | 24      | "High-fit idle" detection window            |
| Cold lead days          | 14      | "Cold leads to recover" recovery window     |

Each value is **clamped** server-side in `lib/revenue-os/settings.ts`:

- First reply SLA: 5–240 minutes
- High-fit threshold: 50–100
- Stale high-fit window: 1–168 hours
- Cold lead window: 3–60 days

A hand-crafted curl with an out-of-range value will be silently
clamped to the boundary; the dashboard never trusts arbitrary jsonb.

### Why the counts may be approximate

- The Overview brief uses a 500-lead in-flight slice + recent message
  activity in batch. A venue with > 500 active leads sees the most
  recent 500 only (very rare).
- The leads-board filter is a client-side approximation backed by an
  on-demand fetch for tours / inbound messages depending on which
  filter is active. When that fetch hasn't completed yet the filter
  shows the candidate stage slice rather than an empty board.
- The Speed-to-Lead chip is best-effort — if either the venue
  settings probe or the earliest-outbound message probe fails, the
  chip silently stays hidden rather than rendering a misleading score.

None of these surfaces are billing-grade truth. They are operator
prompts pointing at where revenue is at risk; the audit feeds
(`AIDraftAuditCard`, `DigestAuditLogCard`, tour audit drawer) are
where the precise per-action history lives.

---

## Speed-to-Lead roll-up + cold-lead baseline (Phase 8AR)

### Inspecting the underlying data

The Speed-to-Lead roll-up on `/dashboard/settings/billing` is
**derived** every render — there's no cron, no cache, no
`speed_to_lead_score` column. To audit it, look at the same two
tables the card reads from:

```sql
-- Per-lead first outbound timestamp (last 7 days)
select
  l.id,
  l.name,
  l.created_at,
  min(case when m.role in ('ai', 'human') then m.created_at end) as first_outbound_at
from public.leads l
left join public.messages m on m.lead_id = l.id
where l.venue_id = '<venue uuid>'
  and l.created_at >= now() - interval '7 days'
group by l.id, l.name, l.created_at
order by l.created_at desc;
```

### Why pending leads are excluded from SLA met rate

`metRate` divides by `(met + missed)`. A pending lead hasn't crossed
the SLA line yet — it could still hit, it could still miss. Counting
it in the denominator would either (a) inflate the met rate every
time a fresh lead came in, or (b) tank it the moment a lead aged
past SLA without a reply. Neither matches operator intuition. The
displayed "Overdue replies" tile carries the pending-overdue count
separately so the operator still sees the urgency.

### Cold-lead baseline fix

Some intake paths create a `leads` row without a corresponding
`messages.role='lead'` row (e.g. a widget intake that serializes the
form into `lead.notes`). Before Phase 8AR, those leads looked cold
the moment they aged past `cold_lead_days`.

The helper now uses `lead.created_at` as the baseline when no inbound
message exists. To verify the fix is healthy for a venue:

```sql
-- Leads with no inbound message, grouped by age
select
  case
    when l.created_at > now() - interval '14 days' then '< 14 days'
    when l.created_at > now() - interval '30 days' then '14-30 days'
    else '> 30 days'
  end as bucket,
  count(*)
from public.leads l
where l.venue_id = '<venue uuid>'
  and l.stage not in ('booked', 'lost')
  and not exists (
    select 1 from public.messages m
     where m.lead_id = l.id and m.role = 'lead'
  )
group by bucket
order by bucket;
```

Anything in the `> cold_lead_days` bucket WILL show up on the
Revenue Leakage Watch's cold-lead tile — that's the intent. What's
fixed is the case where a 3-day-old lead with no inbound was
incorrectly counted before.

---

## Follow-Up Recovery surfaces (Phase 8AS)

Phase 8AS makes stalled leads visible across three surfaces, all
backed by the same pure helper at `lib/revenue-os/recovery.ts`:

| Surface                                                    | What it shows                                           |
|------------------------------------------------------------|---------------------------------------------------------|
| `RecoveryQueueCard` on `/dashboard`                        | Top 5 stalled high-value leads + suggested action       |
| LeadDetailDrawer "Why this lead is slipping" panel         | Active recovery reasons + helper text + suggested CTA   |
| `RecoveryRollupCard` on `/dashboard/settings/billing`      | Stalled count + high-fit stalled + qualified-no-tour    |
| `KanbanBoard` `?leakage=follow_up_recovery` filter         | Pipeline filtered to the recovery queue                 |

### What counts as "stalled"

A lead is on the recovery queue when it triggers at least one of:

| Reason                  | Trigger                                                                                    |
|-------------------------|--------------------------------------------------------------------------------------------|
| `cold_lead`             | In-flight (not new_inquiry/booked/lost), baseline older than `cold_lead_days`              |
| `high_fit_idle`         | Lead score ≥ `high_fit_threshold`, no row update in `stale_high_fit_hours`                 |
| `qualified_no_tour`     | Stage = `qualified` with no `tours` row                                                    |
| `tour_pending_confirm`  | Has a future tour with `status='scheduled'`                                                |
| `negotiation_stalled`   | Stage = `negotiation`, no row update in 2× `stale_high_fit_hours`                          |

`cold_lead` uses the Phase 8AR baseline fix (`last inbound` if any,
else `lead.created_at`).

### Suggested actions are static, not generated

Each reason maps to a static suggested action (e.g. `cold_lead →
soft_check_in`). The action carries a long-form `instruction` string
that the operator can pre-fill into the regenerate prompt via the
drawer's "Use suggestion in draft" CTA. **No AI generation happens
when the suggestion is clicked.** The operator still has to click
Regenerate (which calls `/api/ai/draft`) and Approve & send (which
calls `/api/conversations/[id]/messages`).

### Inspecting the queue with SQL

```sql
-- Stalled candidate leads for a venue (rough — the helper applies
-- the per-venue settings + reason logic on top of this set).
select
  l.id,
  l.name,
  l.stage,
  l.lead_score,
  l.created_at,
  l.updated_at,
  max(case when m.role = 'lead' then m.created_at end)   as last_inbound,
  count(t.id) filter (where t.status = 'scheduled')      as pending_tours,
  count(t.id)                                            as total_tours
from public.leads l
left join public.messages m on m.lead_id = l.id
left join public.tours    t on t.lead_id = l.id
where l.venue_id = '<venue uuid>'
  and l.stage not in ('booked', 'lost')
group by l.id
order by l.lead_score desc, l.updated_at asc
limit 25;
```

The helper sorts by composite score (`lead_score × 10 + reasons × 20
+ min(60, daysSinceActivity)`), so very-old low-score leads never
out-rank a hot stalled lead.

---

## Tour Booking Agent surfaces (Phase 8AT)

Phase 8AT makes the qualified-to-booked transition visible across
three surfaces, all backed by `lib/revenue-os/tour-booking.ts`:

| Surface                                                | What it shows                                            |
|--------------------------------------------------------|----------------------------------------------------------|
| `TourConfirmationQueueCard` on `/dashboard`            | Top 5 scheduled-but-unconfirmed tours                    |
| LeadDetailDrawer "Tour Booking Agent" panel            | Per-lead tour signal + Schedule + Use-suggestion CTAs    |
| `TourConversionRollupCard` on `/dashboard/settings/billing` | Qualified → Scheduled → Confirmed counts (30d)      |
| KanbanBoard `?leakage=tour_booking` filter             | Pipeline filtered to leads with any tour signal          |

### The five Tour Booking signals

| Signal                          | Trigger                                                       |
|---------------------------------|---------------------------------------------------------------|
| `tour_today`                    | Scheduled or confirmed tour with today's UTC date             |
| `tour_scheduled_unconfirmed`    | Future tour with `status='scheduled'`                         |
| `qualified_no_tour`             | Lead at stage `qualified` with no `tours` row                 |
| `tour_completed_no_next_step`   | Completed tour + lead still in `tour_completed`/`negotiation` |
| `tour_no_show_recovery`         | Tour with `status='no_show'` + lead still in-flight           |

Each signal maps to a static suggested action (catalog lives in
`tour-booking.ts`). The action's `instruction` field is the long-form
string the operator can pre-fill into the regenerate prompt via the
drawer's "Use suggestion in draft" CTA.

### Conversion roll-up math

`TourConversionRollupCard` reads:

```sql
-- Qualified-or-later leads in the last 30 days (denominator base)
select count(*)
  from public.leads
 where venue_id = '<venue uuid>'
   and stage in ('qualified', 'tour_scheduled', 'tour_completed',
                 'negotiation', 'booked')
   and created_at >= now() - interval '30 days';

-- Tour rows that crossed the scheduled line for those leads
select count(*), status
  from public.tours
 where venue_id = '<venue uuid>'
   and lead_id in (<qualified ids>)
   and status in ('scheduled', 'confirmed', 'completed', 'no_show')
 group by status;
```

We count tour ROWS (not distinct leads) so a venue that re-schedules
after a cancel still gets credit for the re-attempt. Including
`booked` in the "qualified-or-later" denominator prevents fast
converters from being penalized — a venue with great conversion
shouldn't see a lower scheduled-rate just because their leads zipped
past the qualified stage between snapshots.

### Why no autonomous sends

The Tour Booking Agent is operator-visible scoring, not autonomous
behavior. Surfacing a "Send confirm" suggestion AUTOMATICALLY firing
a `/api/conversations/[id]/messages` POST would have to handle
operator-not-online edge cases, lead-just-replied races, brand-voice
review — none of which the current system mediates. The agent stays
in the "make it impossible to miss" lane until those guardrails are
ready.

---

## Revenue OS digest reframe (Phase 8AU)

The Phase 8R operator activity digest was a generic "tour status
events" summary. Phase 8AU keeps the same cadence + delivery +
audit infrastructure but reframes the BODY around the Revenue OS
agents.

### What changed

- Subject becomes `Your VenueRise Revenue OS summary` (cron) /
  `Your weekly VenueRise Revenue OS summary` when the recipient is
  on weekly cadence — the text uses the cadence sentence already
  present in the footer.
- HTML + plaintext both lead with: leakage snapshot →
  speed-to-lead → follow-up recovery → tour booking → CTAs →
  operator activity log (demoted to a quieter container).
- Cron + preview + manual all call `fetchRevenueOsDigestSummary`
  per venue ONCE; the helper composes the four pure scoring
  helpers + returns the same shape.
- `lib/revenue-os/digest-summary.ts` is pure (no Supabase) so the
  composer is unit-testable in isolation.

### What didn't change

- Cadence (daily / weekly / off) per recipient
- `send_kind` discriminator (`cron`/`preview`/`manual`)
- Idempotency probe (per-recipient + per-day, filtered on
  `send_kind='cron'`)
- Suppression handling
- Audit feed compatibility — outbound rows still tagged the same
  way; `DigestAuditFeed` + `DigestAuditLogCard` keep working
- Unsubscribe / resubscribe token URL helpers
- Per-venue settings sourced from `venues.metadata.revenue_os`
  (the same `parseRevenueOsSettings` the dashboard surfaces use)

### Fallback path

If the per-venue Revenue OS probe fails (DB hiccup, missing
metadata, etc.) the helper returns `null`. The body builders
detect the missing summary and fall back to the legacy tour-
status-events-only template. Logged as
`jobs.operator_activity_digest.revenue_os_fetch_failed`. The
digest still goes out; no recipient loses their email because of
a transient probe failure.

### Required env / setup

No new env vars. No new migrations. The reframe rides on the
existing `OPERATOR_DIGEST_ENABLED=1` gate + the Phase 8S
`DIGEST_UNSUBSCRIBE_SECRET` (for the footer links). The dashboard's
Revenue OS settings card (Phase 8AQ) tunes the thresholds that
flow into the digest.

### Smoke-testing locally

1. Set `OPERATOR_DIGEST_ENABLED=1` (and ideally
   `DIGEST_UNSUBSCRIBE_SECRET=<any 32+ char string>`).
2. From `/dashboard/settings/billing`, click **Send sample Revenue
   OS digest**.
3. Inspect the email: the subject should mention "Revenue OS",
   the body should have the four sections + the demoted activity
   log + the three CTAs at the bottom.
4. Inspect the outbound row in Supabase
   (`outbound_messages` filtered by venue + today):
   `metadata.tour_digest_send_kind` should be `'preview'`.

---

## Brand Voice confidence + escalation (Phase 8AV)

### What's stored

Every successful `/api/ai/draft` call writes a `variant_confidences:
number[]` (and a denorm `min_confidence: number`) into
`ai_actions.metadata`. Read via:

```sql
select
  id,
  created_at,
  metadata -> 'variant_confidences' as scores,
  metadata ->> 'min_confidence'     as min_score,
  metadata ->> 'instruction'        as instruction
from public.ai_actions
where venue_id = '<venue uuid>'
  and agent  = 'venuerise'
  and action = 'draft_regenerate'
order by created_at desc
limit 25;
```

### Settings

Per-venue under `venues.metadata.revenue_os`:

```json
{
  "brand_voice_confidence_floor": 70,
  "brand_voice_escalation_mode": "warn"
}
```

Floor is 0..100 (default 70); mode is `off | warn | block`
(default `warn`). Read/write goes through the existing
`/api/admin/revenue-os/settings` route + the RevenueOsSettingsCard
on `/dashboard/settings/billing`.

### Reset to defaults

The settings card's `Reset to defaults` button writes the
DEFAULT_REVENUE_OS_SETTINGS shape (which now includes the two new
fields). SQL fallback:

```sql
update public.venues
   set metadata = metadata || jsonb_build_object(
     'revenue_os',
     coalesce(metadata -> 'revenue_os', '{}'::jsonb) || jsonb_build_object(
       'brand_voice_confidence_floor', 70,
       'brand_voice_escalation_mode',  'warn'
     )
   )
 where id = '<venue uuid>';
```

### Why no autonomous send

Brand Voice escalation is a SAFETY layer; flipping the gate to
`block` doesn't authorize the AI to send messages on its own. It
just blocks Approve & send until the operator regenerates, edits,
or picks a different variant. Same operator-stays-in-control
posture as every other Phase 8 surface.

## Brand Voice calibration telemetry (Phase 8AW)

### What's stored

Phase 8AW extends the same `ai_actions.metadata` block with the
raw model self-rating, the heuristic score, the adjustment delta
versus the final shown, a `confidence_source` tag, and the
operator outcome that closed out the row. The 8AV
`variant_confidences` array is preserved (it now carries FINAL
scores) so older readers keep working.

```sql
select
  id,
  created_at,
  metadata -> 'variant_confidences'             as final_scores,
  metadata -> 'model_variant_confidences'       as model_scores,
  metadata -> 'heuristic_variant_confidences'   as heuristic_scores,
  metadata -> 'confidence_adjustment_deltas'    as deltas,
  metadata ->> 'confidence_source'              as source,
  metadata ->> 'operator_outcome'               as outcome,
  metadata ->> 'edit_distance_bucket'           as edits,
  metadata ->> 'selected_variant_was_low_confidence' as below_floor_sent
from public.ai_actions
where venue_id = '<venue uuid>'
  and agent = 'venuerise'
  and action = 'draft_regenerate'
order by created_at desc
limit 25;
```

### Troubleshooting

1. **"Panel is stuck on empty state."**
   - The page slice returned `total: 0`. Either the venue has no
     Phase 8AV+ draft_regenerate rows yet, or every row in the
     window pre-dates 8AV (in which case `variant_confidences`
     wasn't persisted). Trigger a regenerate from the lead drawer
     and refresh — the panel rebinds on the next realtime fire.

2. **"Overconfidence signal says High but operators look happy."**
   - Check `metadata->'confidence_adjustment_deltas'` — a single
     batch with deeply negative deltas (e.g. all `-30`) can tip
     the heuristic. The signal is page-scoped, not lifetime; load
     older pages to confirm it isn't a transient spike.
   - If it's persistent, the model is consistently over-rating
     itself relative to the heuristic. Consider lowering
     `brandVoiceConfidenceFloor` if the heuristic is being too
     strict, OR tightening the prompt to nudge the model's self-
     rating down.

3. **"Operator sent a draft as-is but the row stayed unknown."**
   - The outcome write is best-effort and skipped silently when
     the source `ai_actions` row is missing or cross-tenant. Look
     for `conversations.messages.outcome_mark_failed` in logs for
     the request id. Common cause: the operator approved a draft
     from a Phase 8AL-era flow that pre-dates the ai_action_id
     metadata stamp.

4. **"Venue context signal flips to needs_more_context after one
     draft."**
   - The scan triggers when ≥25% of rows in the loaded page
     mention pricing / availability / policy / capacity. With
     `total: 1`, a single matching draft makes that 100%. The
     signal stabilizes as more rows land — wait for `total ≥ 4`
     before reading it as a real instruction to add KB content.

5. **"AIDraftAuditCard detail line shows Model X with no
     Heuristic."**
   - Pre-8AW rows render the line only when SOME 8AW field is
     present. If you see Model without Heuristic (or vice versa),
     the metadata was hand-written or a partial backfill — neither
     happens in normal flow. Confirm with the SQL above; if a row
     is missing both arrays, treat it as a Phase 8AV row that
     should stay quiet in the UI.

### Why no autonomous send (still)

Phase 8AW is telemetry. The Phase 8AV gate still requires a human
to click Approve & send. Phase 8AX is the autonomy gate, and it
won't ship until the calibration panel shows steady-state low
overconfidence + a low edit-before-send rate.

## Safe Autopilot Guardrails (Phase 8AX)

### What's stored

Two new fields on `ai_actions.metadata`, parallel to
`variants_offered`. The 8AV/8AW keys are unchanged.

```sql
select
  id,
  created_at,
  metadata -> 'autopilot_decisions'  as decisions,
  metadata -> 'variant_risk_flags'   as risk_flags
from public.ai_actions
where venue_id = '<venue uuid>'
  and agent = 'venuerise'
  and action = 'draft_regenerate'
order by created_at desc
limit 25;
```

Each `autopilot_decisions[i]` is `{mode, label, helper, reasons,
confidence}`; each `variant_risk_flags[i]` is `{has_pricing_
question, has_policy_question, has_availability_claim}`.

### Decision rules (summary)

The full rules live in `lib/revenue-os/autopilot-guardrails.ts`.
Operational shortcuts:

- **Eligible** requires `finalConfidence >= 85`. Anything less
  drops at least to review.
- **Blocked** fires on ANY hard signal: pricing/policy/
  availability keyword hit, `selectedVariantWasLowConfidence`,
  `finalConfidence < 65`, `heuristicConfidence < 55`, or
  `needs_more_context` context signal combined with
  `finalConfidence < 80`.
- Everything between is **review_required**. Missing
  `finalConfidence` also defaults to review (we never silently
  promote unscored drafts to eligible).

### Troubleshooting

1. **"Every draft renders Review required."**
   - Most likely: the lead's `lead_score` is unset (`null`) and
     the conservative heuristic floors are punishing the score.
     Check `select lead_score from public.leads where id = '<id>';`.
   - Less likely but possible: the model is consistently returning
     CONFIDENCE lines under 85. Look at the Brand Voice
     Calibration panel — if average confidence sits in the 70s,
     review is the correct posture and the prompt is doing its
     job.

2. **"Decision says Blocked but I don't see why."**
   - Hover the pill — the tooltip lists the reason codes that
     fired (`pricing_risk`, `policy_risk`, etc.).
   - SQL deep dive:
     ```sql
     select metadata->'autopilot_decisions'->0->'reasons',
            metadata->'variant_risk_flags'->0
       from public.ai_actions
      where id = '<ai_action_id>';
     ```
   - If `pricing_risk` fires on a draft that doesn't mention
     price, the keyword scan probably caught `package` or `fee`
     in a non-price context. That's intentional over-flagging —
     better the operator reviews a false positive than auto-
     sends a real pricing claim.

3. **"Approve & send is gone."**
   - It isn't. The 8AX classifier never adds or removes the
     button. If it disappeared, check the Phase 8AV brand voice
     escalation gate — `block` mode hard-disables Approve when
     confidence falls below `brandVoiceConfidenceFloor`. Confirm
     with the chip color (red Low confidence = 8AV block, not
     8AX).

4. **"Autopilot readiness card is empty."**
   - The card hides when the page slice has zero scored rows.
     Refresh after a regenerate; if it's still empty, the venue
     has no 8AX+ rows yet (older drafts pre-date the classifier).

5. **"I want to confirm autonomy is still off."**
   - `curl /api/health | jq .checks.autonomous_sending_still_disabled`
     must return `"mounted"`. If it doesn't, autonomy was added
     by a later phase and the health flag should have been removed
     — investigate the diff.

### Why no autonomous send (yet)

Phase 8AX measures readiness. It does not enable sending. The
next phase is **8AY — Autopilot Simulation Mode**: log "would
have sent" decisions against real traffic without emitting
anything, so we can compare the classifier's recommendation
against what the operator actually did. Only after that shows
the classifier is calibrated will Phase 8AZ+ consider letting
the system act on its own — and even then, only behind explicit
per-venue opt-in.

## Autopilot Simulation Mode (Phase 8AY)

### What's emitted

No new persistence in 8AY — the simulation is derived from the
existing 8AV/8AW/8AX fields on `ai_actions.metadata`:

```sql
select
  id,
  created_at,
  metadata -> 'autopilot_decisions'   as decisions,
  metadata ->> 'operator_outcome'      as outcome,
  metadata ->> 'operator_outcome_at'   as outcome_at,
  metadata ->> 'edit_distance_bucket'  as edit_bucket
from public.ai_actions
where venue_id = '<venue uuid>'
  and agent = 'venuerise'
  and action = 'draft_regenerate'
  and created_at >= now() - interval '30 days'
order by created_at desc
limit 200;
```

The simulation helper at `lib/revenue-os/autopilot-simulation.ts`
projects these into `would_send` / `would_require_review` /
`would_block` per row, classifies the operator's response, and
rolls up to a `not_ready` / `watch` / `promising` readiness
signal.

### Endpoints

- `GET /api/admin/ai/autopilot-simulation?venue_id=…&days=…` —
  dedicated simulation roll-up. Default window 30 days, range
  1–90. Returns `{venue_id, window_days, summary, buckets,
  recent_rows}`. Hard ceiling of 1000 rows per window.
- `GET /api/admin/ai/draft-audit` — also emits an
  `autopilot_simulation_summary` block over the loaded page
  slice (typically 25 rows), plus per-row simulation fields and
  CSV columns.

### Readiness rules (summary)

Computed in `computeAutopilotSimulationSummary`. Hard floors:

- `promising` requires `total_scored >= 20` AND
  `eligible_sent_as_is / would_send >= 0.8` AND
  `blocked_sent_as_is / would_block <= 0.1`.
- `watch` requires `total_scored >= 10` AND
  `operator_less_conservative / total_scored < 0.2`.
- Otherwise `not_ready`.

`promising` is NOT permission to enable autonomous sending. It's
the precondition for Phase 8AZ to start a structured review of
disagreements.

### Troubleshooting

1. **"Panel says No simulation data yet but I just regenerated."**
   - The panel only counts rows where BOTH the autopilot mode
     AND an operator outcome exist. A fresh regenerate without
     a follow-up Approve/Reject/Regenerate stays in `unknown`.
     Send the draft (or regenerate it) and refresh — the panel
     will fire on the next `venuerise:ai-draft-audit-fired`
     event.

2. **"Readiness is stuck on `not_ready` even though numbers look good."**
   - Check the row-count gate. `promising` needs ≥ 20 scored
     rows; `watch` needs ≥ 10. A venue with 8 perfectly-aligned
     drafts will still surface as `not_ready` until volume
     catches up. This is intentional — small samples don't
     justify autonomy.

3. **"Operator-less-conservative count is non-zero — is that dangerous?"**
   - Yes, but it's the exact signal we want. Each
     operator_less_conservative row is a case where autopilot
     would have blocked or held a draft, but the human sent it
     as-is anyway. Open the row in the lead drawer via the
     recent-mismatches list. Two interpretations:
     - The guardrail was too strict — relax it (a future phase
       will let you tune per-rule thresholds).
     - The operator was wrong to send as-is — that's a
       coaching moment, not a guardrail bug.

4. **"Estimated time saved is zero but Would-send is non-zero."**
   - Time-saved only counts `eligible + sent_as_is` rows. If
     operators are editing every eligible draft before sending,
     time-saved stays at zero. Check the Eligible bucket — if
     `sent_after_edit` dominates `sent_as_is`, the autopilot
     would have fired but the human wasn't ready to trust it.

5. **"Bucket counts don't match the summary tile counts."**
   - The four tiles count by SIMULATION MODE
     (`would_send` / `would_require_review` / `would_block`).
     The bucket section counts by AUTOPILOT MODE
     (`eligible` / `review_required` / `blocked`). Those are
     1:1 today, so the numbers should match. If they DON'T
     match, the simulation helper's `simulationModeFromAutopilotMode`
     mapping has drifted — confirm with
     `select metadata->'autopilot_decisions'->0->>'mode'
        from public.ai_actions where id = '<row>';`
     against what the panel renders.

6. **"I want to confirm autonomy is still off."**
   - `curl /api/health | jq '.checks.autonomous_sending_still_disabled'`
     must return `"mounted"`. The 8AY phase did NOT touch this
     flag — it's still the 8AX assertion.

### Why no autonomous send (still)

8AY is the third layer of observation (gate → telemetry →
guardrails → SIMULATION). 8AZ is the fourth: a queue of every
disagreement between the system and the operator, with
operator-reviewed labels. Only after both 8AY and 8AZ show
sustained `promising` readiness + low false-positive review
volume should autopilot graduate to opt-in autonomy — and even
then, only per-venue, gated by an explicit toggle the operator
has to flip.

## Autopilot Shadow Evaluation + Review Queue (Phase 8AZ)

### What's stored

A new table `public.ai_action_reviews` (migration 024). One row
per labeled disagreement, keyed unique on `ai_action_id`. Schema:

```sql
select
  id,
  venue_id,
  ai_action_id,
  reviewer_user_id,
  review_state,
  note,
  reviewed_at
from public.ai_action_reviews
where venue_id = '<venue uuid>'
order by reviewed_at desc
limit 25;
```

RLS allows `owner`/`admin` venue roles to SELECT. No
INSERT/UPDATE/DELETE policies — writes go through the service-
role POST route after explicit `requireAdmin` +
`requireVenueRole(ADMIN_ROLES)` checks.

### Endpoints

- `GET /api/admin/ai/autopilot-reviews` — disagreement queue.
  Filters: `state` (`needs_review`, `confirmed_*`, `deferred`,
  `all`), `alignment` (`operator_more_conservative`,
  `operator_less_conservative`, `all`), `occurred_before`
  (cursor), `limit` (1-100, default 25). Hard scan ceiling
  1000 rows.
- `POST /api/admin/ai/autopilot-reviews/[aiActionId]` —
  upserts a review row. Body:
  `{review_state: 'confirmed_guardrail_too_strict' |
  'confirmed_guardrail_correct' | 'confirmed_operator_error' |
  'deferred', note?: string<=500}`. Returns
  `{success, ai_action_id, review_state, reviewed_at}`.
  `needs_review` is NOT a writable state.

### Review state semantics

- `needs_review` — pending operator verdict. Implicit when no
  row exists in `ai_action_reviews`.
- `confirmed_guardrail_too_strict` — operator was right; the
  autopilot rule was over-conservative.
- `confirmed_guardrail_correct` — autopilot was right to
  block/review; the operator's send was the mistake (or the
  edit was real extra work).
- `confirmed_operator_error` — operator overrode a guardrail
  block in a way that should be coached, not replicated.
- `deferred` — operator parked the row for later.

### Critical safety guarantees

These guarantees are enforced in the codebase, not just the
docs:

1. **Labels do NOT auto-tune guardrails.** A row labeled
   `confirmed_guardrail_too_strict` does not weaken any rule.
   Search the codebase for `confirmed_guardrail_too_strict` —
   it appears only in storage, UI, and aggregation paths, never
   in any guardrail evaluation path.
2. **Labels do NOT block operators.** A row labeled
   `confirmed_operator_error` does not change what the operator
   can send. There is no follow-up flag on the operator's user
   record.
3. **No autonomous sending was added.** The
   `autonomous_sending_still_disabled` health flag stays
   `mounted`. The 8AZ phase touched zero send paths.

### Troubleshooting

1. **"Operator clicks a label but the row doesn't update."**
   - Check the inline error under the row buttons — the POST
     route may have 4xx'd (validation, rate limit, cross-tenant
     id). Hit `/api/health` to confirm
     `autopilot_review_labels: 'mounted'`.
   - Check Sentry / server logs for
     `admin.ai.autopilot_review.upsert_failed`.

2. **"Same row labeled twice creates two rows."**
   - It shouldn't — unique constraint on `ai_action_id`. If it
     does, migration 024 didn't apply cleanly. Run:
     ```sql
     select indexname from pg_indexes
      where tablename = 'ai_action_reviews'
        and indexdef ilike '%unique%';
     ```
     If empty, re-apply migration 024.

3. **"Rule signals card is empty even though I labeled rows."**
   - The simulation endpoint only counts a rule signal when
     `riskFlags` (pricing / policy / availability) fired on the
     same row. If you labeled rows that had no risk flags, they
     still count toward `reviewed_disagreements_pct` but won't
     show up in the per-rule card. Confirm with:
     ```sql
     select metadata->'variant_risk_flags' from public.ai_actions
      where id = '<row from queue>';
     ```

4. **"Queue is empty but I know there are disagreements."**
   - The queue only renders DISAGREEMENTS
     (`operator_more_conservative` + `operator_less_conservative`).
     If every operator outcome happened to align with autopilot
     across the window, the queue is correctly empty. Confirm
     with the AutopilotSimulationPanel — `summary.aligned`
     should be high relative to the other two counters.

5. **"I want to confirm autonomy is still off."**
   - `curl /api/health | jq '.checks.autonomous_sending_still_disabled'`
     must still return `"mounted"`. 8AZ did NOT touch this flag.

### Why no autonomous send (yet)

8AZ is observation + labeling. The labels are calibration
evidence; they don't enable any action. Phase 8BA is the
**per-venue autonomy readiness gate** (still read-only) that
will eventually consume `reviewed_disagreements_pct` + the
false-positive rates as the precondition for any future
opt-in autonomy toggle. Real autopilot sending is at least
two more safety phases away, and even then will be per-venue,
gated by an explicit operator toggle.

## Autopilot Safety Scorecard + Readiness Gate (Phase 8BA)

### What's stored

Nothing new. 8BA is purely derived from the 8AY simulation
data + the 8AZ review labels. No migration. No additional
schema. The scorecard is a verdict surface over data that
already exists.

### Endpoint

`GET /api/admin/ai/autopilot-readiness?venue_id=…&days=…`

Window default 30 days, range 1–90. Reuses the same
`ai_actions` + `ai_action_reviews` scan the 8AY/8AZ routes
use. Hard scan cap 1000 rows.

Returns:

```json
{
  "venue_id": "...",
  "window_days": 30,
  "readiness": {
    "verdict": "not_eligible" | "watch" | "eligible",
    "eligible": false | true,
    "reasons": ["..."],
    "caveats": ["..."],
    "gates": [
      {
        "key": "simulation_readiness_promising",
        "label": "Simulation readiness is promising",
        "passed": false,
        "currentValue": "watch",
        "threshold": "promising",
        "severity": "blocking",
        "nextStep": "Keep approving + regenerating drafts..."
      }
      // ... 5 more gates
    ]
  },
  "inputs": {
    "simulation_readiness": "watch",
    "total_scored": 23,
    "reviewed_disagreements_pct": 0.42,
    "max_rule_false_positive_rate": 0.31,
    "operator_less_conservative_unreviewed": 2,
    "window_days_with_data": 11
  },
  "generated_at": "2026-..."
}
```

### Gates

Six gates evaluated independently. Thresholds live in
`lib/revenue-os/autopilot-readiness.ts` as exported constants
(`MIN_SCORED_ROWS`, `MIN_REVIEWED_DISAGREEMENTS_PCT`,
`MAX_RULE_FALSE_POSITIVE_RATE`, `MIN_WINDOW_DAYS_WITH_DATA`).

| Key | Severity | Pass condition |
|-----|----------|----------------|
| `simulation_readiness_promising` | blocking | 8AY `summary.readiness === 'promising'` |
| `min_scored_rows` | blocking | `total_scored >= 50` |
| `min_reviewed_disagreements_pct` | blocking | `reviewed_disagreements_pct >= 0.8` |
| `max_false_positive_rate_per_rule` | warning | no reviewed rule has FP rate > 0.25 |
| `zero_operator_less_conservative_unreviewed` | blocking | count === 0 |
| `min_window_days_with_data` | warning | distinct UTC dates with scored rows >= 14 |

### Verdict rule

- `eligible` — every gate passes.
- `watch` — every blocking gate passes; at most one warning
  gate fails.
- `not_eligible` — anything else.

### Critical safety guarantees

These are enforced in the codebase, not just the docs:

1. **`eligible` does NOT enable autopilot.** Returning the
   verdict has zero side effects — no toggle is flipped, no
   threshold is loosened, no flag is set. Verify with
   `grep -R "verdict === 'eligible'" app lib` — only the UI
   reads it, and the UI only RENDERS the verdict.
2. **No toggle exists in the codebase.** Search the
   AutopilotReadinessScorecard for "Enable" — it shouldn't
   appear. There is no autonomy-related button.
3. **`autonomous_sending_still_disabled` health flag stays
   `mounted`.** 8BA does not touch it; assert with
   `curl /api/health | jq '.checks.autonomous_sending_still_disabled'`.

### Troubleshooting

1. **"Card says eligible but I can't find the autopilot
   toggle."**
   - That's the intended behavior. There is no toggle. The
     `eligible` verdict is the PRECONDITION for a future opt-in
     phase to even consider adding one. Read the emerald
     caveat box on the card — it spells this out explicitly.

2. **"Every gate is failing on a venue that's been active for
   weeks."**
   - Most likely cause: pre-8AX rows. The gates count only
     rows with autopilot decisions, which started landing in
     Phase 8AX. SQL:
     ```sql
     select count(*) from public.ai_actions
      where venue_id = '<id>'
        and agent = 'venuerise'
        and action = 'draft_regenerate'
        and metadata ? 'autopilot_decisions';
     ```
   - If that's zero, the venue's draft regenerations all
     pre-date 8AX. Generate a few new drafts; the gates will
     begin to populate.

3. **"Disagreement coverage gate keeps failing even after I
   label rows."**
   - The denominator is `total_disagreements` — every
     `operator_more_conservative` + `operator_less_conservative`
     row in the window. If new disagreements arrive faster
     than the operator labels them, the percentage drops.
     Either the operator needs to spend more time in the
     review queue, or the window's natural disagreement
     volume is too high for current operator bandwidth.

4. **"`zero_operator_less_conservative_unreviewed` won't
   clear."**
   - Find the unlabeled dangerous-direction rows:
     ```sql
     select aa.id, aa.created_at
       from public.ai_actions aa
       left join public.ai_action_reviews ar
         on ar.ai_action_id = aa.id
      where aa.venue_id = '<id>'
        and aa.agent = 'venuerise'
        and aa.action = 'draft_regenerate'
        and aa.created_at >= now() - interval '30 days'
        and ar.id is null
        and aa.metadata ->> 'operator_outcome' = 'sent_as_is'
        and exists (
          select 1 from jsonb_array_elements(
            aa.metadata->'autopilot_decisions'
          ) d
          where d->>'mode' in ('blocked', 'review_required')
        );
     ```
   - Each one needs a label in the AutopilotReviewQueue.
     This gate is BLOCKING by design — dangerous mismatches
     must be reviewed before any autonomy conversation.

5. **"`max_false_positive_rate_per_rule` is a warning but
   feels important."**
   - It IS important — a single rule firing wrong > 25% of
     the time is concerning. We made it a warning rather
     than blocking because a venue might have one noisy rule
     while the rest of the system is healthy; in that case
     `watch` is the honest verdict. If you'd rather treat it
     as blocking, change the `severity` in
     `lib/revenue-os/autopilot-readiness.ts` — it's a single
     line.

6. **"I want to confirm autonomy is still off."**
   - `curl /api/health | jq '.checks.autonomous_sending_still_disabled'`
     must still return `"mounted"`. 8BA did not touch this
     flag. If it ever changes, the safety stack has
     graduated to a different posture and that requires a
     different runbook entry.

### Why no autonomous send (still)

Phase 8BA closes the read-only safety stack. The full chain
is now: confidence gate (8AV) → calibration telemetry (8AW)
→ guardrails (8AX) → simulation (8AY) → labeled
disagreements (8AZ) → per-venue readiness scorecard (8BA).
That is the entire READ side.

The WRITE side — actually emitting an autopilot message
without operator approval — has not been built and is not
authorized by this phase. The next phase is whatever the
team decides; if it's opt-in autonomy, it must add explicit
per-venue toggle, rollback, kill switch, monitoring, and
customer-visible settings before any send path is touched.

## Tour Slot Suggestions from Availability (Phase 8BB)

### What's stored

Nothing new. 8BB is a derived surface on top of the existing
`tour_availability` table (Phase 6B) + the `tours` table.

### Pipeline

1. The lead detail drawer's recovery effect (already running
   per-lead) fan-outs to also fetch the venue's active
   `tour_availability` rows + the venue's next 60 days of
   tours.
2. The pure helper at
   `lib/revenue-os/tour-slot-suggestions.ts` computes up to
   2 candidate slots:
   - active-only windows
   - 60-minute default duration; windows narrower than that
     are skipped
   - no past times; no times after the lead's `event_date`
   - no overlap with non-cancelled tours
   - sorted earliest-first; de-duplicated by calendar date
3. The TourReadinessPanel renders the slots as small navy
   chips inside the `qualified_no_tour` branch only.
4. Clicking a chip stashes the ISO timestamp in the drawer's
   `scheduleSeedAt` state and opens the existing
   ScheduleTourDrawer with `defaultScheduledAt` set. The
   drawer's Phase 8I re-seed effect picks up the new value
   and pre-fills the date + time inputs.
5. Operator confirms inside the drawer. No autonomous
   scheduling.

### Troubleshooting

1. **"Suggestions don't appear on a qualified lead."**
   - The chips only render when the tour-booking signal is
     `qualified_no_tour`. Check:
     `select stage, lead_score from public.leads where id = '<id>';`
     plus
     `select id, status from public.tours where lead_id = '<id>';`
     The signal goes elsewhere (e.g. `tour_today`,
     `scheduled_unconfirmed`) if a tour already exists in any
     non-cancelled status.

2. **"Operator says 'No open windows found' but I see open
     slots in the calendar."**
   - The helper compares against the venue's next 60 days of
     tours. If you see open slots in the calendar UI but
     the chip shows the empty state, either (a) the
     candidate window is narrower than 60 minutes
     (`end_time - start_time`), or (b) every candidate
     date in the scan window falls after the lead's
     `event_date`. Confirm with:
     ```sql
     select day_of_week, start_time, end_time, is_active
       from public.tour_availability
      where venue_id = '<venue uuid>'
        and is_active = true;
     ```
     plus the lead's `event_date`. If the event date is
     soon (< 21 days away), the scan window will exhaust
     faster than usual.

3. **"Chips show but click does nothing."**
   - Open DevTools. The click should set `scheduleSeedAt`
     and open the existing ScheduleTourDrawer. If the
     drawer opens but the date/time inputs don't update,
     check that `defaultScheduledAt` is reaching the
     drawer (it's the Phase 8I prop). A console warning
     about `Invalid Date` usually means the helper
     produced a malformed ISO — check the row's
     `start_time` for unexpected formatting.

4. **"Two suggestions on the same day."**
   - Shouldn't happen — the helper de-duplicates by
     calendar date. If it does, the row's `created_at`
     might be encoded with a timezone offset that pushes
     two candidates into different ISO day prefixes. File
     it with the row IDs so we can tighten the de-dup
     keying.

### Safety posture

- The Tour Slot Suggestions surface NEVER writes a tour,
  sends a message, or schedules anything. Every action runs
  through the existing operator-confirmed
  ScheduleTourDrawer.
- The `autonomous_sending_still_disabled` health flag
  (8AX→8AY→8AZ→8BA→8BB) remains `mounted`.
- The suggestion chips hide silently on fetch errors so the
  rest of the drawer keeps working.

## Venue Availability Intelligence (Phase 8BC)

### What's stored

Two per-venue settings (Phase 8AQ `RevenueOsSettings` extension)
+ a new dedicated table:

```sql
-- RevenueOsSettings (in `venues.metadata.revenue_os`):
--   tour_duration_minutes  int  (15..240, default 60)
--   tour_buffer_minutes    int  (0..120,  default 0)

-- migration 025 — tour_blackouts:
select id, blackout_date, reason, created_at
  from public.tour_blackouts
 where venue_id = '<venue uuid>'
 order by blackout_date asc;
```

`tour_blackouts` is keyed unique on `(venue_id, blackout_date)`
so re-adding the same day surfaces as a 409 (not a duplicate
row).

### Endpoints

- `GET    /api/venues/[id]/tour-blackouts`  — list (sales roles)
- `POST   /api/venues/[id]/tour-blackouts`  — add (admin only)
- `DELETE /api/venues/[id]/tour-blackouts/[blackoutId]` — remove
  (admin only)
- The existing admin Revenue OS settings PATCH route accepts
  `tourDurationMinutes` + `tourBufferMinutes` alongside the rest.

Auth posture mirrors `/api/venues/[id]/availability` —
unauthenticated → 401, cross-tenant → 404, Zod-validated. Add
returns 409 `conflict` on the unique-violation path so the UI
can render "That date is already blocked." instead of a generic
500.

### Pipeline

1. Settings → Availability fetches `tour_availability` +
   `tour_blackouts` server-side. The Blackout dates section adds /
   lists / deletes against the new routes; on success the rows
   update optimistically.
2. The LeadDetailDrawer's recovery effect now fans out to
   `tour_availability` + `tours` (venue-wide, 60d) +
   `tour_blackouts` (today+) + `venues.metadata + timezone` in
   the same `Promise.all`.
3. `suggestTourSlots` receives `defaultDurationMinutes`,
   `bufferMinutes`, `blackoutDates`, and `timezone`. It uses the
   duration for window-fit + ISO computation, the buffer for the
   end-pad on each existing tour during conflict detection, the
   blackout set for a local-date filter, and the timezone for
   chip label rendering (`Intl.DateTimeFormat({ timeZone })`).
4. Operator clicks a chip → ScheduleTourDrawer opens with the
   suggested ISO via `defaultScheduledAt` (Phase 8I prop). The
   operator still confirms — no autonomous scheduling.

### Critical safety guarantees

- **Blackouts only affect SUGGESTIONS.** Operators can still
  manually schedule a tour on a blackout date from the drawer's
  date picker. Blackouts do NOT cancel existing tours.
- **Buffer is suggestion-side only.** Existing tours stored
  before buffer was set are unchanged; the buffer only affects
  what the system suggests, not what's in the database.
- **No autonomous scheduling. No autonomous sending.** The
  `autonomous_sending_still_disabled` health flag stays
  `mounted`.

### Troubleshooting

1. **"I added a blackout but suggestions still appear on that
     day."**
   - The drawer hydrates fresh on every open — close + re-open
     to refetch. If still wrong, check
     `select * from public.tour_blackouts where venue_id =
     '<id>' and blackout_date = '<YYYY-MM-DD>';` is present.
   - The helper compares the candidate's LOCAL date against the
     blackout set. If the operator's browser timezone differs
     from the venue's, edge cases near midnight can land in a
     different local day. The chip label honors venue TZ but
     the underlying scan uses the JS runtime's TZ. Cross-region
     accuracy is a known limitation.

2. **"Buffer time isn't being respected."**
   - Confirm:
     `select metadata->'revenue_os'->>'tour_buffer_minutes'
        from public.venues where id = '<id>';`
     If null or 0, buffer isn't enabled. Save again from the
     RevenueOsSettingsCard; the dirty check + save body now
     include the field (Phase 8BC fixed a pre-existing 8AV gap
     where brand voice fields had the same issue).

3. **"Chip labels show times that don't match the venue's
     timezone."**
   - The helper passes `venue.timezone` (from
     `venues.timezone`) to `Intl.DateTimeFormat`. If the column
     is null, labels fall back to the operator's browser
     timezone. Fix by setting `venues.timezone` to a valid
     IANA zone (e.g. `America/Los_Angeles`).

4. **"409 conflict on a date I haven't added."**
   - The unique constraint hit on `(venue_id, blackout_date)`.
     Possible causes: a different admin added it; a stale
     hydration showed the operator an empty list. Refresh
     `/dashboard/settings` to see the canonical list.

5. **"I want to confirm autonomy is still off."**
   - `curl /api/health | jq '.checks.autonomous_sending_still_disabled'`
     must still return `"mounted"`. 8BC did not touch the
     send path.

## Reactivation Outreach Cadence + Won/Lost Reason Library (Phase 8BD)

### What's stored

Migration 026 adds `leads.metadata` (jsonb, NOT NULL,
default `'{}'`) + a GIN index. The lost-reason taxonomy lives
at `metadata.lost_reason`:

```sql
select
  id,
  name,
  stage,
  metadata->'lost_reason' as lost_reason
from public.leads
where venue_id = '<venue uuid>'
  and stage = 'lost'
order by updated_at desc
limit 25;
```

Each block is `{reason, note, recorded_at, recorded_by}` with
`reason ∈ {priced_out, date_unavailable, picked_competitor,
ghosted, not_a_fit, other}`. Operator-supplied only — the
system never synthesizes a reason.

### Endpoints

- `PATCH /api/leads/[id]` — extended to accept an allowlisted
  `lost_reason` field (reason enum + optional 500-char note).
  Merges into the existing metadata jsonb; pass `null` to
  clear. Other metadata keys are never overwritten.
- `GET /api/admin/leads/reactivation-queue?venue_id=&limit=`
  — top-N reactivation candidates with rationale + suggested
  instruction. requireAdmin + cross-tenant 404 + per-user
  rate limit. Metadata only — no email, no message body.

### Candidacy rules (summary)

The full rules live in `lib/revenue-os/reactivation.ts`:

- Only `stage === 'lost'`.
- `picked_competitor` and `not_a_fit` are NEVER surfaced.
- Last lead-role message must be > 30 days ago.
- Inside the 60-day pre-event window → never suggest.
- Strong reasons (`priced_out`, `date_unavailable`,
  `ghosted`) → `strong_candidate`.
- `other` / missing reason → `possible_candidate` only after
  60 days of cooling.
- Score = reason quality (40 max) + lead_score (40 max) +
  days-cooled bonus (20 max, capped at 180 days).

### Critical safety guarantees

- **No autonomous outreach.** The system surfaces candidates
  and suggested instructions only. Every reactivation reply
  flows through Regenerate + Approve & send (which themselves
  flow through the 8AV–8BA brand voice + autopilot safety
  stack).
- **Operator-supplied reasons only.** Missing reasons surface
  as "possible", not "strong".
- **Skippable prompt.** The lost-reason prompt does NOT block
  the stage change. Operators who skip end up with a lead
  that still becomes a reactivation candidate after a longer
  cooling window.
- **`autonomous_sending_still_disabled`** flag stays mounted.

### Troubleshooting

1. **"Lost reason prompt doesn't appear when I move a lead
     to lost."**
   - The prompt only opens on a transition INTO `lost` — it
     won't re-open on a lead that's already lost. To re-test,
     move the lead to a non-lost stage first.

2. **"I labeled a lead but it doesn't show in the
     reactivation queue."**
   - Cooling gate: last lead-role message must be > 30 days
     ago (strong reasons) or > 60 days (other / null
     reason). If the lead replied recently, the helper
     correctly excludes it.
   - Event-date guard: if `event_date` is within 60 days
     of today, the lead is excluded from suggestions even
     with a strong reason.
   - SQL deep dive:
     ```sql
     select
       l.id, l.stage,
       l.metadata->'lost_reason'->>'reason' as reason,
       l.event_date,
       (select max(m.created_at) from public.messages m
         where m.lead_id = l.id and m.role = 'lead') as last_inbound
       from public.leads l
      where l.id = '<id>';
     ```

3. **"Admin endpoint returns 0 items but the Overview card
     shows candidates."**
   - The admin endpoint's default `limit` is 10; the Overview
     card also caps at 10. They should agree. If they don't,
     check the request — `limit=0` would be rejected by Zod
     (`min(1)`); a missing limit defaults to 10.

4. **"Operator marks a lost lead's reason as
     `picked_competitor` and it stops appearing."**
   - Correct behavior. `picked_competitor` is a never-surface
     reason — the operator already said the lead picked
     somewhere else, so we don't surface reactivation
     candidates for them.

5. **"Want to confirm autonomy is still off."**
   - `curl /api/health | jq '.checks.autonomous_sending_still_disabled'`
     must still return `"mounted"`. 8BD did not touch the
     send path.

## Phase 9A — Enterprise audit log + RBAC posture sweep

### What 9A added

- **Migration 027** — `public.audit_events` with `venue_id`,
  `actor_user_id`, `actor_kind`, `route`, `action`, `target_table`,
  `target_id`, `request_id`, `ip_hash`, `user_agent`,
  `before_snapshot`, `after_snapshot`, `metadata`, `created_at`.
  Four indexes: `(venue_id, created_at desc)`,
  `(actor_user_id, created_at desc)`,
  `(action, created_at desc)`, `(target_table, target_id)`.
  RLS: SELECT for owner/admin via `has_venue_role`; no write policies
  (service-role only via the helper).
- **`lib/enterprise/audit-events.ts`** — best-effort writer:
  - Recursively drops sensitive keys (password, secret, token,
    api_key, authorization, cookie, webhook_payload, raw_body,
    stripe_secret, anthropic_api_key) before storage.
  - Caps snapshots at 4 KB; truncates strings inside at 1 KB;
    truncates user-agent at 240 chars.
  - Salted-SHA-256 fingerprint for the IP via
    `AUDIT_IP_HASH_SECRET` (falls back to `SUPABASE_JWT_SECRET` in
    dev). Never stores raw IPs.
  - Wraps every step in try/catch — logs + Sentry on failure, never
    throws, never blocks the original business action. Routes use
    `void recordAuditEvent({...})` so a stalled audit write doesn't
    delay the HTTP response.
- **`GET /api/admin/audit-events`** — admin/owner only; cross-tenant
  forbidden collapses to 404. JSON + CSV branches; cursor pagination
  via `?occurred_before=<iso>` + X-Has-More / X-Next-Cursor headers.
  `?id=<uuid>&include_snapshots=1` single-row fetch for the drawer.
  `ADMIN_ENDPOINT_COUNT` bumped 36 → 37.
- **`EnterpriseAuditEventsCard`** on `/dashboard/settings/billing`
  — list view does NOT request snapshots; drawer fetches them on
  demand. Three filters: action, target_table, actor_user_id.

### RBAC posture (cross-cutting recap)

Every `/api/admin/*` route in the codebase follows the same posture:

1. `requireAdmin()` — owner/admin gate, returns 401 unauthorized /
   403 no_venue when the caller is not eligible. Sales /
   coordinator / viewer roles get 403.
2. Per-user rate limit keyed off `${route}:${userId}`. Distinct key
   prefixes per route so a noisy surface doesn't starve a sister
   surface's budget.
3. Optional cross-tenant `?venue_id=<uuid>` (or body field). When
   the resolved venue differs from `callerVenueId`, the route calls
   `requireVenueRole(user.id, targetVenueId, ADMIN_ROLES)`.
   `TenantAccessError` with `status===403` collapses to 404 — the
   admin surface never reveals whether a foreign venue exists.
4. Zod validates the body / query shape; failures return 400 with
   `validation_failed` + the flattened error.
5. Sensitive writes record a `recordAuditEvent({...})` row at the
   success path. Best-effort — the audit row never gates the
   response.

Non-admin routes (e.g. `/api/leads/[id]`, `/api/tours/[id]`,
`/api/ai/actions/[id]/reject`, `/api/conversations/[id]/messages`)
use `SALES_ROLES` instead of `ADMIN_ROLES`. The same 403 → 404
collapse applies on cross-tenant probes.

### Runbook entries

1. **"Audit feed shows the wrong before/after."**
   - The helper sanitizes recursively; if a snapshot looks empty
     it usually means every field matched the sensitive-key
     allowlist. Check `metadata` for the structural fields the
     route writer chose (e.g. `field_count`, `had_metadata_diff`).
   - Snapshots are size-capped at 4 KB. Large jsonb blobs get
     truncated; the helper emits a `[truncated]` marker.

2. **"Audit feed is empty after a known write."**
   - Audit writes are best-effort. Look for
     `audit_events.write_failed` in the pino logs / Sentry. The
     business action still committed; the audit row didn't.
   - Confirm the route actually calls `recordAuditEvent`. Use
     `grep -RE "recordAuditEvent" app/api` to enumerate
     instrumented surfaces.

3. **"Can I rotate `AUDIT_IP_HASH_SECRET`?"**
   - Yes, at any time. Rotation breaks linkability of audit rows
     written before the rotation (by design — incidents resolved
     before rotation should be fully forensicable from the
     pre-rotation rows already, and post-rotation rows get a
     fresh-keyed namespace).

4. **"Audit row missing for an operator-sent message — was the
   body captured?"**
   - No. `/api/conversations/[id]/messages` deliberately
     records `body_length` only — never the message body. The
     audit row's purpose is *who sent what to whom, when* — the
     message contents live in `public.messages` and are surfaced
     by the inbox UI, the message search RPC, and the
     VariantReplayDrawer. Auditing the body would double-store PII
     for no incremental investigation value.

5. **"Want to confirm autonomy is still off."**
   - `curl /api/health | jq '.checks.autonomous_sending_still_disabled'`
     must still return `"mounted"`. 9A did not touch any send
     path. The four 9A flags
     (`enterprise_audit_log`, `enterprise_audit_events_card`,
     `rbac_documentation_pass`, `request_context_baseline`) are
     mounted alongside it.

## Phase 9B — Audit coverage completion + RBAC hardening matrix

### What 9B added

- **`lib/enterprise/audit-actions.ts`** — string constants for
  every audit action name. New routes import from here so a typo
  ("lead_updated" vs "lead_update") gets caught at build time.
  Pre-9B routes keep their literal strings; the strings resolve
  to identical UTF-8.
- **Routes newly instrumented**: `/api/leads` POST,
  `/api/onboarding/create-workspace`, `/api/billing/checkout`,
  `/api/billing/portal`, `/api/admin/billing-events/[id]/clear-dunning`,
  `/api/admin/billing-events/[id]/replay`,
  `/api/team/invitations` POST, `/api/team/invitations/[id]` DELETE,
  `/api/team/invitations/accept`, `/api/team/members/[userId]` DELETE+PATCH,
  `/api/admin/demo/{seed,reset}`, `/api/admin/test-send`,
  `/api/admin/digest/preview`.
- **Routes explicitly exempted with rationale**: `/api/widget`
  (public route), `/api/stripe/webhook` + `/api/resend/webhook`
  (webhook routes), `/api/ai/{draft,chat,followup,qualify}` +
  `/api/admin/anthropic-probe` (AUDIT_EXEMPT with reason).
  Every exemption is documented in `docs/AUDIT-COVERAGE.md`.
- **`docs/AUDIT-COVERAGE.md`** — the source of truth for which
  routes write audit rows and which are exempted. Read it before
  adding a new mutating route.
- **`docs/RBAC-MATRIX.md`** — per-route auth helper, role set,
  tenant source, cross-tenant collapse behavior, service-role
  usage, RLS reliance.
- **`scripts/check-audit-coverage.mjs`** — regression guard.
  Scans `app/api` for mutating route files lacking
  `recordAuditEvent` / `AUDIT_EXEMPT` / `public route` /
  `webhook route` markers. Wired into `npm run verify`.
- **Drawer polish** on `EnterpriseAuditEventsCard`:
  before/after/metadata JSON collapsed by default (compact
  preview shows top-level keys); copy buttons for audit id,
  request id, actor user id, target id; navigator.clipboard with
  textarea-fallback for older browsers.

### Runbook entries

1. **"`check:audit-coverage` failed in CI / `npm run verify`."**
   - Scanner found a mutating route file with neither a
     `recordAuditEvent(...)` call nor an exemption marker. The
     error output lists the file + which methods (POST / PATCH /
     PUT / DELETE) it exports.
   - Resolve by ONE of:
     - Add `recordAuditEvent({...})` at the success path. Prefer
       a constant from `lib/enterprise/audit-actions.ts`; add a
       new constant if your action doesn't fit an existing name.
     - Add `// AUDIT_EXEMPT: <reason>` near the top of the file
       AND document the row in `docs/AUDIT-COVERAGE.md` under
       "Explicit exemptions".
     - For anonymous or webhook routes, add `// public route` or
       `// webhook route` in a header comment.

2. **"Operator can't copy the audit row id."**
   - Clipboard requires a secure context (HTTPS or localhost) +
     active document focus. The drawer's `CopyButton` falls
     back to a `document.execCommand('copy')` flow via a hidden
     textarea — works in older browsers + non-secure contexts.
   - If both fail (some hardened browser profile), the audit id
     is still visible in the drawer's truncated font-mono span;
     the operator can select + Ctrl-C manually.

3. **"Snapshot panel says `Expand (N fields)` — what's hiding?"**
   - The JSON pane is collapsed by default to keep the drawer
     scannable. Clicking "Expand" renders the full sanitized
     `before_snapshot` / `after_snapshot` / `metadata` blob the
     helper saved. The sanitization (sensitive-key drop +
     4 KB cap) already happened at write time; the drawer does
     no further redaction.
   - Empty panes show `—`; the helper writes `null` for routes
     that don't supply a snapshot.

4. **"Want to add a new admin endpoint."**
   - Read `docs/RBAC-MATRIX.md` first. The standard posture is:
     `requireAdmin()` → per-user rate limit → Zod-validate body
     → resolve `targetVenueId = bodyVenueId ?? callerVenueId`
     → if cross-tenant, `requireVenueRole` with `ADMIN_ROLES`
     (403 collapses to 404) → service-role write → `void recordAuditEvent`.
   - Bump `ADMIN_ENDPOINT_COUNT` in `app/api/health/route.ts`.
   - Run `npm run check:audit-coverage` — must pass clean.

5. **"Audit log isn't immutable — that's a problem for compliance."**
   - Acknowledged. As of Phase 9B, an admin with database access
     can delete rows from `audit_events`. The RLS posture only
     blocks the REST surface. A future phase may add a WORM-style
     append-only object storage copy for SOC 2 / HIPAA contexts.
     For now, treat audit logs as forensic evidence (good for
     investigations) not as a legal record (not yet).

## Phase 9C — Audit mirror + cross-tenant probe

### What 9C added

- **Migration 028** — `public.audit_event_mirror` (separate
  table; shares the primary `audit_events.id` so a join is
  trivial). RLS: owner-only SELECT (stricter than the primary
  feed which allows owner OR admin). NO RLS write policies — all
  inserts go through the service-role helper; the REST surface
  cannot mutate the mirror.
- **`lib/enterprise/audit-mirror.ts`** — `mirrorAuditEvent`
  best-effort writer. Gated by `AUDIT_MIRROR_ENABLED=1`
  (default OFF). `recordAuditEvent` selects back the DB-stamped
  id + created_at from the primary insert, then fires
  `mirrorAuditEvent` fire-and-forget. The helper's own try/catch
  ensures failures NEVER throw back.
- **`scripts/check-cross-tenant-rbac.mjs`** — env-driven smoke
  harness. Probes 8 routes × 2 passes (authenticated venue-A
  user against venue-B resources; unauthenticated). Verifies
  authenticated → 404 (collapsed from 403), unauthenticated →
  401. Wired via `npm run check:cross-tenant-rbac`. NOT in
  `npm run verify` because it needs real seeded tenants;
  operators run it manually in staging or local dev.
- **`EnterpriseAuditEventsCard`** now renders a "Mirror:
  best-effort enabled" / "Mirror: disabled" indicator on the
  billing page. The state comes from the server-rendered
  billing page reading `AUDIT_MIRROR_ENABLED` via
  `isAuditMirrorConfigured()` — no new admin endpoint.

### Runbook entries

1. **"Mirror writes are failing."**
   - Grep the structured logs for `audit_mirror.insert_failed`
     or `audit_mirror.helper_threw`. The error message + the
     `route` / `action` / `id` fields identify the offending
     primary row. The Sentry issue carries the venue id.
   - Most common cause: migration 028 hasn't applied in the
     environment. Confirm with
     `select to_regclass('public.audit_event_mirror');` — null
     means the table doesn't exist; apply 028.
   - Second most common: `AUDIT_MIRROR_ENABLED=1` is set but
     the service-role key is misconfigured. Service-role is
     required because the mirror table has NO RLS write
     policies. Confirm the key has the `service_role` claim.

2. **"Mirror is on but the indicator on the card says disabled."**
   - The card reads `AUDIT_MIRROR_ENABLED` at server-render
     time (the billing page is a Server Component). If the env
     var was flipped without restarting the Next.js process,
     the card still shows the boot-time state. Restart the
     server.

3. **"How do I run the cross-tenant probe?"**
   - Seed two test tenants in your local Supabase (or a
     dedicated staging project): venue A with the user you'll
     authenticate as, venue B with at least one lead, one tour,
     and one ai_action.
   - Copy the venue-A user's session cookie from devtools.
     Look for `sb-<projectref>-auth-token=...`.
   - Set env vars (or pass them inline):
     ```bash
     export RBAC_PROBE_BASE_URL=http://localhost:3000
     export RBAC_PROBE_COOKIE='sb-<ref>-auth-token=...'
     export RBAC_PROBE_FOREIGN_VENUE_ID=<venue B uuid>
     export RBAC_PROBE_FOREIGN_LEAD_ID=<lead in B uuid>
     export RBAC_PROBE_FOREIGN_TOUR_ID=<tour in B uuid>
     export RBAC_PROBE_FOREIGN_AI_ACTION_ID=<ai_action in B uuid>
     ```
   - Run `npm run check:cross-tenant-rbac`. Expected output:
     all probes PASS, summary line `Summary: 16 pass / 0 fail
     (16 probes total)`. The script exits 1 if any probe diverged.

4. **"Probe failed — what does each diverging result mean?"**
   - `expected 404, actual 403` → cross-tenant collapse rule
     not applied. The route caught a `TenantAccessError` with
     `status === 403` but returned `403 forbidden` instead of
     `404 not_found`. Fix per `docs/RBAC-MATRIX.md` §1.
   - `expected 404, actual 200` → the route allowed a
     cross-tenant read or write. This is a tenant isolation
     bug. Treat as a P0; do not promote.
   - `expected 404, actual 400` → the route did Zod validation
     BEFORE the tenant check, leaking the existence of a route
     param shape mismatch. Re-order: tenant check first.
   - `expected 401, actual 200` → unauthenticated access
     succeeded. The route is missing `requireAdmin()` or the
     manual `getUser()` gate. P0.

5. **"Want to confirm autonomy is still off."**
   - `curl /api/health | jq '.checks.autonomous_sending_still_disabled'`
     must still return `"mounted"`. 9C added two flags
     (`enterprise_audit_mirror`,
     `enterprise_audit_mirror_best_effort`) alongside it.

## Phase 9D — Data export, PII redaction, retention controls

### What 9D added

- **`lib/enterprise/data-export.ts`** — `buildVenueDataExport`
  builds a venue-scoped JSON snapshot. Per-section row cap
  (`MAX_ROWS_PER_SECTION = 5000`) prevents a pathological venue
  from blowing the response. Sections that hit the cap appear in
  `summary.truncatedSections` so the operator knows to ask for an
  (eventual) async export.
- **`lib/enterprise/pii-redaction.ts`** — pure helpers:
  `redactLeadPiiSnapshot` (narrow PII subtree for the audit
  `before` field), `buildLeadPiiRedactionPatch` (scalar
  replacements + metadata stamps), `buildRedactedEmail` (synthetic
  `redacted+<leadId>@redacted.local`), `dropPiiMetadataKeys`
  (strips `pii.*` subtree and `lost_reason_note`).
- **`POST /api/admin/data-export`** — returns the export inline.
  Capped at `MAX_EXPORT_BYTES = 8 MB`; oversize venues get a 413
  with `error: "export_too_large"`. Writes a
  `data_export_requested` audit row with section counts +
  estimated bytes (NEVER the payload). `ADMIN_ENDPOINT_COUNT`
  37 → 38.
- **`POST /api/admin/leads/[leadId]/redact-pii`** — soft-redact
  one lead. Lead row preserved; conversations / messages / tours
  / ai_actions / audit_events untouched. Writes a
  `lead_pii_redacted` audit row carrying the PII before-snapshot
  + the patch after-snapshot. `ADMIN_ENDPOINT_COUNT` 38 → 39.
- **`DataLifecycleCard`** on `/dashboard/settings/billing` —
  admin-only. Export button + include-audit-events toggle +
  retention posture summary (audit mirror, digest retention,
  audit log, PII redaction availability). No new admin endpoint;
  retention flags come from server-rendered env reads.

### Runbook entries

1. **"Operator requested an export but it returns 413."**
   - The venue's section row counts exceed the 8 MB inline cap.
     The `data_export_requested` audit row carries
     `section_counts` + `estimated_bytes` — query
     `audit_events` filtered on the venue + action to see what
     pushed over.
   - Immediate workaround: run the queries from the helper
     manually via Supabase SQL editor, scope to the operator's
     venue id, save the result as JSON.
   - A future phase will add an async export path (object
     storage + signed URL) for venues over the cap.

2. **"Operator requested an export but a section returned 0
   rows when it shouldn't."**
   - Most likely cause: the section cap `MAX_ROWS_PER_SECTION`
     truncated a different section earlier and the response
     was correctly returned, but a downstream tool joined the
     truncated sections wrong. Check `summary.truncatedSections`
     in the response.
   - Second cause: the venue genuinely has 0 rows in that
     section. Confirm via Supabase SQL: `select count(*) from
     <section> where venue_id = '...';`.

3. **"Operator redacted a lead but their conversations still
   show the customer's name."**
   - Conversations and messages are NOT touched by the redaction
     endpoint. Only the `leads` row's PII is removed. The audit
     event `lead_pii_redacted` proves the lead-level redaction
     happened.
   - This is by design — the soft redaction preserves the
     conversation history so funnel analytics still work. If the
     operator's intent is full PII purge across the conversation
     thread, that's a P0 feature gap; treat as a product
     conversation, not a runbook fix. Future phases will likely
     add a `message_pii_redacted` action for conversation-level
     redaction.

4. **"Re-redacting a lead — is that safe?"**
   - Yes. The endpoint is idempotent. Re-running:
     - Re-stamps `pii_redacted_at` + `pii_redacted_by` to the
       new operator + new timestamp.
     - Resets `name` to "Redacted Lead", `email` to the
       deterministic `redacted+<leadId>@redacted.local`, `phone`
       and `notes` to null again.
     - Writes a fresh `lead_pii_redacted` audit row with
       `metadata.already_redacted: true`.
   - Treat re-redaction as an explicit operator action — the
     audit feed should show one row per click, and the second
     row's `before` snapshot will already show redacted values
     (proving the redaction was already in place).

5. **"How do I verify a lead is fully redacted?"**
   - Query directly: `select id, name, email, phone, notes,
     metadata->>'pii_redacted' as redacted from public.leads
     where id = '...';`.
   - Expected: name = "Redacted Lead", email =
     "redacted+<id>@redacted.local", phone null, notes null,
     redacted = "true".
   - Cross-check: the audit row exists via the
     EnterpriseAuditEventsCard filtered on
     `action = lead_pii_redacted`.

6. **"Want to confirm autonomy is still off."**
   - `curl /api/health | jq '.checks.autonomous_sending_still_disabled'`
     must still return `"mounted"`. 9D added four flags
     (`enterprise_data_export`, `lead_pii_redaction`,
     `data_lifecycle_card`, `retention_posture_visible`)
     alongside it.

## Phase 9E — Secrets rotation and header hardening

### What 9E added

- **Phase 7A security headers** were already in `next.config.js`.
  9E expanded `Permissions-Policy` to include `bluetooth=()` and
  added a SEPARATE `Content-Security-Policy-Report-Only` header
  carrying the fuller aspirational directive set. The existing
  enforced `Content-Security-Policy: frame-ancestors` posture is
  unchanged.
- **`/api/security/csp-report`** — anonymous + per-IP rate-limited
  (60/min via `vr:csp` Upstash prefix). Parses level-2
  `application/csp-report`, level-3 `application/reports+json`,
  and plain JSON. Logs one structured `security.csp_report.received`
  line per report; NEVER stores raw cookies or full user-agents
  (truncated at 240 chars). Returns 204.
- **5 health flags** — `security_headers_report_only`,
  `csp_report_endpoint`, `hsts_header`, `permissions_policy_header`,
  `secrets_rotation_runbook` (doc-presence flag).

### Secrets rotation table

Every secret listed below should rotate AT LEAST when:
- A team member with prod access leaves.
- A vendor reports a breach affecting that secret's class.
- The rotation cadence below elapses.

Never paste the actual secret value into a PR description, a chat
message, a screenshot, or this doc. Never put it in `.env.example`.
Use the deployment platform's secret store (Vercel project env,
Supabase dashboard) as the only source of truth.

| Secret | Cadence | What it controls | Rotation invalidates | Dual-secret needed? | Verify after | Rollback |
|---|---|---|---|---|---|---|
| `SUPABASE_SERVICE_ROLE_KEY` | Quarterly | Bypass-RLS reads/writes from API routes + Inngest cron + scripts | All in-flight requests using the old key fail with 401 from PostgREST | No — Supabase issues a new key alongside the old one; flip env, restart | `GET /api/health` returns `supabase: up`; new audit_events insert; new cron run | Re-insert the old key in env, restart |
| `NEXT_PUBLIC_SUPABASE_URL` | Only on project move | Browser + server reads of Supabase REST/Realtime | Every active browser session breaks; old service-role key no longer valid against new project | Yes — practical impossibility to dual-host; treat as a migration event | Re-sign in to dashboard; widget POST returns 201 | Restore old URL + old service-role key |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Quarterly | Browser-side anon RLS reads | Active browser sessions revalidate on next request | No — Supabase rotates with the JWT secret; restart server | Sign in to dashboard from a fresh session | Restore old anon key |
| `STRIPE_SECRET_KEY` | Quarterly | All server-side Stripe calls (checkout, portal, event retrieval) | All in-flight Stripe calls fail with 401 | No — Stripe allows two keys briefly via key rotation in dashboard | `POST /api/admin/anthropic-probe` is unrelated; instead trigger a `POST /api/billing/portal` and verify 200 | Stripe dashboard → re-activate previous key |
| `STRIPE_WEBHOOK_SECRET` | After every signing-secret rotation in Stripe dashboard | HMAC verification of Stripe webhook payloads | All in-flight webhooks fail signature check → `400 bad_signature` | Yes — Stripe lets you keep both signing secrets active during transition; flip env, then deactivate old in Stripe | `/api/health` `stripe_webhook` flag still `mounted`; trigger a test event from Stripe dashboard | Reactivate previous signing secret in Stripe, restore env |
| `RESEND_API_KEY` | Quarterly | Outbound email (digest, tour notifications, test-send) | All in-flight `resend.emails.send` calls 401 | No — Resend issues new key, both work until you revoke the old | `POST /api/admin/test-send` returns `delivered: true` | Restore old key, restart |
| `ANTHROPIC_API_KEY` | Quarterly | All AI generation (`/api/ai/{draft,chat,followup,qualify}`) + autopilot guardrails + autopilot simulation | All in-flight Anthropic calls 401 | No — Anthropic console issues a new key, revoke old after a window | `POST /api/admin/anthropic-probe` returns 200 with content | Restore old key, restart |
| `DIGEST_UNSUBSCRIBE_SECRET` | Annually OR on operator suspicion of leak | HMAC signing for digest unsubscribe + resubscribe tokens emailed to operators | Every outstanding unsubscribe link in operator inboxes silently stops working. Operators re-receive working links on the next digest. | No — single secret. Acceptable to drop active links because the next digest carries new ones. | Send a digest preview, click the footer unsubscribe — should land at `/unsubscribe` and succeed | Restore old secret; outstanding links work again |
| `TOUR_ACTION_SECRET` | Annually OR on suspected leak | HMAC signing for tour confirm/cancel one-click links in tour notification emails | Every outstanding `/tour/confirm?token=` and `/tour/cancel?token=` link silently stops working until the next email goes out | No — same dynamic as DIGEST_UNSUBSCRIBE_SECRET | Send a tour reminder, click confirm — should land at `/tour/confirm` and succeed | Restore old secret |
| `AUDIT_IP_HASH_SECRET` | Annually | Salted-SHA-256 fingerprint stored in `audit_events.ip_hash` (Phase 9A) | Pre-rotation audit rows' IP hashes are no longer linkable to post-rotation rows from the same client (by design — fresh-keyed namespace) | No — single secret. Falls back to `SUPABASE_JWT_SECRET` in dev when unset. | New audit row writes; `ip_hash` field changes character set | Restore old secret to restore linkability of pre-rotation rows |
| `AUDIT_MIRROR_ENABLED` | Not a secret — operational toggle | Phase 9C audit mirror best-effort writes | When flipped off, new `audit_events` inserts stop populating `audit_event_mirror`. Existing mirror rows remain. | No — toggle. Restart Next.js to pick up the new value (the DataLifecycleCard reads it at server-render time) | DataLifecycleCard's "Audit mirror" line shows the new state; query `select count(*) from audit_event_mirror where created_at > now() - interval '5 minutes'` after a write | Flip toggle back |
| `DIGEST_AUDIT_RETENTION_ENABLED` | Not a secret — operational toggle | Weekly Inngest cron that archives old `digest_audit_events` rows | When flipped off, old rows accumulate. No data loss. | No — toggle | DataLifecycleCard's "Digest retention" line updates after restart; Inngest dashboard shows next-run schedule | Flip toggle back |

### Runbook entries

1. **"Headers look right in production but wrong in dev."**
   - HSTS is intentionally production-only (would brick
     `http://localhost`). Confirm via
     `curl -I http://localhost:3000/dashboard` — Strict-Transport-Security
     should be ABSENT.
   - `curl -I https://your-prod-host.com/dashboard` — Strict-Transport-Security
     should be `max-age=63072000; includeSubDomains; preload`.

2. **"CSP report endpoint is getting flooded."**
   - Per-IP rate limit is 60/min via `vr:csp`. A genuine flood
     means the deployed CSP is misconfigured AND a popular page
     trips violations on every load.
   - Grep `security.csp_report.received` for the most common
     `violatedDirective` + `blockedUri` pair — that's the rule
     to relax in `next.config.js`.
   - The endpoint itself is anonymous + 204; a flood doesn't
     leak data, it just produces log noise.

3. **"Stripe checkout suddenly fails after a CSP change."**
   - The report-only header doesn't enforce, so a CSP change
     can only cause a hard break if you moved the directive
     from `Content-Security-Policy-Report-Only` to
     `Content-Security-Policy`. Revert.
   - Stripe Checkout iframes need `frame-src https://checkout.stripe.com`
     + `form-action https://checkout.stripe.com` to load card entry
     without console errors. Both are in the report-only baseline;
     verify they're in any enforced policy too.

4. **"Widget broke after a header change."**
   - The widget route (`/widget/*`) deliberately gets
     `Content-Security-Policy: frame-ancestors *` and NO
     `X-Frame-Options`. If a recent change added either of those
     globally without excluding the widget path, embedding
     breaks immediately.
   - Confirm with `curl -I http://localhost:3000/widget/<venueId>`
     — there should be no `X-Frame-Options` header and the CSP
     should be `frame-ancestors *`.

5. **"How do I rotate `STRIPE_WEBHOOK_SECRET` without dropping events?"**
   - In Stripe dashboard → Webhooks → your endpoint, click
     "Roll signing secret" — Stripe gives you both old + new for
     a window.
   - Update env to the new secret, restart Next.js. Existing
     in-flight events get verified against the new secret.
   - After confirming `/api/health` shows `stripe_webhook` still
     mounted AND new events land successfully, deactivate the
     old secret in Stripe.

6. **"Want to confirm autonomy is still off."**
   - `curl /api/health | jq '.checks.autonomous_sending_still_disabled'`
     must still return `"mounted"`. 9E added five flags
     (`security_headers_report_only`, `csp_report_endpoint`,
     `hsts_header`, `permissions_policy_header`,
     `secrets_rotation_runbook`) alongside it.

## Phase 9F — Rate-limit normalization + abuse monitoring

### What 9F added

- **`lib/rate-limit-catalog.ts`** — typed `RATE_LIMIT_DOMAINS`
  constants. Single source of truth for every limiter key prefix.
  Adoption is incremental: pre-9F routes keep their literal
  strings; new routes import from the catalog.
- **`lib/enterprise/abuse-events.ts`** — `recordAbuseEvent`
  best-effort writer to `public.abuse_events` (migration 029).
  Reuses `maskIpForAudit` so the same salted-SHA-256 fingerprint
  shape appears in both `audit_events.ip_hash` and
  `abuse_events.ip_hash` for cross-feed correlation. Failures
  log + Sentry but never throw.
- **`lib/rate-limit.ts`** — every wrapper (`rateLimitWidget`,
  `rateLimitAi`, `rateLimitUserAction`, `rateLimitCspReport`)
  accepts an optional `abuseContext`. On block, the wrapper fires
  `void recordAbuseEvent(...)` — fire-and-forget.
- **9 routes newly rate-limited** in this phase:
  `/api/leads/[id]` (PATCH+DELETE), `/api/tours` (POST),
  `/api/tours/[id]` (PATCH), `/api/venues/[id]` (PATCH),
  `/api/venues/[id]/availability` (POST),
  `/api/venues/[id]/availability/[slotId]` (PATCH+DELETE),
  `/api/venues/[id]/tour-blackouts` (POST),
  `/api/venues/[id]/tour-blackouts/[blackoutId]` (DELETE),
  `/api/team/invitations/[id]` (DELETE).
- **`scripts/check-rate-limit-coverage.mjs`** — regression guard.
  Scans `app/api` for mutating routes (and admin GETs) lacking
  `rateLimit*` / `RATE_LIMIT_EXEMPT` / `webhook route` /
  `public route` markers. 65 routes currently clean. Wired into
  `npm run check:rate-limit-coverage` (NOT yet in `verify` —
  promote after a sweep cycle confirms stability).
- **`GET /api/admin/security/abuse-events`** — admin/owner only;
  cross-tenant collapses to 404. JSON + CSV branches; cursor
  pagination. In-slice summary (top routes / reasons / limiter
  keys) so the AbuseMonitorCard chips don't need a second query.
  `ADMIN_ENDPOINT_COUNT` bumped 39 → 40.
- **`AbuseMonitorCard`** on `/dashboard/settings/billing` —
  admin-only. Top-3 chips for route/reason/limiter, recent rows
  table, Load older, CSV export, manual Refresh.

### Runbook entries

1. **"Card shows 'No abuse events recorded yet' but I expected
   blocks."**
   - The card is venue-scoped. Public-route blocks (widget,
     CSP report) have `venue_id IS NULL` and are intentionally
     NOT surfaced through the venue-bound card. Query directly:
     ```sql
     select route, count(*) from public.abuse_events
     where venue_id is null and created_at > now() - interval '1 hour'
     group by route order by count(*) desc;
     ```
   - If you expected blocks on a venue-scoped route, check that
     the route's rate-limit call passes an `abuseContext`. Without
     the context, blocks still happen but no `abuse_events` row
     is written.

2. **"Operator says they're getting 429 on a normal workflow."**
   - The userAction limiter is 30/min. Drag-and-drop board
     operations issue 1 PATCH per move; a normal operator stays
     well under. A 429 means either:
     a) A bug is firing the route in a loop (check browser network
        tab), or
     b) The operator legitimately hit 30+ moves in 60 seconds
        (rare but possible with bulk reorganization).
   - Either way the AbuseMonitorCard row will show the route +
     timestamp. Confirm with the operator before raising the
     budget; persistent 429s from one user is information.

3. **"Want to seed a fake abuse row to verify the card renders."**
   ```sql
   insert into public.abuse_events (
     venue_id, user_id, route, method, limiter_key, ip_hash, reason
   ) values (
     '<your venue id>', '<your user id>',
     '/api/leads/[id]', 'PATCH', 'leads:update:<your user id>',
     'demo_hash_0000000000000000000000000000000000', 'rate_limited'
   );
   ```
   Refresh the AbuseMonitorCard. Delete the row when done.

4. **"Rate-limit coverage scanner is failing in CI."**
   - The error output lists the file + methods. Two valid fixes:
     - Add a `rateLimit*` call before the mutation, OR
     - Add a `RATE_LIMIT_EXEMPT: <reason>` header comment and
       document the row in `docs/RATE-LIMIT-COVERAGE.md` under
       "Explicit exemptions."
   - Webhook routes use `// webhook route` instead;
     anonymous public endpoints use `// public route`.

5. **"Want to confirm autonomy is still off."**
   - `curl /api/health | jq '.checks.autonomous_sending_still_disabled'`
     must still return `"mounted"`. 9F added five flags
     (`rate_limit_catalog`, `rate_limit_coverage_check`,
     `abuse_monitoring`, `abuse_monitor_card`,
     `public_route_throttles`) alongside it.

## Phase 9G — Enterprise SSO readiness

### What 9G added

- **Migration 030** — `sso_connections` (owner-only mutations,
  admin SELECT) + `sso_login_events` (service-role insert,
  admin/owner SELECT scoped to venue).
- **`lib/enterprise/sso/*`** — `types.ts`, `domain.ts`,
  `audit.ts` (recordSsoLoginEvent), `provider.ts`
  (resolveSsoAdapter + SsoProviderAdapter interface),
  `adapters/not-configured.ts` (placeholder).
- **Public routes** — `POST /api/auth/sso/initiate`,
  `POST /api/auth/sso/callback`. Rate-limited via new
  `vr:sso` Upstash prefix (10/min/IP+domain on initiate,
  10/min/IP on callback). `AUDIT_EXEMPT` because the forensic
  record lives in `sso_login_events`.
- **Admin routes** —
  `GET/POST /api/admin/security/sso-connections`,
  `PATCH/DELETE /api/admin/security/sso-connections/[id]`,
  `GET /api/admin/security/sso-login-events`. Audit row
  emitted on every connection mutation
  (`sso_connection_create/update/delete`).
- **Admin UI** — `SsoConnectionsCard` + `SsoLoginEventsCard` on
  `/dashboard/settings/billing`.
- **`ADMIN_ENDPOINT_COUNT`** bumped 40 → 43.
- **`docs/SSO-READINESS.md`** — vendor comparison, security
  rules, future-implementation checklist.

### Runbook entries

1. **"Operator says SSO doesn't work."**
   - Expected. 9G is readiness-only. Every initiate / callback
     returns `SSO_PROVIDER_NOT_CONFIGURED` /
     `SSO_CALLBACK_NOT_CONFIGURED`. The forensic feed is in
     `sso_login_events` — the SsoLoginEventsCard shows every
     attempt with the structured reason.

2. **"Owner created a draft connection but login still fails."**
   - Drafts persist but never open an auth path. The
     connection's `status` must be flipped to `active` via the
     PATCH route AND a real adapter must be wired (Phase 9G
     placeholder still rejects). Documented in SSO-READINESS.md.

3. **"Want to delete an active SSO connection."**
   - The DELETE route refuses to delete `active` or `pending`
     connections. Flip the status to `disabled` first
     (separate PATCH). That preserves audit context for any
     in-flight login attempts.

4. **"How do I configure WorkOS later?"**
   - Follow the `docs/SSO-READINESS.md` "Future implementation
     checklist" — adapter file + env vars + JIT branch are
     the only code changes needed.

5. **"Cross-tenant SSO check failed in a probe."**
   - Run `npm run check:cross-tenant-rbac` with
     `RBAC_PROBE_FOREIGN_VENUE_ID` set and a session cookie. The
     `/api/admin/security/sso-connections?venue_id=<foreign>`
     path should return 404, not 403 — same posture as every
     other admin surface (Phase 9C documents the collapse).

6. **"Want to confirm autonomy is still off."**
   - `curl /api/health | jq '.checks.autonomous_sending_still_disabled'`
     must still return `"mounted"`. 9G added 5 flags
     (`sso_readiness`, `sso_connections_table`,
     `sso_login_events`, `sso_admin_endpoints`,
     `sso_provider_abstraction`) alongside it.

## Phase 9H — Backup posture + disaster recovery

### What 9H added

- **`lib/enterprise/disaster-recovery/*`** — `types.ts`,
  `policy.ts` (conservative enterprise defaults — RTO 4h, RPO
  24h, retention 7d floor, quarterly dry-runs),
  `backup-posture.ts` (env-gated Supabase Management API smoke
  probe + safe `unknown` fallback), `restore-intent.ts` (audit
  helper routing through `recordAuditEvent`).
- **3 new audit action constants** — `RESTORE_INTENT_RECORDED`,
  `RESTORE_INTENT_CANCELLED`, `RESTORE_COMPLETED_OUTSIDE_APP`.
- **`GET /api/admin/security/backup-posture`** — admin/owner
  read-only. Returns the typed BackupPostureSummary; never
  surfaces the Supabase Management API token. `AUDIT_EXEMPT`
  (read-only, no mutation).
- **`POST /api/admin/security/restore-intents`** — owner-only.
  Records operator intent via `recordRestoreIntent` →
  `recordAuditEvent`. NEVER executes a restore.
- **`BackupPostureCard`** + **`RestoreIntentCard`** mounted on
  `/dashboard/settings/billing`. Both cards explicitly state
  that restores happen outside the app.
- **`scripts/check-backup-posture.mjs`** — file/route/doc
  presence scanner with optional live Management API probe when
  env vars are set. Wired via `npm run check:backup-posture`;
  NOT in `npm run verify` (external network call).
- **`docs/DISASTER-RECOVERY.md`** — 7 incident classes,
  restore decision tree, Supabase workflow, dry-run checklist,
  customer-facing language.
- **`ADMIN_ENDPOINT_COUNT`** bumped 43 → 45.

### Runbook entries

1. **"BackupPostureCard shows status=unknown."**
   - Expected when `SUPABASE_PROJECT_REF` /
     `SUPABASE_ACCESS_TOKEN` aren't set. The card surfaces
     policy targets + runbook presence; live PITR / last-backup
     checks degrade to `unknown` rather than `critical` because
     "we can't see" is materially different from "we know it's
     broken."
   - Set the two env vars in the deployment platform's secret
     store, restart the server, click Refresh on the card.

2. **"Management API probe returns 401."**
   - The `SUPABASE_ACCESS_TOKEN` lacks read access to the
     project. Mint a fresh personal access token in the
     Supabase dashboard (Account → Access Tokens). Rotate via
     the secrets table in Phase 9E's RUNBOOK section.

3. **"Operator filed a restore intent — what happens next?"**
   - Nothing automatic. The audit row lands in `audit_events`
     (action `restore_intent_recorded`) and the EnterpriseAuditEventsCard
     surfaces it. The actual restore is the operator's
     out-of-app workflow per `docs/DISASTER-RECOVERY.md`.
   - When the restore completes (or is cancelled), the operator
     should file a SECOND intent with
     `status: 'completed_outside_app'` or `'cancelled'` so the
     audit feed reflects closure.

4. **"`npm run check:backup-posture` fails in CI."**
   - The script asserts file/doc presence. The most common
     failure is a missing or renamed file under
     `lib/enterprise/disaster-recovery/`. Re-add or update the
     expected path list at the top of the script.
   - When `SUPABASE_PROJECT_REF` + `SUPABASE_ACCESS_TOKEN` are
     present in CI, the live probe runs. A 4xx/5xx from
     Supabase fails the script — this is intentional (the
     token might have lapsed). Skip the probe in CI by
     unsetting the env vars there if it becomes noisy.

5. **"Want to confirm autonomy is still off."**
   - `curl /api/health | jq '.checks.autonomous_sending_still_disabled'`
     must still return `"mounted"`. 9H added 5 flags
     (`backup_posture`, `disaster_recovery_runbook`,
     `restore_intent_audit`, `backup_posture_card`,
     `backup_posture_check`) alongside it.

## Phase 9I — SOC 2 / enterprise evidence packaging

### What 9I added

- **`lib/enterprise/evidence/*`** — `types.ts`, `control-map.ts`
  (static EVIDENCE_CONTROLS catalog), `report.ts`
  (`buildEvidenceReport()` + markdown/CSV renderers).
- **`GET /api/admin/security/evidence-report`** — admin/owner;
  `format=json|markdown|csv`. Markdown + CSV exports write a
  `evidence_report_exported` audit row; JSON refreshes do not
  (would flood the feed).
- **`SecurityEvidenceCenter`** card on
  `/dashboard/settings/billing` — summary chips + grouped
  controls + Refresh / Markdown / CSV buttons + disclaimer.
- **`scripts/build-evidence-pack.mjs`** — local static
  generator. Writes `artifacts/evidence/{md,csv,json}`. Reads
  the control map source via regex extraction — no Supabase
  creds required. Wired via `npm run build:evidence-pack`.
- **`scripts/check-evidence-packaging.mjs`** — presence scanner
  for the evidence scaffolding. `npm run check:evidence-packaging`.
- **`docs/SOC2-EVIDENCE-MAP.md`** — TSC mapping, certification
  disclaimer, security questionnaire snippets, known gaps.
- **2 new audit action constants** — `EVIDENCE_REPORT_EXPORTED`,
  `EVIDENCE_PACK_GENERATED` (reserved for future).
- **`ADMIN_ENDPOINT_COUNT`** bumped 45 → 46.

### Runbook entries

1. **"Operator asks for a security questionnaire response."**
   - Open `/dashboard/settings/billing`, scroll to the
     SecurityEvidenceCenter, click "Markdown". The download is
     a self-contained report with controls + status + SOC 2
     mappings + disclaimer. Audit row
     `evidence_report_exported` lands automatically.
   - For a no-session response (e.g. helping a customer pre-call):
     `npm run build:evidence-pack` writes the same shape to
     `artifacts/evidence/`. Static — no live backup posture
     snapshot.

2. **"Control map shows `unknown` for backup posture."**
   - Expected when Supabase Management API env vars aren't set.
     See Phase 9H runbook entries for the env doc. The evidence
     report continues without the snapshot; auditors see the
     warning in the report header.

3. **"Want to add a new control to the evidence map."**
   - Edit `lib/enterprise/evidence/control-map.ts`. Add a new
     row to `EVIDENCE_CONTROLS` with id / title / category /
     soc2Categories / status / description / artifacts /
     limitations / recommendedNext.
   - **Honesty rule**: only mark `implemented` if a code path
     actually enforces the control. Docs-only goes `manual`.
     Env-dependent live checks go `unknown` when env is unset.
   - Run `npm run check:evidence-packaging` to confirm the
     scaffolding is still wired. Re-run
     `npm run build:evidence-pack` to refresh the static pack.

4. **"check:evidence-packaging fails in CI."**
   - The scanner checks file presence + package.json scripts +
     doc cross-references. The most common failure is a
     renamed or moved file under
     `lib/enterprise/evidence/`. Update the expected path list
     at the top of the script.

5. **"Want to confirm autonomy is still off."**
   - `curl /api/health | jq '.checks.autonomous_sending_still_disabled'`
     must still return `"mounted"`. 9I added 5 flags
     (`security_evidence_center`, `evidence_report_api`,
     `evidence_pack_generator`, `soc2_evidence_map`,
     `evidence_packaging_check`) alongside it.

## Phase 9J — Enterprise sales readiness + security questionnaire automation

### What 9J added

- **`lib/enterprise/evidence/*`** — `questionnaire-types.ts`,
  `questionnaire-map.ts` (12 sections × ~25 buyer questions
  mapped to Phase 9I evidence controls), `questionnaire-report.ts`
  (builder + markdown/CSV renderers), `security-summary.ts`
  (buyer-facing prose), `readiness-checklist.ts` (12-item
  ready/partial/missing checklist).
- **Migration 031** — added `venues.demo_mode_enabled`,
  `demo_mode_label`, `demo_mode_started_at`,
  `demo_mode_started_by`. Owner-only PATCH via route gate.
- **3 new admin routes**: questionnaire-response,
  buyer-security-summary, demo-mode (GET+PATCH).
- **4 new UI cards** + 1 banner mounted on
  `/dashboard/settings/billing`:
  SecurityQuestionnaireCard, BuyerSecuritySummaryCard,
  DemoModeCard, EnterpriseReadinessCard, DemoModeBanner.
- **3 new audit actions** — `questionnaire_response_exported`,
  `buyer_security_summary_exported`, `demo_mode_updated`.
- **2 new scripts** — `npm run build:questionnaire-pack`,
  `npm run check:sales-readiness`.
- **`docs/ENTERPRISE-SALES-READINESS.md`** — operator workflow,
  buyer-question scripts, review-before-sending checklist.
- **`ADMIN_ENDPOINT_COUNT`** bumped 46 → 49.

### Runbook entries

1. **"Sales engineer needs a security questionnaire response."**
   - Sign in as admin/owner → `/dashboard/settings/billing`.
   - Open SecurityQuestionnaireCard. Pick the format. Click
     Download Markdown.
   - REVIEW before sending (checklist in
     docs/ENTERPRISE-SALES-READINESS.md).
   - Audit row `questionnaire_response_exported` lands
     automatically.

2. **"Need to demo VenueRise to an enterprise prospect."**
   - Owner flips demo mode on via DemoModeCard with the buyer
     label. Dashboard renders "DEMO MODE — Label" banner
     across the topbar. Flip off after the demo. Both edges
     audit via `demo_mode_updated`.

3. **"Demo mode does not anonymize data — what's the right
   move for actual anonymization?"**
   - Phase 9D PII redaction
     (`/api/admin/leads/[leadId]/redact-pii`) is the lead-level
     surface. Demo mode is a visual screen-share signal only.

4. **"No dashboard session — can sales still get the pack?"**
   - `npm run build:questionnaire-pack` writes a static pack
     to `artifacts/evidence/questionnaires/`. Disclaimer +
     review-before-sending notes still apply.

5. **"`check:sales-readiness` fails in CI."**
   - File-presence scanner. A renamed file under
     `lib/enterprise/evidence/` or
     `components/dashboard/settings/` is the most common
     cause. Update the required-files list at the top of the
     script.

6. **"Want to confirm autonomy is still off."**
   - `curl /api/health | jq '.checks.autonomous_sending_still_disabled'`
     must still return `"mounted"`. 9J added 5 flags
     (`security_questionnaire_generator`,
     `buyer_security_summary`, `demo_mode_foundation`,
     `enterprise_readiness_checklist`, `sales_readiness_exports`)
     alongside it.

## Phase 9K — Vendor risk + subprocessor disclosure

### When a new SDK lands in package.json

1. Add a `VendorRecord` entry to
   `lib/enterprise/vendor-risk/vendor-registry.ts` BEFORE
   merging. Populate `id` / `name` / `category` / `purpose` /
   `criticality` / `disclosureStatus` / `dataCategories` /
   `productionUse` / `buyerSafeDescription` / `riskTier` /
   `assuranceStatus` (default `manual_review_required`) /
   `evidence` (env vars + package name) / `knownLimitations` /
   `reviewOwner` / `reviewCadence` / `lastReviewedAt: null`.
2. Add the package + match string to `KNOWN_VENDOR_PACKAGES` in
   `scripts/check-vendor-risk.mjs` so future drift is caught
   automatically.
3. Run `npm run check:vendor-risk` — passes.
4. Run `npm run build:vendor-risk-pack` — regenerates the
   static pack under `artifacts/evidence/vendor-risk/`.

### After a vendor review

1. Update `lastReviewedAt` on the registry row to today's ISO
   date.
2. If executed DPA / current SOC 2 report is on file and
   confirmed by legal, optionally move `assuranceStatus` from
   `manual_review_required` to `verified`. Default to manual
   review on any doubt.
3. Update `knownLimitations` if anything new came up.
4. Commit the registry change with a pointer (e.g. shared
   drive folder id) to the external evidence.
5. If the change affects buyer-facing rows
   (`disclosureStatus === 'public'`), regenerate the pack and
   re-share the buyer disclosure with enterprise prospects per
   their sub-processor change notification SLA.

### When a buyer asks for a subprocessor list

1. Open `/dashboard/settings/billing` (admin or owner).
2. Click **Download Markdown** on the
   "Subprocessor disclosure" card.
3. Review the markdown — confirm every line is buyer-safe
   (no env vars, no internal route paths, no architecture
   details).
4. Attach to the response. The export was audited
   (`subprocessor_disclosure_exported`) so the action is
   traceable.

### When a buyer asks for DPAs

1. Do NOT answer "we have DPAs in place" without confirming.
2. The platform tracks DPA status as `manual_review_required`
   by default. Confirm against the external vendor evidence
   repository before sending any contractual representation.
3. Use the language in `docs/VENDOR-RISK.md` §6 / §7.

### When a vendor security incident is reported

1. Trigger an out-of-cadence vendor review immediately.
2. Update the registry row's `knownLimitations` with the
   incident reference.
3. If the vendor is `disclosureStatus === 'public'`, decide
   whether to notify enterprise prospects per their
   sub-processor change SLA.
4. Update `lastReviewedAt` after the review concludes.

### Cron / scheduled tasks

None. Phase 9K is read-only + operator-triggered. No background
work, no autonomous sending, no audit-event retention sweeps.

## Phase 9L — Incident response

### When a real incident occurs

1. **Open the incident** via IncidentResponseCard `+ New Incident`.
   Pick the right severity from `docs/INCIDENT-RESPONSE.md` §2.
2. **Move to investigating** as soon as triage starts. Add a
   note with the current understanding.
3. **Decide on alerts** — for SEV1/SEV2 click `Send alert`. If
   the response shows `skipped_unconfigured` and the situation
   warrants paging, confirm env vars or fall back to manual
   notification.
4. **Update at the cadence** in the severity matrix (every 60
   min for SEV1, every 4 h for SEV2, daily for SEV3, weekly
   for SEV4). Each update appends a `note_added` timeline event.
5. **Mitigate** — once customer-visible impact is contained,
   move status to `mitigated`. This stamps `mitigated_at`.
6. **Resolve** — once root cause is addressed, move to
   `resolved`. Stamps `resolved_at` + `resolved_by`. Audit row
   is `incident_resolved`.
7. **For SEV1 + SEV2**: write the post-incident review using
   the template at
   `artifacts/evidence/incidents/post-incident-review-template.md`
   (regenerate via `npm run build:incident-response-pack`).
   Append to the timeline via the `postmortem` PATCH field.
8. **Update the runbook** if the incident exposed an
   ambiguity. Reference the PR in the action items.

### When a detector candidate appears

1. Click `Detect Candidates` → `Preview`. Review every
   candidate before clicking `Create all`. Detectors are
   conservative but not infallible — a single noisy buyer
   embed can cross the abuse threshold.
2. For candidates you DO want to materialise, use `Create all`
   (one click) — each candidate becomes a SEV3-suggested
   incident with the source pre-populated and the threshold
   metadata in the row's `metadata` JSON.
3. For candidates you DON'T want, just close the panel. No row
   is written. The `incident_candidates_detected` audit row
   still records that you ran detection.

### When alerts won't fire

1. Check the `Send alert` button's response.
2. `skipped_disabled` → `INCIDENT_ALERTS_ENABLED` is not set
   to `true`/`1`. Update env and redeploy.
3. `skipped_unconfigured` → the channel's env var is missing
   (`INCIDENT_SLACK_WEBHOOK_URL` for Slack,
   `INCIDENT_PAGERDUTY_ROUTING_KEY` for PagerDuty). Sentry uses
   the existing SDK init; if Sentry skipped, the master toggle
   is off.
4. `failed` → look at the timeline event for the short error
   message (e.g. `slack:403` = revoked webhook,
   `pagerduty:429` = rate-limited at the PagerDuty side).
5. Webhook URLs / routing keys are NEVER logged. To debug, set
   the env var to a known-good value and re-fire from the card.

### When a buyer asks "do you have incident response?"

1. Refer them to `docs/INCIDENT-RESPONSE.md` §2 (severity
   matrix) + §6 (automated vs manual).
2. The buyer security summary (Phase 9J) already has an
   `incident-response-detail` section — operators can attach
   the markdown export.
3. Be honest about the §11 / §12 limitations: no 24/7
   staffing, no SLA contract, alert routing is OFF by default.

### Cron / scheduled tasks

None. Phase 9L is entirely operator-triggered. No background
detection cron, no autonomous alert escalation, no auto-resolve.

## Phase 9M — Privacy + DSR readiness

### When a customer files a DSR

1. **Open the DSR** via DsrRequestsCard `+ New DSR`. Pick the
   right type (access / export / delete / correct /
   restrict_processing / opt_out / other) and risk level.
   Capture subject email + name + requested-by email + due
   date.
2. **Move to triage** as soon as the request is acknowledged.
   Add a note with the inbound channel + any context.
3. **Verify subject identity** via your existing process
   (email round-trip, OAuth proof, out-of-band). Once verified,
   click **Mark identity verified**.
4. **Move to in_progress** and decide the response:
   - For access / export requests: click **Export preview** to
     enumerate scope, then run the real export via
     `/api/admin/data-export` (Phase 9D) for venue-scoped JSON
     under legal review.
   - For deletion requests: click **Deletion review** to see
     the retention-exception map, then run real deletion via
     `/api/admin/leads/[leadId]/redact-pii` (Phase 9D) or
     equivalent flow under legal review.
   - For correction requests: update the underlying record via
     the existing operator flow.
5. **Move to awaiting_legal_review** for any response with
   contractual or jurisdictional risk. Append the legal review
   note via the detail panel.
6. **Close** as `fulfilled` / `denied` / `cancelled`. The
   appropriate timestamp + `closed_by` are stamped
   automatically.

### When a buyer asks about privacy posture

1. Open `/dashboard/settings/billing`.
2. **Privacy readiness card** — confirm counts.
3. For procurement evidence, regenerate the static pack:

   ```bash
   npm run build:privacy-pack
   # → artifacts/evidence/privacy/privacy-readiness-report.md
   # → artifacts/evidence/privacy/data-inventory.csv
   # → artifacts/evidence/privacy/retention-policy.csv
   # → artifacts/evidence/privacy/dsr-workflow.md
   # → artifacts/evidence/privacy/privacy-summary.json
   ```

4. Review every line before sending. The questionnaire (Phase
   9J) carries the verbatim answers under §11 / §12 of
   `docs/PRIVACY-DSR-READINESS.md`.

### When a customer asks "do you train AI on my data?"

1. Refer to `docs/PRIVACY-DSR-READINESS.md` §9.
2. The honest answer: VenueRise does not train internally;
   AI inference happens at Anthropic; their training-use
   posture requires legal verification of the active contract.
3. Do NOT say "we never use your data for training" without
   confirmed Anthropic contract terms.

### When a customer asks "where is my data stored?"

1. Refer to the Phase 9K subprocessor disclosure +
   `docs/PRIVACY-DSR-READINESS.md` §2.
2. Default: Supabase US, Vercel US, Anthropic US, Resend US.
3. EU-resident customers can be provisioned on Supabase EU on
   request.

### When a customer asks "how long do you keep my data?"

1. Refer to `docs/PRIVACY-DSR-READINESS.md` §3.
2. Be honest about the gaps — audit / abuse / SSO / incident
   tables currently accumulate; sweepers are planned, not
   live.

### Cron / scheduled tasks

None added in 9M. Phase 9M is operator-triggered + workflow
only. No background DSR processing, no automated retention
sweeper (the audit-class sweepers are reserved for a future
phase pending policy review with legal).

## Phase 9N — Trust Center

### When a buyer asks for security documentation

1. Open `/dashboard/settings/billing` (admin or owner).
2. **TrustCenterCard** — preview the packet at the right
   scope before granting access. Use `Download Markdown` to
   review the manifest content.
3. **TrustAccessGrantsCard** → **New grant**. Fill buyer
   details / scope / expiry days.
4. Save the URL when it appears — it is shown ONCE. The
   creation panel also shows the warning copy + expiry
   timestamp.
5. Send the URL via your buyer communication channel.
6. Monitor access counts + last-accessed in the
   TrustAccessGrantsCard.
7. Revoke when no longer needed.

### When choosing a scope

| Scope | Use when |
|---|---|
| `summary_only` | First procurement contact, NDA not yet signed. |
| `standard_packet` | Post-NDA security review covering questionnaire + privacy + DR + incident posture. |
| `full_packet` | Active enterprise security review or auditor request — includes evidence report + vendor risk report + SOC 2 evidence map. |

For `full_packet`, run a legal review before sending.

### When a grant URL leaks

1. **Revoke immediately** via TrustAccessGrantsCard.
2. The next access attempt with that URL returns the generic
   denial page; an `access_denied` event is recorded.
3. Check the `trust_access_events` log for unauthorised
   downloads. The salted-SHA-256 IP + user-agent fingerprints
   give correlation without exposing raw values.
4. If a sensitive scope (`full_packet`) was potentially
   accessed by an unintended party, file an incident
   (`category = privacy` or `security`) via
   IncidentResponseCard and route through the Phase 9L
   workflow.

### When updating the public page copy

1. Edit `lib/enterprise/trust-center/policy.ts →
   PUBLIC_TRUST_SECTIONS`.
2. Ensure the new section id is in `PUBLIC_SECTION_IDS`.
3. Run `npm run build:trust-center-pack` and review the
   generated public summary markdown.
4. Run `npm run check:trust-center` to confirm scaffolding.
5. Commit + deploy. The public page revalidates every 5
   minutes.

### Cron / scheduled tasks

None added in 9N. Trust Center is entirely operator-managed.
No background grant expiry sweeper (expired grants flip on
first denied validation). No background public-page rebuild
(Next.js ISR handles cache revalidation).

## Phase 9O — Compliance operations calendar

### When you ship a new readiness area (future phase)

1. Add a row to `lib/enterprise/compliance-ops/policy.ts`
   with id / area / cadence / description / owner role /
   evidence references / recommended action / staleAfterDays /
   buyer impact.
2. Update `docs/COMPLIANCE-OPS.md` cadence matrix in the
   same PR.
3. Update the relevant doc's review section if applicable
   (RUNBOOK / VENDOR-RISK / TRUST-CENTER / etc.).
4. Operators re-seed via ComplianceCalendarCard → `Seed
   missing` to pick up the new row.

### When an operator runs a scheduled review

1. Refer to the policy row's `recommendedAction`.
2. Run the actual review (walk the vendor registry, do the
   DR drill, regenerate the pack, etc.).
3. Capture notes + optional evidence URL (shared drive
   doc / ticket / diff link).
4. Open the row in ComplianceCalendarCard → paste notes +
   URL → click `Mark completed`.

### When a review needs to be waived

1. Identify the reason (policy superseded, area covered by
   another control, scoped-out for this venue).
2. Type the explicit reason into the waiver field.
3. Click `Waive`. The row stays in the trail.
4. If the underlying policy item is genuinely no longer
   applicable, update `lib/enterprise/compliance-ops/policy.ts`
   in a follow-up PR.

### When you need to re-schedule

The seed helper does NOT auto-reschedule on completion. After
a wave of completions:

1. Open ComplianceCalendarCard → `Seed missing`.
2. The helper inserts fresh upcoming events for any policy
   items without an active row.

### When a buyer asks about review cadence

1. Open `/dashboard/settings/billing` → ComplianceCalendarCard.
2. Click `Freshness MD` → download
   `venuerise-compliance-freshness-YYYY-MM-DD.md`.
3. Review every line. Confirm no internal review notes leak
   subject identity or operator personal data.
4. If the buyer is post-NDA, share the markdown directly. If
   pre-NDA, send the static `compliance-review-policy.md` pack
   (cadence-only, no completion timestamps).

### Cron / scheduled tasks

None added in 9O. The calendar is entirely operator-pull. No
background reminder job, no external alerting, no autonomous
state change. Future phases could add an Inngest reminder cron
that surfaces overdue reviews in the operator digest — that
remains explicitly opt-in.

## Phase 9P — Contract commitments register

### When sales / legal signs a new MSA / DPA / security addendum

1. Walk the contract for customer-specific commitments —
   anything that obligates VenueRise to a specific behaviour
   for THIS buyer that differs from the baseline product.
2. Open `/dashboard/settings/billing` → CommitmentsRegisterCard
   → `+ New commitment`.
3. Record one row per commitment with:
   - Buyer identity (company + email).
   - Source type (msa / dpa / security_addendum / order_form / trust_grant / email / other).
   - Commitment area (closest match).
   - Title (1-line).
   - Description (paragraph quoting the relevant clause).
   - Status = `draft` until the contract is signed; flip to
     `active` after.
   - Risk level (operator judgement).
   - Owner (the operator accountable).
   - Due / review dates (when do we need to fulfil; when do
     we re-check).
   - Evidence URL (shared drive doc / ticket / contract).
4. Check CommitmentsReadinessCard for unsupported-risk
   warnings on any rows you just added. Walk each warning
   with the buyer if applicable before flipping to `active`.

### When an unsupported-risk warning surfaces

1. Read the reason carefully. The warning explains what the
   product DOES / DOES NOT support today.
2. Options:
   - **Renegotiate**: ask the buyer to amend the commitment to
     reflect current capability. Update the commitment row.
   - **Withdraw**: status → `withdrawn` + record the reason
     in notes.
   - **Commit + plan**: leave the row as recorded; file a
     follow-up product phase that implements the capability;
     keep risk = `high` until shipped.
3. Do NOT silently leave the commitment `active` without
   addressing the warning.

### When a commitment hits its review date

1. Open the row in CommitmentsRegisterCard.
2. Confirm we still meet it. Update evidence URL if needed.
3. Click `Mark reviewed`. The next review window starts now.
4. Cross-link in the Phase 9O compliance calendar: capture
   the review as a custom compliance event with
   `evidence_url` pointing at the commitment.

### When a commitment is fulfilled / expires / is superseded

- **Fulfilled**: operator confirms we met it → `Mark
  fulfilled`. Stamps `fulfilled_at` + `fulfilled_by`. Use
  for one-off commitments.
- **Expired**: time-bound commitment past its window →
  `Set status: expired`.
- **Superseded / cancelled**: → `Set status: withdrawn` +
  record the reason in notes (we never DELETE).

### When sales asks "what did we promise this buyer?"

1. Open CommitmentsRegisterCard.
2. Filter by buyer company.
3. Review every row. Cross-check `evidence_url` is current.
4. For deep procurement reviews, download the CSV via the
   admin route and share internally after redaction review.

### When a buyer asks about commitment tracking posture

1. Open `/dashboard/settings/billing` →
   CommitmentsReadinessCard.
2. Click `Download Markdown` → review every line.
3. **Redact buyer-specific commitment titles + notes before
   sharing externally** — the readiness export is buyer-
   identifying. The static pack (`build:commitments-pack`)
   contains only per-area support posture and is safe to
   share without redaction.

### Cron / scheduled tasks

None added in 9P. The register is entirely operator-pull. No
background reminder cron, no external alerting, no autonomous
state change. Future phases could add a digest reminder of
overdue reviews; that remains explicitly opt-in.

---

## Phase 8BE — Omnichannel inbox foundation

Operator-facing surfaces:

- `/dashboard/settings/billing` → **Channel connections** card
  shows every supported channel with posture (inbound /
  outbound / manual reply) and active connection rows.
  Add / mark disconnected / save label here.
- Inbox + lead drawer render `ChannelSourceBadge` per
  conversation / message bubble when the channel metadata
  is stamped.
- When the operator drafts a reply on a manual-required
  channel, the `ManualChannelReplyBanner` mounts with a
  `Copy reply` button + a `Mark sent manually` confirmation.
  Pressing `Mark sent manually` records a `human` message in
  the conversation and stamps an `external_messages` row
  with `delivery_status='marked_sent_manually'`.

Public inbound routes (all anonymous, IP+venue rate-limited):

- `POST /api/integrations/website/message` — structured
  website intake (sibling to `/api/widget`).
- `POST /api/integrations/lead-forwarding/the-knot` and
  `…/weddingwire` — structured forwarded-lead intake. No
  raw email parsing in this phase.
- `GET|POST /api/integrations/meta/webhook` — placeholder.
  Verification round-trip works when
  `META_WEBHOOK_VERIFY_TOKEN` is set; POST accepts and
  returns 202 without normalizing. Real handler ships in
  Phase 8BF.

No autonomous sending. No real OAuth.
`autonomous_sending_still_disabled` health flag stays mounted.
See `docs/OMNICHANNEL-INBOX.md` for the full posture and the
operator workflow.

---

## Phase 8BE-2 — Omnichannel inbox activation patch

Patch on top of Phase 8BE. Two behaviours are now operator-
visible:

1. **Channel badges in the inbox.** ConversationList rows on
   `/dashboard/inbox` and `/dashboard/inbox/[leadId]` now show
   the source channel badge (Website / Instagram / Facebook /
   Meta Lead Ad / Email / The Knot / WeddingWire / Manual)
   for any conversation that has a normalized
   `external_conversations` mapping OR a
   `messages.metadata.channel_type` stamp. Legacy
   conversations without channel context render unchanged.
2. **Manual-required workflow in LeadDetailDrawer.** When the
   selected lead's conversation lives on a manual-required
   channel, the drawer mounts `ManualChannelReplyBanner`
   above the Approve & send row. The Approve & send button
   is disabled (label flips to `Manual reply only`) and the
   operator's path is Copy reply → send out-of-band →
   `Mark sent manually`. The audit + external_messages
   trail records the operator assertion; VenueRise does NOT
   claim to have delivered the reply.

No new admin routes; `ADMIN_ENDPOINT_COUNT` stays at 72.
See `docs/OMNICHANNEL-INBOX.md` §13 for the full activation
detail.

---

## Phase 8BG — Lead-forwarding parser

The Knot + WeddingWire lead-forwarding routes
(`/api/integrations/lead-forwarding/the-knot`,
`/api/integrations/lead-forwarding/weddingwire`) now run
incoming payloads through a deterministic parser. Confidence +
needs-review flag are stamped onto both `messages.metadata`
and `external_messages.metadata`.

Operator-visible signals:

- **Inbox sidebar**: amber dot next to the channel badge when
  the latest inbound message carries `parse_needs_review`.
- **ConversationThread bubble**: "Needs parse review" pill on
  the bubble itself with confidence + missing signals on
  hover.
- **LeadDetailDrawer**: a "Source parse review" panel renders
  next to the recovery / reactivation panels when a lead's
  most-recent inbound message needs review. Shows extracted
  event date / guests / budget + missing signals list.
- **ChannelConnectionsCard**: The Knot + WeddingWire rows now
  say "Lead forwarding parser active · Outbound reply: manual
  · Parse confidence review: active".

Operator QA:

- `POST /api/admin/integrations/lead-forwarding/test-parse` —
  admin-only. Runs the parser without creating a lead. Body:
  `{ channel_type, subject?, body?, payload? }`. Returns the
  fully-parsed shape so operators can validate a forwarder
  before pointing it at the public route. PII-light audit
  metadata; raw body is NEVER logged.

`ADMIN_ENDPOINT_COUNT` bumped 72 → 73.

---

## Phase 8BF — Meta / Instagram / Facebook connector

Replaces the placeholder webhook with verified inbound.

Operator setup:
1. Set `META_WEBHOOK_VERIFY_TOKEN` + `META_APP_SECRET` in
   prod env. Until both are set, the webhook returns 503
   `webhook_not_configured` (POST) / 503 `placeholder_only`
   (GET).
2. In ChannelConnectionsCard create an `instagram` /
   `facebook` / `meta_lead_ads` connection and fill the
   Meta identifier fields (Page ID, IG Business Account ID,
   Ad Account ID, App ID). NO tokens — the admin route
   rejects token/secret-shaped keys server-side.
3. In Meta App Dashboard subscribe the webhook to
   `https://<host>/api/integrations/meta/webhook` with the
   matching verify token.

Operator-visible behaviour:
- Verified inbound messages from Instagram / Facebook
  thread into the existing inbox, render the source badge
  via Phase 8BE-2, and the Approve & send button stays
  gated by the manual-required banner.
- Lead-ad submissions land as placeholder messages with
  the "Needs parse review" badge until Graph hydration
  ships in 8BF+1.

QA endpoint:
- `POST /api/admin/integrations/meta/test-parse` — pure
  parser, no DB writes, no signature required. Useful for
  demos and payload-shape validation.

`ADMIN_ENDPOINT_COUNT` bumped 73 → 74.

No autonomous sending. No Send API call.
`autonomous_sending_still_disabled` health flag stays
mounted.

---

## Phase 8BH — Website + Ads attribution

Operator-visible:
- New leads from the widget and from omnichannel inbound
  (Instagram / Facebook / Meta lead-ads / The Knot /
  WeddingWire / manual) carry `metadata.attribution`.
- AttributionPerformanceCard on `/dashboard` groups by
  source label.
- Analytics page renders the breakdown as a table.
- LeadDetailDrawer shows an AttributionPanel with campaign,
  landing page, referrer, and click-ID presence badges.
- KanbanCard rows show a compact source badge alongside
  the lead email.

Widget integration:
- `public/widget.js` captures UTM + click IDs + referrer +
  landing page from the parent page and forwards via
  iframe query params.
- The embedded widget page reads them on mount and submits
  them with the intake POST.
- Locked-down embeds with no readable `window.location`
  still submit successfully — the lead just lands as
  `Website` (or `Unknown` if no channel context).

Honesty:
- No pixel.
- No ad-platform API call.
- No multi-touch.
- "Estimated pipeline" is summed from operator-entered
  budgets — NOT ROAS.

`ADMIN_ENDPOINT_COUNT` is unchanged (no new admin routes).

---

## Phase 8BI — Booked revenue attribution

Operator-visible surfaces:

- **`/dashboard` BookedRevenueAttributionCard**: top 5
  sources by estimated booked value with leads / tours /
  booked / L→Booked rate columns. Empty state when no
  attributed leads have reached booked yet.
- **`/dashboard/analytics` "Booked revenue by source"
  section**: full table with the same metrics plus tours,
  pipeline, and L→Tour rate.
- **LeadDetailDrawer Attribution panel**: header flips to
  "Booked source" + estimated-booked pill on booked leads.
- **KanbanCard**: Budget row label flips to "Est. booked"
  with emerald tone for booked leads.

Helper:
- `lib/enterprise/attribution/revenue.ts` —
  `buildAttributionRevenueSummary({leads, tours})` returns
  per-source rollup + totals + disclaimer. Pure function.
- `formatBookedValueShort(n)` — `$15k` / `$1.2M` style
  shortener reused across surfaces.

Honesty contract (carried in every render):
- NOT ROAS — ad spend is not connected.
- Booked value is **estimated** from `leads.budget`. There
  is no dedicated booked-contract-value column yet.
- Legacy leads with no `metadata.attribution` group under
  `Unknown`.
- Multi-touch attribution is not supported.

`ADMIN_ENDPOINT_COUNT` unchanged (no new admin routes).

---

## Phase 8BJ — Source-level revenue leakage drilldowns

Operator-visible surfaces:

- **`/dashboard` SourceRevenueLeakageCard**: top 5 sources
  by at-risk lead count, with leads / booked / est. booked /
  top leak / at-risk columns + per-row CTA into the leads
  board.
- **`/dashboard/leads?source=<SourceLabel>`**: source filter
  pill (amber) that composes on top of the existing leakage
  filter pill (blue). Each pill has an independent "Clear"
  control. DnD reordering is disabled while EITHER filter is
  active (same posture as `?leakage=`).
- **AttributionPerformanceCard + BookedRevenueAttributionCard**:
  each source row now has a "View leads →" CTA linking to
  `/dashboard/leads?source=<sourceLabel>`. Additive only —
  card numbers and meaning unchanged.
- **`/dashboard/analytics` "Source leakage breakdown"
  section**: per-source table with Leads / Booked / Slow
  reply / No tour / Recovery / Reactivation / Top leak /
  At-risk + a View leads CTA.
- **LeadDetailDrawer Attribution panel**: read-only context
  lines naming the lead's source cohort and (when present)
  the active leakage bucket.

Helpers:
- `lib/enterprise/attribution/leakage.ts` —
  `buildSourceLeakageSummary({leads, tours, outbound,
  inbound, lastMessages, settings})` returns per-source row
  buckets + totals + disclaimer. Composes existing
  `computeRevenueLeakage` / `computeRecoverySignals` /
  `computeTourBookingSignals` / `computeReactivationSignals`.
  Pure function, never throws.
- `sourceLeakageForLead({...args, leadId})` returns the
  single highest-priority active leakage key for one lead.

Honesty contract (carried in every render):
- NOT ROAS — no ad-platform API calls, no spend ingestion.
- Booked / pipeline values are **estimated** from
  `leads.budget`.
- Attribution is the captured intake-time signal —
  multi-touch is not supported.
- Legacy leads with no `metadata.attribution` group under
  `Unknown` so the unattributed cohort is always visible.
- Source leakage is an operator prioritization lens, not an
  accounting report.

`ADMIN_ENDPOINT_COUNT` unchanged (no new admin routes).

---

## Phase 9Q — Payment Methods + Stripe Billing Portal

Operator-visible surface:

- **`/dashboard/settings/billing` PaymentMethodsCard**: header
  "Payment methods" + Stripe-hosted message + status badge
  (active / trialing / past-due / canceled / incomplete /
  none / unknown). One primary CTA: **Manage payment method**
  (when a Stripe customer exists) or **Set up billing** (when
  one does not).
- Read-only data shown: Stripe customer connected / not
  connected; "Open Stripe portal to view or update payment
  methods." We deliberately do NOT render card brand or last4.
  No Stripe API fetch is added — the portal is the source of
  truth.

Routes:

- `POST /api/billing/portal` — unchanged contract; now reads
  the venue subscription snapshot via
  `getVenueSubscriptionStatus(venueId)` (request-memoized) and
  records `subscription_status`, `stripe_customer_present`,
  and `source` in the audit metadata. ADMIN_ROLES gated.
  User-scoped rate-limit. Returns `{ url }` on success.
  Error codes: `unauthorized` / `no_venue` /
  `tenant_access_*` (forbidden family) / `rate_limited` /
  `billing_not_configured` (503) / `billing_customer_not_found`
  (404) / `stripe_failed` / `unexpected_error`. The Phase 9Q
  PaymentMethodActions client maps these to friendly strings.
- `POST /api/billing/checkout` — used as the fallback when no
  Stripe customer exists yet. Unchanged.

Env vars used:

- `STRIPE_SECRET_KEY` (required for any portal / checkout call)
- `STRIPE_WEBHOOK_SECRET` (already used by /api/stripe/webhook)
- `STRIPE_DEFAULT_PRICE_ID` (used by checkout fallback)
- `STRIPE_BILLING_PORTAL_RETURN_URL` (return URL from Stripe
  portal back into the app; falls back to dashboard if unset)
- `STRIPE_CHECKOUT_SUCCESS_URL` / `STRIPE_CHECKOUT_CANCEL_URL`
  (used by checkout)

Local testing:

1. Set `STRIPE_SECRET_KEY` (test mode) + `STRIPE_DEFAULT_PRICE_ID`
   in `.env.local`.
2. As an admin, navigate to `/dashboard/settings/billing` and
   click **Set up billing** if you have no Stripe customer yet.
   Complete the test-card checkout flow.
3. Return to `/dashboard/settings/billing`. The Payment Methods
   card should now show "Stripe customer: Connected" and the
   CTA should be **Manage payment method**.
4. Click **Manage payment method** → Stripe Billing Portal opens.
5. Inspect EnterpriseAuditEventsCard for a
   `billing_portal_session_create` row with metadata.source =
   `payment_methods_card`.

Troubleshooting:

- "Stripe is not configured for this deploy." → set
  `STRIPE_SECRET_KEY` and restart.
- "Stripe customer missing. Start checkout first." → the venue
  has no `billing_customers` row yet. Walk the checkout flow.
- "Only venue owners and admins can manage billing." → caller's
  role is sales/coordinator/viewer. Promote via team management.
- "Could not open Stripe portal." → check `STRIPE_SECRET_KEY`
  matches the mode (test vs live) of the customer record; check
  Sentry for the captured `billing.portal.unexpected` error.

Honesty contract:

- We DO NOT claim PCI compliance, Stripe certification, or
  "fully secure".
- Allowed copy: "processed by Stripe", "full card details are
  not stored in VenueRise", "billing actions are audited".
- The portal is Stripe-hosted by design — VenueRise will not
  build a custom card form (out of scope; raises PCI surface
  unnecessarily for the same UX outcome).

`ADMIN_ENDPOINT_COUNT` unchanged (no new `/api/admin/*` routes).

---

## Phase 9R — Subscription Plans + Pricing Tiers

Operator-visible surface:

- **`/dashboard/settings/billing` SubscriptionPlansCard**: 4 tier
  cards (Starter $497 / Growth $997 / Elite $1,997 / Enterprise
  Custom). Growth carries the **Recommended** chip. The currently
  active plan carries a **Current** chip. Card header shows
  "Current plan: <name>" plus subscription status + interval.

Plan catalog: `lib/billing/plans.ts`. Single source of truth.
Feature gates helper: `lib/billing/plan-gates.ts` (foundation only
— **not** enforced globally in 9R).

Routes:

- `POST /api/billing/checkout` — extended body. Accepts:
    `{ plan_id, interval, source }` (Phase 9R) — preferred.
    `{ price_id }` (legacy) — still accepted.
    No body (`{}`) — falls back to `STRIPE_DEFAULT_PRICE_ID`.
  - Enterprise → 400 `enterprise_contact_required`.
  - Plan missing matching env var → 422 `stripe_price_not_configured`
    with `detail: { plan_id, interval }`.
  - All existing gates preserved: auth / ADMIN_ROLES /
    rate-limit (`billing:checkout:${userId}`) / audit.
  - Audit metadata now also carries `plan_id`, `interval`,
    `stripe_price_configured`, `source`.

Env vars (NEW in 9R):

```
STRIPE_PRICE_STARTER_MONTHLY=
STRIPE_PRICE_STARTER_ANNUAL=
STRIPE_PRICE_GROWTH_MONTHLY=
STRIPE_PRICE_GROWTH_ANNUAL=
STRIPE_PRICE_ELITE_MONTHLY=
STRIPE_PRICE_ELITE_ANNUAL=
```

Local test:

1. In Stripe Dashboard → Products, create monthly + annual prices
   for Starter / Growth / Elite. Copy each `price_…` id.
2. Set the matching env vars in `.env.local`. Restart `npm run dev`.
3. As an admin, open `/dashboard/settings/billing` → confirm all
   4 plan cards render + CTAs are enabled.
4. Click Growth → `Start plan` → Stripe Checkout opens with the
   monthly Growth price; complete with the 4242 test card.
5. Return to billing — header should now read "Current plan: Growth
   · Active · monthly", and the Growth card carries the **Current**
   chip.
6. Inspect EnterpriseAuditEventsCard for the
   `billing_checkout_session_create` row with
   `metadata.plan_id='growth'`.

Current plan resolution:

- Helper: `lib/billing/current-plan.ts` →
  `getCurrentPlanForVenue(venueId)`. Service-role read,
  request-memoized. Resolution order:
    1. `subscriptions.metadata.plan_id` (set by Phase 9R checkout)
    2. `subscriptions.stripe_price_id` reverse-lookup against
       the env-configured plan catalog
  Returns `null` when neither path resolves — card shows
  "Current plan: Not set" and an unprompted upgrade flow.

Webhook compatibility:

- `app/api/stripe/webhook/route.ts` was NOT modified. The webhook
  already copies the full `subscription.metadata` object into
  `subscriptions.metadata`, so the `plan_id` + `interval` keys we
  added to the Stripe subscription metadata flow through
  automatically. Legacy venues (no plan_id metadata) resolve via
  the price-id reverse lookup.

Plan limits posture:

- `limits.venues / leadsPerMonth / adminSeats / teamSeats` are
  rendered in the card but are NOT enforced anywhere yet. This is
  a Phase 9R **foundation** commitment — sudden hard-blocking
  would break trial users. Future phases can call
  `canUseFeature(planId, featureKey)` to soft-gate.

Honesty contract:

- We DO NOT claim SOC 2, GDPR, HIPAA, PCI, real SSO, SCIM, or
  24/7 monitoring. Trust / privacy / SSO surfaces are described as
  **readiness scaffolding** — operator-controlled workflows
  shipped today, not certifications.
- Plan limits are PRODUCT controls, not legal / compliance
  guarantees.
- Card data still lives only inside Stripe — Phase 9R adds no card
  storage or card form.

`ADMIN_ENDPOINT_COUNT` unchanged (no new `/api/admin/*` routes).

---

## Phase 9S — UI Interaction Audit + Dead Button Fix Pass

Two new CI scanners + a per-surface audit doc:

- `npm run check:ui-interactions` — catches placeholder hrefs,
  empty `onClick={() => {}}`, `alert()` / `window.confirm()`
  outside admin destructive flows, `console.log` in client
  components, JSX placeholder text. Exemptions via
  `// UI_INTERACTION_EXEMPT: <reason>` on the same line OR the
  line immediately above the offending statement.
- `npm run check:fetch-routes` — walks every client
  `fetch('/api/...')` and verifies the URL resolves to an
  `app/api/.../route.ts` on disk. Tolerates string-concat +
  first-segment-dynamic templates as info-only.

Inventory + status table: `docs/UI-INTERACTION-AUDIT.md`.

Honest disablement pattern added by 9S:

- `<button disabled className="text-[#CBD5E1] cursor-not-allowed"
  title="<why this isn't enabled>" aria-label="<same>">…</button>`
- Add an inline yellow callout above the surface when an entire
  workflow is read-only (see `KnowledgeBaseTab`).

P0 / P1 fixes shipped:

- KnowledgeBaseTab Add / Toggle / Delete buttons removed (dead
  routes). Tab is now read-only + carries a "Contact support to
  edit" callout. Will return as a real CRUD surface in a future
  phase.
- MessageComposer Paperclip + Mic buttons disabled with tooltip
  ("Attachments are not yet enabled" / "Voice input is not yet
  enabled"). Will return when upload + transcription paths ship.

`ADMIN_ENDPOINT_COUNT` unchanged at 74. No new routes added.

---

## Phase 9T-alt — Knowledge Base CRUD + Audit + Rate-Limit

Operator-visible surface:

- **`/dashboard/settings` → Knowledge Base tab**: full inline
  CRUD restored. Add entry button, per-row edit (Save icon),
  toggle active/inactive (Check icon), delete (Trash icon with
  native confirm). Per-row spinners + inline error rendering;
  no row blocks another from saving.
- Header callout reads: "These entries guide AI replies. Avoid
  pasting secrets, credentials, or anything you wouldn't want
  surfaced in a reply. Edits are audited."

Routes:

- `GET    /api/venues/[id]/knowledge`                  — list (any venue member)
- `POST   /api/venues/[id]/knowledge`                  — create (SALES_ROLES)
- `PATCH  /api/venues/[id]/knowledge/[knowledgeId]`    — update / toggle (SALES_ROLES)
- `DELETE /api/venues/[id]/knowledge/[knowledgeId]`    — delete (SALES_ROLES)

Auth + safety:
- SALES_ROLES = owner / admin / sales_manager / coordinator,
  matching `knowledge_base` RLS in migration 005.
- Cross-tenant forbidden collapses to 404.
- Zod validation: title 1–160, content 1–8,000, category ≤80,
  priority 0–100, is_active boolean. PATCH with empty body →
  400 `validation_failed`.
- User-scoped rate limit per HTTP verb
  (`venues:knowledge:{list|create|update|delete}:<userId>`).

Audit:
- `KNOWLEDGE_ENTRY_CREATED` — after metadata only (no full content).
- `KNOWLEDGE_ENTRY_UPDATED` — before + after metadata; changed
  field list in `metadata.fields`.
- `KNOWLEDGE_ENTRY_TOGGLED` — distinct action when only
  `is_active` flips, so admins can filter enable/disable churn.
- `KNOWLEDGE_ENTRY_DELETED` — before snapshot only.
- Audit metadata captures `title`, `category`, `priority`,
  `is_active`, `content_length`. Full `content` is NOT mirrored
  to the audit feed.

Behavior preserved:
- AI orchestrator reads `public.knowledge_base` at conversation
  time (unchanged from before 9T-alt). New / updated entries
  flow into the next reply without an agent prompt change.
- `ADMIN_ENDPOINT_COUNT` still 74 — these are venue routes, not
  admin routes.

Troubleshooting:
- "Stripe customer missing" copy → wrong surface; this tab
  doesn't touch billing.
- "Only owners, admins, sales managers, or coordinators can
  edit knowledge." → caller's role is viewer. Promote via team
  management.
- "Invalid input. Check title (1–160) and content (1–8,000)." →
  empty / over-length submission rejected at Zod.
- Entry disappears after delete → success path; audit row
  `knowledge_entry_deleted` appears in EnterpriseAuditEventsCard.

Honesty:
- Knowledge entries influence AI replies. The audit feed is
  admin-readable; full content is intentionally not mirrored
  there because operators are warned via UI copy to keep
  secrets out, but we don't want auditors browsing pasted
  business content either. The audit row tells you WHEN and
  WHO; the entry itself lives in the table.

---

## Phase 9T — Playwright Runtime Interaction QA

Scope: core operator workflows. Static UI + fetch-route scanners
from 9S still ship; 9T adds the load/error/redirect coverage
those scanners can't see.

Test files:
- `tests/e2e/core-dashboard.spec.ts` — overview load, command
  palette, Add Lead → Kanban → drawer → close.
- `tests/e2e/settings-knowledge.spec.ts` — full Knowledge Base
  CRUD round-trip (add / edit / toggle / delete) + empty-content
  validation.
- `tests/e2e/settings-availability.spec.ts` — Availability tab
  render + Blackout add/delete round-trip.
- `tests/e2e/inbox-tours-smoke.spec.ts` — Inbox page render,
  Paperclip+Mic disabled assertion, Tours calendar render,
  Billing cards render, optional Stripe portal CTA gated on
  `E2E_ALLOW_STRIPE=1`.

Helpers:
- `tests/e2e/helpers/selectors.ts` — single source of truth for
  every `data-testid` the suite touches. Update here when a
  testid is renamed.
- `tests/e2e/helpers/auth.ts` — `gotoDashboard()` + early
  storage-state assertion.
- `tests/e2e/helpers/seed.ts` — `cleanupKnowledgeEntriesByPrefix`
  for E2E-prefixed rows.

### One-time auth setup

Tests use Playwright `storageState` from `.auth/admin.json` (in
`.gitignore`). Generate once per workstation:

```bash
# 1. Make sure the app is running and you have a test venue:
npm run dev
npm run demo:seed   # if you haven't yet — creates a venue + user

# 2. Open Playwright codegen against the app:
npx playwright codegen http://localhost:3000/login

# 3. Sign in as the admin user.
# 4. In the codegen window menu, "Save Storage State…" → save as
#    `.auth/admin.json` at the repo root.
```

Sanity check the file exists:
```bash
ls -la .auth/admin.json
```

### Run the tests

```bash
# Make sure the dev server is running in another terminal first
npm run dev

# In another terminal:
npx playwright install chromium   # first time only
npm run test:e2e:core              # core workflows
npm run test:e2e                   # full E2E suite
npm run test:e2e:headed            # open Chromium with the UI
```

Reports:
- Console: `list` reporter by default (CI gets `list` + HTML).
- On failure: `playwright-report/index.html` + `test-results/`
  with traces, screenshots, and a retry video.

### Env vars used

```
E2E_BASE_URL=http://localhost:3000   # required
E2E_VENUE_ID=                         # optional; cross-tenant probes
E2E_ALLOW_STRIPE=                     # set to 1 to exercise portal CTA
```

Auth email/password are NOT consumed by the suite — they're only
needed during the manual `codegen` flow.

### What is NOT covered yet

- AI generation paths (`/api/ai/draft`, `/api/ai/chat`) — those
  need Anthropic credentials + a stable prompt.
- Drag-and-drop reordering on the Kanban board.
- Realtime layers (digest sends, tour status, AI audit).
- Stripe checkout completion (CTA assertion is gated on
  `E2E_ALLOW_STRIPE=1`; the full flow stays manual).
- The 47 enterprise cards individually. The smoke spec only
  asserts that the billing page mounts; per-card runtime
  coverage is a future phase.
- External-channel send paths (Meta, Instagram, email) — the
  manual-reply posture is enforced server-side, and the UI
  surfaces that gate honestly; runtime coverage of the actual
  external send is intentionally out of scope.

### Honesty contract

- We do NOT add a test-auth API route to production code. The
  storage state mechanism keeps the suite honest about how the
  app actually authenticates.
- Tests use `E2E `-prefixed names so cleanup can locate them
  without risking real data.
- Stripe checkout is opt-in. Default runs never hit Stripe.
- Console errors fail the test by default. The allowlist is
  narrow (browser-extension hydration noise only).

`ADMIN_ENDPOINT_COUNT` unchanged — no new routes added.

---

## GTM-0A — Revenue Recovery Demo Seed

Quick-seed a wedding-venue pipeline so `/dashboard` tells the
Revenue OS story in 30 seconds. Designed for sales demos and
pilot setup.

Full doc: `docs/DEMO-REVENUE-RECOVERY.md`.

Operator surface:
- `/dashboard/settings/billing` → **Revenue Recovery demo mode**
  card (admin-only). Toggle "Reset previous demo seed first" if
  you want a clean re-seed, then click **Seed demo data**.
- Or hit the route directly:
  ```bash
  curl -X POST http://localhost:3000/api/admin/demo/revenue-recovery-seed \
    -H "Cookie: <admin-session>" \
    -H "Content-Type: application/json" \
    -d '{"reset_existing_demo_data": true}'
  ```

What it seeds:
- 24 leads tagged `metadata.demo_seed=true` across every stage,
  with `metadata.attribution` and (for lost rows)
  `metadata.lost_reason`.
- ~14 conversations / ~25 messages with `channel_type` set per
  message. One Meta lead carries `parse_needs_review`.
- 7–8 tours (scheduled / confirmed / completed).
- 5 venue_channel_connections (Website connected, others
  manual_only). No tokens.
- 6 knowledge_base entries **only when the venue has none**.
- 3 tour_availability slots + 1 blackout **only when empty**.

What it never does:
- Calls Stripe, Anthropic, or any external platform.
- Deletes non-demo rows. Reset matches `metadata->>demo_seed`
  only; tables without that metadata column
  (`knowledge_base`, `tour_availability`, `tour_blackouts`) are
  never reset — the result's `warnings` array documents this.
- Sends a real message. `autonomous_sending_still_disabled`
  health flag stays mounted.

Audit: every seed call writes `revenue_recovery_demo_seeded`
to `public.audit_events` with the counts + reset flag.

Rate limit: `admin:demo:revenue-recovery-seed:<userId>` —
user-scoped. The seed is heavy (~24 leads + their artifacts);
the limiter keeps a single operator from hammering it.

`ADMIN_ENDPOINT_COUNT` bumped 74 → **75** (new admin route).

---

## GTM-0B — Public marketing reposition

Public homepage repositioned around the Revenue OS wedge.

Section order on `/`:
- Hero → PainPoints (5 leaks) → HowItWorks (4-step loop) →
  DemoPreview (static mock dashboard) → Differentiation (operator
  control + honesty) → ROI (pilot offer) → FAQ → FinalCTA
  (AuditForm).

New routes:
- `/demo` — pilot application landing zone. Reuses the existing
  `AuditForm` (writes to `audit_leads` Supabase table). No new
  backend.

Removed from the page:
- `SocialProof` "Trusted by top venues nationwide" + venue-type
  marquee — we don't have public partner logo rights yet.
- `Solution` generic 6-feature grid — replaced by the 4-step
  HowItWorks loop.
- `Trust` generic shield-icon section — folded into
  `Differentiation` as the operator-control + honesty surface.

Removed copy (autonomy overclaims):
- "Respond in under 60 seconds" / "24/7 sales coordinator" — these
  implied autonomous sending, which is not the product posture.
- "3× more tours" / "80% less follow-up" — specific lift % we
  don't have public case-study evidence for.

Approved + forbidden claim list: `docs/GTM-POSITIONING.md` (single
source of truth).

CTA inventory: every CTA points at a real anchor or `/demo`.
`check:ui-interactions` + `check:fetch-routes` pass; no dead
links. `ADMIN_ENDPOINT_COUNT` unchanged.

Marketing QA checklist (run before promoting copy changes):

- [ ] Homepage builds cleanly (`npm run build`).
- [ ] `/` renders without runtime errors in browser console.
- [ ] Hero headline + subhead match `docs/GTM-POSITIONING.md`.
- [ ] All anchors resolve (`#leaks`, `#how-it-works`, `#why`,
      `#pilot`, `#faq`, `#apply`).
- [ ] Hero "Book a demo" → `/demo`. `/demo` renders + form
      submits to `audit_leads`.
- [ ] No fake testimonials, no fake partner logos, no fake "trusted
      by N venues" claims.
- [ ] No autonomous-send copy ("AI responds in N seconds", "24/7
      sales coordinator").
- [ ] No SOC 2 / GDPR / PCI / HIPAA / "fully secure" claims.
- [ ] FAQ "Does AI send messages automatically?" answers No.
- [ ] FAQ "Is this a CRM?" answers No.
- [ ] Pilot section uses "Pilot packages available" rather than a
      specific price.
- [ ] Footer points at `/demo`, not the old `#audit` anchor.

---

## GTM-0A.2 — Revenue Recovery Load / Stress Demo seed

**Route:** `POST /api/admin/demo/revenue-recovery-load-seed`
**Card:** Settings → Billing → "Revenue Recovery load / stress demo"

### Operator QA

- [ ] Card renders for admins only (`isAdmin && <RevenueRecoveryLoadDemoCard />`).
- [ ] Lead count picker offers 100 / 250 / 500 / 1000.
- [ ] Profile picker offers balanced / high_volume / messy_channels / sales_demo.
- [ ] "Reset previous load-seed rows" checkbox is wired and warns that it does NOT touch the hand-crafted GTM-0A demo.
- [ ] Submit calls the route, returns a `SeedResult` with distribution breakdown shown in collapsible sections.
- [ ] Distribution panel renders 5 sections: Stage mix, Source mix, Channel mix, Leakage signals, Lost reasons.
- [ ] "View dashboard →" link appears on success.
- [ ] Reset flag deletes ONLY rows tagged `metadata.demo_seed_type='load'` AND `demo_seed_version='gtm_0a_2'`.

### Multi-venue stress smoke

1. Pick two different venues (or invite a second test user with their own venue).
2. Seed `balanced` 250 leads to venue A, then `messy_channels` 250 leads to venue B.
3. Confirm `/dashboard` for each shows only its own data.
4. Reset venue A — venue B's load-seed data remains untouched.
5. Run the GTM-0A hand-crafted demo seed on venue A — both datasets coexist; reset of GTM-0A doesn't remove GTM-0A.2 rows and vice versa.

---

## Phase GTM-ILR — Instant Lead Response troubleshooting

### "New lead created but no AI response"

1. Check Inngest dashboard — is `lead.created` event firing? If not,
   the widget enqueue is silently failing; check `widget.job.enqueue_failed`
   in logs.
2. Check `ai_actions` table for the lead_id — should have a row with
   `agent='instant_lead_response'`. If absent, the orchestrator never
   ran. Look for `orchestrator.handle_new_lead.lead_not_found` or
   `venue_not_found`.
3. Check the conversation's `messages` table — if a row with
   `role='ai'` exists but `metadata.source !== 'instant_lead_response'`,
   the legacy path ran. Check `venues.metadata.revenue_os.instant_response.enabled` — should be `true`.

### "AI response is generic / off-brand"

1. Confirm the venue has filled in the InstantResponseTrainingCard
   (sample replies are the single biggest lever).
2. Check `venues.metadata.revenue_os.instant_response.sample_replies`
   directly via SQL — values should match what's in the UI.
3. The model can be capped by the heuristic if the draft is short or
   lacks a CTA. If `metadata.heuristic_confidence` is low, the model
   confidence was capped — that's the signal to add more training
   examples, not to bypass the cap.

### "Auto-send did not happen"

Auto-send is scaffold-only in this phase. The route NEVER sends. It
only records `auto_send_eligible: true` on the audit row. There is no
outbound integration wired.

### "Claude API failed"

The helper has its own try/catch and ALWAYS returns either the model
response or the deterministic warm fallback. If you're seeing
`orchestrator.handle_new_lead` failures, it's downstream of the
helper — check `qualifyLead`, `enqueueLeadCreated`, or the
follow-up scheduler.

### "Duplicate drafts created"

The orchestrator's idempotency guard checks for any `messages.role='ai'`
row on the conversation. If two `lead.created` events fire and both
race past the guard, the second insert will fail at the unique-row
level only if there's a constraint — there isn't one today, so two
events firing simultaneously CAN produce two messages. In practice,
Inngest's per-event idempotency on the `lead_id` key handles this; the
local-fallback path does not. Don't run two `next dev` processes against
the same DB.

### "Pricing or availability claims are too aggressive"

1. Pull the lead's `messages.metadata.unsupported_claims` array — those
   are the phrases the model thinks lack KB grounding.
2. Add the supporting facts to the venue KB (pricing page, availability
   policy).
3. As a hard guardrail: add a line to InstantResponseTrainingCard →
   "Additional venue rules (binding)" — e.g. "Never quote prices over
   $25k without operator approval." The system prompt enforces these.

---

## Phase GTM-0C — Sales asset pack

Created `docs/gtm/` with 12 sales asset files. No product code changes.

### Operator checklist

- [ ] Read `docs/gtm/README.md` to understand the asset map
- [ ] Pre-demo: seed the dashboard with the load-demo (Settings → Billing →
      Revenue Recovery load / stress demo → 250 leads / `sales_demo` /
      reset existing). See `docs/gtm/DEMO-SCRIPT.md` for the full setup.
- [ ] Personalize `docs/gtm/ONE-PAGE-PITCH.md` calendar link + email
      before sending to a prospect
- [ ] Track every call in the `docs/gtm/SALES-CALL-SCORECARD.md` format
- [ ] Weekly review every Friday (pattern: which subject lines, objections,
      channels)
- [ ] After 30 venue conversations, evaluate against GTM-1 sprint targets
      (10+ proposals sent, 3+ pilots signed)

### What's intentionally not in this phase

- No new code, no admin routes, no DB migrations
- No public pricing page (pilot pricing stays conversation-first)
- No new claims that aren't already in `docs/GTM-POSITIONING.md`

## Phase 8BN — Operator-composer outbound email delivery

New env var: `OUTBOUND_EMAIL_DELIVERY_ENABLED` (default `0`).

Set `1` (plus the existing `RESEND_API_KEY` + `RESEND_FROM_EMAIL`)
to enable real direct email send from the inbox composer for
website / email-bearing leads.

When OFF: composer keeps the honest "Saved in VenueRise only"
pill, messages save as `role:'human'` with
`delivery_status: 'skipped'`. No external send is attempted.

When ON: composer flips to "Direct" pill, send delivers via
Resend, pill on the bubble shows "Sent via Email" (or
"Email failed" with a safe tooltip on provider rejection).

Health flags:
- `outbound_email_delivery: 'mounted' | 'disabled'`
- `outbound_email_reply_method_direct: 'mounted'`
- `outbound_email_delivery_status_pills: 'mounted'`
- `outbound_email_failure_honesty: 'mounted'`

Rollback: unset `OUTBOUND_EMAIL_DELIVERY_ENABLED` (or set `0`).
No data migration required — the kill switch is a runtime
gate; existing message rows keep their delivery metadata
either way.

See `docs/OUTBOUND-EMAIL-DELIVERY.md` for the full spec, QA
checklist, and honesty contract.

## Phase 8BO — Inbound email reply capture

New env vars:
- `INBOUND_EMAIL_ENABLED` (default `0`)
- `INBOUND_EMAIL_WEBHOOK_SECRET` (required when enabled; generate
  with `openssl rand -hex 32`)

Set `INBOUND_EMAIL_ENABLED=1` + a webhook secret, then configure
your inbound provider (Resend Inbound / Postmark / SendGrid /
Cloudflare Email Workers) to POST normalized JSON to
`https://<your-deploy>/api/inbound/email` with the HMAC-SHA256
signature as `x-inbound-email-signature: sha256=<hex>`.

When OFF: the route returns **503** to the provider (not 404) so
misconfiguration is loud, not silent. When ON: lead replies land
in the conversation thread as `role:'lead'` with the existing
8BG ParseReviewBadge flagging low-confidence matches.

Health flags:
- `inbound_email_capture: 'mounted' | 'disabled'`
- `inbound_email_header_matching: 'mounted'`
- `inbound_email_recent_recipient_fallback: 'mounted'`
- `inbound_email_no_auto_ai_trigger: 'mounted'`

Rollback: set `INBOUND_EMAIL_ENABLED=0`. Existing captured
messages stay in the thread; no further inbound is accepted
until re-enabled.

See `docs/INBOUND-EMAIL-CAPTURE.md` for the full spec, payload
shape, matching strategy, and QA checklist.

## Phase 8BP — Email delivery status + retry polish

No new env vars. Reuses existing Resend config +
`OUTBOUND_EMAIL_DELIVERY_ENABLED` (8BN).

New public routes:
- `POST /api/messages/[id]/retry-email` — operator-only,
  rate-limited per user+message, max 5 retries per message.
- `POST /api/messages/[id]/mark-fallback` — operator-only,
  flips an existing operator message to `manual_fallback`.

The Resend webhook (`/api/resend/webhook`) is now
configured to ALSO patch `messages.metadata` when the
linked `outbound_messages` row points at a composer-
originated message (`related_table='messages'`). Digest
and tour-notification webhook behavior is unchanged.

Health flags:
- `email_delivery_status_lifecycle`
- `email_delivery_webhook_message_patch`
- `email_delivery_retry`
- `email_delivery_manual_fallback`
- `email_delivery_honest_accepted_vs_delivered`

Rollback: revert the commit. No data migration required
— all state lives on `messages.metadata` (jsonb).
Historical sends keep their existing fields; any new
fields (`delivery_event_type`, `accepted_at`, `delivered_at`,
`delivery_retry_count`, etc.) are absent on legacy rows
and the UI handles that gracefully.

See `docs/EMAIL-DELIVERY-STATUS-AND-RETRY.md` for the
full spec, QA checklist, and event-mapping table.
