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

## 13. Editing, confirming, cancelling, and navigating tours (Phase 8E)

Closes the two remaining gaps on `/dashboard/tours`: operators can now **edit, confirm, and cancel** existing tours, and the page supports **URL-based month navigation** so a tour scheduled into a future month is one chevron-click away.

### 13.1 Quick reference

| Action | How |
|---|---|
| Schedule a new tour | Click **Schedule Tour** in the header → `ScheduleTourDrawer` (Phase 8D). |
| Edit an existing tour | Click any row in **Upcoming Tours** → `EditTourDrawer` opens prefilled. |
| Mark scheduled tour as confirmed | Click the inline **Mark confirmed** button on the row (only shows for `scheduled`). |
| Cancel a tour | Open the edit drawer → **Cancel tour** button in the footer. Soft-cancel — row stays in DB with `status='cancelled'`. |
| Navigate months | Chevron pair + "Today" in the page header → URL becomes `?month=YYYY-MM`. |

### 13.2 The full walkthrough

1. Open `http://localhost:3000/dashboard/tours`. Page header shows: `[‹] October 2026 [›] [Today]` and `[+ Schedule Tour]`.
2. Click **‹** (previous month) — URL becomes `?month=2026-09`, page re-fetches for September.
3. Click **›** (next month) twice — `?month=2026-11`.
4. Click **Today** — URL strips the param; you're back on the current month.
5. Click **Schedule Tour**, pick a lead, submit. The tour appears in the Upcoming Tours list (via realtime + `router.refresh()`).
6. Click that newly-scheduled row. `EditTourDrawer` opens prefilled with the date, time, duration, notes, and status.
7. Bump the duration to 90 minutes, add `"Bring portfolio + sample menus."` to the notes, click **Save changes**. Green banner → drawer auto-closes → row updates.
8. Hover the row again — the inline **Mark confirmed** button is visible (status is still `scheduled`). Click it. The badge flips from `Scheduled` to `Confirmed`, the inline button disappears.
9. Click the row again to re-open the drawer. The status select now reads `Confirmed`. Click **Cancel tour** in the footer → window.confirm → on accept, the drawer flashes a "Tour cancelled" banner and auto-closes.
10. Refresh the page — the cancelled tour is gone from Upcoming (filter excludes `cancelled`) but still visible in the calendar grid with the `cancelled` chip.
11. Soft-cancel means the row is preserved for audit + reschedule context. Use SQL or a future bulk-cleanup tool if you need to hard-delete.

### 13.3 What's happening under the hood

| Surface | Behavior |
|---|---|
| `MonthNavClient` | Reads `?month` from `useSearchParams`, pushes new value via `useRouter().push()`. "Today" deletes the param entirely so the URL stays clean. Server re-fetches the tour rows for the new month. |
| `TourInteractionClient` | Wraps the Upcoming Tours list. Each row is a button → `setSelectedTour` + `setDrawerOpen(true)`. Inline **Mark confirmed** stops event propagation so it doesn't double-fire the drawer open. |
| `EditTourDrawer` | Same shape as `ScheduleTourDrawer` (Phase 8D) but PATCHes `/api/tours/[id]` instead of POSTing. Re-seeds local state on every open via `useEffect([open, tour])` so clicking row A then row B loads B's values. |
| Cancel button | PATCHes `{ status: 'cancelled' }`. window.confirm prompts the operator first. The drawer's status state machine surfaces a `cancelling` spinner. |
| Calendar grid | Stays server-rendered. Click handlers only live on the Upcoming Tours list per the Phase 8E spec (surgical pass). |
| `RealtimeToursLayer` (Phase 8C) | Subscription unchanged. `router.refresh()` preserves `?month=YYYY-MM` so a realtime event doesn't bounce the operator to the current month. |

### 13.4 PATCH `/api/tours/[id]` shapes

The route's existing Phase 7D Zod schema accepts:

