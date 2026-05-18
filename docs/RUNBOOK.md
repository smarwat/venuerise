# VenueRise — Operations Runbook

Last reviewed: Phase 7A.

Pager-friendly playbook. Each section: how to verify the system is working, then what to do when it isn't. Pair this with [SECURITY.md](./SECURITY.md) for secrets handling and [DEPLOYMENT.md](./DEPLOYMENT.md) for first-time setup.

Convention used throughout:
- `$APP` = canonical production URL (e.g. `https://app.venuerise.com`).
- `$VENUE` = a real production venue id (cross-reference Supabase `venues` table).

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

### 2.5 Inngest jobs not running

1. Check Inngest dashboard → Apps → your app → "Sync status". A failed sync means Inngest can't reach `$APP/api/inngest`. Most common: missing or wrong `INNGEST_SIGNING_KEY`.
2. Trigger a manual sync from the dashboard.
3. If syncs are green but functions still aren't firing: ensure `INNGEST_EVENT_KEY` matches the project. Test:
   ```bash
   curl -i -X POST $APP/api/widget -H "Content-Type: application/json" \
     -H "Origin: $APP" -d '{"venue_id":"'"$VENUE"'","name":"sync","email":"sync@example.com"}'
   ```
   The `lead.created` event should appear in Inngest's event stream within seconds.

### 2.6 Rate limiting misfires

Symptoms: legitimate users seeing 429 from `/api/widget` or `/api/ai/*`.

1. Hit `$APP/api/health` — `upstash` should be `configured`.
2. Open Upstash dashboard → Metrics → throughput. Sudden spike + 0 errors means real traffic — bump the limit in `lib/rate-limit.ts` (rebuild + redeploy).
3. If Upstash itself is failing, `lib/rate-limit.ts` is fail-open: requests are allowed and a `rate_limit.disabled` warning logs once. Verify the warning is the only sign of disablement before assuming it's just slow.

---

## 3. Health vs readiness — when to use which

- `/api/health` — answers "is the process alive?". 200 unless Supabase is wholly down. Use for uptime pingers running every 60s.
- `/api/readiness` — answers "is the deployment configured to take production traffic?". 503 in production if ANY of: Supabase down, Anthropic key missing, Inngest keys missing, Resend keys missing, Upstash missing, Sentry missing, `INTERNAL_API_SECRET` missing-or-short, or `NEXT_PUBLIC_APP_URL` missing/invalid. Use for load-balancer in-rotation checks (5-minute interval).

The `failed` array in the readiness response names exactly which checks need attention. Don't dig further until that's empty.

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
