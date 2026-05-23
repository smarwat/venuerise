# GTM-0G — Analytics Page Revenue Intelligence Polish

## Before / After positioning

| | Before | After |
|---|---|---|
| Page title | "Analytics" | "Revenue intelligence" |
| Subtitle | "30-day performance and conversion funnel" | "See which sources create booked weddings and where revenue leaks from the funnel." |
| Top KPI row | Leads (30d) · Avg Score · Conversion · Pipeline · Tours Done · AI Latency | New inquiries · 30d · Tours completed · Booked weddings · Lead → booked · Open pipeline · Est. booked value |
| Key insight | (none) | New champagne-accented Key Insight card with deterministic source-prioritization headline + CTA |
| Source leakage CTA | "View leads →" | "Recover leads →" (champagne) |
| Attribution section title | "Attribution breakdown" | "Which sources create real opportunities" |
| Booked revenue section title | "Booked revenue by source" | "Which sources are turning into booked weddings" |
| Source leakage section title | "Source leakage breakdown" | "Where each source is leaking revenue" |
| Funnel | Chart only | Chart + deterministic "Biggest funnel drop-off" insight underneath |
| Inquiry chart title | "Leads Over Time" | "Inquiry volume over time" + peak-day annotation |
| AI Performance Insight | "Better client communication can boost tips and repeat work — try faster responses and more follow-ups." + vague "Run Analysis" CTA | "Response speed insight" / "Faster first replies help protect high-intent inquiries before couples move on to another venue." + "View slow-reply leads" deep-link CTA. Hides entirely when `ai_actions` has no recorded latency. |

## KPI definitions

| Tile | Logic | Honesty note |
|---|---|---|
| New inquiries · 30d | `leads.created_at >= now - 30d`, count | Counts every captured inquiry, including unattributed |
| Tours completed | `tours.status === 'completed'`, count | All-time on the venue |
| Booked weddings | `leads.stage === 'booked'`, count | All-time |
| Lead → booked | `booked / total_leads * 100` | Rate across the venue's lifetime leads |
| Open pipeline | sum of `leads.budget` where `stage NOT IN {lost, booked}` | Estimated from operator-entered budgets — never claimed as contracted revenue |
| Est. booked value | sum of `leads.budget` where `stage = 'booked'` | Estimated from booked-lead budgets — labeled "Est." in helper text |

Money tiles always render even when the value is `—` so the operator
sees where the budget-entry workflow will light up; non-money tiles
hide when their value isn't meaningful (matches the GTM-0D ExecutiveHero
discipline).

## Key insight logic

Deterministic. No model call. Selection priority:

1. If the top-pipeline source has another source with ≥3 at-risk
   leads, the headline highlights both and the CTA opens the
   at-risk source's leads filter:
   > "Website and Meta Ads created the most pipeline, but Meta Ads has 19 at-risk leads. Prioritize follow-up recovery there first."
2. Else if a different source has the most booked value than the
   top-pipeline source:
   > "Google Ads has the strongest booked value so far, while Website is creating the most inquiries but fewer booked weddings."
3. Else if a top-pipeline source exists:
   > "Website is currently your highest-value pipeline source. Keep response speed tight on inbound from this channel."
4. Else fallback:
   > "Connect at least 20 attributed inquiries to see source-level intelligence here."

CTA buttons always deep-link into an existing filtered surface
(`/dashboard/leads?source=<label>` or `/dashboard/leads`) — never
into a fake "Run analysis" no-op.

## Source leakage logic (unchanged)

Reuses the existing `buildSourceLeakageSummary` helper from
`lib/enterprise/attribution/leakage.ts`. Each row buckets the
venue's leads by attribution source label and counts the active
Revenue OS signals (slow first reply / no tour booked / follow-up
recovery / cold-lead recovery / reactivation). The table renders
the top leakage reason + at-risk count + a "Recover leads →"
CTA into the leads-board source filter.

## Attribution honesty rules

Preserved verbatim from prior phases — only the surfacing copy
changed:

- **Not ROAS.** Ad spend is not connected. The
  `attributionSummary.disclaimer` footer says so explicitly on
  every render of the attribution table.
- **Estimated, not contracted.** Booked revenue values come from
  `leads.budget` entered by the operator, not a final contract
  field. The booked-revenue footer says so explicitly.
- **Best-effort attribution.** Source labels are derived from
  UTM / click-id / channel data captured at inquiry time. No
  per-impression measurement.

## Funnel insight rules

