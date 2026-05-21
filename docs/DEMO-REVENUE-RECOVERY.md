# Revenue Recovery Demo Seed (GTM-0A)

A controlled demo dataset that makes `/dashboard` and
`/dashboard/leads` tell the **Revenue OS** story within 30 seconds:

> *"These are the leads slipping through the cracks. This is the
> money at risk. VenueRise shows my team exactly where to act."*

Seed it once on a venue and every Revenue OS surface — Leakage Brief,
Recovery Queue, Tour Confirmation Queue, Reactivation Queue,
Attribution Performance, Booked Revenue by Source — comes alive.

---

## What gets seeded

| Surface | Rows | What you'll see |
|---|---:|---|
| `leads` | 24 | Every stage populated. Each lead tagged `metadata.demo_seed=true` + `metadata.attribution` + (lost rows) `metadata.lost_reason`. |
| `conversations` + `messages` | ~14 / ~25 | Realistic threads on a subset of leads. `channel_type` set per message (website / instagram / the_knot / weddingwire / meta_lead_ads / email). One Meta lead carries `parse_needs_review` metadata. |
| `tours` | 7–8 | Mix of `scheduled` (unconfirmed), `confirmed`, `completed`, plus the three booked-lead tours. |
| `venue_channel_connections` | 5 | website / instagram / the_knot / weddingwire / meta_lead_ads. All `manual_only` except Website. No tokens stored. |
| `knowledge_base` | 6 | Pricing, tour policy, catering, alcohol/vendor, parking, rain plan. **Only inserted when the venue has zero existing KB entries** (so real entries are never overwritten). |
| `tour_availability` | 3 | Tue 10–16, Thu 10–18, Sat 9–14. **Only inserted when empty.** |
| `tour_blackouts` | 1 | "Private event (demo seed)" 60 days out. **Only inserted when empty.** |

### Leakage-signal coverage

The 24 leads are hand-tuned so every Revenue OS signal fires at
least once:

- **Slow first reply** — 5 new-inquiry leads created 7–52 hours ago
  with no outbound reply yet.
- **High-fit idle / no tour booked** — qualified leads with high
  `lead_score` and no `tours` row.
- **Tour pending confirm** — `tour_scheduled` stage with
  `tours.status = 'scheduled'` (unconfirmed).
- **Tour completed, no next step** — `tour_completed` lead that
  hasn't moved to negotiation.
- **Cold-lead recovery** — qualified Meta lead with a single inbound
  240h ago and no follow-up.
- **Follow-up recovery** — stale negotiation lead (proposal sent
  ~336h ago, no reply).
- **Reactivation** — lost lead with `lost_reason.reason='ghosted'`
  past the cooling window.
- **Lost (non-candidate)** — `lost_reason.reason='picked_competitor'`
  to verify the helper excludes correctly.

### Attribution coverage

Booked + non-booked leads span: Google Ads, Meta Ads, Instagram, The
Knot, WeddingWire, Website, Referral. This lets the Attribution
Performance and Booked Revenue by Source cards render top-N rows
with non-trivial groupings (3 booked leads, 3 different sources).

---

## How to seed

### From the dashboard (preferred)

1. As an admin/owner, open `/dashboard/settings/billing`.
2. Find the **Revenue Recovery demo mode** card (next to Demo mode).
3. (Optional) check **Reset previous demo seed first** if you want
   to wipe the prior GTM-0A rows before re-seeding.
4. Click **Seed demo data**. Result counts + any warnings render
   inline. Click "View dashboard →" when done.

### From the API directly

```bash
curl -X POST http://localhost:3000/api/admin/demo/revenue-recovery-seed \
  -H "Cookie: <your-admin-session-cookie>" \
  -H "Content-Type: application/json" \
  -d '{"reset_existing_demo_data": true}'
```

Response shape:

```json
{
  "success": true,
  "venueId": "<uuid>",
  "created": {
    "leads": 24,
    "conversations": 14,
    "messages": 26,
    "tours": 8,
    "channel_connections": 5,
    "knowledge_base": 6,
    "tour_availability": 3,
    "tour_blackouts": 1
  },
  "skipped": {
    "knowledge_base": 0,
    "tour_availability": 0,
    "tour_blackouts": 0
  },
  "reset": {
    "leads": 0,
    "channel_connections": 0
  },
  "warnings": []
}
```

### Cross-tenant seeding (multi-venue operators)

Pass `venue_id` in the body to seed a venue other than the caller's
default. The route re-validates `requireVenueRole(ADMIN_ROLES)` on
the target venue; mismatches collapse to 404, never 403, so the
existence of other venues isn't leaked.

---

## Reset behavior

`reset_existing_demo_data: true` deletes only rows tagged by this
seed:

- **`leads` WHERE `metadata->>demo_seed = 'true'`** — cascades to
  `conversations`, `messages`, `tours` via existing `ON DELETE
  CASCADE` constraints.
- **`venue_channel_connections` WHERE `metadata->>demo_seed = 'true'`**
  — explicit delete.

Three tables are **never reset** because they have no metadata
column to identify demo rows safely:

- `knowledge_base`
- `tour_availability`
- `tour_blackouts`

The result `warnings` array always documents this when reset is
requested. If you re-seed after a reset and those tables already
have rows, the seeder skips them (no duplicate slots, no duplicate
KB entries) and the corresponding `skipped` counter increments.

---

## Honesty contract

- Demo data is for sales demos and pilot setup. **It is not
  evidence of real customer performance** and should not be mixed
  with production reporting unless clearly marked.
- The Phase 9J `DemoModeCard` (visual banner) is a separate
  surface. Toggle it on during screen-shared demos so the
  audience knows they're looking at a marked surface; the seeded
  data is then unambiguously demo-only.
- The seeder never calls external APIs:
  - No Stripe call.
  - No Anthropic / AI generation call.
  - No Meta / Instagram / The Knot / WeddingWire platform send.
- No autonomous behavior. The seed runs once per operator click.
- `autonomous_sending_still_disabled` health flag remains
  mounted and `true`.
- Reset cleans only rows the seed created. Real venue data is
  never touched.

---

## Audit + rate-limit posture

- Audit action: `revenue_recovery_demo_seeded` (per call). Metadata
  carries counts + reset flag + warnings count, not the seeded
  content. Lives in `EnterpriseAuditEventsCard`.
- Rate-limit key: `admin:demo:revenue-recovery-seed:<userId>`. The
  default user-action bucket keeps a single operator from hammering
  the seeder.
- New admin route → `ADMIN_ENDPOINT_COUNT` bumped 74 → **75**.

---

## QA checklist

After a fresh seed:

- [ ] `/dashboard` — RevenueLeakageBrief shows non-zero counts;
      RecoveryQueueCard / TourConfirmationQueueCard /
      ReactivationQueueCard each list at least one lead;
      AttributionPerformanceCard + BookedRevenueAttributionCard
      each render top-N rows with multiple sources.
- [ ] `/dashboard/leads` — every Kanban column has at least one
      card. `?leakage=` filters narrow correctly.
- [ ] Open LeadDetailDrawer for at least 3 leads: a slow-reply
      lead, a qualified-no-tour lead, a lost reactivation
      candidate. Each shows the expected Revenue OS panel(s).
- [ ] `/dashboard/inbox` — conversations list populated; channel
      badges visible; the Meta lead shows the parse-review badge.
- [ ] `/dashboard/tours` — scheduled, confirmed, and completed
      tours visible across the calendar.
- [ ] `/dashboard/analytics` — Attribution breakdown table has
      multiple source rows; Booked revenue by source table has
      three rows (Google Ads, The Knot, Referral).
- [ ] Re-seed with **Reset previous demo seed first** checked. No
      duplicate Kanban cards. Reset counter > 0 for `leads`.
