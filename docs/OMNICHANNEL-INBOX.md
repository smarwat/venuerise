# Omnichannel inbox foundation

_Phase 8BE — Omnichannel Inbox Connector Foundation._

This document is the operator-facing companion to:

- `lib/integrations/channels/types.ts`
- `lib/integrations/channels/capabilities.ts`
- `lib/integrations/channels/normalization.ts`
- `lib/integrations/channels/delivery.ts`
- `lib/integrations/channels/connections.ts`
- `supabase/migrations/037_omnichannel_inbox_foundation.sql`
- `app/api/admin/integrations/channels/*`
- `app/api/integrations/website/message/route.ts`
- `app/api/integrations/lead-forwarding/the-knot/route.ts`
- `app/api/integrations/lead-forwarding/weddingwire/route.ts`
- `app/api/integrations/meta/webhook/route.ts` (placeholder)
- `app/api/conversations/[id]/mark-sent-manually/route.ts`
- `components/dashboard/messages/ChannelSourceBadge.tsx`
- `components/dashboard/messages/ManualChannelReplyBanner.tsx`
- `components/dashboard/settings/ChannelConnectionsCard.tsx`

---

## 1. Purpose

Real venue inquiries arrive from many surfaces — the VenueRise
widget, Instagram DMs, Facebook Messenger, Meta lead ads,
email, SMS eventually, The Knot, WeddingWire, plus operator-
entered manual leads. VenueRise has to:

1. Normalize every inbound message into a single internal
   `leads / conversations / messages` graph so the inbox,
   AI drafts, Revenue OS surfaces, and audit trail work
   identically regardless of source.
2. Preserve the mapping back to the external thread so the
   right operator action (direct reply vs copy + paste) can
   happen, and so de-duplication works when the same channel
   relays a message twice.
3. Surface the channel honestly in the UI so operators know
   whether VenueRise can send back through it or whether the
   reply has to be sent out-of-band.

Phase 8BE is the FOUNDATION. The schema, type system,
capability matrix, normalization helper, admin endpoint, UI
badges, and manual-required workflow all land here. Real
Meta / Gmail / WeddingWire / The Knot connectors ship in
later phases.

> **What it does not do.** This phase does NOT call the Meta
> Send API. It does NOT do real OAuth. It does NOT parse
> inbound email bodies. It does NOT enable autonomous
> sending. Manual-required channels surface an explicit copy
> and `Mark sent manually` workflow.

---

## 2. Supported channel matrix

| Channel | Inbound | Outbound | Realtime | Manual reply | Notes today |
|---|:---:|:---:|:---:|:---:|---|
| `website` | ✅ | ✅ | ✅ | — | First-party widget. Existing `/api/widget` keeps working unchanged; `/api/integrations/website/message` is the structured equivalent. |
| `instagram` | ✅ via forwarding | ❌ | ❌ | required | Direct Meta Graph Send API ships in Phase 8BF. |
| `facebook` | ✅ via forwarding | ❌ | ❌ | required | Same as Instagram — Meta Page Send API in Phase 8BF. |
| `meta_lead_ads` | ✅ via forwarding | ❌ | ❌ | required | One-shot lead payload, no thread. Reply via email/phone/DM. |
| `email` | ✅ structured JSON | ❌ | ❌ | required | Raw email parsing + outbound mailbox ship in Phase 8BG. |
| `sms` | ❌ | ❌ | ❌ | required | Placeholder. Requires Twilio + consent capture phase. |
| `the_knot` | ✅ via forwarding | ❌ | ❌ | required | No two-way public API — lead-forwarding + manual reply. |
| `weddingwire` | ✅ via forwarding | ❌ | ❌ | required | No two-way public API — lead-forwarding + manual reply. |
| `manual` | ✅ operator-entered | ❌ | ❌ | required | Catch-all for phone / referral / in-person. |

`CHANNEL_CAPABILITIES` in `capabilities.ts` is the single
source of truth. Any operator-facing UI consults it before
showing or gating an action.

---

## 3. What lives where

### 3a. Database (migration 037)

