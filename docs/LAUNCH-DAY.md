# VenueRise — Launch-Day Playbook

Last reviewed: Phase 7B.

Companion to [DEPLOYMENT.md](./DEPLOYMENT.md), [STAGING-CHECKLIST.md](./STAGING-CHECKLIST.md), and [RUNBOOK.md](./RUNBOOK.md). This doc covers the launch window itself: the 72 hours from "first customer can sign up" through "we're confident the system is stable enough that on-call is normal-priority again".

Print this. Tape it next to the laptop. The pager won't, but you will.

---

## 1. Pre-launch checklist (T-24h)

- [ ] [STAGING-CHECKLIST.md](./STAGING-CHECKLIST.md) is fully ✓ and the staging smoke script passed within the last 24 hours.
- [ ] Production env vars in Vercel — full set from [DEPLOYMENT.md §1](./DEPLOYMENT.md) — populated with **production** credentials.
- [ ] `npm run check:prod-env` against a `.env.production` copy returns ✓.
- [ ] Sentry production project has alerts wired (§4).
- [ ] Inngest production app has alerts wired (§4).
- [ ] Resend production sending domain is verified; webhook URL points at prod.
- [ ] Upstash production database has > 10× headroom on RPS for the launch traffic estimate.
- [ ] DNS for the canonical app URL points at Vercel.
- [ ] On-call rotation has 2 people for the 72h window, with phone numbers exchanged.
- [ ] Rollback build SHA pinned: note the last known-good production SHA below.

```
Last known-good prod SHA: ____________________________________
Last known-good prod date: ____________________________________
```

---

## 2. Launch smoke commands (T-0)

Run these in order against production the moment the deploy completes. Stop and roll back at the first ✗.

```bash
# 1. Readiness — must be 200 + ready:true.
curl -s "$APP/api/readiness" | jq '.ready, .environment, .failed'

# 2. Liveness sanity.
curl -s "$APP/api/health" | jq '.ok'

# 3. Origin block on /api/widget — must be 403.
curl -sI -X POST "$APP/api/widget" -H "Origin: https://evil.example.com" \
  -H "Content-Type: application/json" -d '{}' | head -1

# 4. Dashboard auth gate — must be 307 to /login.
curl -sI "$APP/dashboard" | head -3

# 5. End-to-end smoke (drives widget → lead → AI → follow-ups).
SMOKE_APP_URL="$APP" \
  SMOKE_SUPABASE_URL="$SUPABASE_URL" \
  SMOKE_SUPABASE_ANON_KEY="$ANON" \
  SMOKE_SUPABASE_SERVICE_ROLE_KEY="$SERVICE" \
  SMOKE_TEST_USER_EMAIL="$SMOKE_EMAIL" \
  SMOKE_TEST_USER_PASSWORD="$SMOKE_PASS" \
  npm run smoke:prod

# 6. Small widget load smoke (sanity, not a benchmark).
LOAD_APP_URL="$APP" LOAD_VENUE_ID="$VENUE" \
  LOAD_TOTAL=15 LOAD_CONCURRENCY=5 \
  LOAD_SUPABASE_URL="$SUPABASE_URL" LOAD_SUPABASE_SERVICE_ROLE_KEY="$SERVICE" \
  npm run load:widget
```

If smoke #5 fails on any step, immediately:
1. Capture the failing `step` + `detail` lines from stderr.
2. Pull the `X-Request-Id` from the failing response (curl with `-i` to see headers).
3. Search Sentry and Vercel logs for that request id (see [RUNBOOK.md §5](./RUNBOOK.md)).
4. Roll back per §6 if the failure is widespread (more than one of: widget, AI, email).

---

## 3. What to watch — first 72 hours

Watch one dashboard tab per system. Update the "baseline" column once a stable steady state is observed (typically ~6h post-launch).