- [ ] EnterpriseAuditEventsCard shows the
      `revenue_recovery_demo_seeded` row with metadata.

---

## Limitations

- **`knowledge_base`, `tour_availability`, `tour_blackouts` reset
  is intentionally skipped.** Re-seeding when these tables have
  real entries leaves them alone — see the per-section comments
  in `lib/demo/revenue-recovery-seed.ts`. Operators who need a
  truly clean slate can run a `truncate` via the Supabase SQL
  editor (out of scope here).
- **No `external_conversations` / `external_messages` mirror.** The
  Phase 8BE omnichannel tables are not seeded — we use the
  primary `conversations` + `messages` tables with
  `metadata.channel_type` so the inbox surfaces light up without
  doubling the data. If a buyer demo specifically needs to see
  the omnichannel split, that's a follow-up phase.
- **Lead `created_at` is in the past** (set via the service-role
  client). The `updated_at` follows the seed timestamp because
  the `leads_updated_at` BEFORE-UPDATE trigger doesn't fire on
  INSERT. Speed-to-lead numbers will look reasonable; if you re-
  seed in the same hour the freshest leads may appear too "young"
  for slow-first-reply to fire — bump the clock by waiting a few
  minutes or use a venue you haven't seeded in the last hour.

---

## GTM-0A.2 — Load / Stress Demo (250–1000 leads)

Sibling seeder for **scale testing** and large sales demos. The
GTM-0A demo above is hand-crafted (24 leads, every signal lit) —
this one generates 25–1000 leads with realistic source / channel /
stage / leakage distribution so the dashboard, charts, and Revenue
OS surfaces can be exercised under load.

**Route:** `POST /api/admin/demo/revenue-recovery-load-seed`
**Helper:** `lib/demo/revenue-recovery-load-seed.ts`
**Card:** Billing → "Revenue Recovery load / stress demo"
**Audit action:** `revenue_recovery_load_demo_seeded`
**Rate-limit key:** `admin:demo:revenue-recovery-load-seed`

### Isolation contract

Every row this seeder writes carries:

- `metadata.demo_seed = true`
- `metadata.demo_seed_type = 'load'`
- `metadata.demo_seed_version = 'gtm_0a_2'`

Reset matches **both** `demo_seed_type='load'` AND
`demo_seed_version='gtm_0a_2'`, so a load-seed reset NEVER touches
GTM-0A hand-crafted rows (which have no `demo_seed_type` and
`demo_seed_version='gtm_0a'`). The two demos are independent and
can coexist on the same venue.

### Profiles

| Profile          | Use case                                            |
|------------------|-----------------------------------------------------|
| `balanced`       | Default. Healthy pipeline, all stages represented.  |
| `high_volume`    | Overflowing new inquiries (stress test inbox/kanban).|
| `messy_channels` | Manual-required channel heavy (IG, The Knot, etc.). |
| `sales_demo`     | Every signal lit and a high booked share.           |

### Lead count

- Min 25, default **250**, max **1000**.
- Clamped silently with a `lead_count_clamped` warning in the
  result; obvious abuse (negative or >10k) returns
  `lead_count_out_of_range` 400.
- Recommended ramp: **250 first**, then **500**, then **1000** if
  500 still feels smooth. If 500 lags any surface, the load seed is
  doing its job — fix the surface before the demo, not the seed.

### Performance

- Leads insert in chunks of **100**, conversations in chunks of
  **100**, messages in chunks of **250**, tours in chunks of
  **100**. A 250-lead run typically completes in 4–8 seconds on a
  warm database; a 1000-lead run in 20–40 seconds. The result
  includes a `durationMs` field for monitoring.

### Honesty

- No external API calls. No autonomous sending. No production-data
  deletion path — reset only touches `demo_seed_type='load'` rows
  this seed itself created.
- Names are generated from a fixed pool — they are NOT real people.
- Email domain is `@venuerise-demo.test` so no live recipient can
  be reached even if a manual-send slipped through.