- `public.venue_channel_connections` — per-venue posture
  (channel_type + status + label + metadata). Owner/admin
  write; sales_manager + coordinator read. No DELETE policy
  — operators flip to `status='disconnected'`. **NO secrets
  / tokens / credential columns.**
- `public.external_conversations` — mapping from an external
  thread id back to the internal `conversation_id` + `lead_id`.
  Service-role writes only. Unique on
  `(venue_id, channel_type, external_thread_id)` for
  idempotency.
- `public.external_messages` — per-message mapping with
  delivery direction + status. Service-role writes. Unique
  on `(venue_id, channel_type, external_message_id)`.
  `delivery_status` ∈
  `received | drafted | sent | failed | manual_required | copied | marked_sent_manually`.

All three tables are RLS-gated for venue-member reads;
writes happen through the normalization helper / admin
routes.

### 3b. Normalization helper

`normalizeInboundChannelMessage` in
`lib/integrations/channels/normalization.ts` is the SINGLE
entry point every public inbound route calls. It:

1. Verifies the venue exists + is active.
2. Short-circuits when `external_message_id` already maps —
   never inserts a duplicate.
3. Resolves the lead by email, then phone, then existing
   `external_lead_id` mapping. Creates a new lead with
   `source = channel_type` when nothing matches.
4. Reuses or creates a `conversations` row, stamps
   `unread_count` + `last_message_at`.
5. Inserts a `messages` row with `role='lead'` and stamps
   `messages.metadata.channel_type` + `external_message_id`
   so the inbox UI can render the source badge without a
   join.
6. Upserts `external_conversations` + inserts
   `external_messages` for the trail.

Provider payloads are NEVER logged verbatim. The helper
runs payloads through `sanitizeAuditJson` and caps both
size and key count.

### 3c. Delivery helper

`sendChannelMessage` in
`lib/integrations/channels/delivery.ts` is the outbound
equivalent. In this phase it:

- Looks up the most recent `external_conversations` row for
  the conversation.
- Consults `getChannelCapabilities` for the resolved channel.
- If outbound is unsupported / manual-required, records an
  `external_messages` row with `delivery_status='manual_required'`
  and returns `{ status: 'manual_required', reason }`.
- If outbound IS supported (today only `website`), records
  `delivery_status='sent'` and returns `{ status: 'sent' }`.
  The actual delivery already happens through the existing
  in-product reply path — this just keeps the trail aligned.
- NEVER calls Meta / Gmail / Twilio / WeddingWire.

`recordManualSendOutcome` is the helper the
`/api/conversations/[id]/mark-sent-manually` route uses to
stamp the operator's manual reply on the trail.

---

## 4. Public inbound routes

All inbound routes are anonymous + rate-limited by IP+venue
via `rateLimitWidget`. They accept STRUCTURED JSON only —
no raw email parsing in this phase.

### `POST /api/integrations/website/message`

Structured website-channel intake. Use this for any new
website surface (chat widget, popup, retargeted form) that
should land in the omnichannel inbox.

### `POST /api/integrations/lead-forwarding/the-knot`
### `POST /api/integrations/lead-forwarding/weddingwire`

Lead-forwarding intake. An operator-configured forwarding
pipe (Zapier, Make, custom forwarder) POSTs the cleaned
lead payload here. VenueRise does NOT integrate with The
Knot or WeddingWire's internal APIs.

Body shape (shared with the website route, minus `external_contact_id`):

```json
{
  "venue_id": "<uuid>",
  "external_lead_id": "<optional>",
  "external_message_id": "<optional>",
  "external_thread_id": "<optional>",
  "name": "Sarah",
  "email": "sarah@example.com",
  "phone": "5555555555",
  "message": "Looking for a luxury garden venue.",
  "event_date": "2026-10-12",
  "guest_count": 180,
  "budget": 25000,
  "received_at": "2026-05-20T14:00:00Z"
}
```

### `GET/POST /api/integrations/meta/webhook` (placeholder)

PLACEHOLDER ONLY. GET implements the standard Meta
`hub.challenge` round-trip when `META_WEBHOOK_VERIFY_TOKEN`
env var is set, otherwise returns 503 `placeholder_only`.
POST accepts the payload and returns 202 without
normalizing — the real handler (signature verification +
event dispatch) ships in Phase 8BF.