| Surface | Where to watch | Healthy baseline | Pause threshold |
|---|---|---|---|
| **Sentry error rate** | Sentry → Issues, filtered to last 1h | < 0.5% of requests | > 2% sustained 5 min |
| **Inngest job failures** | Inngest → Functions → Failure rate (15m window) | < 1% | > 5% sustained 15 min |
| **Supabase DB/API** | Supabase → Reports → Database health | < 30% CPU, 0 5xx | sustained 5xx > 0 |
| **Supabase connection count** | Supabase → Reports → API → Pool usage | < 60% of pool max | > 90% sustained 5 min |
| **Resend bounce rate** | Resend → Logs → filter `bounced` (24h) | < 1% | > 2% sustained 1h |
| **Resend complaint rate** | Resend → Logs → filter `complained` (24h) | 0 | > 0.1% any |
| **Upstash usage** | Upstash → Metrics | < 50% of plan QPS | > 80% sustained 10 min OR any 429 from Upstash |
| **Anthropic 429/5xx** | Sentry events tagged `layer=api route:/api/ai/*` | 0 retries exhausted | > 3 `anthropic_retry_exhausted` events / hour |
| **Widget 4xx rate** | Vercel logs grepped for `route:/api/widget` + status 4xx | < 5% (mostly 429 + 400) | > 10% sustained 10 min |
| **Widget 5xx rate** | Same with status 5xx | 0 | > 2% sustained 5 min |

Vercel logs sample command:

```bash
vercel logs $APP --since=15m | grep -E '"route":"/api/widget"' | jq '.status'
```

---

## 4. Alert wiring (set up T-24h, verify on launch)

### 4.1 Sentry alerts

In Sentry → Project → Alerts → New Alert:

| Alert | Trigger | Action |
|---|---|---|
| Critical API exception | New unhandled issue with `layer:api` AND `environment:production` | Page on-call (PagerDuty or SMS) |
| AI orchestrator failure spike | Issue count for `layer:api route:/api/ai/qualify` > 5 in 15 min | Page on-call |
| Webhook signature failures | Issue count for `webhook.resend.signature_mismatch` > 3 in 15 min | Email ops (could be secret rotation in progress) |

### 4.2 Inngest alerts

In Inngest → Settings → Alerts:

| Alert | Trigger | Action |
|---|---|---|
| Function failure rate | Any function failure rate > 5% over 15 min | Page on-call |
| Function backlog | Any function pending count > 100 for 10 min | Email ops |
| App sync drift | `venuerise` app sync status not green for 5 min | Page on-call |

### 4.3 Resend alerts

In Resend → Domain → Reputation:

| Alert | Trigger | Action |
|---|---|---|
| Bounce rate | > 2% over 24h | Email ops |
| Complaint rate | > 0.1% over 24h | Page on-call (deliverability risk) |

### 4.4 Uptime + readiness pingers

Pick any: UptimeRobot / Better Uptime / Pingdom / Vercel Monitoring.

| Probe | Endpoint | Interval | Expected | Alert |
|---|---|---|---|---|
| Liveness | `$APP/api/health` | 60s | HTTP 200 | Email + SMS after 3 consecutive fails |
| Readiness | `$APP/api/readiness` | 5 min | HTTP 200, body includes `"ready":true` | Page on-call after 2 consecutive fails |
| Dashboard auth | `$APP/dashboard` | 5 min | HTTP 307 (redirect to /login) | Email ops after 3 fails |

For tools that support response-body matching, use the readiness `"ready":true` substring as the assertion.

---

## 5. Baseline metrics table

Fill these in from the first 6 hours of real or smoke traffic. Use the load-widget script to capture widget percentiles. Update once the second 6-hour window confirms steady state.

| Metric | First 6h | Steady state | Pause threshold |
|---|---|---|---|
| Widget POST p50 latency | _________ | _________ | > 1500ms sustained 5 min |
| Widget POST p90 latency | _________ | _________ | > 3000ms |
| Widget POST p95 latency | _________ | _________ | > 5000ms |
| Widget POST p99 latency | _________ | _________ | > 8000ms |
| AI qualification median (lead-create → first AI message) | _________ | _________ | > 30s |
| AI qualification max | _________ | _________ | > 90s |
| Email send → Resend "delivered" webhook | _________ | _________ | > 60s |
| Readiness endpoint p50 | _________ | _________ | > 1000ms |
| Readiness endpoint p99 | _________ | _________ | > 3000ms |

Capture command:

```bash
LOAD_APP_URL="$APP" LOAD_VENUE_ID="$VENUE" \
  LOAD_TOTAL=60 LOAD_CONCURRENCY=10 \
  LOAD_SUPABASE_URL="$SUPABASE_URL" LOAD_SUPABASE_SERVICE_ROLE_KEY="$SERVICE" \
  npm run load:widget
```

The p50/p90/p95/p99/max in that output is the widget POST baseline. Run it twice with 30 min between runs; record both.

---

## 6. Pause / rollback procedure

### 6.1 When to pause

Trigger any of these → take action:

- `/api/readiness` returns 503 for > 5 min.
- Widget 5xx > 2% sustained 5 min.
- AI failure rate > 5% sustained 15 min.
- Resend bounce > 2% over the last hour.
- Inngest function failure > 5% sustained 15 min.
- Any "anthropic_retry_exhausted" issue rate > 3/hour.

### 6.2 What "pause" looks like

VenueRise has no built-in feature flags yet. The pause toolkit is:

1. **Hold new sign-ups** by setting `is_active=false` on the affected venue(s) in Supabase. Widget responses become 403 for those venues; existing data is preserved.
   ```sql
   update public.venues set is_active=false where id='<venue id>';
   ```
2. **Stop AI workloads** by deleting or invalidating `ANTHROPIC_API_KEY` in Vercel and redeploying. AI routes return 500; queued jobs retry and eventually surface in Sentry — clear them manually after recovery.
3. **Stop outbound email** by deleting `RESEND_API_KEY`. The console-fallback kicks in and follow-ups flip to `skipped` instead of `sent`. Once restored, re-trigger the relevant follow-ups via `/api/ai/followup` per lead.

### 6.3 Rolling back

VenueRise has no destructive DB migrations after 004; rollbacks are deploy-only.

```bash
# 1. Find the last known-good deployment SHA (top of this doc).
vercel ls $PROJECT --prod

# 2. Promote that SHA back to prod.
vercel promote <deployment-url> --scope=$TEAM
```

Then:

- Re-run the launch smoke commands (§2). All ✓ → you've rolled back successfully.
- Open an incident postmortem doc within 24h.
- The rolled-back build's SHA + the failing commit's diff become the postmortem inputs.

### 6.4 Rolling back across migration 005

005 widens RLS to `venue_members`. Rolling back to a build that predates 005 will lock non-owner members out of their own data. **Do not roll back across this line during a live deploy without coordinating with the team.** The DOWN script lives as a comment at the bottom of `supabase/migrations/005_widen_rls_to_members.sql`.

---

## 7. Secret rotation during the launch window

If a secret is suspected leaked during launch, prioritize:

1. **Service role key** (Supabase) — full DB access. Rotate immediately via Supabase dashboard, deploy, then audit `auth.users` for unfamiliar sign-ups and `venues` for unfamiliar rows.
2. **Anthropic key** — financial impact. Rotate, deploy, watch the Anthropic console usage chart for the next 24h.
3. **Internal secret** — invalidates outstanding unsubscribe links and breaks the widget → orchestrator signed-call path during the rotation window. Coordinate a brief widget pause (§6.2) before rotating.
4. **Resend webhook secret** — has a brief overlap window where both old + new work; see [RUNBOOK.md §2.4](./RUNBOOK.md).
5. **Anything else** — see [RUNBOOK.md §4](./RUNBOOK.md).

After any rotation:

```bash
curl -s "$APP/api/readiness" | jq .checks
```

Every check should still pass.

---

## 8. First customer onboarding checklist

When the first real customer is about to sign up:

- [ ] Confirm `/api/readiness` is green right now (not 5 minutes ago).
- [ ] Confirm Sentry has < 5 unresolved issues in the last hour with `layer:api`.
- [ ] Confirm at least one staging smoke run within the last 4 hours has passed end-to-end.
- [ ] Onboard them yourself: walk through `/login` → `/onboarding` → workspace creation → widget embed snippet. Take screenshots as you go (they're the start of the customer-facing onboarding doc).
- [ ] Within 30 minutes of their first widget submission, manually verify:
  - lead row in Supabase,
  - conversation row,
  - AI message ≤ 60s,
  - inbound email to whoever they listed as `RESEND_REPLY_TO_EMAIL`.
- [ ] Within 24 hours, ask them: did the first AI reply read well? did anything feel off? does the widget look right on their site? Capture the answers.
- [ ] Add them to a private support channel (Slack DM, shared email, or a Linear project) so they don't have to figure out where to report bugs.

---

## 9. Closing the launch window

After 72 hours of stable steady state, demote the launch posture:

- [ ] Move on-call rotation back to normal cadence.
- [ ] Update [DEPLOYMENT.md §4](./DEPLOYMENT.md) operational checklist with anything we learned (esp. baseline numbers from §5).
- [ ] File a postmortem doc with: what went right, what surprised us, what's queued for fixing.
- [ ] Update `Last known-good prod SHA` in §1 above to the current SHA.
- [ ] Take everyone who was on-call for the window to dinner. (Recommended, not required.)
