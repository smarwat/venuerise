# VenueRise — Staging Environment Setup Checklist

Last reviewed: Phase 7B.

Goal: stand up a staging deployment that mirrors production closely enough to validate every flow end-to-end (widget intake → AI qualification → email → team invite), but on isolated credentials so a smoke test can't ever touch real customer data.

> **Hard rule:** zero production keys in staging. If a staging incident is going to leak something, it should leak the staging key — easy to rotate, no customer impact.

Pair this with [DEPLOYMENT.md](./DEPLOYMENT.md) for the per-variable detail and [SECURITY.md](./SECURITY.md) for the trust-boundary rules.

---

## 0. Naming convention

Suffix every upstream resource with `-staging` so they're impossible to confuse with production in a dashboard at 2am:

- Supabase project: `venuerise-staging`
- Inngest app: `venuerise-staging`
- Resend sending domain: `mail.staging.venuerise.com` (or whichever subdomain you own)
- Upstash DB: `venuerise-staging`
- Sentry project: `venuerise-staging` with environment tag `staging`
- Vercel project: `venuerise-staging` (or a `staging` preview branch in the prod project — see §3)

---

## 1. Supabase staging project

- [ ] Create a new project in the Supabase organization. Pick a small region (e.g. `us-east-1`) — staging doesn't need global reads.
- [ ] Apply migrations 001 → 006 in order, either via Supabase CLI:
   ```bash
   supabase db push --linked
   ```
   or by pasting each `supabase/migrations/00*.sql` file into the SQL editor in order.
- [ ] Verify with: `select count(*) from venues;` (should be 0) and `select count(*) from public.venue_members;` (also 0).
- [ ] Copy `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` from Settings → API. Stash for §4.
- [ ] **Create a test user** via Authentication → Users → "Add user" with email/password (e.g. `smoke-owner@example.com` / `hunter2`). Stash the password as `SMOKE_TEST_USER_PASSWORD`.

## 2. Inngest staging app

- [ ] Create app `venuerise-staging` at https://app.inngest.com.
- [ ] Copy `INNGEST_EVENT_KEY` + `INNGEST_SIGNING_KEY` for §4.
- [ ] We point its serve URL at the Vercel staging URL in §3 (after the first deploy exists).

## 3. Vercel project / preview environment

Pick one of:

**Option A — separate Vercel project.** Cleaner blast radius.
- [ ] Import the same Git repo as `venuerise-staging`.
- [ ] Track a separate branch (e.g. `staging`) or deploy on push-to-main if your prod uses tags.

**Option B — Vercel preview environment in the prod project.** Less setup.
- [ ] Use the existing project's Preview env scope for env vars.
- [ ] Promote preview deploys instead of merging.

Either way:
- [ ] Build command: `npm run build` (default).
- [ ] Functions: `vercel.json` (Phase 7A) sets the right timeouts. Don't override.

## 4. Add all required env vars

Set in Vercel → Project → Environment Variables → **Preview** (for Option B) or **Production** of the staging project (Option A). Every variable from [DEPLOYMENT.md §1](./DEPLOYMENT.md) needs a value:

- [ ] `NEXT_PUBLIC_APP_URL` — staging URL (set after first deploy, then redeploy)
- [ ] `NEXT_PUBLIC_SUPABASE_URL` + `NEXT_PUBLIC_SUPABASE_ANON_KEY` + `SUPABASE_SERVICE_ROLE_KEY`
- [ ] `ANTHROPIC_API_KEY` — a **separate** key from prod with a low monthly cap
- [ ] `INTERNAL_API_SECRET` — `openssl rand -hex 32`, distinct from prod
- [ ] `INNGEST_EVENT_KEY` + `INNGEST_SIGNING_KEY`
- [ ] `RESEND_API_KEY` + `RESEND_FROM_EMAIL` + `RESEND_WEBHOOK_SECRET`
- [ ] `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN`
- [ ] `SENTRY_DSN` + `NEXT_PUBLIC_SENTRY_DSN` (the staging DSN)
- [ ] `NEXT_PUBLIC_APP_VERSION` (optional; set in CI from git SHA)

After populating: deploy. Note the canonical URL. Set `NEXT_PUBLIC_APP_URL` to it. Redeploy.

## 5. Resend staging configuration

- [ ] Add and verify a **staging** sending domain (NOT your prod domain). DNS propagation may take ~1h.
- [ ] Create a Resend API key — staging-only.
- [ ] After the Vercel deploy is live, add a webhook:
  - URL: `https://<staging-url>/api/resend/webhook`
  - Events: `email.delivered`, `email.bounced`, `email.complained`, `email.delivery_delayed`, `email.failed`
  - Copy the signing secret → `RESEND_WEBHOOK_SECRET`.

## 6. Upstash staging Redis

- [ ] Create a separate Global Redis database `venuerise-staging`.
- [ ] Copy REST URL + token → §4.

## 7. Sentry staging project

- [ ] Create a separate Sentry project `venuerise-staging`. Default environment tag should be `staging` (the SDK reads `NEXT_PUBLIC_VERCEL_ENV` or falls back to `NODE_ENV`).
- [ ] Copy DSN.
- [ ] Optional: create a release auth token with `project:releases` scope for source map upload.

## 8. Wire the webhooks

- [ ] Inngest → Apps → `venuerise-staging` → set serve URL to `https://<staging-url>/api/inngest`. Click **Sync**. Should turn green within a minute.
- [ ] Resend → Webhooks → confirm "Recent attempts" shows 200 for a test event.

---

## 9. Readiness check

```bash
curl -s https://<staging-url>/api/readiness | jq .
```

Pass criteria: `ready: true`, every check `ok` or `configured`, `environment: production` (Vercel sets `NODE_ENV=production` for preview + prod deploys).

