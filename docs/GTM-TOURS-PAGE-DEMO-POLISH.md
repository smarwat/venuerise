# GTM-0F — Tours Page Revenue Protection Polish

## Before / After positioning

| | Before | After |
|---|---|---|
| Page header | "Tours" / "Schedule, confirm, and track every venue tour" | "Tour pipeline" / "Confirm upcoming tours, prevent no-shows, and turn completed visits into booked weddings." |
| First-paint focus | 4 status counts (Scheduled / Confirmed / Completed / No Show) | Champagne `TourProtectionSummary` band with 5 risk tiles |
| Stat cards | Primary visual weight, big-typography | Secondary reference cards with owner-friendly helper copy under each count |
| Upcoming Tours card title | "Upcoming Tours / Next on your calendar" | "Tours needing protection / Upcoming visits that need confirmation, reminders, or a clean handoff." |
| Completed-tour follow-up | (missing — couples who toured then disappeared) | New `CompletedTourFollowupList` queue below the calendar |
| Calendar legend | (none) | Subtle legend row under the grid: Scheduled · Confirmed · Completed · Needs follow-up · No-show |

## New tour-protection language

- **Tour pipeline** (page) — replaces generic "Tours"
- **Tour protection** (summary eyebrow) — replaces "Tours stats"
- **Tour risks this week** (summary title) — frames the page around active risk
- **Tours to confirm** (tile) — replaces "Scheduled"
- **Needs follow-up** (tile) — replaces "Completed" framing for un-booked tours
- **Upcoming tour value** (tile) — replaces nothing; new revenue framing
- **Tours needing protection** (Upcoming card) — replaces "Upcoming Tours"
- **Completed tours needing follow-up** (queue) — new workflow surface

## Summary metric definitions

| Tile | Logic |
|---|---|
| Tours to confirm | `status === 'scheduled'` AND `scheduled_at > now` |
| Tours this week | `status ∈ {scheduled, confirmed}` AND `scheduled_at` is in the current week (Sun→Sat) |
| Needs follow-up | `status === 'completed'` AND `leads.stage NOT IN {booked, lost}` |
| Upcoming tour value | Sum of `leads.budget` across tours where `status ∈ {scheduled, confirmed}` AND `scheduled_at > now`. Rendered as "Est. value $42k" — never claimed as confirmed revenue. |
| No-shows this month | `status === 'no_show'` AND `scheduled_at` falls within the displayed month (tracks the month nav) |

All counts derive from a single broader-window tour fetch (last 60
days through next 30 days) with `leads(name, stage, lead_score,
budget)` joined. No new DB routes, no migration.

## Completed-follow-up logic

```ts
tours
  .filter(t => t.status === 'completed')
  .filter(t => t.leads?.stage !== 'booked')
  .filter(t => t.leads?.stage !== 'lost')
  .sort((a, b) => bScheduledAt - aScheduledAt)  // most recent first
  .slice(0, 5)
```

Each row renders:
- Couple name (truncated)
- Lead score chip (if known)
- Current lead stage chip
- Tour date
- **Next action** champagne label ("Send proposal" / "Revive
  around fit" / "Follow up while interest is warm" /
  "Ask for feedback"), derived from the lead's current stage
- **Est. value $42k** pill (champagne) when budget is known
- "Open lead" CTA — deep-links to `/dashboard/leads?lead=<id>`

Empty state renders the emerald "No completed tours waiting on
follow-up — couples are moving through the funnel" message,
mirroring the RevenueLeakageBrief and queue-card empty states
across the dashboard.

## Status color meanings

| Status / condition | Calendar chip color | Tone |
|---|---|---|
| Scheduled (not yet confirmed) | `#1D4ED8` blue | Action needed |
| Confirmed | `#0F172A` navy | Locked in |
| Completed | `#047857` emerald | Won the visit |
| Needs follow-up (completed + unbooked) | `#92763C` champagne | High-intent revenue at risk |
| No-show | `#B91C1C` red | Recovery candidate |

