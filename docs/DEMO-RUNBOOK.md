# VenueRise — Demo Runbook

Last reviewed: Phase 8A.

Founder-led demo playbook. Read it once before any demo. The walkthrough assumes ~10 minutes with a wedding-venue prospect.

Companion to [DEPLOYMENT.md](./DEPLOYMENT.md), [RUNBOOK.md](./RUNBOOK.md), [BILLING-QA.md](./BILLING-QA.md).

---

## 1. Local dev setup (one-time)

```bash
cd /Users/yusufmarwat/venuerise
npm install                                # if not done
cp .env.example .env.local                 # if not done
# Fill .env.local with at minimum: Supabase URL/anon, service role,
# Anthropic key, internal secret. Stripe / Resend / Upstash / Sentry
# can be left blank — /api/health will say "missing", that's fine for a demo.
npm run dev                                # http://localhost:3000
```

In a separate tab if you want jobs to actually fire (AI qualification, follow-up scans):

```bash
INNGEST_DEV=1 npm run dev
# in another shell:
npx inngest-cli@latest dev                 # default http://localhost:8288
```

Without Inngest dev, the queue falls back to `setImmediate` — fine for demo since the AI orchestration still runs.

---

## 2. Provision the demo venue

The demo seed targets an existing venue owned by the test user. Easiest path:

```bash
# Sign in via the dashboard once at http://localhost:3000/login
#   - creates the Supabase auth user
#   - completes /onboarding which provisions one venue + member row
# Then in your shell:

export DEMO_APP_URL=http://localhost:3000
export DEMO_SUPABASE_URL=https://xxx.supabase.co
export DEMO_SUPABASE_ANON_KEY=eyJ...
export DEMO_TEST_USER_EMAIL=owner@example.com
export DEMO_TEST_USER_PASSWORD='your-password'

npm run demo:seed
```

Expected output:

```text
▶ demo:seed → http://localhost:3000
✓ auth.signin
✓ demo.seed.completed
  leads created:         10
  conversations created: 4
  messages created:      15
  tours created:         4
  follow-ups created:    7
  ai_actions created:    5
```

Run it again — it's idempotent. Any previous demo rows are wiped before re-insertion.

---

## 3. The demo walkthrough

### 3.1 `/dashboard` — Overview (90 seconds)

Open `http://localhost:3000/dashboard`. Talk track:

- **MetricCards** — "Here's your KPI strip — pipeline count, response time, booked tours, revenue. Updated in real time as leads come in."
- **Recent leads table** — "These are inquiries from the last 7 days, with the AI's qualification score and pipeline stage."
- **Quick actions tiles** — "One-click jumps into the inbox, leads, or analytics."

### 3.2 `/dashboard/leads` — Pipeline kanban (2 minutes)

Open `http://localhost:3000/dashboard/leads`. Talk track:

- **Stages left → right** — "New Inquiry through Booked. Your sales team drags cards as deals progress, but the AI auto-stages most of them."
- **Click any card** — opens the detail panel on the right. Show:
  - Lead score (AI-generated).
  - Conversation history (if seeded; lead3, lead4, lead6, lead8 have history).
  - Notes + budget + guest count.
- **Add Lead button (top right)** — "If a couple calls you instead of using the widget, your coordinator drops the details here and the AI starts replying via email."

### 3.3 `/dashboard/inbox` — Conversations (2 minutes)

Open `http://localhost:3000/dashboard/inbox`. Talk track:

- **Click a conversation** (e.g. Emily & Daniel — lead3). Shows full thread.
- **Lead → AI → Human bubbles** — point out the message authors. "The AI handles ~80% of replies; your team jumps in only when needed."
- **AI/Human toggle in composer** — "Send a reply as the AI persona, or as yourself."

### 3.4 `/dashboard/tours` — Calendar (1 minute)

Open `http://localhost:3000/dashboard/tours`. Talk track:

- **Stats strip** — Scheduled / Confirmed / Completed counts.
- **Calendar grid** — show today, point out a scheduled tour next week.
- **Upcoming Tours list** — "Each row is auto-pinged 24h and 2h before the tour."

### 3.5 `/dashboard/analytics` — KPIs + funnel (1 minute)

Open `http://localhost:3000/dashboard/analytics`. Talk track:

- **6 KPI tiles** — 30-day totals.
- **Leads Over Time chart** — shows seeded leads spread across the month.
- **Conversion Funnel** — drop-off rate per stage.
- **AI Performance Insight card** — "We surface AI-specific metrics like average response time so you know the bot is keeping up."

### 3.6 `/dashboard/settings/billing` — Subscription (30 seconds, optional)

Open `http://localhost:3000/dashboard/settings/billing`. Talk track:

