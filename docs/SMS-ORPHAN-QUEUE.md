# SMS Orphan Queue

Phase 8BT — extends the unmatched-replies safety net (originally
built for email in 8BQ) to also cover inbound SMS. Operators
get **one queue for both channels** instead of two parallel
surfaces.

## What this phase does

Before 8BT, inbound SMS that the 8BS matcher couldn't confidently
tie to a conversation was dropped silently with a pino log. Same
silent-loss risk email had before 8BQ.

8BT persists those orphans into the existing `inbound_email_orphans`
table (extended with a `channel` column in migration 041) and
surfaces them in the same inbox queue card that already shows
email orphans. Link / Dismiss work for both channels.

## Why we extended the email table (not made a new one)

Operators don't care whether the unmatched reply is email or
SMS. They need **one queue for "replies that need review."**
Forking into `inbound_sms_orphans` would mean:
- two RLS policies to keep in sync
- two list routes
- two queue cards on the inbox page
- two retention crons later

Extending the existing table with a `channel` discriminator
keeps the operator surface unified and the security posture
identical to 8BQ. The table is still named
`inbound_email_orphans` for backwards compatibility — renaming
later is a low-priority polish.

## What this phase does NOT do

- **No SMS retry** (deferred).
- **No Twilio status callback** for outbound.
- **No MMS attachment capture.**
- **No per-venue Twilio numbers.**
- **No new lead creation** from cold inbound SMS.
- **No autonomous AI** on persist, link, or dismiss.
- **No automated SMS auto-reply.**
- **No new API routes** — existing `/api/inbound-email-orphans/*`
  routes serve both channels.
- **No new admin surface.**

## Migration 041

```sql
alter table public.inbound_email_orphans
  add column if not exists channel text not null default 'email';
alter table public.inbound_email_orphans
  add column if not exists from_phone text;
alter table public.inbound_email_orphans
  add column if not exists to_phone text;

-- Channel check constraint (guarded).
alter table public.inbound_email_orphans
  add constraint inbound_email_orphans_channel_check
  check (channel in ('email', 'sms'));

-- Indexes for the multi-channel queue + phone history lookups.
create index ... on public.inbound_email_orphans
  (venue_id, channel, status, created_at desc);
create index ... on public.inbound_email_orphans
  (from_phone, created_at desc) where from_phone is not null;
```

Legacy rows default to `channel='email'` — no backfill needed.
Existing dedupe (`(provider, provider_inbound_id)` unique
partial index) works for Twilio MessageSid since SMS rows set
`provider='twilio'` and `provider_inbound_id=<MessageSid>`.

## SMS orphan creation behavior

`lib/integrations/inbound/orphans.ts` exports a new
`createInboundSmsOrphan()` parallel to `createInboundEmailOrphan()`:

- Dedupe by `(provider='twilio', provider_inbound_id=MessageSid)`
  before insert; second-call returns existing orphan id.
- Trusts the SMS matcher's pre-computed venue inference
  (`preInferredVenueId`). Doesn't repeat the email-style
  `outbound_messages` lookup because outbound SMS sends don't
  write to `outbound_messages` — only `messages.metadata`.
