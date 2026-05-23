# AI Inbox Scheduling QA

**Phase 8BJ — P0 regression fix.** Manual + transcript-based QA for
the inbox AI's tour availability awareness and contact-info handling.

---

## The bug we fixed

A real lead transcript:

```
Lead: yes when is avail for next week
Lead: email is 67676@gmail.com and 3332323223 is number
Lead: just tell me all the avail times
```

Previous AI behavior (broken):

> "I don't have access to the live calendar right in this chat..."

That response was unacceptable because:

1. VenueRise **does** have access to the venue's calendar — `tour_availability`, `tours`, and `tour_blackouts` are all in the database.
2. The lead had already given email and phone in plain text. The AI's previous turn asked for them again.
3. Saying "I don't have access" makes the AI sound like a generic chatbot, breaking the entire "Revenue OS for wedding venues" promise.

---

## Expected AI behavior after Phase 8BJ

Given the same transcript, the AI should respond similar to:

```
Sarah, here are a few tour openings we have next week:
  - Tuesday, May 26 at 11:00 AM
  - Thursday, May 28 at 2:00 PM
  - Saturday, May 30 at 10:00 AM

Which one works best for you? I have your email and phone on file,
so once you pick a time, we can get it prepared for confirmation.
```

The exact dates depend on the venue's saved `tour_availability` rows
and the test clock. **What must match:**

- ✅ The reply offers actual numbered slots (not "let me check with the team")
- ✅ The reply does NOT say "I don't have access to the calendar" / "I can't see the calendar"
- ✅ The reply does NOT ask for email or phone
- ✅ The reply does NOT say the tour is "confirmed" / "booked" / "scheduled" — only "prepared for confirmation"

---

## Manual QA — full procedure

### Prereqs

- Demo seed loaded (`Settings → Billing → Revenue Recovery load / stress demo`, 250 leads, `sales_demo`, reset checked)
- Venue has at least one row in `tour_availability` (the seed populates this; if blank, add via `Settings → Availability`)
- AI is active for the lead (`leads.ai_active = true`)

### Test 1 — "next week" availability ask, contact already known

1. Open `/dashboard/inbox`
2. Pick a lead in `new_inquiry` or `qualified` that already has email + phone
3. Send: `yea do you have any timing available this week`
4. Send: `yes when is avail for next week`
5. Send: `just tell me all the avail times`

**Pass criteria:**

- ✅ AI reply lists 2–5 specific tour slots
- ✅ Slots are in the future (not past)
- ✅ AI does NOT say it lacks calendar access
- ✅ AI does NOT re-ask for email or phone
- ✅ No tour row is created in the `tours` table

**Inspect the AI message metadata** (Inbox → click the AI reply → look at the metadata block) to confirm:

```json
{
  "scheduling_intent": {
    "timeframe": "next_week",
    "specific_booking": false,
    "availability_configured": true,
    "suggested_slots_count": 3,
    "unavailable_reason": null
  },
  "contact_signals": {
    "email_known": true,
    "phone_known": true,
    "extracted_from_this_message": { "email": false, "phone": false }
  }
}
```

### Test 2 — Lead types email + phone in chat (no prior contact data)

1. Open a fresh lead with `email = null` and `phone = null` (or pick a meta_lead_ads lead from the demo seed where parser left fields blank)
2. Send: `Hi, interested in your venue`
3. Send: `email is 67676@gmail.com and 3332323223 is number`

**Pass criteria:**

- ✅ After turn 2, the `leads` row has `email = '67676@gmail.com'` and `phone = '3332323223'`
- ✅ AI does NOT re-ask for email or phone in any subsequent turn
- ✅ Message metadata shows `extracted_from_this_message.email === true` and `phone === true`

### Test 3 — Venue has no availability configured

1. Edit a test venue: delete all rows from `tour_availability` (or set `is_active = false`)
2. Open a lead under that venue
3. Send: `when can I tour next week?`

**Pass criteria:**

- ✅ AI says something like "I'll check with our team and get back to you with available times"
- ✅ AI does NOT invent specific slots
- ✅ AI does NOT say "I don't have access to the calendar" (this is the bug)
- ✅ Message metadata shows `availability_configured: false` and `unavailable_reason: 'no_availability'`

### Test 4 — Availability exists but all windows are booked

Harder to reproduce on demo seed; document the expected behavior.

- ✅ AI says "Let me check with the team for the nearest openings" (no invented times)
- ✅ Message metadata shows `availability_configured: true`, `suggested_slots_count: 0`, `unavailable_reason: 'no_open_windows'`

### Test 5 — Scheduling intent miss (false negative check)

Send messages that should NOT trigger scheduling intent:

- `What's the parking like?` → no scheduling intent
- `Do you cater?` → no scheduling intent
- `What's your pricing?` → no scheduling intent
- `How big is the room?` → no scheduling intent

