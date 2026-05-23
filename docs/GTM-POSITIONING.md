# GTM-0B — VenueRise positioning

The wedge, the buyer, the pain, the promise, and the
anti-positioning. **One file. One source of truth.** If a marketing
asset, sales script, or homepage section disagrees with this doc,
update this doc *first*.

---

## Category

**AI Revenue OS for wedding venues.**

Not a CRM. Not a chatbot. Not an "AI sales agent." A revenue
operations layer that sits *on top of* fragmented inquiry channels
and helps a venue's team turn more inquiries into booked tours.

---

## Buyer

- **Primary**: Owner / GM of a single wedding & event venue doing
  $1M–$10M in annual booked revenue.
- **Secondary**: VP Sales / Director of Sales at a multi-venue group
  (2–10 properties).
- **Daily user**: the sales coordinator / inquiry-response lead who
  lives in the inbox.

The owner buys. The coordinator uses it. Both need the dashboard to
make the sales motion *visible* — that's the wedge.

---

## Pain (operator language)

The five gaps named on the public page:

1. **Slow replies** — a strong inquiry sits unanswered while the
   couple books a tour at another venue.
2. **Qualified, no tour** — the couple is a fit but nobody pushes
   them to the next step.
3. **Cold follow-up** — a warm lead ghosts and never gets a
   thoughtful recovery message.
4. **Unconfirmed tours** — the tour is on the calendar but nobody
   confirms, reminds, or recovers the no-show.
5. **Source blind spots** — they know inquiry counts but not which
   sources became booked weddings.

These five map 1:1 to Revenue OS surfaces in the product
(RevenueLeakageBrief, RecoveryQueueCard, TourConfirmationQueueCard,
ReactivationQueueCard, AttributionPerformanceCard /
SourceRevenueLeakageCard).

---

## Promise

- See which inquiries are slipping, what they're worth, and what to
  do next.
- AI drafts every next-best reply.
- Your team approves before anything goes out.
- Per-source attribution shows which channels actually became
  booked weddings.

**What we do NOT promise:**
- Guaranteed revenue.
- Specific lift percentages or "3× more tours."
- Anonymized production data via demo mode.
- Compliance certifications (SOC 2, GDPR, HIPAA, PCI).
- Autonomous sending.
- Multi-touch attribution.

---

## Anti-positioning

| Buyer asks… | Honest answer |
|---|---|
| Is this a CRM? | No. We sit above your CRM. |
| Does this replace HoneyBook / Tripleseat? | No. We connect around them. |
| Does this replace The Knot / WeddingWire? | No. They remain your listing platforms; we connect to them. |
| Does AI send messages on its own? | No. AI drafts; your team approves. |
| Is the AI a "sales rep"? | No. It's a draft + detection layer. The judgment stays with your team. |
| Are you SOC 2 / GDPR certified? | Not today. We share a security questionnaire response on request. |

---

## Demo story (paired with GTM-0A seed)

1. Operator opens `/dashboard/settings/billing` → Revenue Recovery
   demo mode card → **Seed demo data**.
2. We open `/dashboard` and walk the five Revenue OS cards in
   order — Leakage Brief, Recovery, Tour Confirmation,
   Reactivation, Attribution / Booked-by-source.
3. Open `/dashboard/leads`, scrub the Kanban, filter by `?leakage=`
   and `?source=`.
4. Open a slow-reply lead. Show the speed-to-lead chip + draft
   suggestion. Walk through Approve & send vs Mark manual.
5. Open a lost reactivation candidate. Show the reactivation
   panel + "Use suggestion in draft" affordance.
6. Close on `/dashboard/analytics` — Attribution breakdown +
   Booked revenue by source.

End-to-end the demo is about 12 minutes. The seeded numbers map to
the static mock dashboard panel on `/` so the buyer sees the same
shape on the marketing site and in the live demo.

---

## Approved homepage claims (verbatim)

These are safe to repeat in landing pages, decks, outreach:

- "Stop losing weddings in the follow-up gap."
- "AI Revenue OS for wedding venues."
- "See which inquiries are slipping, what they're worth, and what
  to do next."
- "VenueRise sits above your existing lead sources — website,
  Instagram, The Knot, WeddingWire, Meta Ads, and inbox."
- "Your team approves every reply. No autonomous sending."
- "AI drafts. Your team approves."
- "Manual-required channels stay operator-sent until you verify a
  direct integration."
- "We do not promise guaranteed revenue."
- "Pilot packages available for a limited cohort of venues."

