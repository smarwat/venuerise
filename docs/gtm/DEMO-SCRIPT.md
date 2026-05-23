# 10-Minute VenueRise Demo Script

**Phase GTM-0C** — the canonical walkthrough used in every booked demo.

---

## Demo objective

By minute 10, the buyer should feel:

> *"We probably have money leaking from slow follow-up, stale leads, unconfirmed tours, and unclear source performance — and I want to see this on my own pipeline."*

Not:
- "Wow, that's a slick AI product."
- "Cool, send me pricing."

If the buyer doesn't feel the leak in their own business, the demo failed regardless of how the dashboard looked.

---

## Pre-demo setup (5 min before the call)

1. **Open the dashboard** at `/dashboard` logged in as the demo admin user.
2. **Seed the demo data** if it's a fresh venue or stale:
   - Settings → Billing → Revenue Recovery load demo card
   - **Lead count:** 250
   - **Profile:** `sales_demo`
   - **Reset previous load-seed rows first:** ✅ (so the demo always looks the same)
   - Click **Seed load demo** — completes in ~6–8 seconds
3. **Open three tabs** ahead of time so you don't context-switch live:
   - Tab 1: `/dashboard` (overview)
   - Tab 2: `/dashboard/leads`
   - Tab 3: `/dashboard/analytics`
4. **Pick three specific leads to open during the demo** — write the names down:
   - A slow-reply lead from the new_inquiry column
   - A qualified-no-tour lead
   - A reactivation candidate from the lost column
5. **Mute notifications**, close everything else, full-screen browser.

---

## Demo flow (10 minutes, with timestamps)

### 0:00 – 0:45 — Problem framing

**Say:**

> "Before I open the dashboard, let me frame what we're going to look at. Most wedding venues are not short on lead sources — you already have website inquiries, The Knot, WeddingWire, Instagram, Meta leads, referrals, email. The hard part is *seeing which inquiries are slipping* and making sure your team follows up fast enough to turn them into tours.
>
> So instead of walking you through screens, I'm going to walk you through where the money usually leaks. Sound good?"

**Why this works:** sets the frame that this is about *their* business, not your product.

---

### 0:45 – 2:00 — Dashboard overview

Open Tab 1: `/dashboard`.

**Point at** the RevenueLeakageBrief card.

**Show:**
- Estimated pipeline at risk (`$124k` on demo data)
- Slow replies count
- Recovery candidates
- Tours needing confirmation
- Booked revenue by source preview

**Talk track:**

> "This is not another place to store leads. This is the revenue leak view. The number at the top is roughly how much pipeline is sitting in leakage buckets right now — leads that haven't been replied to, qualified leads with no tour booked, warm leads that went cold, and tours that haven't been confirmed.
>
> The job of this dashboard isn't to be pretty. It's to tell your team where to act today."

**Avoid:** clicking around. Let the page breathe. Buyers process numbers slowly the first time.

---

### 2:00 – 3:30 — Leads board

Switch to Tab 2: `/dashboard/leads`.

**Show:**
- Stages (Kanban view)
- Leakage filters in the top bar (`?leakage=slow_reply` etc.)
- Source filter
- Click into the "High-fit idle" filter or "Qualified, no tour"

**Talk track:**

> "Here's where your sales team actually works. The default view is by stage — same shape as any pipeline view. But the difference is up here." [point at leakage filters] "Instead of scanning every inquiry and trying to remember who needs a follow-up, your team can filter by 'who's slipping right now.'
>
> Slow first reply. Qualified but no tour. Cold leads to recover. Tours that haven't been confirmed. Each of these is a revenue leak."

**Click one filter** — say `?leakage=slow_reply` — to show the board narrowing.

---

### 3:30 – 5:00 — Lead drawer

**Open lead 1: slow-reply lead.**

Click a lead from the new_inquiry column.

**Show:**
- Lead details (name, event date, guest count, budget)
- Source attribution badge
- Speed-to-lead chip ("Waiting 7h")
- AI draft section — operator hasn't clicked Approve & send yet
- The actual draft text

**Talk track:**

> "When your team clicks into a lead, this drawer shows everything in one place. Lead details. Where they came from — Google Ads, The Knot, Instagram, whatever. How long they've been waiting for a reply.
>
> Down here is the AI draft. The AI has already read the lead's question, looked at your venue profile and knowledge base, and drafted a reply. Your coordinator reads it, edits if they want, and clicks Approve & send. Nothing goes out without a human in the loop."

**Open lead 2: qualified-no-tour lead.**

**Show:**
- TourReadinessPanel
- Suggested tour slots
- "Use suggestion in draft" affordance

**Talk track:**

> "This lead is qualified — budget fits, date works, guest count fits — but they haven't been pushed to a tour. The system surfaces that. It shows your next open tour slots and lets the coordinator generate a draft that suggests those slots."

**Open lead 3: reactivation candidate.**

