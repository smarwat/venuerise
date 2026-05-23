# GTM-0H — Settings Page Workspace Control Center Polish

## Before / After positioning

| | Before | After |
|---|---|---|
| Page title | "Settings" | "Workspace settings" |
| Subtitle | "Configure your venue profile, AI behavior, and team" | "Configure the venue details, AI behavior, team access, and revenue workflows that power VenueRise." |
| Header explanation | (none) | Champagne control-center card teaching that each tab maps to a real revenue surface |
| Venue Profile heading | (none — raw form) | "Venue intelligence" section heading + subtitle + per-field helper text |
| Base Price label | "Base Price ($)" | "Starting venue investment" with safe-pricing helper |
| AI Configuration | Form only | "AI behavior controls" intro + dynamic "How your AI will behave" preview card + champagne "AI reply rules" guardrail list |
| Knowledge Base empty state | One generic line | Rich champagne "Untrained" empty state with 5 example first-entry prompts |
| KB warning | "Edits are audited" terse line | Reworded for clarity: avoid secrets, credentials, private contract terms |
| Availability heading | "Tour availability — set the days and hours when tours can be scheduled" | "AI tour availability — set the windows your AI can safely offer when couples ask for tour times" + champagne explanation card + N active days / M blackout dates summary |
| Blackout copy | "Block days when tours should not be suggested" | "Block holidays, private events, or unavailable days so the AI does not suggest them" |
| Team Members subtitle | "1 person have access today." (grammar bug) | "1 person has access" / "N people have access" |
| Team role guide | (none) | Role guide card above Members table — Owner / Admin / Coordinator / Viewer one-line definitions |
| Billing card | "Subscription & billing / View your plan, manage payment method, download invoices" | "Billing & plans / Manage your subscription, payment method, plan limits, and invoices" + Stripe honesty note + "Open billing center →" CTA |

## Tab-by-tab copy changes

### Venue Profile

- Section heading: **Venue intelligence**
- Subtitle: "These details help VenueRise qualify leads, guide pricing conversations, and understand which couples are a strong fit."
- **Venue name** helper: "Used in AI replies and customer-facing messages."
- **Venue positioning** (relabeled from "Description"): helper "A short description of your venue style, atmosphere, and ideal couple." Placeholder uses a luxury-garden example.
- **Min/Max capacity** helper: "Used to identify leads that are too small, too large, or a strong fit for your space."
- **Starting venue investment** (relabeled from "Base Price"): helper "Used for safe pricing guidance. VenueRise should not quote final packages unless your knowledge base supports it."
- **Timezone** helper: "Used for tour availability, reminders, and scheduling suggestions."

Stored field names unchanged.

### AI Configuration

- Section heading: **AI behavior controls**
- Subtitle: "Set how your AI coordinator introduces the venue, handles pricing questions, and guides couples toward tours."
- Existing fields (persona name, conversation tone, response time target) preserved.
- NEW champagne preview card: **"How your AI will behave"** — dynamically renders the owner's chosen persona + tone in a one-sentence summary.
- NEW reply rules card listing the orchestrator's actual guardrails (UI/copy only — mirrors the prompt rules shipped in earlier phases).

### Knowledge Base

- Section heading: **AI knowledge base**
- Subtitle: "Teach VenueRise how to answer pricing, policies, amenities, and booking questions accurately."
- Warning copy reworded: "Avoid secrets, credentials, private contract terms, or anything you would not want surfaced in a customer reply. Edits are audited."
- Empty state replaced with a champagne "Untrained" card containing 5 example first-entry prompts:
  - What is included in the starting venue fee?
  - What is the maximum guest count?
  - Can couples bring outside vendors?
  - What happens if it rains?
  - How do tours and proposals work?

All CRUD behavior unchanged. No demo seed button added — keeping the
"don't fake KB entries" rule from the prompt.

### Availability

- Section heading: **AI tour availability**
- Subtitle: "Set the windows your AI can safely offer when couples ask for tour times."
- NEW champagne explanation card: "How the AI uses availability — when a couple asks 'what times are available?', VenueRise suggests times from these windows while respecting blackout dates and existing tours."
- NEW summary line (when data is present): "N active days · M blackout dates" derived from the existing state.
- Blackout copy: "Block holidays, private events, or unavailable days so the AI does not suggest them."

Scheduling logic from 8BJ/8BK preserved.

### Team

- NEW role guide card above the Members table (Owner / Admin / Coordinator / Viewer).
- Members subtitle grammar fix: `1 person has access` vs `N people have access`.
- All invite / role / revoke flows preserved.