---

## 5. Admin endpoints

| Method | Path | Notes |
|---|---|---|
| GET | `/api/admin/integrations/channels` | Lists per-channel capability info + active connection. Read-only — not audited. |
| POST | `/api/admin/integrations/channels` | Creates a draft connection. Writes `channel_connection_created`. Owner/admin only. |
| PATCH | `/api/admin/integrations/channels/[id]` | Updates label / status / metadata. Writes `channel_connection_updated`. Cross-tenant access collapses to 404. |

Rate-limit catalog keys: `adminIntegrations.channelsRead`,
`adminIntegrations.channelsWrite`.

---

## 6. Manual-required reply workflow

Channels with `capabilities.manualReplyRequired = true`
cannot be replied to directly by VenueRise. The flow:

1. Operator drafts the reply (existing AI draft path
   unchanged).
2. UI mounts `ManualChannelReplyBanner` above the composer
   when the conversation's channel is manual-required.
3. Operator clicks **Copy reply** → draft body copied to
   clipboard.
4. Operator sends the reply out-of-band (Instagram app,
   WeddingWire dashboard, etc.).
5. Operator clicks **Mark sent manually** → POSTs to
   `/api/conversations/[id]/mark-sent-manually`. The route:
   - Inserts a `human` message in the conversation with
     `metadata.source='manual_channel_reply'` +
     `channel_type` + `manual_reply_marked_at`.
   - Calls `recordManualSendOutcome` to stamp an
     `external_messages` row with
     `delivery_status='marked_sent_manually'`.
   - Writes a `channel_reply_marked_sent_manually` audit row.

The banner is purely opt-in for the inbox UI — drawers
that don't surface channel context skip mounting it.

---

## 7. Inbox UI changes

- `ConversationList` rows render a small
  `ChannelSourceBadge` next to the lead email when the
  conversation has channel context.
- `ConversationThread` message bubbles render a badge
  inside the bubble when `messages.metadata.channel_type`
  is stamped. Manual-sent human messages also carry a
  `Sent manually` pill.
- `ChannelConnectionsCard` (settings → billing) shows
  active connections + the full available-channel inventory
  with the operator note + capability summary for each.

Legacy in-product messages (no metadata) render exactly as
before — the badge hides gracefully when `channel_type` is
null.

---

## 8. Honesty contract

- **No autonomous sending.** `autonomous_sending_still_disabled`
  health flag stays mounted. Outbound is always
  operator-approved, and on manual-required channels the
  operator also has to confirm out-of-band.
- **No real OAuth in this phase.** No tokens, no secrets in
  any row. When OAuth-backed connectors ship in Phase 8BF
  the encrypted credentials will live in a separate store
  and be joined to `venue_channel_connections` by id.
- **No claims of The Knot / WeddingWire two-way API.** Both
  are modeled as `lead-forwarding + manual reply`.
- **No raw email parsing.** Structured JSON only. The
  inbound email parser is a Phase 8BG scope item.
- **No autonomous Meta payload processing.** The Meta
  webhook accepts and parks payloads (HTTP 202) but does
  NOT normalize them until signature verification is wired.
- **No raw IPs stored.** All hashing flows through
  `maskIpForAudit`.

---

## 9. What NOT to claim

- Do **NOT** claim VenueRise sends Instagram / Facebook /
  Messenger / Meta lead-ad replies for you. It does not.
- Do **NOT** claim WeddingWire / The Knot have official
  VenueRise two-way connectors. They do not.
- Do **NOT** claim email is wired for inbound parsing OR
  outbound sending in this phase. Both ship in Phase 8BG.
- Do **NOT** claim SMS is connected. It is not.
- Do **NOT** claim the Meta webhook route processes events.
  It records a placeholder acknowledgement only.

---

## 10. Known limitations

- Operator-recorded lead-forwarding only — no autonomous
  scraping, no first-party platform API calls in this phase.