```ts
{
  status?: 'scheduled' | 'confirmed' | 'completed' | 'cancelled' | 'no_show'
  scheduled_at?: <ISO datetime>
  duration_minutes?: <int 15–480>
  location_notes?: <string | null>
  reminder_24h_sent?: boolean
  reminder_2h_sent?: boolean
  outcome?: <string | null>
}
```

Phase 8E uses these bodies:

**Save changes** (full edit):
```json
{
  "scheduled_at": "<ISO datetime, UTC>",
  "duration_minutes": 60,
  "location_notes": "<string|null>",
  "status": "<scheduled|confirmed|completed|cancelled|no_show>"
}
```

**Mark confirmed** (inline):
```json
{ "status": "confirmed" }
```

**Cancel tour** (drawer footer):
```json
{ "status": "cancelled" }
```

### 13.5 Troubleshooting

**Edit submit returns 401** — operator's session expired. Sign back in.

**Edit submit returns 403** — operator's role on the venue isn't in `SALES_ROLES`. Re-check `venue_members`.

**Edit submit returns 402 `subscription_required`** — Phase 7D billing gate is on AND the venue's subscription isn't `active`/`trialing`. Flip the gate off for demos, or seed:
```bash
SEED_SUBSCRIPTION_STATUS=trialing npm run billing:seed
```

**Edit submit returns 404 `Tour not found`** — the tour was deleted (rare; we soft-cancel rather than delete) OR the row's `venue_id` doesn't match the caller's venue (cross-tenant attempt). Refresh the page.

**Tour not visible in Upcoming Tours** — check the URL's `?month=YYYY-MM` value matches the tour's `scheduled_at`. Click **Today** to jump back. Cancelled/completed rows are filtered from Upcoming by design but still appear in the calendar grid + month-level stat cards.

**Realtime stale** — the bottom-right "Tours updated" toast should fire on any tour change. If it doesn't, verify the `tours` table is still in the `supabase_realtime` publication:
```sql
select tablename from pg_publication_tables
where pubname='supabase_realtime' and tablename='tours';
```

**Month nav chevron does nothing** — check the URL bar; the param updates immediately. If the calendar doesn't re-render, your `useSearchParams` cache might be stale — hard refresh.

---

## 12. Full schedule-tour drawer (Phase 8D)

Always-available drawer for the real product flow. Lives on:
- **`/dashboard/tours`** — header **Schedule Tour** button opens the drawer with the venue's full lead list.
- **`/dashboard/leads`** → click any lead → right-side detail panel → **Schedule tour…** button opens the drawer prefilled with the chosen lead.

Both entry points POST the same `/api/tours` payload (existing Phase 6B route, SALES_ROLES + billing-gated):

```json
{
  "lead_id": "<uuid>",
  "scheduled_at": "<ISO datetime, UTC>",
  "duration_minutes": 60,
  "location_notes": "<string|null, max 500 chars>"
}
```

The drawer defaults match Phase 8C's quick-schedule helper: next Tuesday at 10:00 local time, 60-minute duration, empty notes (or `"Scheduled from lead detail."` when launched from the lead panel).

### 12.1 The full flow

1. Open `http://localhost:3000/dashboard/tours`.
2. Click **Schedule Tour** in the page header. Drawer opens.
3. Pick a lead from the dropdown — sorted by `created_at desc`, capped at 100.
4. Adjust date / time / duration. Type a location note (optional).
5. Click **Schedule tour**. Spinner → green "Tour scheduled" banner → drawer auto-closes after ~700ms.
6. The new tour appears in the calendar + Upcoming Tours list — via `RealtimeToursLayer` (no manual refresh).

### 12.2 From the lead detail panel

