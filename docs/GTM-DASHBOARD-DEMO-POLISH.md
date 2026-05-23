# GTM-0D — Dashboard Buyer Clarity Pass

## What changed

The `/dashboard` Overview was technically strong but felt like a
generic SaaS analytics dashboard. For sales demos to wedding-venue
owners we wanted the page to communicate in under 10 seconds:

> "Here is where your venue is losing bookings today, and here is
> exactly what to do next."

### Top of the page

| Before | After |
|---|---|
| `AIBriefCard` zero-state — "0 replies sent", "0 tour booked", "0 packets sent", "0h time returned" | `ExecutiveHero` — leads with "X revenue opportunities need attention today" + 4 tiles (Pipeline at risk, Needs action, Tours to protect, Booked value tracked) |
| Loud red/blue "Start your subscription" CTA banner | Quiet champagne "Pilot workspace active" pill when billing gate is off (no CTA, no checkout pressure on demos) |
| (no priority list) | `TodayPriorityCard` — numbered "do these first" list with deep-link CTAs |

### Revenue Leakage as thesis

| Before | After |
|---|---|
| Eyebrow: "Revenue OS" | Eyebrow: "Revenue thesis" (champagne tone) |
| Title: "Revenue leakage watch" | Title: "Where bookings are slipping today" |
| Subtitle: "Where leads are most at risk of slipping. Updated each load." | Subtitle: "The fastest way to recover revenue is to catch missed replies, idle hot leads, and tours that were never confirmed." |
| (no count badge) | "N need attention" champagne badge in header |

### Signal labels (Revenue Leakage tiles)

| Old label | New label |
|---|---|
| Inquiries waiting for a first reply | New inquiries waiting |
| High-fit leads without a next step | Hot leads sitting idle |
| Qualified leads with no tour booked | Qualified leads not yet touring |
| Tours pending confirmation | Tours not confirmed |
| Cold leads to recover | Recoverable cold leads |

### Queue card rename + reframe

| File | Old | New |
|---|---|---|
| `RecoveryQueueCard` | "Follow-up recovery / Stalled leads to recover / Highest-value leads that need a human touch." | "Revenue recovery / High-value leads to recover / Leads with buying intent that still need a human touch." |
| `TourConfirmationQueueCard` | "Tour Booking Agent / Tours needing confirmation / Scheduled tours that still need a clear yes from the couple." | "Tour protection / Tours that need confirmation / Scheduled visits that need clear confirmation before they slip." |
| `ReactivationQueueCard` | "Reactivation Agent / Leads worth re-engaging / Lost leads where the cool-down + recorded reason suggest a soft check-in could re-open the conversation." | "Lost-lead recovery / Lost leads worth re-engaging / Older lost leads that may still be worth a soft check-in." |

### Attribution card reframe

| Card | Title before | Title after |
|---|---|---|
| `AttributionPerformanceCard` | "Attribution performance" | "Which sources are creating real opportunities" |
| `BookedRevenueAttributionCard` | "Booked revenue by source" | "Which sources are turning into booked weddings" |
| Column rename | "Est. pipeline" | "Est. inquiry value" |
| Column rename | "Est. booked" | "Est. booked value" |
| Column rename | "L → Booked" | "Lead → booked" |

The "not ROAS" disclaimer copy already lived in each card's footer
and is preserved verbatim — we deliberately do NOT claim ad-spend
ROAS anywhere.

## Why the dashboard now leads with revenue recovery

Wedding-venue owners don't buy "SaaS productivity dashboards." They
buy revenue. The new Overview structure tells the same story three
times in three ways:

1. **One sentence** in the hero: "X revenue opportunities need
   attention today."
2. **Four tiles** that quantify it: pipeline at risk, needs action,
   tours to protect, booked value tracked.
3. **A priority list** with the exact next action: "Reply to N new
   inquiries → Open inbox", "Confirm N scheduled tours → Open tour
   queue", etc.

If the buyer's attention drops off after the hero, they've already
gotten the thesis. If they keep scrolling, the priority list shows
the product in action. If they scroll further, the Revenue Leakage
card + queue cards show the depth.

## Buyer-facing language rules

Use:
- "Pipeline at risk"
- "Needs action today"
- "Tours to protect"
- "Booked value tracked"
- "Hot leads sitting idle"
- "Recoverable cold leads"
- "High-value leads to recover"
- "Tours that need confirmation"
- "Lost leads worth re-engaging"
- "Revenue thesis"
- "Revenue recovery"
- "Tour protection"
- "Pilot workspace active"