- The website channel keeps using the legacy `/api/widget`
  route for the multi-step form. The new
  `/api/integrations/website/message` is the structured
  equivalent for other surfaces.
- Manual-required confirmation is operator-recorded — the
  platform cannot verify the operator actually sent the
  reply on the source platform.
- `external_messages` is RLS-gated but not WORM at the DB
  level (mirrors audit_events / abuse_events).
- The capability matrix is hand-maintained in `policy.ts`
  /equivalent — adding a new channel requires a code edit +
  re-deploy.

---

## 11. Future connector phases

- **Phase 8BF** — Meta / Instagram / Facebook connector.
  Real webhook verification, signature checks, page / IG
  account connection metadata, gated outbound until tokens
  + scopes are confirmed.
- **Phase 8BG** — Email + WeddingWire / The Knot lead
  forwarding parser. Inbound email parser, forwarding
  mailbox pattern, structured parse confidence, manual
  review of parsed fields, source-specific templates.
- **Phase 8BH** — SMS connector (Twilio) with explicit
  consent capture.

Each connector phase will extend the existing helpers
without changing the foundation contract.

---

## 12. Honesty disclaimer (carried in every render)

> Omnichannel inbox is a foundation surface. Channel
> capabilities reflect what the platform can actually do
> today — direct Instagram/Facebook/Meta lead-ad sending
> is NOT enabled. Email + SMS connectors are placeholders.
> The Knot + WeddingWire are modeled as lead-forwarding/
> manual-reply channels. Operators are never auto-sent;
> manual-reply channels require explicit copy + mark-sent-
> manually.

Identical string across the admin API, the
ChannelConnectionsCard footer, and the operator notes so
downstream consumers can grep for it.

---

## 13. Phase 8BE-2 addendum — Activation patch

Phase 8BE shipped the foundation but two gaps were left
unwired: the inbox loader didn't populate `channel_type`, and
`ManualChannelReplyBanner` existed without a mount point.
8BE-2 closes both gaps without adding real connector
complexity.

### 13a. How the badge is populated

`lib/integrations/channels/inbox-channels.ts` exposes
`loadInboxChannelMap(venueId, conversationIds)`. Both inbox
pages call it after fetching the conversation list and merge
the result onto each row as `channel_type` +
`manual_reply_required`.

Resolution order:

1. Most-recent `external_conversations` row mapped to the
   conversation id (preferred).
2. Fallback: scan up to 8 recent `messages.metadata.channel_type`
   stamps for the conversation.
3. Otherwise null → the badge hides gracefully (legacy
   conversations behave exactly as before).

The same lookup runs client-side inside `LeadDetailDrawer`
so the in-drawer header badge + manual-required banner can
react when the operator switches leads.

### 13b. How the manual-required reply works

When `conversationChannel.manualReplyRequired === true` and a
draft is present:

1. `ManualChannelReplyBanner` mounts inside the draft footer
   above the Edit / Regenerate / Reject / Approve row.
2. Banner copy explains that direct VenueRise sending is
   not enabled for the channel (Instagram / Facebook / Meta
   lead ad / email / The Knot / WeddingWire / manual).
3. **Copy reply** copies the draft body to the clipboard.
4. **Mark sent manually** POSTs to
   `/api/conversations/[id]/mark-sent-manually` with the
   draft body + channel type. The route:
   - Inserts a `human` message with
     `metadata.source='manual_channel_reply'`,
     `channel_type`, `manual_reply_marked_at`,
     `manual_reply_marked_by`.
   - Stamps an `external_messages` row with
     `delivery_status='marked_sent_manually'` via
     `recordManualSendOutcome`.
   - Writes a `channel_reply_marked_sent_manually` audit row.
5. The drawer clears the local `draftBody` so the operator
   does not accidentally re-send. The realtime messages
   subscription surfaces the new human row + the
   `Sent manually` pill in the conversation thread.

The Approve & send button is **disabled** for the duration
of the conversation when the channel is manual-required.
Its label flips to `Manual reply only` and the hover
tooltip points operators to the banner. Website /
internal conversations keep the existing Approve & send
behavior unchanged.

