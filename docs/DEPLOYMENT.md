# VenueRise — Production Deployment Guide

Last reviewed: Phase 7A.

This guide walks through standing up a production VenueRise instance on Vercel with Supabase, Anthropic, Inngest, Resend, Upstash, and Sentry as managed dependencies. Read it once front-to-back before provisioning; the order matters.

---

## 0. Prerequisites

- Vercel team account with permission to create projects.
- Supabase project (one per environment — separate prod from preview).
- Anthropic console access with billing enabled.
- Inngest team account.
- Resend account with a verified sending domain.
- Upstash Redis instance (Global, eventual consistency is fine).
- Sentry organization with a Next.js project.

---

## 1. Environment Variables — by Category

For each variable, this section answers: **Required in prod?** · **Safe to expose publicly?** · **Where to get it** · **What breaks if missing**.

The `.env.example` file is the canonical machine-readable list; this doc is the human-friendly companion. The live `/api/readiness` endpoint will tell you which of these your deploy is actually missing.

### 1.1 Core

| Var | Required in prod? | Public? | Source | Breaks if missing |
|---|---|---|---|---|
| `NEXT_PUBLIC_APP_URL` | **Yes** | Yes (NEXT_PUBLIC_) | Hand-set to your canonical https URL (no trailing slash) | Invite emails, unsubscribe URLs, internal-call origin checks, widget CORS allowlist |
| `NEXT_PUBLIC_APP_VERSION` | No (falls back to `package.json#version`) | Yes | Set in CI from git tag, e.g. `0.1.0` | Sentry release tagging less precise |

### 1.2 Supabase

| Var | Required in prod? | Public? | Source | Breaks if missing |
|---|---|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | **Yes** | Yes | Supabase dashboard → Settings → API → Project URL | Browser auth, server SSR helper, ALL Supabase calls |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | **Yes** | Yes | Same panel → `anon` public key | Browser auth + RLS-aware client-side queries |
| `SUPABASE_SERVICE_ROLE_KEY` | **Yes** | **NEVER expose** | Same panel → `service_role` secret key | Widget intake, AI orchestrator, team accept, onboarding, suppression writes, every server-side admin path |

### 1.3 Anthropic

| Var | Required in prod? | Public? | Source | Breaks if missing |
|---|---|---|---|---|
| `ANTHROPIC_API_KEY` | **Yes** | **Server-only** | https://console.anthropic.com/settings/keys | AI qualification + chat replies + admin probe; `/api/readiness` returns 503 |

### 1.4 Internal Security

| Var | Required in prod? | Public? | Source | Breaks if missing |
|---|---|---|---|---|
| `INTERNAL_API_SECRET` | **Yes** (≥ 32 chars) | **Server-only** | Generate: `openssl rand -hex 32` | HMAC-signed internal calls (`/api/ai/qualify` from widget path), unsubscribe link signing; readiness fails when missing or < 32 chars |

### 1.5 Jobs / Inngest

| Var | Required in prod? | Public? | Source | Breaks if missing |
|---|---|---|---|---|
| `INNGEST_DEV` | No (dev-only) | Server-only | Set `1` to route through local Inngest dev server | If unset locally with no cloud keys, jobs run via in-process `setImmediate` fallback |
| `INNGEST_EVENT_KEY` | **Yes** in prod | Server-only | https://app.inngest.com → Your App → Keys | Events silently dropped in prod |
| `INNGEST_SIGNING_KEY` | **Yes** in prod | Server-only | Same panel | Inngest can't verify webhook signatures back to your function endpoint |

### 1.6 Email / Resend

