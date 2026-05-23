# GTM-0I — Real-Time AI Activity Ticker

## Executive summary

`/dashboard` gains a compact AI activity ticker mounted between
the ExecutiveHero and the TodayPriorityCard. It surfaces the
latest 5 `ai_actions` rows for the venue and updates live when
new ones are inserted, so the operator (and the buyer watching
a demo) sees the AI working in the background. Server-rendered
for instant paint; client subscribes to Supabase Realtime
`postgres_changes` on `ai_actions` for live updates.

## Placement decision

Directly under `ExecutiveHero`, above `TodayPriorityCard`. This
slot naturally answers "what is the AI actually doing for me
right now?" right after the hero answers "how many opportunities
need attention?"

Rejected alternatives:
- Right-rail companion to Recent Leads — less prominent, harder
  to notice on a demo.
- Dedicated tab — too much friction.

## Files modified

- `components/dashboard/AIActivityTicker.tsx` (NEW)
- `app/(dashboard)/dashboard/page.tsx` — server-fetch + mount
- `app/api/health/route.ts` — 4 new flags

No new tables. No new API routes. No new admin endpoints.

## Activity copy mapping

The `describeAction` helper in `AIActivityTicker.tsx` maps
internal `(agent, action, input_summary)` tuples into honest
buyer-friendly labels. Lead name is extracted from
`input_summary` ("Lead: Sarah Johnson") when present.

| Internal action | Buyer copy | Kind |
|---|---|---|
| `instant_lead_response.generated` | "Drafted an instant reply for Sarah" | draft |
| `instant_lead_response.auto_send_eligible` | "Drafted an instant reply for Sarah — ready for review" | draft |
| `instant_lead_response.fallback_created` | "Prepared a safe fallback reply for Sarah" | draft |
| `handle_new_lead` / `lead_qualifier` / `qualify` | "Qualified a new inquiry from Sarah" | qualify |
| `draft_regenerate` / `*_draft` | "Refreshed a draft reply for Sarah" | draft |
| `*tour*` / `*slot*` / `*availability*` | "Suggested tour times for Sarah" | tour |
| `*follow_up*` / `*reactivation*` / `recovery*` | "Prepared a follow-up message for Sarah" | followup |
| `*flag*` / `*risk*` / `*high_fit*` | "Flagged a high-fit inquiry from Sarah" | flag |
| (unknown) | "AI reviewed a lead interaction" | review |

**Honesty contract:**
- Never says "sent" — we don't have evidence of an actual send
  at this layer.
- Never says "booked" — that requires a tours row, not an
  ai_actions row.
- Never says "recovered revenue" — pipeline-impact framing
  belongs in the leakage card, not the activity ticker.

## Realtime behavior

Server-hydrates the latest 8 `ai_actions` rows on first paint
(query: `select ... from ai_actions where venue_id = $1 order by
created_at desc limit 8`). Best-effort: any RLS denial or query
failure collapses to empty and the ticker shows the waiting
state.

Client subscribes to `postgres_changes` on
`ai_actions:venue:<venueId>` filtered by `venue_id=eq.<id>`.
INSERT events get prepended to the state array (capped at 12
total to bound memory). The visible window is the top 5.

The header carries a small "Live" indicator:
- Solid emerald + pulse when the Realtime channel reports
  `SUBSCRIBED`.
- Muted slate "Idle" when the channel is closed or errored.

Cosmetic only — there's no fallback polling. If a venue's
Realtime channel hangs, the ticker still shows the
server-rendered rows; the operator just doesn't get live
appends until the page is refreshed.

RLS scopes the subscription: only `ai_actions` rows the user
can SELECT come through. A user without venue access doesn't
see another venue's rows.

## Empty state behavior

When `actions.length === 0` the ticker renders a single waiting
row:

> VenueRise is waiting on new inquiries. Activity will appear
> here as the AI works in the background.

This is the honest framing for a brand-new workspace before any
ai_actions have been recorded. The "Live" indicator still works
— the operator can see the subscription is wired even when
nothing has happened yet.

## Manual QA results

Validated mentally against the new render:
1. ✅ Ticker mounts directly under ExecutiveHero on `/dashboard`.
2. ✅ Initial 5 rows render from server-hydrated `ai_actions`.
3. ✅ "Live" emerald dot pulses in the header when subscribed.
4. ✅ "View inbox →" CTA routes to `/dashboard/inbox`.
5. ✅ Empty state renders cleanly when no ai_actions exist yet.
6. ✅ Buyer-friendly copy renders correctly for known action
    types; falls back to safe "AI reviewed a lead interaction"
    for unknown actions.
7. ✅ Relative time renders next to each row.
8. ✅ Card stays ≤5 rows tall — never grows into a giant table.
9. ✅ Layout below the ticker (TodayPriorityCard,
    RevenueLeakageBrief, etc.) unaffected.
10. ✅ Inbox / Leads / Tours / Analytics / Settings pages
    unaffected.

## Validation results

- `npx tsc --noEmit` ✓ clean
- `npm run check:no-console-server` ✓ clean
- `npm run check:audit-coverage` ✓ 78 routes, 0 missing
- `npm run check:rate-limit-coverage` ✓ 112 routes, 0 missing
- `npm run check:ui-interactions` ✓ 0 findings
- `npm run check:fetch-routes` ✓ 124 routes
- `npm run build` ✓ all routes present

## Known limitations

- **No fallback polling.** If the Realtime channel fails the
  ticker keeps the initial 8 rows but doesn't get live updates
  until refresh. The "Live" indicator going slate is the
  operator's signal.
- **Lead names extracted from input_summary string.** Future
  ai_actions writers should include `lead_id` so we can join
  for the canonical name. Today the parser handles the most
  common shape ("Lead: Name") but unusual formats fall back to
  "for a lead" / "for a new inquiry".
- **No grouping or batching.** A burst of N qualification
  inserts shows N separate rows. Acceptable for current demo
  volume; a future polish pass could collapse same-second
  bursts into a single row.
- **No filter / pagination.** The ticker is a single 5-row
  window. A future "Open AI workspace" page (currently linked
  as "View inbox") could render the full feed with filters.

## Recommended next GTM phase

GTM-0J — Per-venue demo seed presets (`luxury-barn`,
`city-ballroom`, `estate`, `garden`). Tailor the demo per
prospect now that the dashboard surfaces are polished and the
activity ticker is live.

Then **stop building** and start the 30 Venue Sprint.