**Show:**
- Lost reason metadata
- Reactivation panel
- Draft that re-opens the conversation thoughtfully

**Talk track:**

> "And this one's a reactivation. The couple ghosted three months ago after we sent pricing — happens all the time. Most venues never re-touch these. The system flags them and drafts a follow-up that doesn't sound like a generic 'just checking in.'"

---

### 5:00 – 6:30 — Inbox / omnichannel

Click into Inbox (`/dashboard/inbox`).

**Show:**
- Channel badges (Instagram, The Knot, WeddingWire, website, email)
- A `manual_required` reply marker
- A `parse_needs_review` badge if one exists (Meta lead ad parse)

**Talk track:**

> "The goal is to unify your inbox across channels. Website inquiries, Instagram DMs, The Knot, WeddingWire, Meta leads, email — all in one place with the source tagged on every message.
>
> Important honesty point: some channels stay manual until verified direct integrations are available. For example, The Knot doesn't have an outbound API today, so VenueRise drafts the reply, your coordinator copies it and sends from inside The Knot. The system still tracks the reply so the team knows what happened. We don't pretend to send through channels we can't actually send through."

**Why this works:** buyers expect you to overclaim. Pre-empting that builds trust.

---

### 6:30 – 7:30 — Tours

Switch to `/dashboard/tours`.

**Show:**
- Calendar / upcoming tour list
- Scheduled vs confirmed status
- TourConfirmationQueueCard
- A no-show example

**Talk track:**

> "Tours are the bridge between inquiry and booking. So if qualified leads are not moving into tours, or scheduled tours aren't getting confirmed, that's revenue leakage you can measure.
>
> The TourConfirmationQueue here surfaces every scheduled-but-unconfirmed tour. The bigger your team, the more this matters — because the coordinator who scheduled it isn't always the one who confirms."

---

### 7:30 – 8:30 — Attribution / booked revenue

Switch to `/dashboard/analytics`.

**Show:**
- AttributionPerformanceCard
- Booked revenue by source breakdown
- The "Estimated booked value" disclaimer

**Talk track:**

> "This is the one most venues don't have today. You know how many leads The Knot sends you, you know how many Instagram inquiries you got, you know what you spent on Google Ads. But you usually don't know which sources actually became *booked weddings.*
>
> This view ties each lead to a source and tracks which sources are producing real booked revenue. Important caveat: this is **not ROAS** because ad spend isn't connected yet — we don't pull from Google Ads or Meta Ads APIs. But it shows which inquiry sources are becoming bookings, which is usually enough to redirect spend."

**Why this works:** the disclaimer makes the next claim more credible.

---

### 8:30 – 9:30 — Pilot offer

Close the dashboard tabs. Look at the camera.

**Say:**

> "For pilots, we install this with you. We configure your venue profile, lead sources, brand voice, knowledge base, tour availability, and revenue leakage dashboard. Then we walk the leaks with your team every week for the first 30 days so you can turn more inquiries into tours.
>
> The pilot is designed to answer one question: are there enough recoverable revenue leaks in your current process to justify keeping VenueRise long-term?"

---

### 9:30 – 10:00 — Close

**Ask:**

> "Would it be worth testing this for 30 days if we can show you where your current inquiries are slipping and help your team recover even one more booking?"

**Then shut up.**

Wait for the answer. Don't fill silence with more pitching. The buyer needs to commit verbally to wanting this measured against their own business.

---

## What NOT to say (ever)

- ❌ "Guaranteed more bookings."
- ❌ "Direct integration with The Knot." *(no public API exists)*
- ❌ "Autonomous AI sales rep."
- ❌ "Set it and forget it."
- ❌ "Fully automated follow-up."
- ❌ "SOC 2 certified" / "GDPR compliant." *(not today)*
- ❌ "Replaces your CRM."
- ❌ "3× more tours" or any specific lift % you can't back with a case study.
- ❌ "Trusted by hundreds of wedding venues." *(until written testimonials exist)*

If the buyer asks any of these directly, answer honestly — "We don't have that today, but here's what we do have." Honesty is a closing technique with this buyer.

---

## Common live mistakes

| Mistake | Fix |
|---|---|
| Talking through every screen | Stop. Pick 5–7 surfaces total. Buyers can't process more in 10 min. |
| Demoing on real customer data | Always run the demo seed first. Real data is messy + risks PII exposure. |
| Skipping the "honest scope" framing | Buyers expect overclaim. Pre-empting builds the kind of trust that closes pilots. |
| Filling silence after the close question | Wait. The first person to talk after the close loses. |
| Letting buyer drive screen-by-screen tour | They don't know what to ask. You're the guide. |
| Promising features that "are coming soon" | If it's not shipped, don't pitch it. Pitch the gap as a future phase. |

---

## After the demo

See `docs/gtm/POST-DEMO-FOLLOW-UP.md` for the email templates.

Recap email goes out within 2 hours. The faster you send, the higher the close rate.