- **Current plan card** — shows trial or active state. (Phase 7D banner appears if past_due — clear with `npm run billing:seed SEED_SUBSCRIPTION_STATUS=trialing` if needed.)
- **"Manage billing" button** — "Stripe handles the actual card UI; we never see card details."

---

## 4. Submit a real widget lead (live demo)

Show that NEW leads flow through the actual product, not just seed data.

```bash
# In another shell:
export VENUE_ID="<your venue uuid>"   # get from /dashboard/settings or SQL
curl -i -X POST http://localhost:3000/api/widget \
  -H "Content-Type: application/json" \
  -H "Origin: http://localhost:3000" \
  -d '{
    "venue_id": "'"$VENUE_ID"'",
    "name": "Live Demo Couple",
    "email": "live-demo@example.com",
    "phone": "5555550100",
    "event_date": "2027-06-12",
    "guest_count": 180,
    "budget": 28000,
    "message": "Saw your venue at a wedding fair — would love to schedule a tour."
  }'
# expect 201 { "success": true, "lead_id": "...", "conversation_id": "..." }
```

Then refresh `/dashboard/leads` — the new lead shows up in **New Inquiry**. Within ~30s an AI message will appear in the inbox if Anthropic is configured.

> **Heads up**: `live-demo@example.com` does NOT match the `demo+%@venuerise.test` pattern. The reset script won't touch it. Either delete it manually via SQL after the demo, or re-use the seed pattern: `demo+livedemo@venuerise.test`.

---

## 5. Reset between demos

```bash
npm run demo:reset
```

Output:

```text
▶ demo:reset → http://localhost:3000
✓ auth.signin
✓ demo.reset.completed
  leads deleted:      10
  ai_actions deleted: 5
```

Re-seed when ready:

```bash
npm run demo:seed
```

The reset deletes ONLY:
- Leads with `email LIKE 'demo+%@venuerise.test'`
- `ai_actions` tagged `agent='demo-seed'`

Cascades from `leads` (per migration 001) clean up `conversations`, `messages`, `tours`, and `follow_up_schedules`. Real data, real widget submissions, real Stripe rows — all untouched.

---

## 6. Known demo limitations

- **AI replies require `ANTHROPIC_API_KEY`.** Without it, conversations show only the lead's message and `ai_active=true` is set but no reply comes in. The seeded conversations include pre-baked AI replies so the inbox still looks alive.
- **Emails are console-fallback in dev** unless `RESEND_API_KEY` is set. Follow-up rows in the demo show as `sent` / `pending` regardless — that state is local, not provider-confirmed.
- **The widget origin allowlist** (Phase 7A) rejects POSTs without an Origin header equal to `NEXT_PUBLIC_APP_URL`. For the live demo step (§4) we pass `Origin: http://localhost:3000` explicitly. If demoing against staging, use the staging URL.
- **Stripe / billing UI** shows the banner from Phase 7D. If `BILLING_GATE_ENABLED=1` is set and the test user's subscription is past_due/canceled, write routes return 402. Always demo with `BILLING_GATE_ENABLED=0` (default) OR after seeding the venue into `trialing` (`npm run billing:seed SEED_SUBSCRIPTION_STATUS=trialing`).
- **Demo seed picks the test user's PRIMARY venue** (first venue by `created_at` where the user is owner/admin). If they own multiple, only the first one gets seeded.
- **Realtime updates** require the Supabase realtime publication (already configured in migration 001 for leads / messages / conversations / tours). Dashboard refreshes don't auto-update on lead inserts unless realtime is wired in the page — that's why a refresh during the live widget demo (§4) is the demoable moment.

---

## 7. Emergency reset (when seed/reset gets weird)

If demo data ended up in a bad state and the API reset doesn't recover, drop to SQL via Supabase MCP or dashboard:

```sql
-- Remove all demo rows for a venue.
delete from public.ai_actions
 where venue_id = '<venue id>' and agent = 'demo-seed';

delete from public.leads
 where venue_id = '<venue id>' and email like 'demo+%@venuerise.test';
-- Cascades: conversations, messages, tours, follow_up_schedules.

-- Confirm only real rows remain.
select count(*) from public.leads where venue_id = '<venue id>';
```

The conditions are identical to the API path — never accidentally hits non-demo rows.

---

## 8. Verifying the demo surface is mounted

Quick health probe:

```bash
curl -s http://localhost:3000/api/health | jq '.demo, .admin'
# expected:
# { "seed": "mounted" }
# { "mounted": true, "endpoints": 12 }
```

If `demo.seed` is missing or `admin.endpoints != 12`, the demo routes aren't loaded — restart `npm run dev` and rebuild.

---

## 11. Variant inquiries + quick tour scheduling (Phase 8C)