If anything reads `missing`, fix that env var and redeploy before continuing — none of the downstream flows will work without it.

## 10. Run the smoke scripts

Populate the smoke env (these are **local** vars, not Vercel env):

```bash
export SMOKE_APP_URL="https://<staging-url>"
export SMOKE_SUPABASE_URL="https://<staging-project>.supabase.co"
export SMOKE_SUPABASE_ANON_KEY="eyJ..."           # staging anon
export SMOKE_SUPABASE_SERVICE_ROLE_KEY="eyJ..."   # staging service role
export SMOKE_TEST_USER_EMAIL="smoke-owner@example.com"
export SMOKE_TEST_USER_PASSWORD='hunter2'
# Optional — set this if you've already created the venue for the test user.
# Otherwise the script asks the DB for the first venue this user owns.
# export SMOKE_EXISTING_VENUE_ID="<uuid>"

npm run smoke:prod
```

Pass criteria: all probe rows print `✓`, the cleanup line prints `✓ cleanup: deleted smoke rows`, exit code 0.

Then a small load smoke:

```bash
export LOAD_APP_URL="https://<staging-url>"
export LOAD_VENUE_ID="<uuid the smoke script just resolved>"
export LOAD_CONCURRENCY=5
export LOAD_TOTAL=15
export LOAD_SUPABASE_URL="$SMOKE_SUPABASE_URL"
export LOAD_SUPABASE_SERVICE_ROLE_KEY="$SMOKE_SUPABASE_SERVICE_ROLE_KEY"

npm run load:widget
```

Default rate limit is 10 widget POSTs/min/IP/venue, so 15 requests at concurrency 5 will get some 429s — that's expected. To force-test the limiter:

```bash
LOAD_TOTAL=40 LOAD_CONCURRENCY=15 LOAD_EXPECT_RATE_LIMIT=1 npm run load:widget
```

## 11. Manual dashboard login test

- [ ] Open `https://<staging-url>/login` in an incognito window.
- [ ] Sign in as the staging test user.
- [ ] Land on `/dashboard`. Confirm the test venue from §10 appears in the sidebar / overview.
- [ ] Click into **Leads** — the smoke test lead should be visible (only true if you ran the smoke test recently AND `cleanup` is disabled, since the smoke script deletes its rows by default).

## 12. Widget embed test

Create a temporary HTML file:

```html
<!doctype html>
<html>
  <body>
    <iframe src="https://<staging-url>/widget/<VENUE_ID>"
            width="420" height="640" style="border:1px solid #ccc"></iframe>
  </body>
</html>
```

- [ ] Open it via a local file (`file://`) or any disposable hosting (`python3 -m http.server`).
- [ ] Confirm the iframe loads (Phase 7A CSP `frame-ancestors *` on `/widget/*` allows it).
- [ ] Submit a lead. Confirm:
  - the widget shows the success state,
  - the lead appears in `/dashboard/leads` within 30s,
  - within ~60s an AI message appears in the inbox.

If the iframe fails to load with a CSP error, the frame-ancestors override didn't apply — recheck `next.config.js` (Phase 7A).

## 13. Team invitation flow

- [ ] In `/dashboard/settings/team`, click **Invite member**, fill in a real address you control, role `coordinator`.
- [ ] Expect a 201 with `email_sent: true`.
- [ ] Confirm the invite arrives within ~30s.
- [ ] Open `/onboarding/accept?token=...` in an incognito window. The "Please sign in" message appears.
- [ ] Sign in as a different staging user. Land on the accept page → success → `/dashboard`.
- [ ] Verify in Supabase: `select role from venue_members where user_id='<new user id>';` returns `coordinator`.

## 14. Resend webhook arrives

- [ ] Trigger an email (the team invite from §13 is enough).
- [ ] Confirm in Resend dashboard → Webhooks → "Recent attempts": status 200 within ~5s of the send.
- [ ] In Supabase, check `outbound_messages` for a `delivered`/`opened` status update.

## 15. Sentry receives a test event

- [ ] Hit a deliberately broken route to provoke a 500. The simplest: POST `/api/widget` with a malformed JSON body — Phase 7A logs it but won't 500. Instead, temporarily delete the SUPABASE_SERVICE_ROLE_KEY in Vercel (Preview only!), redeploy, hit `/api/widget`, then restore.
   *Or* hit `/api/admin/anthropic-probe` while signed out — it should 401 (no Sentry event). To force one, sign in and temporarily set `ANTHROPIC_API_KEY` to garbage — the probe will throw and Sentry will capture.
- [ ] Confirm the event appears in Sentry → Issues with `environment: staging`.
- [ ] **REMEMBER TO REVERT** the env vars you touched.

## 16. Rate limiting actually works

- [ ] Re-run `LOAD_TOTAL=40 LOAD_CONCURRENCY=15 LOAD_EXPECT_RATE_LIMIT=1 npm run load:widget`.
- [ ] Confirm at least one `HTTP 429` in the status table.
- [ ] Hit `/api/health` and confirm `upstash: "configured"`.

## 17. Final no-leak audit

- [ ] In Vercel → staging env vars, scroll through. Every value should be a staging credential — no `prod-` / `live_` prefixes, no apex-domain Resend keys, no production Sentry DSN.
- [ ] Grep your local shell history for "prod" or your prod URL — make sure you haven't accidentally exported a prod key for the smoke run.
- [ ] In Anthropic console, confirm the staging key shows usage from the smoke runs (and only from those).

---

## When this checklist is fully ✓

You can promote a build to production with reasonable confidence. Run through [LAUNCH-DAY.md](./LAUNCH-DAY.md) next for the launch-window playbook.