- Stores safe SMS fields:
  - `channel: 'sms'`
  - `provider: 'twilio'`
  - `provider_inbound_id: MessageSid`
  - `provider_message_id: MessageSid` (same value)
  - `from_phone`, `to_phone`
  - `subject: 'SMS reply'` (UI placeholder so list ordering
    code that expects subject doesn't choke)
  - `stripped_body`, `raw_body_preview` (capped 8000 / 500)
  - `match_confidence: 95/70/40/0` (mapping the SMS matcher's
    confidence tiers to the same 0-100 scale email uses)
  - `match_reasons[]`
  - `suggested_conversation_ids[]` / `suggested_lead_ids[]`
  - `metadata.source: 'inbound_sms_orphan'`
  - `metadata.sms_num_media` + `had_attachments` +
    `attachments_ignored_count` when `NumMedia > 0`

## Webhook behavior change

`/api/inbound/sms` (8BS) previously had three terminal paths:
1. HIGH match → insert message
2. MEDIUM match → insert message
3. NONE / LOW / needsReview → ignore + log

8BT replaces path #3 with **persist orphan**:

```ts
if (!match.conversationId || !match.venueId || match.needsReview) {
  await createInboundSmsOrphan({ ...payload, preInferredVenueId, ... })
  return { ignored: true, reason: 'orphaned_no_match' | 'orphaned_needs_review' }
}
```

Even orphans with no venue inference are stored (`venue_id=null`,
operator-invisible, infra-team-only) so we still have a
forensic trail.

## Venue inference (SMS-specific)

Inherits from the 8BS matcher's existing strategy:

1. **Recent outbound SMS to fromPhone** (HIGH) — uses the
   `messages` jsonb query on `metadata.reply_method='sms'` +
   `metadata.reply_destination=fromPhone` within 90 days.
   Already produced the conversation; the orphan path is only
   hit when this misses or returns nothing.
2. **Lead phone exact match** → single conversation (MEDIUM)
   or multiple conversations (LOW). Multiple conversations is
   `needsReview=true` — orphan with suggestions.
3. **To-number mapping** — not used. We have one platform-wide
   `OUTBOUND_SMS_FROM` so `toPhone` doesn't identify a venue.
   When per-venue Twilio numbers ship (future phase), this
   becomes the highest-confidence venue signal.

## Queue API behavior

`GET /api/inbound-email-orphans` — extended:
- Returns rows from BOTH channels by default.
- New `?channel=email|sms|all` query param (default `all`).
- Response shape gains: `channel`, `from_phone`, `to_phone`.
- `unresolved_count` counts both channels (current
  implementation already counted by status only).

`POST /api/inbound-email-orphans/[id]/link` — extended:
- Reads `orphan.channel`.
- **Email path** unchanged from 8BQ.
- **SMS path**: inserts `role:'lead'` message with:
  ```json
  {
    "source": "inbound_sms_orphan_link",
    "channel_type": "sms",
    "inbound_provider": "twilio",
    "inbound_provider_message_id": "SMxxxx",
    "inbound_from_phone": "+15551231234",
    "inbound_to_phone": "+15557654321",
    "inbound_orphan_id": "...",
    "manually_linked": true,
    "linked_by_user_id": "...",
    "linked_at": "...",
    "parse_needs_review": false,
    "parse_confidence": 100,
    "parse_confidence_reasons": ["operator_linked_from_orphan_queue"],
    "parser_version": "8BT_v1"
  }
  ```
- Audit row (`inbound_email_orphan_linked`) gains `channel`
  field.
- Same ownership / status / body-empty / platform-orphan guards.
- **NO AI trigger** — same guarantee as email path.

`POST /api/inbound-email-orphans/[id]/dismiss` — extended:
- Reads `orphan.channel`, adds to audit metadata.
- Otherwise unchanged.

## Queue UI behavior

`UnmatchedEmailQueueCard` — channel-aware:

- Collapsed chip label is already "Unmatched replies: N" (8BQ).
- Per-row channel icon:
  - Email → `Mail` (slate)
  - SMS → `MessageSquare` (blue accent)
- Sender display:
  - Email → `Name <email>` or bare email
  - SMS → phone number (E.164)
- Subject line:
  - Email → existing subject text (truncated)
  - SMS → small `SMS reply` chip (blue)
- Picker, suggestions, Link, Dismiss — all work identically
  for both channels.
- Footer copy: "Linked replies (email or SMS) appear in the
  conversation as a lead message. AI does not auto-respond."

## Channel badge on linked SMS

Linked SMS orphans land as `role:'lead'` with
`metadata.channel_type='sms'`. The existing `ChannelSourceBadge`
(Phase 8BE) already supports `sms` and renders the appropriate
icon + label, so no new UI was needed for the conversation
thread.

## Duplicate protection

Two layers:

1. **DB**: unique partial index
   `(provider, provider_inbound_id)` already shipped in
   migration 040. Twilio's `MessageSid` is unique per account
   → no collisions across SMS retries.
2. **App**: `createInboundSmsOrphan` reads first, returns
   existing orphan id on hit. Race-safe — unique-index
   violation caught + re-read.

Also preserved: the existing message-level dedupe in 8BS
(`processInboundSmsReply` checks for a `messages` row with
matching `provider_message_id` before doing any matching). If
the SMS already became a real message earlier, we don't create
an orphan for the retry.

Order:
1. Message dedupe (8BS)
2. Match attempt
3. Orphan dedupe (8BT)
4. Create orphan if all three pass

## AI / no-auto-trigger behavior

**Four guarantees** (documented via
`inbound_sms_orphan_no_ai_guard: 'mounted'`):

1. The SMS webhook does NOT call `handleIncomingMessage` when
   creating an orphan.
2. `createInboundSmsOrphan` does NOT call any AI helper.
3. The link route inserts `role:'lead'` directly via
   service-role; does NOT call any AI helper.
4. The dismiss route only mutates the orphan row.

Operator must explicitly compose any response via the existing
8BR outbound pipeline.

## Audit / rate-limit behavior

**Audit** — reuses the existing 8BQ actions:
- `inbound_email_orphan_linked` (extended with `channel`)
- `inbound_email_orphan_dismissed` (extended with `channel`)

Constants stay named after the table they describe; `channel`
in the metadata payload is the discriminator. If/when the
table is renamed, the action names can shift in lockstep.

Safe metadata only — never includes SMS body, full phone (when
project policy avoids PII at the audit layer), raw Twilio
payload, or auth token.

**Rate-limit** — no changes. Link/dismiss routes still use
the `inboundEmailOrphan.{link,dismiss}` per-user-per-orphan
bucket. SMS-side persistence happens on the webhook hot path
(no new rate-limit needed).

**Scanner deltas** — none.
- `check:audit-coverage` 84 (unchanged)
- `check:rate-limit-coverage` 118 (unchanged)
- `check:fetch-routes` 131 (unchanged)
- `ADMIN_ENDPOINT_COUNT` unchanged

## Health flags

5 new (+ 1 multichannel marker):
- `inbound_sms_orphan_queue: 'mounted'`
- `inbound_sms_orphan_persistence: 'mounted'`
- `inbound_sms_orphan_linking: 'mounted'`
- `inbound_sms_orphan_dismissal: 'mounted'`
- `inbound_sms_orphan_no_ai_guard: 'mounted'`
- `unmatched_replies_queue_multichannel: 'mounted'`

## QA checklist

### SMS orphan creation
1. `INBOUND_SMS_ENABLED=1`. POST a Twilio-signed inbound SMS
   from a phone with no outbound history AND no lead phone
   match.
2. No `messages` row inserted.
3. Row in `inbound_email_orphans` with `channel='sms'`,
   `from_phone=<sender>`, `provider='twilio'`, `match_method='none'`.
4. Queue card chip count includes this row.
5. No `ai_actions` row created.

### Low-confidence SMS (multiple conversations)
1. Lead phone matches 2+ conversations.
2. Webhook creates orphan with
   `match_confidence='low'` + `needsReview=true` + suggested
   conversation ids populated.
3. Queue card item shows "Suggested conversation" chip.
4. Click Link → operator picks the right conversation → 200,
   row flips to `linked`, message inserts.

### Duplicate SMS orphan
1. POST same MessageSid twice.
2. Only one orphan row exists.
3. Second response: `orphan_created: false` (or treated as
   ignored).

### Link SMS orphan
1. Click Link on an SMS orphan.
2. Orphan disappears (optimistic).
3. DB: orphan status `linked`, `linked_message_id` set.
4. DB: new `messages` row in target conversation,
   `role='lead'`, `metadata.channel_type='sms'`,
   `metadata.source='inbound_sms_orphan_link'`.
5. Conversation `last_message_at` touched.
6. ConversationThread realtime renders the bubble LEFT-side
   with the SMS channel badge.
7. No `ai_actions` row created.

### Dismiss SMS orphan
1. Pick reason from dropdown.
2. Orphan disappears from list.
3. DB: status `dismissed`, `dismiss_reason` populated.
4. Row not deleted.
5. Audit row carries `channel='sms'`.

### Email regression
1. Existing email orphan creation still works.
2. Email link still inserts with `channel_type='email'`
   metadata.
3. Email queue items still display sender + subject + body.

### RLS / cross-tenant
1. Venue A can't see Venue B SMS orphan.
2. Platform orphan with `venue_id=null` hidden from operators.

### Build / scanner
1. Migration applies cleanly.
2. All 5 scanners clean.
3. Route counts unchanged (no new routes).

## Honesty contract

> The unmatched replies queue surfaces SMS replies that
> VenueRise cannot confidently assign. VenueRise does not
> auto-decide ambiguous SMS matches; an operator must review
> and link them.

> Linking an SMS orphan inserts a real lead message in the
> chosen conversation. AI does not auto-respond. The operator
> uses the existing 8BR composer pipeline for any reply.

## File map

- `supabase/migrations/041_extend_orphans_for_sms.sql` — NEW
- `lib/integrations/inbound/orphans.ts` — `InboundEmailOrphanRow`
  extended with `channel` + phone fields; NEW
  `createInboundSmsOrphan()`
- `lib/integrations/inbound/sms.ts` — `processInboundSmsReply`
  persists orphans on no/low match (was: ignore)
- `app/api/inbound-email-orphans/route.ts` — `?channel` filter;
  SELECT widened to include new columns
- `app/api/inbound-email-orphans/[id]/link/route.ts` — branches
  on `orphan.channel` for the message insert; audit row gains
  `channel`
- `app/api/inbound-email-orphans/[id]/dismiss/route.ts` — audit
  row gains `channel`
- `components/dashboard/messages/UnmatchedEmailQueueCard.tsx` —
  channel-aware icons + sender display; SMS rows render phone
  + "SMS reply" chip
- `app/api/health/route.ts` — 5+1 new flags

## Recommended next phase

Two natural follow-ons:

**Phase 8BU — SMS delivery callback + retry.** Closes the
remaining outbound-SMS gap from 8BR. Twilio status callback
URL → patch `messages.metadata.delivery_status` lifecycle
(queued → sent → delivered → undelivered). Add an SMS retry
route mirroring the email retry from 8BP. After 8BU, SMS is
fully symmetric with email.

**Phase 8BV — Reply method switching UI.** The resolver has
returned `switchOptions[]` since 8BM. Add a dropdown on the
Reply Method Bar so operators can pick Email vs SMS for
leads with both contact methods, instead of being stuck on
the resolver's default. Small UI scope; high operator value
now that both channels are real.

Pick based on which gap is hurting the pilot venues more.

---

## Phase 8BU note — orphan flow unaffected

8BU only touches outbound lifecycle + retry. Orphan-side
inbound capture, persistence, and link/dismiss are unchanged.
The shared queue card continues to render both channels
side-by-side. See `docs/SMS-DELIVERY-STATUS-AND-RETRY.md`.