### 13c. Why manual confirmation is not platform delivery

`Mark sent manually` is an operator assertion that they
copied the reply into the source platform and clicked send
there. VenueRise has no way to verify the message actually
left the source platform — there is no API integration with
Meta / Gmail / WeddingWire / The Knot in this phase. The
audit row + external_messages stamp record the operator's
intent, not the receiving system's acknowledgement.

If a customer disputes whether a reply went out, the
authoritative evidence still lives on the source platform.

### 13d. Known limitations (8BE-2)

- The `messages.metadata.channel_type` fallback only fires
  when at least one message in the conversation carries a
  channel stamp. Conversations created entirely before
  Phase 8BE have no stamp and stay unbadged.
- The Approve & send button is gated by channel posture in
  the drawer only — the legacy `LeadDetailPanel` (used in
  some routes) does not yet carry the banner. Phase 8BF
  will sweep remaining mount points if a real send path
  becomes available.
- No real Meta / Gmail / WeddingWire / The Knot outbound
  yet. Manual workflow remains the supported path until
  Phase 8BF connector lands.

---

## 14. Phase 8BG addendum — Lead-forwarding parser

Phase 8BG ships the deterministic parser that powers the
The Knot + WeddingWire intake. No model call — pure regex
+ structured-payload extraction with confidence scoring.

### 14a. Forwarding payload shape

The lead-forwarding routes (`/api/integrations/lead-forwarding/the-knot`
and `…/weddingwire`) accept any combination of these fields:

```jsonc
{
  "venue_id": "<uuid>",          // required
  "external_lead_id": "<string>",
  "external_message_id": "<string>",
  "external_thread_id": "<string>",
  "subject": "<email subject>",  // optional — feeds the parser
  "body": "<raw forwarded body>",// optional — regex extraction
  "payload": { /* structured */ },// optional — preferred
  // Legacy 8BE flat fields still accepted:
  "name": "...", "email": "...", "phone": "...",
  "message": "...", "event_date": "...",
  "guest_count": 0, "budget": 0,
  "received_at": "<ISO>"
}
```

The parser prefers `payload` for structured extraction and
falls back to regex on `body` + `subject` for everything
that's still missing. A successful POST returns:

```json
{
  "success": true,
  "lead_id": "<uuid>",
  "conversation_id": "<uuid>",
  "created": true,
  "parse_confidence": 78,
  "parse_needs_review": false
}
```

### 14b. Confidence rules

| Signal | Points |
|---|---:|
| Email extracted | +35 |
| Message body ≥ 40 chars | +25 |
| Message body 1–39 chars | +10 |
| Name extracted | +15 |
| Phone extracted | +10 |
| Event date extracted | +8 |
| Guest count extracted | +4 |
| Budget extracted | +3 |

`needs_review = confidence < 75`. The threshold is
deliberately conservative — operators see the warning more
than they would in a tuned-down config, but it's safer for
the platform to over-flag than under-flag.

`confidence_reasons` lists `<signal>_extracted` /
`<signal>_missing` strings so the UI tooltip + the
"Source parse review" panel can render concrete missing
signals without the operator having to guess.

### 14c. No raw email-body logging

The parser is called with the raw `body` but NEVER logs it
verbatim. Routes log only `parseConfidence` +
`parseNeedsReview` + the lead/conversation ids that came out
of normalization. The admin test-parse endpoint stamps the
PARSER OUTPUT into audit metadata (confidence + reasons),
NEVER the input body. Operators who need to debug a malformed
payload run it through the test endpoint and look at the
returned `parsed` shape — they do not grep the audit log.

### 14d. Manual-required outbound stays unchanged

Phase 8BG does NOT touch outbound. The Knot + WeddingWire
remain `outbound: false` + `manualReplyRequired: true` in
the capability matrix. The 8BE-2 `ManualChannelReplyBanner`
+ `Mark sent manually` workflow continues to be the supported
path for replying to these inquiries.

### 14e. Admin QA endpoint

`POST /api/admin/integrations/lead-forwarding/test-parse`
runs the parser with no DB side effects. Body:

```json
{
  "channel_type": "the_knot",  // or "weddingwire"
  "subject": "<optional>",
  "body": "<raw body or>",
  "payload": { /* structured */ }
}
```

Returns the fully-parsed shape including
`confidence`, `confidence_reasons`, `needs_review`, and a
500-char preview of the extracted message body. Writes a
`lead_forwarding_test_parse` audit row with parser-output
metadata only — raw body is never logged.

### 14f. Known limitations (8BG)

- Deterministic parser is **not perfect**. Forwarded emails
  with unusual layouts (signatures in the middle, multiple
  embedded threads, RTF/HTML stripping artifacts) will
  score low and land in the review panel — that is the
  intended behaviour.
- No direct The Knot / WeddingWire outbound API. Manual
  workflow remains the path until a partner API ships.
- Date extraction prefers ISO + US (`MM/DD/YYYY`) + human
  ("October 12") formats. Human dates without a year are
  shifted to next year as a best-guess; verify in the
  Source parse review panel before tour scheduling.
- Budget extraction handles `$15K`, `$15,000`, `25000` but
  not currency conversion or ranges (`$15K-20K` extracts as
  $15,000).
- Edit UI for parsed fields is intentionally NOT shipped in
  this phase — operators can either fix the underlying
  lead via the lead PATCH endpoint or re-submit the
  forwarded payload with cleaner structured fields.
- Operator-recorded only — VenueRise does NOT scrape The Knot
  or WeddingWire and does NOT poll them.

---

## 15. Phase 8BF — Meta / Instagram / Facebook connector

Replaces the Phase 8BE webhook placeholder with **verified
inbound delivery** for Instagram DMs, Facebook Page inbox,
and Meta lead-ad submissions.

> **Still no autonomous sending.** Capability matrix keeps
> `instagram` / `facebook` / `meta_lead_ads` on `outbound:
> false` + `manualReplyRequired: true`. Approve & send is
> still gated by the 8BE-2 banner. The Meta Send API is
> deliberately NOT wired in this phase.

### 15a. Required env vars

```env
META_WEBHOOK_VERIFY_TOKEN=…
META_APP_SECRET=…
# Reserved for the Phase 8BF+1 Graph hydration work:
# META_APP_ID=
# META_GRAPH_API_VERSION=v20.0
```

When either is missing the public webhook responds 503
`webhook_not_configured` so an operator who hasn't completed
the Meta App Dashboard hand-off gets an explicit signal
instead of a silently-failing webhook.

### 15b. GET verification

`GET /api/integrations/meta/webhook?hub.mode=subscribe&hub.verify_token=…&hub.challenge=…`
returns the raw `hub.challenge` as `text/plain; charset=utf-8`
when `hub.verify_token` matches `META_WEBHOOK_VERIFY_TOKEN`
in constant time. Mismatches return 403. Token is never
logged.

### 15c. POST signature verification

Reads the raw body exactly once (HMAC must be computed over
the bytes Meta sent — re-serializing would invalidate the
signature). Computes HMAC-SHA-256 with `META_APP_SECRET` and
compares via `crypto.timingSafeEqual`. Verifier lives in
`lib/integrations/channels/meta-signature.ts` — pure function,
returns a discriminated union:

- `{ ok: true }`
- `{ ok: false, reason: 'missing_secret' | 'missing_signature' | 'bad_format' | 'invalid_signature' }`

Routes translate:

- `missing_secret` → **503** `webhook_not_configured` (server)
- everything else → **401** `invalid_signature` (caller)

The body, the signature, and the secret are NEVER logged.

### 15d. Payload parser (`meta-parser.ts`)

Pure function. Supports:

| Meta shape | → channel | Notes |
|---|---|---|
| `object: 'instagram'` + `messaging[]` with `message.text` | `instagram` | Skips read/delivery/postback events and text-less attachments. |
| `object: 'page'` + `messaging[]` with `message.text` | `facebook` | Same skip list. |
| `object: 'page'` + `changes[].field === 'leadgen'` | `meta_lead_ads` | Records a **placeholder** message — does NOT call Graph API. Metadata carries `requires_graph_hydration: true` + `parse_needs_review: true`. |