1. Open `/dashboard/leads`. Click any lead card.
2. In the right drawer, click **Schedule tour…** (always visible, regardless of stage — the API itself decides what's valid).
3. The dialog opens with the lead pre-selected (single-item picker). Operator can't swap from here — go to `/dashboard/tours` for cross-lead scheduling.
4. Defaults + submit identical to §12.1.

> The demo-only **QuickScheduleTourButton** (Phase 8C) stays in the LeadDetailPanel but only renders when `NEXT_PUBLIC_DEMO_BUTTON=1`. Production users see only the full drawer.

### 12.3 What's happening under the hood

| Surface | Behavior |
|---|---|
| `ScheduleTourDrawer` | Radix Dialog. Lead picker is a Radix Select; date/time/duration are HTML inputs; notes are a styled `<textarea>`. Combines date + time into a local Date and serializes with `.toISOString()` for an unambiguous UTC wire format. |
| `TourSchedulingClient` | Tiny client wrapper that owns the drawer's open state. Mounted from the server-rendered tours page so the page stays a Server Component. |
| Tours page server fetch | Loads `id, name, email, stage` for the 100 most recent leads in addition to the existing tours fetch. Passes them into `TourSchedulingClient`. |
| LeadDetailPanel | Renders `ScheduleTourDrawer` alongside the panel. Drawer's `leads` array is a single entry — the active lead. Drawer's `defaultNotes` is `"Scheduled from lead detail."`. |
| Realtime | Submit → `router.refresh()` + `RealtimeToursLayer` (Phase 8C) → calendar + Upcoming Tours both update without a hard refresh. |

### 12.4 Troubleshooting

**Drawer submit returns 401** — operator's Supabase session expired. Sign back in.

**Drawer submit returns 403** — operator's role on the venue isn't in `SALES_ROLES` (`owner | admin | sales_manager | coordinator`). Re-check `venue_members`.

**Drawer submit returns 402 `subscription_required`** — `BILLING_GATE_ENABLED=1` AND the venue's subscription isn't `active`/`trialing`. Flip the gate off for demos, or seed the subscription:
```bash
SEED_SUBSCRIPTION_STATUS=trialing npm run billing:seed
```

**Drawer submit returns 400 `validation_failed`** — body schema rejected. Most common cause: date+time combined into an invalid Date. Check the operator's browser locale; format inputs through the date/time pickers rather than typing manually.

**Tour doesn't appear after submit** — `router.refresh()` ran (drawer success banner showed) but the calendar didn't update. Either:
- `tours` table isn't in `supabase_realtime` publication (verify with `select tablename from pg_publication_tables where pubname='supabase_realtime' and tablename='tours';`).
- The tour was created with a `scheduled_at` outside the current month window — the page only loads the current month's rows. Navigate to the right month (a future phase will add month navigation).

**Lead picker is empty** — no leads exist for this venue. Either submit a widget inquiry (Phase 8B `Send test inquiry` button) or run `npm run demo:seed`.

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

## 11. Rescheduling tours from the inbox (Phase 8F)

The `/dashboard/inbox/[leadId]` view now renders a **TourLifecycleStrip** between the conversation header and the message thread. It surfaces the most relevant tour for the lead and a one-click action so an operator can schedule, reschedule, or edit a tour without leaving the conversation.

The "most relevant" pick is server-resolved in `app/(dashboard)/dashboard/inbox/[leadId]/page.tsx::pickRelevantTour`:

1. Prefer any **upcoming** `scheduled` or `confirmed` tour (`scheduled_at > now`).
2. Otherwise fall back to the most recent past tour (any status) so the operator sees "last tour completed / cancelled / no-show".
3. If the lead has never had a tour, the strip shows "No tour scheduled yet" with a **Schedule tour** button.

The strip reuses the Phase 8D `ScheduleTourDrawer` and the Phase 8E `EditTourDrawer` verbatim — no duplicate scheduling logic anywhere. Both drawers call `router.refresh()` on success, so the strip re-fetches the relevant tour and the badge / date line update without a manual reload.

### 11.1 Demo script

1. Open `/dashboard/inbox` and click any conversation that doesn't yet have a tour.
2. Strip says **"No tour scheduled yet"** → click **Schedule tour**. The drawer's lead picker is pre-filled with the active lead.
3. Pick a future date/time + duration → submit. Strip flips to show the upcoming tour with a blue "Scheduled" badge.
4. Click **Edit / reschedule** → drawer opens with the existing tour. Change the time, save. Strip updates.
5. Open the drawer again → set status to `cancelled` and save. Strip now shows **"Last tour"** with a slate "Cancelled" badge and a **Schedule another tour** button.

### 11.2 Troubleshooting

- **Strip shows the wrong tour** → check the `tours` table for this lead. The strip prefers an upcoming `scheduled` or `confirmed` row. If multiple are upcoming, it picks the soonest. Past rows ordered desc by `scheduled_at`.
- **Drawer says "Tour not found" after edit** → an admin or another operator may have deleted the tour. Close the drawer; the strip will re-fetch on next render.
- **Date picker shows past dates** → that's intentional for the edit drawer (you may legitimately need to backdate a completed tour). The schedule drawer rejects past dates at submit time.

---

## 12. Bulk cancel tours for a date range (Phase 8F)

Operators can mass-cancel every future `scheduled|confirmed` tour for a venue in a date window without hand-running SQL. Useful when a venue closes for a holiday, weather event, or any incident that forces a sweeping reschedule.

**Endpoint**: `POST /api/admin/tours/bulk-cancel`

**Auth**:
- `requireAdmin()` — caller must be owner/admin of some venue.
- If `venue_id` is supplied and differs from the caller's primary venue, `requireVenueRole(ADMIN_ROLES)` re-verifies access. Cross-tenant attempts collapse to `404` so admins can't enumerate other venues by guessing UUIDs.
- Rate-limited per caller (key `admin:tours-bulk-cancel:{userId}`).

**Body**:

```json
{
  "venue_id": "<uuid, optional — defaults to caller's primary venue>",
  "from_date": "YYYY-MM-DD",
  "to_date":   "YYYY-MM-DD",
  "reason":    "Optional free-text, max 240 chars"
}
```

**Validation**:
- `from_date <= to_date` (else 400 `from_after_to`).
- Range `<= 90` days inclusive (else 400 `range_too_large`).
- Only rows where `status ∈ {scheduled, confirmed}` AND `scheduled_at > now()` are touched. Completed / cancelled / no-show / past rows are left alone — we never retroactively rewrite history.
- If `reason` is present it gets written to `tours.outcome` so the EditTourDrawer surfaces it.

**Response**:

```json
{
  "success": true,
  "venue_id": "<uuid>",
  "cancelled_count": 12,
  "from_date": "2026-07-04",
  "to_date":   "2026-07-06"
}
```

**Example**:

```bash
curl -i -X POST http://localhost:3000/api/admin/tours/bulk-cancel \
  -H "Cookie: <copy from your logged-in browser session>" \
  -H "Content-Type: application/json" \
  -d '{
    "from_date": "2026-07-04",
    "to_date":   "2026-07-06",
    "reason":    "Fire damage — venue closed for restoration"
  }'
```

**Verify**:

```sql
select id, scheduled_at, status, outcome
from public.tours
where venue_id = '<uuid>'
  and scheduled_at >= '2026-07-04'
  and scheduled_at <  '2026-07-07'
order by scheduled_at;
```

All rows should have `status = 'cancelled'` and (if a reason was supplied) `outcome` set to that string. The cancellations propagate through the Phase 8C realtime layer so any open dashboard tab sees the calendar update within seconds.

---

## 9. Quick reference

| Command | Effect |
|---|---|
| `npm run dev` | Local dashboard at http://localhost:3000 |
| `npm run demo:seed` | Wipe + insert ~10 leads, 4 conversations, 4 tours, 7 follow-ups, 5 AI actions |
| `npm run demo:reset` | Delete all demo rows (real data untouched) |
| `curl http://localhost:3000/api/health | jq .demo` | Verify the demo surface is mounted |
| `POST /api/widget` | Live-demo lead intake (use Origin header matching app URL) |