**Pass criteria:**

- ✅ Message metadata shows `scheduling_intent: null` (the block is omitted when intent is false)
- ✅ AI responds normally to the actual question

### Test 6 — Specific date request (lead picks a slot)

1. After the AI offers slots in Test 1, send: `Tuesday at 11 works`

**Pass criteria:**

- ✅ AI says something like "Great — I can get that time prepared for confirmation"
- ✅ AI does NOT say "you're booked" or "tour is scheduled"
- ✅ No `tours` row is created automatically (operator must use ScheduleTourDrawer)

---

## What the AI prompt sees (debug output)

Inside `handleIncomingMessage`, the orchestrator builds and injects
two structured blocks into the conversation prompt.

### Example: Test 1 prompt blocks

```
TOUR_AVAILABILITY_CONTEXT:
- Lead is asking for tour availability: yes
- Timeframe hint: next_week
- Lead's exact wording: "next week"
- Venue timezone: America/New_York
- Default tour duration: 60 minutes
- Available suggested slots:
  1. Tue, May 26 · 11:00 AM
  2. Thu, May 28 · 2:00 PM
  3. Sat, May 30 · 10:00 AM
- Instruction: Offer these specific slots to the lead and ask them
  to pick one. Phrase it as "I have these tour openings available…"
  — never say "I don't have access to the calendar." Do NOT say
  the tour is confirmed; a tour record only exists after an
  operator schedules it.

KNOWN_CONTACT:
- email: present
- phone: present
- Instruction: Do NOT ask the lead for their email or phone — both
  are already on file.
```

### Example: Test 3 prompt blocks

```
TOUR_AVAILABILITY_CONTEXT:
- Lead is asking for tour availability: yes
- Timeframe hint: next_week
- Lead's exact wording: "next week"
- Default tour duration: 60 minutes
- Availability configured: no
- Instruction: Do not invent times. Say the team will confirm
  available tour times manually. Do NOT claim you lack calendar
  access (we have the venue's profile, just no availability
  windows yet).

KNOWN_CONTACT:
- email: missing
- phone: missing
- Instruction: If natural to the conversation, ask the lead for the
  missing contact fields (email and/or phone) — but only after
  answering their actual question.
```

---

## Manual-channel preservation

Phase 8BJ does NOT change manual-channel behavior:

- Instagram, The Knot, WeddingWire, Meta Lead Ads messages still
  flow through the same `manual_required` reply path
- The AI still generates a DRAFT; the operator still copies + sends
- The new TOUR_AVAILABILITY_CONTEXT block is included in the
  drafted reply text, so the operator's manual-send reply offers
  the same specific slots

**Verify:** open a lead with `metadata.channel_type = 'instagram'`,
send a scheduling question, confirm the AI draft includes real slots
AND the inbox UI shows the "Mark sent manually" affordance (Phase
8BE behavior, unchanged).

---

## Auto-send posture

Phase 8BJ does NOT enable autonomous tour booking.

- Slots come from `suggestTourSlots` (pure suggestion helper)
- The AI offers slots to the lead
- The lead picks a slot
- The AI says "I can get that prepared for confirmation"
- The operator uses ScheduleTourDrawer to create the actual `tours` row

If a future phase wires AI → tour creation, it must:

1. Go through `/api/tours` POST with operator-equivalent auth
2. Set `status = 'scheduled'` (not `confirmed`)
3. Write an `ai_actions` row with `action = 'tour_auto_scheduled'`
4. Require the venue setting `instantResponse.autoSendEnabled === true`

None of that happens today.

---

## Rollback

If a venue reports the AI is offering wrong slots or breaking on
scheduling messages, the fastest mitigation is to set the venue's
`metadata.revenue_os.instant_response.enabled = false`. This
disables the new path AND falls back to the original
`generateConversationReply` — but the orchestrator's
`handleIncomingMessage` still includes the new context blocks.

If a deeper rollback is needed, revert this commit. The change is
fully additive to `handleIncomingMessage` and the conversation
agent's `extraContextBlocks` parameter defaults to `[]`, so
removing the wiring restores the pre-8BJ behavior exactly.

---

## Known limitations

- **Timezone math is JS-runtime local** in `suggestTourSlots`. If the venue is in PT and the server is in UTC, slot times may be off by hours. Per-venue TZ-aware math is a future phase.
- **No "this week" bias.** The scan starts from `now` for everything except `next_week`. If the lead says "this week", they get the earliest slot regardless of when in the week.
- **No multi-day grouping.** The helper de-duplicates by calendar date, so a lead asking "any time Saturday?" gets at most one Saturday slot.
- **No lead-side direct booking.** Even when the AI offers slots and the lead picks one, the actual `tours` row is created by the operator. A future phase may add a lead-facing confirmation link.