`external_message_id` prefers `message.mid` / `leadgen_id`;
otherwise a deterministic hash of `(sender, recipient, ts,
text-prefix)` for idempotency.

Anything else (postbacks, story mentions, attachments-only,
unknown change fields) is counted as `ignored` and never
errors. Message text is capped at 8000 chars.

### 15e. Connection resolution

`findMetaConnectionForEvent(event)` looks up
`venue_channel_connections` by channel type + the metadata
identifiers the operator entered in the
ChannelConnectionsCard:

- `instagram` → matches on `metadata.instagram_business_account_id`
- `facebook` → matches on `metadata.meta_page_id`
- `meta_lead_ads` → matches on `metadata.meta_page_id` (or
  `metadata.meta_ad_account_id` as a fallback)

No matching connection ⇒ event is counted as
`ignored_no_connection` and the webhook still returns 200 so
Meta doesn't retry-loop on traffic that simply isn't ours.

### 15f. Channel-connection metadata UI

`ChannelConnectionsCard` now renders a Meta-identifier
editor for `instagram` / `facebook` / `meta_lead_ads` rows
with allowlisted fields:

- **Meta Page ID**
- **Instagram Business Account ID**
- **Meta Ad Account ID**
- **Meta App ID**

The admin POST + PATCH routes run every submitted metadata
payload through `sanitizeChannelConnectionMetadata`:

1. Rejects any key whose name matches a forbidden substring
   (`token`, `secret`, `access_token`, `client_secret`,
   `app_secret`, `webhook_secret`, `private_key`,
   `refresh_token`). Returns 400 `forbidden_metadata_key`
   with the rejected key listed.
2. For Meta-family channels, silently drops keys not in the
   `META_CONNECTION_METADATA_KEYS` allowlist (avoids
   accidental form-field-name typos polluting metadata).
3. For all other channels, passes through (the previous
   8BE behaviour).

Card copy reads: "Identifiers only. Tokens / app secrets /
page tokens are configured server-side via env vars and are
never stored here."

### 15g. POST response shape

```json
{
  "success": true,
  "received": true,
  "events_parsed": 2,
  "events_normalized": 1,
  "events_ignored": 1,
  "object_type": "instagram",
  "per_event": [
    { "channel": "instagram", "status": "normalized" },
    { "channel": "instagram", "status": "ignored_no_connection" }
  ]
}
```

Always **200** — Meta retries on non-2xx. Per-event
outcomes (`normalized` / `ignored_no_connection` /
`ignored_normalization_failed`) ride in the body for
QA + curl runs.

### 15h. Admin QA endpoint

`POST /api/admin/integrations/meta/test-parse` runs the
parser without verifying a signature, without resolving a
connection, and without writing leads/messages. Used for
demos + payload-shape debugging.

```json
{ "payload": { "object": "instagram", "entry": [ … ] } }
```

Audit row (`meta_webhook_test_parse`) carries only
parser-output metadata (`object_type`, `events_parsed`,
`events_ignored`, `channels`). Raw payload is NEVER
logged.

### 15i. Known limitations (8BF)

- No Meta OAuth, no token storage, no Page-token refresh.
- No Graph API hydration for lead-ad form fields — only a
  placeholder message is created until 8BF+1.
- No Send API outbound; manual-required posture preserved.
- Meta app review / advanced permissions are operator
  responsibility — VenueRise does NOT bundle App Review
  artifacts in this phase.
- Old test payloads without `X-Hub-Signature-256` are
  rejected by design.
- Attachments-only / story mentions / postbacks / read
  receipts are counted as `ignored` until a future phase
  adds richer support.
- Matching depends on operators entering correct Page /
  IG Business Account / Ad Account ids in
  ChannelConnectionsCard. Misconfigured rows surface as
  `ignored_no_connection` in the response body.
- Webhook route is public by design (verification happens
  inside the handler).

---

## 16. Phase 8BH — Attribution