| Var | Required in prod? | Public? | Source | Breaks if missing |
|---|---|---|---|---|
| `RESEND_API_KEY` | **Yes** | Server-only | https://resend.com → API Keys | Outbound email becomes console-fallback (logged, not delivered) |
| `RESEND_FROM_EMAIL` | **Yes** | Server-only | Hand-set to an address on your verified sending domain | Resend rejects every send |
| `RESEND_REPLY_TO_EMAIL` | Recommended | Server-only | Hand-set (e.g. `coordinator@yourvenue.com`) | Lead replies go to the From address |
| `RESEND_WEBHOOK_SECRET` | **Yes** | Server-only | Resend dashboard → Webhooks → Signing Secret (`whsec_…`) | `/api/resend/webhook` returns 401 to every event; bounces + suppressions never update |

### 1.7 Rate limiting / Upstash

| Var | Required in prod? | Public? | Source | Breaks if missing |
|---|---|---|---|---|
| `UPSTASH_REDIS_REST_URL` | **Yes** in prod | Server-only | https://console.upstash.com → Redis → REST URL | Rate limiting becomes a no-op; readiness fails |
| `UPSTASH_REDIS_REST_TOKEN` | **Yes** in prod | Server-only | Same panel → REST token | Same as above |

### 1.8 Sentry

| Var | Required in prod? | Public? | Source | Breaks if missing |
|---|---|---|---|---|
| `SENTRY_DSN` | **Yes** in prod | Server-only | Sentry → Project Settings → Client Keys (DSN) | Server-side captures become no-ops; readiness fails |
| `NEXT_PUBLIC_SENTRY_DSN` | **Yes** in prod | Yes (DSN is public by design) | Same value | Client-side captures become no-ops |
| `SENTRY_AUTH_TOKEN` | Recommended | **Build-time only** | Sentry → Auth Tokens (with `project:releases`) | Source maps not uploaded — stack traces stay minified |
| `SENTRY_TRACES` | No (default 0.1) | Server-only | Hand-set sample rate `0`–`1` | — |
| `NEXT_PUBLIC_SENTRY_TRACES` | No (default 0.01) | Yes | Hand-set sample rate | — |
| `SENTRY_DEBUG` | No | Server-only | Set `1` to dump SDK logs | — |

---

## 2. Provisioning Order

Follow this order so each upstream system is ready when the next one needs it.

### 2.1 Create the Supabase project

1. Create a new project in Supabase.
2. From `supabase/migrations/`, run migrations 001 → 006 in order (Supabase CLI or SQL editor).
3. Copy `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` from Project Settings → API. Stash for step 2.6.

### 2.2 Configure Anthropic

1. Create an API key at https://console.anthropic.com/settings/keys.
2. Stash as `ANTHROPIC_API_KEY`.

### 2.3 Configure Inngest

1. Create an Inngest app named `venuerise` (or your project name).
2. Stash `INNGEST_EVENT_KEY` + `INNGEST_SIGNING_KEY`.
3. After Vercel deploy (step 2.8), point the app's serve URL at `https://<your-deploy>/api/inngest`.

### 2.4 Configure Resend

1. Add and verify your sending domain at https://resend.com/domains. DNS propagation can take an hour.
2. Create an API key, stash as `RESEND_API_KEY`.
3. Pick a `RESEND_FROM_EMAIL` on the verified domain (e.g. `notifications@mail.yourvenue.com`).
4. After Vercel deploy, configure the webhook:
   - URL: `https://<your-deploy>/api/resend/webhook`
   - Events: `email.delivered`, `email.bounced`, `email.complained`, `email.delivery_delayed`, `email.failed`
   - Copy the **Signing Secret** (`whsec_…`) → stash as `RESEND_WEBHOOK_SECRET`.

### 2.5 Configure Upstash

1. Create a Global Redis database at https://console.upstash.com.
2. Stash `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN`.

### 2.6 Configure Sentry

1. Create a new Next.js project at https://sentry.io.
2. Stash `SENTRY_DSN` (use the same value for `NEXT_PUBLIC_SENTRY_DSN`).
3. Create a build-time auth token with `project:releases` scope → stash as `SENTRY_AUTH_TOKEN`.

### 2.7 Generate the internal secret

```bash
openssl rand -hex 32
```