Three additions on top of the Phase 8B live-demo loop:
- The "Send test inquiry" button now has a **variant selector** next to it (Garden / Greenhouse / All-inclusive) so the AI replies feel distinct across multiple demo clicks.
- The **Lead Detail panel** has a "Quick schedule tour" button for any lead in `qualified`, `tour_scheduled`, `tour_completed`, or `negotiation`. Defaults to next Tuesday at 10am local time.
- The **Tours page** subscribes to realtime — newly scheduled tours appear without manual refresh.

### 11.1 Pre-flight

```bash
# In .env.local:
NEXT_PUBLIC_DEMO_BUTTON=1
```

Restart `npm run dev`. The variant selector + button live in the Leads page header. The quick-schedule action lives inside the lead detail drawer regardless of the flag (it's role-gated to SALES_ROLES at the API).

### 11.2 The full 90-second demo

1. Open `http://localhost:3000/dashboard/leads`.
2. With the variant dropdown set to **Garden venue inquiry**, click **Send test inquiry**. A toast appears, kanban shows the new lead in `new_inquiry`.
3. Switch the dropdown to **Greenhouse vibe**, click again. A different name + budget arrives. Talk track: "Same widget endpoint, the AI tailors the first reply to the message body — watch the inbox in a second."
4. Switch to **All-inclusive package question**, click again. Three distinct leads now in the kanban; the AI is qualifying all three in parallel via Inngest.
5. Click into one of the qualified leads (Phase 8A seed leaves several in the `qualified` column).
6. In the right-side drawer, click **Quick schedule tour**. The button shows a spinner → "Tour scheduled ✓".
7. Hop to `http://localhost:3000/dashboard/tours`. The new tour appears at the top of the calendar grid + the Upcoming Tours list — via realtime, no refresh. A toast in the bottom-right reads "Tours updated".
8. Click into the tour to show the auto-generated `location_notes`: "Quick-scheduled from demo dashboard."

### 11.3 What's happening under the hood

| Surface | Behavior |
|---|---|
| `DemoInquiryButton` (variant) | Renders a native `<select>` keyed to `DEMO_INQUIRY_VARIANTS`. Each click POSTs `/api/widget` with the variant's message + a budget/guest band tuned to feel realistic. Email follows `demo+live-<variant>-<stamp>-<rand>@venuerise.test` so Phase 8A reset still sweeps it up. |
| `QuickScheduleTourButton` | POSTs `/api/tours` with `{ lead_id, scheduled_at: <next Tuesday 10am local>, duration_minutes: 60, location_notes: "Quick-scheduled from demo dashboard." }`. Hidden for `lost`, `booked`, `new_inquiry`. Re-scheduling on a lead with an existing tour is allowed — the API doesn't dedupe. |
| `RealtimeToursLayer` | `supabase.channel('tours:venue:<venueId>').on('postgres_changes', { event: '*', table: 'tours', filter: 'venue_id=eq.<venueId>' })`. Calls `router.refresh()` and shows a "Tours updated" toast on any change. |
| Dashboard overview banner | Shown only when `totalLeads === 0`. Hidden the moment the first seed/inquiry lands. |

### 11.4 Troubleshooting

**Tour doesn't appear on /dashboard/tours**:
- Hard refresh — the realtime layer + the 2s router.refresh fallback both should have fired.
- Check `/api/tours` response in DevTools → Network. Common error codes:
  - `forbidden` → caller doesn't have SALES_ROLES on the venue.
  - `subscription_required` → Phase 7D billing gate is on AND the venue's subscription isn't `active`/`trialing`. Either flip `BILLING_GATE_ENABLED=0` for the demo, or seed the subscription to `trialing` (`npm run billing:seed SEED_SUBSCRIPTION_STATUS=trialing`).
  - `Venue not found` → no venue context (user hasn't completed onboarding).
- Verify the publication carries `tours`:
  ```sql
  select tablename from pg_publication_tables
  where pubname = 'supabase_realtime' and tablename = 'tours';
  ```
  Should return one row. Migration 001 adds it.

**Variant button shows but click fails with `origin_not_allowed`**:
- Same Phase 8B fix: ensure `NEXT_PUBLIC_APP_URL` equals the host serving the dashboard.

**Quick schedule tour says "Sales / coordinator role required"**:
- The signed-in user isn't in SALES_ROLES (`owner | admin | sales_manager | coordinator`) on the venue. Re-check `venue_members` for that user.

**Same variant used twice in a row produces identical-looking lead cards**:
- Names + budgets are randomized within the variant's band; collisions are visual not structural. Each click creates a real new row with a unique email. Cards differ on `created_at` (a few seconds apart) and the random name pool of 7 entries.

---

## 10. Live demo mode (Phase 8B)

Two complementary upgrades land here:
- **Realtime refresh** on `/dashboard/leads` and `/dashboard/inbox` — new leads + conversations appear without a page refresh.
- **"Send test inquiry" button** on `/dashboard/leads` — fires a real `/api/widget` POST with a randomized realistic wedding payload. The full pipeline runs (lead insert → conversation pre-create → Inngest enqueue → AI qualification → first AI message → follow-up schedule). The button is hidden unless explicitly enabled.

### 10.1 Enable the demo button

```bash
# In .env.local:
NEXT_PUBLIC_DEMO_BUTTON=1
```

Restart `npm run dev`. The Leads page header will show a "Send test inquiry" button in the top-right.

### 10.2 The 60-second live demo

1. Open `http://localhost:3000/dashboard/leads`.
2. Click **Send test inquiry** in the page header.
3. Wait ~1 second — a toast appears in the bottom-right: *"New lead just landed: Sophia Miller"*. The kanban refreshes; the new card shows up in **New Inquiry**.
4. Click into the new lead — opens the detail panel with the message body.
5. Hop to `http://localhost:3000/dashboard/inbox` — the new conversation is at the top of the list (sorted by `last_message_at`). If Anthropic is configured, an AI message will appear within ~5–30s and the message bubble will pop in via the existing `ConversationThread` realtime subscription.
6. Click into the conversation — show the full lead → AI thread updating without refresh.

### 10.3 What's happening under the hood

| Layer | Behavior |
|---|---|
| `DemoInquiryButton` | Posts to `/api/widget` from the browser. Browser sets `Origin` header automatically — matches `NEXT_PUBLIC_APP_URL` if that's the same host you're demoing on. |
| `RealtimeLeadsLayer` | Subscribes to `leads:venue:<venueId>` postgres_changes. On any event, calls `router.refresh()` and (for INSERTs) shows the toast. |
| `RealtimeMessagesLayer` | Subscribes to `conversations:venue:<venueId>` for inbox-list re-ordering. |
| `ConversationThread` (pre-existing) | Subscribes to `messages:<conversationId>` for live bubble updates in the open thread. |
| `KanbanBoard` (Phase 8B sync) | `useEffect([initialLeads])` re-syncs local state when the server-fetched leads change via `router.refresh()`. |

### 10.4 Troubleshooting

**Button doesn't appear**:
- Check `NEXT_PUBLIC_DEMO_BUTTON` — must be exactly `"1"`. Anything else (unset, `true`, `yes`, `0`) hides it.
- Restart `npm run dev` after changing the env var (Next bundles public env at build/start time).

**Button click → 4xx**:
- 403 `origin_not_allowed` → the browser's `Origin` header doesn't match `NEXT_PUBLIC_APP_URL`. Either set `NEXT_PUBLIC_APP_URL=http://localhost:3000` or run the dashboard on the URL that matches.
- 404 `Venue not found` → the test user's primary venue isn't seeded yet. Run `npm run demo:seed` first (or sign in + complete onboarding).
- 429 → widget rate limit (10/min/IP/venue). Wait and retry.

**Lead doesn't appear after click**:
- Wait 2 seconds — the button schedules a fallback `router.refresh()` after that window if Realtime didn't fire.
- Check browser DevTools → Console / Network. If you see WebSocket errors from `supabase.realtime`, your Supabase project may have Realtime disabled or the publication isn't synced. Verify:
  ```sql
  select schemaname, tablename
  from pg_publication_tables
  where pubname = 'supabase_realtime'
    and tablename in ('leads', 'conversations', 'messages');
  ```
  Should return three rows. Migration 001 adds them.
- If realtime is unavailable, the page still works — every click on the kanban (or any natural navigation) re-fetches.

**Duplicate cards**:
- Shouldn't happen — KanbanBoard's `useEffect([initialLeads])` replaces local state wholesale on refresh. If it does, the `useEffect` may have been skipped due to stale React closure; hard refresh the page.

**Inbox doesn't re-order**:
- The `conversations.last_message_at` field is bumped by the orchestrator when a new message lands. If the orchestrator didn't fire (no `ANTHROPIC_API_KEY`), the row never updates → no realtime event → no re-order. Add the key.

### 10.5 Demo cleanup

The button's payload uses `demo+live-<timestamp>-<rand>@venuerise.test`. The Phase 8A `npm run demo:reset` matches `demo+%@venuerise.test` so these get cleaned up alongside seeded fixtures.

---

## 9. Quick reference

| Command | Effect |
|---|---|
| `npm run dev` | Local dashboard at http://localhost:3000 |
| `npm run demo:seed` | Wipe + insert ~10 leads, 4 conversations, 4 tours, 7 follow-ups, 5 AI actions |
| `npm run demo:reset` | Delete all demo rows (real data untouched) |
| `curl http://localhost:3000/api/health | jq .demo` | Verify the demo surface is mounted |
| `POST /api/widget` | Live-demo lead intake (use Origin header matching app URL) |
