# GTM-0E — Leads Page Revenue Pipeline Polish

## Before / After positioning

| | Before | After |
|---|---|---|
| Page header | "Leads" / "Manage every wedding inquiry from first touch to booked tour" | "Revenue pipeline" / "Prioritize overdue replies, hot leads without tours, scheduled visits, and recovery opportunities across every source." |
| Top summary | "104 of 104 leads shown" | "104 leads tracked · 71 need action · $2.49M open pipeline" (champagne hero band) |
| Action summary | (none) | 5-bucket "Needs attention today" bar — Reply overdue / Hot leads idle / No tour booked / Tours to confirm / Recoverable lost — each a clickable deep-link |
| Stage column labels | "New Inquiry", "Qualified", "Tour Scheduled", "Tour Completed", "Negotiation", "Booked", "Lost" | "New inquiries", "Qualified, needs next step", "Tours scheduled", "Tours completed", "Proposal / negotiation", "Booked weddings", "Lost / recovery" |
| Lead card bottom row | "BUDGET · $12k" | "NEXT · Reply now" + "EST. VALUE · $12k" (or `EST. BOOKED` / `EST. LOST` by stage) |
| Search placeholder | "Search leads…" | "Search couple, email, or source…" |

## View modes

This pass ships the **single-view** approach: the existing
PIPELINE-STAGES Kanban remains the only board view. The
"Needs attention" experience is delivered through the new
clickable summary bar — each bucket deep-links into the
EXISTING leakage filters
(`/dashboard/leads?leakage=slow_first_reply`,
`?leakage=high_fit_idle`, `?leakage=tour_booking`,
`?leakage=reactivation`).

A full bucket-Kanban "Needs Attention" view is scoped as
`leads_attention_view: 'scaffold-only'` in the health route —
the deep-links cover 90% of the demo value without requiring
a parallel KanbanBoard implementation. A future phase can
promote it.

## Action bucket definitions

| Bucket | Counted from | Filter URL |
|---|---|---|
| Reply overdue | `stage = new_inquiry` AND `age > slaMinutes` | `?leakage=slow_first_reply` |
| Hot leads idle | `lead_score ≥ 80` AND `stage ∈ {new_inquiry, qualified}` | `?leakage=high_fit_idle` |
| No tour booked | `stage = qualified` | `?leakage=tour_booking` |
| Tours to confirm | Non-cancelled tour rows with `scheduled_at > now`. Falls back to `stage = tour_scheduled` if the tours array isn't loaded. | `?leakage=tour_booking` |
| Recoverable lost | `stage = lost` (raw count; precise reactivation-candidacy check runs on click) | `?leakage=reactivation` |

These counts are derived in `LeadsPipelineSummary.tsx` from the
leads array the page already fetched + a narrow `tours` SELECT.
**No new backend routes, no new DB queries.** Counts that can't
be safely inferred from the lead row fall back to the closest
honest approximation; the precise leakage helpers run when the
operator clicks through.

## Next-action labels (per card)

| Stage | Next action | Tone |
|---|---|---|
| `new_inquiry` (past SLA) | "Reply now" | Urgent amber |
| `new_inquiry` (within SLA) | "Send first reply" | Blue |
| `qualified` | "Offer tour times" | Navy |
| `tour_scheduled` | "Confirm attendance" | Blue |
| `tour_completed` | "Send proposal" | Champagne |
| `negotiation` | "Revive around fit" | Champagne |
| `booked` | "Protect relationship" | Emerald |
| `lost` | "Reactivate softly" | Mute slate |

The pill sits in the same row as the dollar figure on the
bottom of the card. Truncates gracefully on narrow columns.

## What changed

- `app/(dashboard)/dashboard/leads/page.tsx` — header reframe;
  loads tours + venue settings; renders LeadsPipelineSummary
- `components/dashboard/leads/LeadsPipelineSummary.tsx` (NEW)
- `components/dashboard/KanbanColumn.tsx` — column labels
- `components/dashboard/KanbanBoard.tsx` — counter reframe + search
  placeholder
- `components/dashboard/KanbanCard.tsx` — NextActionPill + value
  framing
- `app/api/health/route.ts` — 5 new flags

## What NOT to claim

- **No new "Needs Attention" view yet.** The 5 buckets deep-link
  into the existing pipeline-stage view filtered by leakage.
  Don't call it a separate Kanban during demos — call it a
  "priority queue."
- **No ROAS.** Source attribution still doesn't connect ad spend.
  The card-level source badge is unchanged.
- **No autonomous lead processing.** The NextActionPill is a
  *suggested* action — clicking the card still opens the drawer
  where the operator approves the action.
- **No new lead status.** "Recoverable lost" reads as a smart
  inference, but it's just `stage = lost`. The reactivation
  helper does the precise candidacy check after the operator
  clicks through to the filtered view.

## Demo QA checklist

Open `/dashboard/leads` after seeding realistic demo data.

1. ✅ Header reads "Revenue pipeline" (not "Leads").
2. ✅ Top hero band shows champagne-accented "Pipeline overview" eyebrow.
3. ✅ Headline row reads "N leads tracked · N need action · $X open pipeline".
4. ✅ "Needs attention today" bar with 5 buckets appears below the headline.
5. ✅ Clicking each non-zero bucket routes to `/dashboard/leads?leakage=<key>` and the KanbanBoard filters correctly.
6. ✅ Zero-count buckets render disabled (no link, muted styling).
7. ✅ Pipeline stages Kanban still works — drag/drop intact.
8. ✅ Column labels read "New inquiries / Qualified, needs next step / Tours scheduled / Tours completed / Proposal / negotiation / Booked weddings / Lost / recovery".
9. ✅ Every lead card has a "NEXT · …" pill at the bottom-left.
10. ✅ Pill copy varies by stage (Reply now / Offer tour times / etc.).
11. ✅ Urgent overdue replies get amber pill.
12. ✅ Card dollar figure reads "EST. VALUE" for open leads, "EST. BOOKED" for booked, "EST. LOST" for lost.
13. ✅ Search placeholder reads "Search couple, email, or source…".
14. ✅ Add Lead button still works.
15. ✅ Source badges still render on cards.
16. ✅ Kanban counter line reads "Showing all N leads" or "Showing X of Y leads" when filtered.
17. ✅ Page scrolls correctly inside dashboard `<main>` (8BL-Hotfix-3 shell preserved).
18. ✅ Inbox unaffected.
19. ✅ No SOC 2 / GDPR / autonomous-booking overclaims anywhere.

## Recommended next GTM phase

- **GTM-0F — Tours page polish.** Same revenue-recovery framing
  applied to `/dashboard/tours`: confirm queue at the top,
  outcome funnel (scheduled → confirmed → completed → booked),
  reschedule shortcuts. Mirror the "Today's priority" pattern
  from the Overview.
- **GTM-0G — Real-time AI activity ticker.** Replace the
  AIBriefCard zero-state (currently removed from Overview) with
  a live `ai_actions` feed. Makes the demo feel alive.
- **GTM-0H — Per-venue demo seed presets.** `luxury-barn`,
  `city-ballroom`, `estate`, `garden` seed packs so the demo
  reflects the prospect in front of you.