Avoid:
- "Operator activity"
- "Agentic workflow"
- "Items" (use "leads" / "tours" / "inquiries")
- "Signals" (use "opportunities" / "leakage")
- "Automation stack"
- "Tour Booking Agent" (internal name, use "Tour protection" externally)
- "Reactivation Agent" (internal name, use "Lost-lead recovery" externally)
- "Follow-Up Recovery" (internal name, use "Revenue recovery" externally)

## What NOT to claim

- **No ROAS.** Ad spend is not connected anywhere in the product.
  Attribution cards explicitly disclose this in their footers.
- **No SOC 2 / GDPR certifications.** We have a Trust Center
  evidence pack (Phase 9I) and disclosures (Phase 9N), not active
  certifications.
- **No autonomous booking.** Every AI suggestion still requires
  operator approval. The Tour Booking + Recovery + Reactivation
  cards all surface suggestions that the operator confirms in the
  drawer.
- **No "billing is active"** copy when the billing gate is disabled
  in the workspace. The "Pilot workspace active" champagne pill is
  honest: billing is genuinely disabled.

## Demo QA checklist

Open `/dashboard` after seeding realistic demo data. Confirm:

1. ✅ No red billing error appears on Overview. (Pilot pill shows
   instead when gate is off.)
2. ✅ Top section explains the business value in under 10 seconds:
   "X revenue opportunities need attention today."
3. ✅ Dashboard leads with revenue recovery, not generic SaaS
   productivity metrics.
4. ✅ Revenue Leakage card reads as the central thesis (champagne
   eyebrow, "N need attention" badge, "Where bookings are slipping
   today" title).
5. ✅ Today's Priority card tells operator exactly what to do, in
   numbered order, with one-click CTAs.
6. ✅ Recovery / Tour / Reactivation cards still present but
   relabeled in owner-friendly language.
7. ✅ Attribution cards are understandable and honestly labeled —
   "Est. inquiry value", "Est. booked value", "Lead → booked".
8. ✅ Attribution footer explicitly says ad spend is not connected
   (no fake ROAS).
9. ✅ No SOC 2 / GDPR / autonomous-booking overclaims anywhere.
10. ✅ All deep-links into `/dashboard/leads?leakage=...` work and
    pre-filter correctly.
11. ✅ Page is visually cleaner — hero band, then priority, then
    thesis, then queues, then attribution, then metric tiles, then
    pipeline + recent leads.
12. ✅ Layout scrolls correctly inside `<main>` (8BL-Hotfix-3 shell
    viewport lock preserved).
13. ✅ Inbox fixes (`/dashboard/inbox`) unaffected — independent
    scroll regions, no body scroll, composer pinned.
14. ✅ Dashboard feels premium enough for a wedding-venue owner —
    champagne accent on the hero + leakage card, navy elsewhere,
    no purple, no pastels, no rainbow.

## Files modified

- `app/(dashboard)/dashboard/page.tsx` — hero / priority / reorder
- `components/dashboard/ExecutiveHero.tsx` — NEW
- `components/dashboard/TodayPriorityCard.tsx` — NEW
- `components/dashboard/RevenueLeakageBrief.tsx` — copy reframe
- `components/dashboard/RecoveryQueueCard.tsx` — title / subtitle
- `components/dashboard/TourConfirmationQueueCard.tsx` — title / subtitle / footer
- `components/dashboard/ReactivationQueueCard.tsx` — title / subtitle
- `components/dashboard/AttributionPerformanceCard.tsx` — title / subtitle / column
- `components/dashboard/BookedRevenueAttributionCard.tsx` — title / subtitle / columns
- `components/dashboard/billing/BillingBanner.tsx` — pilot pill when gate off
- `lib/revenue-os/leakage.ts` — 5 signal labels reworded
- `app/api/health/route.ts` — 5 new flags

## Recommended next GTM phase

After GTM-0D the dashboard is closer to 9/10 sales-ready. To push to
true 10/10 the gaps are:
1. **Real venue feedback.** Run 3–5 demos and observe which sections
   buyers point at, which they ignore, which they ask questions
   about.
2. **Live "AI just handled X" feed.** The AIBriefCard was removed
   for honesty, but a real-time replacement (powered by `ai_actions`
   inserts) would make the product feel even more alive in a demo.
3. **Per-venue demo seed presets.** Seed scripts that mimic
   "your-venue-with-3-months-of-real-leads" — current demo seed is
   strong but a "luxury barn", "city ballroom", "estate" preset
   palette would let demos feel customized to the buyer.