The calendar's per-day chips already use these tones via
`STATUS_CONFIG`. The new legend row below the grid teaches
the color meanings explicitly in case a buyer pattern-matches
on color before reading the chips.

## What NOT to claim

- **"Upcoming tour value" is estimated.** Sum of operator-entered
  lead budgets — not a confirmed contract figure. Labeled
  "Est. value" throughout.
- **No autonomous confirmations.** Tour status transitions
  remain operator-driven (Mark confirmed) or lead-driven
  (Phase 8K/8L tokens via email, Phase 8BL public confirmation
  links currently disabled).
- **"Needs follow-up" is a suggestion, not a forced step.** The
  list surfaces couples for the operator to choose to follow up
  with; the product does not auto-send a follow-up.
- **No SOC 2 / GDPR / autonomous-booking overclaims.** Tour
  status events feed Trust Center audit (Phase 9I) but no
  certification is claimed.

## Demo QA checklist

Open `/dashboard/tours` after seeding realistic demo data.

1. ✅ Header reads "Tour pipeline" (not "Tours").
2. ✅ Subtitle reads "Confirm upcoming tours, prevent no-shows, and turn completed visits into booked weddings."
3. ✅ Champagne `TourProtectionSummary` band sits below the header.
4. ✅ Eyebrow reads "Tour protection"; title reads "Tour risks this week" (or "No urgent tour risks right now" when all tiles are empty).
5. ✅ Each visible tile shows a 22px tabular number, an icon-tone, a one-line helper, and "Open queue →" only when href is wired.
6. ✅ Zero-value tiles are hidden entirely — the bar never shows a row of "0"s.
7. ✅ The 4 per-status reference cards (Scheduled / Confirmed / Completed / No-shows) render below the summary with reduced visual weight and an owner-friendly helper line under each count.
8. ✅ Calendar still renders the displayed month; month chevrons + Today button still work.
9. ✅ Calendar legend row sits under the grid: Scheduled · Confirmed · Completed · Needs follow-up · No-show.
10. ✅ "Upcoming Tours" card is now titled "Tours needing protection" with the updated subtitle.
11. ✅ `CompletedTourFollowupList` renders below the calendar+upcoming row when there are completed-unbooked tours.
12. ✅ Each follow-up row shows couple name + score chip + stage chip + tour date + champagne next-action label + Est. value pill + Open lead CTA.
13. ✅ Empty state: emerald "couples are moving through the funnel" message renders cleanly.
14. ✅ Schedule Tour button still works.
15. ✅ Mark confirmed on an upcoming row still works.
16. ✅ Open lead deep-links route correctly.
17. ✅ Audit drawer still opens.
18. ✅ Real-time tour status updates still fire (the existing RealtimeTourStatusLayer is untouched).
19. ✅ No fake ROAS or revenue claims; no SOC 2 / GDPR overclaims.
20. ✅ Overview, Leads, and Inbox are unaffected.

## Files modified

- `app/(dashboard)/dashboard/tours/page.tsx` — header reframe + summary mount + status card reframe + calendar legend + follow-up queue mount + broader-window tour fetch
- `components/dashboard/tours/TourProtectionSummary.tsx` (NEW)
- `components/dashboard/tours/CompletedTourFollowupList.tsx` (NEW)
- `app/api/health/route.ts` — 5 new flags

## Recommended next GTM phase

- **GTM-0G — Analytics + Settings polish.** Same revenue-recovery
  framing for `/dashboard/analytics` (lead-source funnel, booking
  velocity) and `/dashboard/settings` (knowledge-base + Revenue OS
  thresholds reframed as "tune the AI to your venue's voice").
  Completes the dashboard-trilogy + branding pass.
- **GTM-0H — Real-time AI activity ticker.** Replace the
  AIBriefCard zero-state (removed in GTM-0D) with a live
  `ai_actions` feed across the Overview hero.
- **GTM-0I — Per-venue demo seed presets.** `luxury-barn`,
  `city-ballroom`, `estate`, `garden` packs so demos reflect the
  prospect in front of you.