Pure deterministic computation over `funnelStages`:

```ts
counts = stages.map(s => s.count)         // descending by funnel order
biggestDrop = max((1 - counts[i+1]/counts[i]))
```

The largest gap is matched to a curated insight string:

| Gap | Insight |
|---|---|
| Qualified → Tour Scheduled | "Qualified leads are not getting onto tour slots fast enough." |
| Tour Scheduled → Tour Completed | "Tours are being scheduled but not showing up. Confirmation reminders matter here." |
| Tour Completed → Negotiation | "Couples tour the venue but the proposal handoff is delayed." |
| Negotiation → Booked | "Proposals are landing but final close needs a stronger nudge." |
| New Inquiry → Qualified | "First-reply speed and qualification questions need a tighter rhythm." |

Guards:
- If the first stage has < 10 leads, render "More data is needed
  before identifying a reliable funnel drop-off."
- If the biggest drop is < 5%, render "Funnel conversion is
  consistent stage-to-stage right now." instead.

## What NOT to claim

- **No ROAS.** Section footers say "ad spend is not connected" on
  every attribution table render.
- **No fake certainty.** Key Insight and Funnel insight both fall
  back to safe honest copy when data is sparse.
- **No autonomous sends.** Insight CTAs deep-link into filtered
  views; the operator decides whether to follow up.
- **No "Run Analysis" no-op buttons.** The AI Performance Insight
  card's previous vague CTA is now a real "View slow-reply leads"
  deep-link.
- **No SOC 2 / GDPR / autonomous-booking overclaims.**

## Demo QA checklist

Open `/dashboard/analytics` after seeding realistic demo data.

1. ✅ Page title reads "Revenue intelligence" (not "Analytics").
2. ✅ Subtitle reads "See which sources create booked weddings and where revenue leaks from the funnel."
3. ✅ Top KPI row shows 6 buyer-friendly metrics. `Avg Score` and `AI Latency` are gone.
4. ✅ Money cards show "Estimated from couple budgets" / "From booked leads with entered budgets" helper lines.
5. ✅ Champagne-accented Key Insight card sits below the KPI row.
6. ✅ Insight headline reads as a real prioritization sentence with the operator's actual top sources, not generic copy.
7. ✅ Insight CTA links to a real filtered surface.
8. ✅ "Inquiry volume over time" chart shows total + peak-day annotation underneath.
9. ✅ "Conversion funnel" card shows the chart + champagne-eyebrow drop-off insight underneath.
10. ✅ "Which sources create real opportunities" attribution table title.
11. ✅ "Which sources are turning into booked weddings" booked-revenue table title.
12. ✅ Booked-revenue table columns read "Est. inquiry value" / "Est. booked value" / "Lead → tour" / "Lead → booked".
13. ✅ "Where each source is leaking revenue" source-leakage table title.
14. ✅ Source-leakage table CTA reads "Recover leads →" in champagne tone.
15. ✅ "Response speed insight" card (renamed from AI Performance Insight) reads "Faster first replies help protect high-intent inquiries before couples move on to another venue."
16. ✅ Response speed CTA reads "View slow-reply leads" and deep-links to `/dashboard/leads?leakage=slow_first_reply`.
17. ✅ Card hides entirely when no AI actions have been recorded yet.
18. ✅ Date-range selector still works.
19. ✅ Charts still render.
20. ✅ All table footers preserve the "not ROAS — ad spend is not connected" disclaimer.
21. ✅ Overview, Leads, Tours, and Inbox are unaffected.

## Files modified

- `app/(dashboard)/dashboard/analytics/page.tsx` — header, KPI
  rebuild, Key Insight card, section title relabels, column
  relabels, funnel drop-off insight, inquiry-chart peak-day
  annotation, Response Speed Insight rewrite
- `app/api/health/route.ts` — 5 new flags

## Recommended next GTM phase

- **GTM-0H — Settings page polish.** Reframe `/dashboard/settings`
  as "tune the AI to your venue's voice" with revenue-oriented
  tab labels (Knowledge base · Brand voice · Availability ·
  Revenue thresholds). Completes the dashboard pentagon.
- **GTM-0I — Real-time AI activity ticker.** Replace the
  AIBriefCard zero-state (removed in GTM-0D) with a live
  `ai_actions` feed across the Overview hero.
- **GTM-0J — Per-venue demo seed presets.** `luxury-barn`,
  `city-ballroom`, `estate`, `garden` seed packs so demos
  reflect the prospect in front of you.