Every inbound lead now carries an `attribution` metadata
blob. `parseLeadAttribution` derives a `SourceLabel`
(`Google Ads` / `Meta Ads` / `Instagram` / `Facebook` /
`WeddingWire` / `The Knot` / `Website` / `Email` /
`Referral` / `Direct` / `Manual entry` / `Unknown`) from
UTM params, click ids, channel type, and referrer in that
priority order.

Where it lands:

- `/api/widget` parses `attribution` off the intake payload
  (or empty input → `Website`) and stamps
  `leads.metadata.attribution`.
- `normalizeInboundChannelMessage` does the same for
  omnichannel inbound (Instagram, Facebook, Meta lead-ads,
  The Knot, WeddingWire, manual) using the channel type as
  the primary signal.
- `widget.js` captures UTM + click ids + referrer + landing
  page from the parent page and forwards via iframe query
  params; the embedded widget page reads them on mount and
  POSTs them with the lead intake.

Honesty:

- No pixel. No ad-platform API. No multi-touch.
- "Estimated pipeline" sums `leads.budget` only — NOT ROAS.
  Ad spend is unknown.
- Legacy leads have no `attribution` blob; helpers return
  null and the UI hides badges gracefully.

---

## Phase 8BN — first real outbound channel wired

**Email delivery for website/email leads is now real.** When
`OUTBOUND_EMAIL_DELIVERY_ENABLED=1` and Resend is configured,
the operator-composer "Direct" pill is honest — clicking Send
delivers the reply to the lead's email via Resend (see
`docs/OUTBOUND-EMAIL-DELIVERY.md`).

What this means for the inbox model:

- **Source channel `website` + lead has email** is now the
  ONLY combination that resolves to a `direct` reply-method
  delivery mode in production. Every other channel +
  combination behaves exactly as Phase 8BM left it.
- **Manual channels (Instagram / Facebook / The Knot /
  WeddingWire) remain unchanged.** No outbound integration
  exists for these and they continue to require
  copy-and-paste + mark-sent-manually.
- **SMS remains `internal_only`** until the SMS connector
  ships. The `smsDirectDeliveryEnabled` flag is still
  platform-default false.
- **Inbound email parsing was NOT added.** A lead reply to a
  composer-sent email will not auto-populate the thread.

---

## Phase 8BO — email becomes the first true two-way channel

With inbound reply capture wired (Phase 8BO), the `email` channel
is now the FIRST channel in VenueRise that has both:

- Real outbound (Phase 8BN) — `Direct` reply method delivers
  via Resend when configured
- Real inbound (Phase 8BO) — provider-agnostic HMAC-authenticated
  webhook at `/api/inbound/email` captures lead replies back into
  the conversation thread as `role: 'lead'`

Manual channels (Instagram / Facebook / The Knot / WeddingWire)
still require operator copy-and-paste in both directions.
Website widget is in-product only. SMS remains internal_only
until 8BR/8BS ship.

See `docs/INBOUND-EMAIL-CAPTURE.md` for the inbound spec.

---

## Phase 8BP — email lifecycle becomes operationally complete

Email now has a full **observed lifecycle** on every
operator-sent bubble (Sending → Accepted → Delivered, or
Bounced / Marked as spam / Failed / Manual fallback) plus
inline **Retry** and **Mark handled manually** actions.
Manual channels (Instagram / Facebook / The Knot /
WeddingWire) are unchanged.

See `docs/EMAIL-DELIVERY-STATUS-AND-RETRY.md`.

---

## Phase 8BQ — unmatched inbound email safety net

Email replies the 8BO matcher can't confidently tie to a
conversation now land in a persistent review queue (table
`inbound_email_orphans`) instead of being silently dropped.
The inbox page surfaces a small amber chip when the queue is
non-empty; operators can Link or Dismiss each orphan. No AI
auto-fires on link.

See `docs/UNMATCHED-INBOUND-EMAIL-QUEUE.md`.

---

## Phase 8BR-alt — orphan picker is now operationally complete

The unmatched email queue card now includes a per-row
search/select picker. Operators can resolve every orphan,
not just the ones with a pre-computed suggestion. Strict
no-AI rule preserved. See
`docs/UNMATCHED-INBOUND-EMAIL-QUEUE.md`.