---

## Forbidden claims

Do NOT use any of these — outreach, decks, ads, posts:

- "Fully autonomous AI sales rep"
- "Responds in under 60 seconds" (autonomy implication; we draft,
  the operator sends)
- "24/7 sales coordinator"
- "Guaranteed revenue" / "Guaranteed bookings"
- "3× more tours" or any specific lift % we don't have case-study
  evidence for
- "SOC 2 certified", "GDPR compliant", "HIPAA-ready", "PCI compliant"
- "Real SSO / SCIM" (we have readiness scaffolding only)
- "Fully secure" / "No risk" / "Bank-level security"
- "Trusted by hundreds of venues" / "Trusted by top venues
  nationwide" (until we have written testimonials we can attach
  publicly)
- Generic "AI CRM" or "agentic automation platform" framing —
  takes us back into the noisy category we're trying to escape

---

## CTA inventory

| Surface | CTA copy | Target | State |
|---|---|---|---|
| Hero primary | Book a demo | `/demo` | live |
| Hero secondary | See how it works | `#how-it-works` | live |
| Navbar (desktop + mobile) | Book a demo | `/demo` | live |
| Demo preview | Book a walkthrough | `/demo` | live |
| ROI / Pilot card | Apply for a pilot | `/demo` | live |
| Final CTA / AuditForm | Apply for a pilot (submits to `audit_leads`) | n/a (in-page form) | live |
| `/demo` | Email fallback | `mailto:hello@venuerise.com` | live |
| Footer | Book a demo | `/demo` | live |

**No `href="#"` or dead links.** The Phase 9S
`check:ui-interactions` and `check:fetch-routes` scanners pass.

---

## Visual direction

- Premium, light, editorial.
- Navy, slate, soft blue, white cards. Subtle gradients.
- Wedding-venue feel via the hero photograph + serif display font.
- No generic robot / "AI" gimmicks.
- Framer Motion already in use for hero + section reveals; keep it
  restrained.
- Static dashboard mock on the marketing page — no fetches from
  public routes. Numbers mirror the GTM-0A seed.

---

## Maintenance

When this changes, ripple the change through:

1. `app/(marketing)/page.tsx` + section components
2. `app/(marketing)/demo/page.tsx`
3. Marketing copy in `components/Hero.tsx` / `PainPoints.tsx` /
   `HowItWorks.tsx` / `DemoPreview.tsx` / `Differentiation.tsx` /
   `ROI.tsx` / `FAQ.tsx` / `FinalCTA.tsx` / `AuditForm.tsx`
4. `docs/PRODUCT-THESIS.md` (if the wedge changes)
5. `docs/AGENTIC-WORKFLOW-MAP.md` (if the AI posture changes)
6. Buyer-facing assets in `docs/ENTERPRISE-SALES-READINESS.md` /
   `docs/BILLING-QA.md`

**Update this doc first; everything else follows.**

---

## Sales asset pack (Phase GTM-0C)

The canonical positioning above is enforced by the assets in
`docs/gtm/`:

- `docs/gtm/README.md` — index
- `docs/gtm/GTM-PLAYBOOK.md` — ICP, channels, daily activity, sprint plan
- `docs/gtm/DEMO-SCRIPT.md` — 10-min walkthrough with timestamps
- `docs/gtm/COLD-CALL-SCRIPT.md` — opener, branching responses, voicemail, gatekeeper
- `docs/gtm/COLD-EMAIL-SEQUENCE.md` — 5-email sequence (Day 1/3/7/12/18)
- `docs/gtm/INSTAGRAM-DM-SCRIPTS.md` — short DM + voice note + story reply
- `docs/gtm/DISCOVERY-QUESTIONS.md` — categorized questions for discovery calls
- `docs/gtm/OBJECTION-HANDLING.md` — 12 objections + responses
- `docs/gtm/PILOT-OFFER.md` — 30-day pilot offer + 3 internal pricing tiers
- `docs/gtm/ROI-FRAMING.md` — formulas + the one-extra-wedding framing
- `docs/gtm/POST-DEMO-FOLLOW-UP.md` — recap, no-show, objection, pricing, nurture, kickoff
- `docs/gtm/SALES-CALL-SCORECARD.md` — 100-point qualification scoring
- `docs/gtm/ONE-PAGE-PITCH.md` — printable one-pager

**Rule:** if any sales script contradicts the approved claims / forbidden
claims tables in this doc, **this doc wins.** Update the script, not
the positioning.