Stash as `INTERNAL_API_SECRET`.

### 2.8 Create the Vercel project

1. Import the repo in Vercel.
2. Framework preset: **Next.js**.
3. Build command: `npm run build` (default).
4. Output: standard Next defaults — `vercel.json` (Phase 7A) sets function timeouts; do not override.
5. Add **every** variable from §1 in Settings → Environment Variables → Production. Mirror to Preview if you want preview deploys to work end-to-end.
6. Deploy.
7. Note the resulting canonical https URL → set `NEXT_PUBLIC_APP_URL` to it.
8. Trigger one more deploy so the env change picks up.

### 2.9 Wire the upstream webhooks

1. Inngest → Apps → your app → set serve URL to `https://<your-deploy>/api/inngest`. Click "Sync".
2. Resend → Webhooks → set URL to `https://<your-deploy>/api/resend/webhook`. Send a test event; verify it returns 200 in Resend's UI.

---

## 3. Post-deploy verification

Run these against the production URL.

### 3.1 Liveness + readiness

```bash
curl -s https://<your-deploy>/api/health | jq .
curl -s https://<your-deploy>/api/readiness | jq .
```

Readiness must report `"ready": true` with every check `ok` or `configured`. If anything reads `missing`, look it up in §1 above.

### 3.2 Widget end-to-end smoke

After picking a venue id (the easiest way: run `POST /api/onboarding/create-workspace` once as your test user, then read `venue_id` out of the response):

```bash
curl -i https://<your-deploy>/api/widget/<VENUE_ID>/config \
  -H "Origin: https://<your-deploy>"
# expect 200 with name/persona/tagline/style_tags
```

```bash
curl -i -X POST https://<your-deploy>/api/widget \
  -H "Content-Type: application/json" \
  -H "Origin: https://<your-deploy>" \
  -d '{
    "venue_id": "<VENUE_ID>",
    "name": "Smoke Test",
    "email": "smoke@example.com",
    "phone": "5555555555",
    "event_date": "2026-10-12",
    "guest_count": 120,
    "budget": 18000,
    "message": "Production smoke test"
  }'
# expect 201 with lead_id + conversation_id
```

Watch Inngest (Functions tab) for the AI qualification run, and Resend for the welcome email. If the email never sends, see [docs/RUNBOOK.md](./RUNBOOK.md) → "Follow-ups aren't sending".

### 3.3 Dashboard auth gate

```bash
curl -sI https://<your-deploy>/dashboard
# expect 307 with Location: /login
```

If you see 200, the proxy hook (Phase 7A's `proxy.ts`) isn't running — check the Vercel Functions tab.

### 3.4 Origin protection

```bash
curl -sI -X POST https://<your-deploy>/api/widget \
  -H "Content-Type: application/json" \
  -H "Origin: https://evil.example.com" \
  -d '{}'
# expect 403 {"error":"origin_not_allowed"}
```

---

## 4. After-deploy operational checklist

- [ ] Add `/api/readiness` to your uptime monitor as the primary "in-rotation" probe (5-minute interval).
- [ ] Add `/api/health` as the secondary low-noise liveness probe (60s interval).
- [ ] Wire Sentry alerts: any unhandled exception in `layer=api` should page on-call.
- [ ] Wire Inngest alerts: function failure rate > 5% over 15 min should page on-call.
- [ ] Wire Resend alerts: bounce rate > 2% should email ops.
- [ ] Bookmark [docs/RUNBOOK.md](./RUNBOOK.md) for on-call.

---

## 5. Rolling back

VenueRise has no destructive migrations after 004 — every Phase 5/6 migration is additive. Roll back by redeploying the previous build SHA in Vercel. The database does not need to be touched.

The one exception: if you must roll back across migration 005 (member-aware RLS), do so manually via the inline DOWN comment at the bottom of `supabase/migrations/005_widen_rls_to_members.sql`. Doing so during a live deploy will lock non-owner members out of their own data — coordinate with the team first.