### Billing

- Card title: **Billing & plans**
- Card body: "Manage your subscription, payment method, plan limits, and invoices."
- CTA: "Open billing center →"
- Below the card: "Payment details are handled securely through Stripe. VenueRise never stores full card numbers."

Routes to `/dashboard/settings/billing` unchanged. Stripe pricing
unchanged.

## AI safety explanation

The new "AI reply rules" card in AI Configuration teaches the buyer
the five guardrails the orchestrator actually enforces:

1. Uses your venue profile and knowledge base
2. Offers tour times only from saved availability
3. Does not claim a tour is confirmed until confirmation happens
4. Does not auto-send on manual channels like The Knot, WeddingWire, or Instagram
5. Avoids final package pricing unless your knowledge base supports it

This is UI/copy only — it surfaces existing prompt-level behavior;
it does not modify the AI prompt.

## Billing honesty rules

- No SOC 2 certification claim
- No GDPR compliance claim
- No 24/7 monitoring claim
- No autonomous-sending claim
- "Payment details are handled securely through Stripe" — true because Stripe Elements + Checkout/Portal are the payment surface; we do not store PANs
- Demo/pilot billing keeps the "Pilot workspace active" banner (GTM-0D)

## Demo QA checklist

Open `/dashboard/settings`.

1. ✅ Header reads "Workspace settings" (not "Settings").
2. ✅ Champagne control-center card appears below the header.
3. ✅ Venue Profile tab shows the "Venue intelligence" section heading + per-field helper copy.
4. ✅ "Base Price" field renamed "Starting venue investment" with the safe-pricing helper.
5. ✅ Venue profile save still works (stored field name unchanged).
6. ✅ AI Configuration tab shows the "AI behavior controls" intro.
7. ✅ Dynamic "How your AI will behave" preview reflects the persona + tone you've selected.
8. ✅ "AI reply rules" champagne card lists the 5 guardrails.
9. ✅ AI config save still works.
10. ✅ Knowledge Base tab shows the "AI knowledge base" heading.
11. ✅ Warning copy uses the new safety language.
12. ✅ Empty state shows the champagne "Untrained" card with 5 example prompts when there are no entries.
13. ✅ KB add / edit / toggle / delete still work.
14. ✅ Availability tab shows "AI tour availability" heading + explanation card.
15. ✅ Active days / blackout summary appears when data is present.
16. ✅ Blackout subtitle uses the new copy.
17. ✅ Availability add / save / delete still work.
18. ✅ Blackout add / delete still work.
19. ✅ Team page shows the role guide card above the Members table.
20. ✅ Members subtitle reads "1 person has access" or "N people have access" — grammar fixed.
21. ✅ Team invite / role / revoke flows still work.
22. ✅ Billing tab card reads "Billing & plans" with the Stripe honesty note below.
23. ✅ Open billing center → routes to `/dashboard/settings/billing`.
24. ✅ Full billing page still works (no changes inside).
25. ✅ Overview / Leads / Tours / Analytics / Inbox unaffected.

## Files modified

- `app/(dashboard)/dashboard/settings/page.tsx` — header rename + champagne control-center card
- `components/dashboard/SettingsTabs.tsx` — Venue Profile reframe, AI Configuration preview + safety rules, KB heading + empty state, Availability AI-framing + summary, Billing card polish
- `components/dashboard/team/TeamManagementClient.tsx` — role guide card + members grammar fix
- `app/api/health/route.ts` — 5 new flags

## Recommended next GTM phase

The dashboard pentagon polish (Overview ✅ → Leads ✅ → Tours ✅ →
Analytics ✅ → Settings ✅) is now complete. Logical next phases:

- **GTM-0I — Real-time AI activity ticker.** Replace the AIBriefCard
  zero-state (removed in GTM-0D) with a live `ai_actions` feed on
  the Overview hero. Makes the demo feel alive in a way the static
  numbers can't.
- **GTM-0J — Per-venue demo seed presets.** `luxury-barn`,
  `city-ballroom`, `estate`, `garden` seed packs that produce
  demo data tuned to the prospect in front of you.
- **GTM-0K — Marketing site pass.** Apply the same revenue-recovery
  language ("Revenue Pipeline", "Tour Protection", "Revenue
  Intelligence", "Workspace Control Center") to the public
  marketing pages so prospects land on consistent positioning
  before reaching the dashboard.

Pick GTM-0I for **demo aliveness**. Pick GTM-0J for **per-prospect
customization**. Pick GTM-0K to **align top of funnel with the
dashboard polish**.
