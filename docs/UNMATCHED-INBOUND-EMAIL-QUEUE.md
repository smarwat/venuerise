# Unmatched Inbound Email Queue

Phase 8BQ — dead-letter / review surface for inbound email
replies the 8BO matcher couldn't confidently tie to a
conversation.

## What this phase does

Before 8BQ, an inbound email reply that didn't match a header
(`In-Reply-To`) and didn't match a recent outbound recipient
(30-day window) was silently dropped with a pino warning + safe
200 to the upstream provider. That's invisible to the operator
— a real couple's reply could disappear if their email client
stripped headers, or if they replied from a different address.

8BQ persists those orphan replies into `inbound_email_orphans`
and surfaces them in a compact review queue on the inbox page.
Operators can **Link** an orphan to the correct conversation
(inserts as `role:'lead'`) or **Dismiss** it with a reason.

## What this phase does NOT do

- **Does NOT auto-link.** Even when suggestions exist, the
  operator must click Link. We never decide where ambiguous
  replies belong.
- **Does NOT auto-trigger AI.** Linking an orphan inserts the
  message but does NOT fire the AI orchestrator. The operator
  composes any response manually.
- **Does NOT auto-create new leads from unmatched email.** A
  cold inbound reply (from an address we've never sent to)
  shows up as a platform-orphan unless we can tie it to a
  venue — and even then, only via Link to an EXISTING
  conversation. There is no "create lead from orphan" button.
- **Does NOT store raw payloads, full headers, or attachments.**
  Body preview is capped (500 chars raw + 8000 chars stripped).
- **Does NOT delete dismissed rows.** Dismiss flips status to
  `dismissed` so an operator can re-link later if they change
  their mind.
- **Does NOT build a full admin module.** Inbox-page card only.

## Architecture

```
Provider POST → /api/inbound/email ──┐
                                     │ if no match OR low confidence
                                     ▼
                          createInboundEmailOrphan
                                     │
                                     │ expanded venue lookup:
                                     │  1. ANY outbound to fromEmail
                                     │  2. leads.email = fromEmail
                                     │
                                     ▼
                          inbound_email_orphans row
                          (status='unresolved',
                           venue_id inferred or NULL,
                           suggested_conversation_ids[])
                                     │
                                     ▼
                          Inbox page → UnmatchedEmailQueueCard
                                     │
                          ┌──────────┴──────────┐
                          ▼                     ▼
                  POST /link              POST /dismiss
                  inserts role:'lead'     status='dismissed'
                  status='linked'         + reason
                  NO AI auto-trigger
```

## Storage model (migration 040)

`public.inbound_email_orphans`

| Column | Purpose |
|---|---|
| `id` | PK |
| `venue_id` | Inferred tenant; NULL = platform orphan (infra-only) |
| `status` | `unresolved` / `linked` / `dismissed` / `ignored` |
| `provider` | `resend` / `postmark` / etc. (free-form, capped) |
| `provider_inbound_id` | Provider's own id for dedupe |
| `provider_message_id` | Referenced outbound id (when parseable) |
| `from_email` / `from_name` / `to_email` / `subject` | Safe envelope |
| `stripped_body` | Reply-quote-stripped body (cap 8000) |
| `raw_body_preview` | First 500 chars of raw (forensic) |
| `received_at` / `parsed_at` | Provider time + our ingest time |
| `match_confidence` / `match_reasons` | Why we couldn't auto-match |
| `suggested_conversation_ids` / `suggested_lead_ids` | One-click link targets |
| `linked_*` / `dismissed_*` | Operator action audit |
| `metadata` | Loose jsonb |
| `created_at` / `updated_at` | Trigger-maintained |

Indexes:
- `(venue_id, status, created_at desc)` — primary operator query
- `(provider, provider_inbound_id)` — dedupe + ops queries
- `(from_email, created_at desc)` — sender history
- `(created_at desc)` — retention cron
- Unique partial: `(provider, provider_inbound_id)` where not null

RLS: SELECT for venue sales roles (`owner`/`admin`/`sales_manager`/
`coordinator`). No INSERT/UPDATE/DELETE policies — all writes go
through service-role helpers after tenant checks in app code.
Same posture as `abuse_events` (migration 029).

## Webhook behavior change

`/api/inbound/email` (8BO) previously had two terminal paths:
1. Match found → insert as `role:'lead'` message.
2. No match → `200 { captured: false }` and drop.

8BQ adds an orphan path:
1. Match found AND confidence ≥ 75 → insert message (unchanged).
2. **No venue match OR confidence < 75** → call
   `createInboundEmailOrphan` → `200 { captured: false,
   orphaned: true, orphan_id, confidence }`.

The expanded venue-detection net used by the helper is
deliberately non-authoritative — it gives the orphan a tenant
so it shows up in the right venue's queue, but never causes
an auto-insert. Strategies:

1. **Any outbound to this address** (no time cap) — most
   common signal; covers leads who replied months later or
   from a forwarded thread.
2. **`leads.email = fromEmail`** — covers a lead replying
   from a new conversation thread.
3. Domain-only heuristic is deliberately NOT used (would
   misroute @gmail.com / @yahoo.com replies across tenants).

When multiple venues signal, the venue with the most signals
wins.

## API routes

### `GET /api/inbound-email-orphans`

Query params: `?status=unresolved|linked|dismissed|ignored|all` (default
`unresolved`), `?limit=1..50` (default `20`).

RLS-scoped. Returns safe envelope only:
```json
{
  "orphans": [
    {
      "id": "...",
      "status": "unresolved",
      "from_email": "sarah@gmail.com",
      "from_name": "Sarah Johnson",
      "subject": "Re: Our wedding",
      "body_preview": "Saturday works...",
      "received_at": "...",
      "match_confidence": 30,
      "suggested_conversation_ids": ["..."],
      ...
    }
  ],
  "unresolved_count": 3
}
```

### `POST /api/inbound-email-orphans/[id]/link`

Body: `{ "conversation_id": "<uuid>" }`

Preconditions:
- Authenticated user with `SALES_ROLES` on the orphan's venue.
- Conversation belongs to the same venue.
- Orphan is `unresolved`.
- Orphan has a venue (platform-orphans cannot be linked from
  the operator surface).
- Orphan body is not empty.

Behavior:
1. Insert `role:'lead'` message with metadata stamping
   `source='inbound_email_orphan_link'`, `channel_type='email'`,
   inbound provider context, and `parse_needs_review=false`
   (operator vouched).
2. Touch `conversations.last_message_at`.
3. Mark orphan `status='linked'` + linked_*.
4. Audit `inbound_email_orphan_linked` with safe fields.
5. Return `{ ok, orphan_id, message_id, conversation_id }`.

**Does NOT trigger AI.** Operator must compose any response
manually.

### `POST /api/inbound-email-orphans/[id]/dismiss`

Body: `{ "reason": "spam|wrong_venue|duplicate|not_relevant|auto_responder|other" }`

Preconditions:
- Authenticated user with `SALES_ROLES` on the orphan's venue.
- Orphan is `unresolved`.
- Orphan has a venue.

Behavior:
1. Flip `status='dismissed'` + dismiss_*.
2. Audit `inbound_email_orphan_dismissed`.
3. Return `{ ok, orphan_id, status, reason }`.

**Does NOT delete the row** — preserved for audit + future
re-link.

## Dashboard UI

`components/dashboard/messages/UnmatchedEmailQueueCard.tsx` —
mounted at the top of the inbox empty-state column.

States:
- **Count = 0** → renders nothing (clean inbox).
- **Count > 0, collapsed** → small amber chip: "Unmatched
  replies: 3" with an alert-triangle icon.
- **Expanded** → list of up to 20 unresolved orphans, each
  showing sender, subject, time-ago, body preview (truncated
  to 280 chars), match confidence chip, and suggestion
  chip when present.

Per-row actions:
- **Link** — primary blue button. Visible when
  `suggested_conversation_ids[0]` exists. Click → POST link
  → optimistic remove from list.
- **Dismiss** — secondary button with reason dropdown
  (Spam / Wrong venue / Duplicate / Not relevant /
  Auto-responder / Other).

When the orphan has no suggestion, an italic "Link via inbox"
hint replaces the Link button (operator must navigate to the
conversation and use the in-thread link surface — deferred to
a future phase).

Footer copy: "Linked replies appear in the conversation as a
lead message. AI does not auto-respond."

## AI / auto-trigger behavior

**Strict rule**: orphans never trigger AI. Specifically:

- The webhook path (`createInboundEmailOrphan`) does not call
  `handleIncomingMessage`.
- The link route inserts the `role:'lead'` row directly via
  service-role and does NOT call any AI helper. The
  operator's `MessageComposer` flow remains the only way to
  send a response (with the existing 8BN/8BP delivery
  pipeline).
- The dismiss route only mutates the orphan row.

Rationale: manual linking is a human review action. We do not
want to surprise-send an AI draft based on an operator's
recovery click.

## Duplicate protection

- **Hard**: unique partial index on `(provider, provider_inbound_id)`
  in migration 040.
- **App-layer**: the helper reads first, returns the existing
  orphan id when the provider id matches.
- **Race**: a concurrent insert that loses the unique index
  race is caught and re-read.
- Payloads without `provider_inbound_id` (some providers don't
  include one) cannot be hard-deduped — operators may see
  multiples in that case. Future enhancement: soft hash of
  `from_email + subject + body_preview + received_at` bucket.

## Audit / rate-limit

**Audit actions added**:
- `inbound_email_orphan_linked` (link route success)
- `inbound_email_orphan_dismissed` (dismiss route success)

Safe metadata only — orphan id, venue id, conversation id,
match confidence, provider name, `provider_inbound_id_present`
boolean. Never: full body, raw payload, full headers, secrets,
raw provider response.

**Rate-limit catalog**:
- `inboundEmailOrphan.link: 'inbound-email-orphan:link'`
- `inboundEmailOrphan.dismiss: 'inbound-email-orphan:dismiss'`

Both routes use `rateLimitUserAction` with key
`<prefix>:<user_id>:<orphan_id>`. The webhook insert path
remains covered by HMAC + the existing inbound rate limit
from 8BO.

**Scanner deltas**:
- `check:audit-coverage` 81 → 83 (link + dismiss)
- `check:rate-limit-coverage` 115 → 117 (link + dismiss)
- `check:fetch-routes` 127 → 130 (list + link + dismiss)
- `ADMIN_ENDPOINT_COUNT` unchanged

## Health flags

- `inbound_email_orphan_queue`
- `inbound_email_orphan_persistence`
- `inbound_email_orphan_linking`
- `inbound_email_orphan_dismissal`
- `inbound_email_orphan_no_ai_guard`

All `'mounted'`.

## QA checklist

### Orphan creation
1. POST a signed inbound payload with no matching headers AND
   no recent recipient match for the From address.
2. Webhook returns `200 { captured: false, orphaned: true,
   orphan_id }`.
3. New row exists in `inbound_email_orphans`.
4. No row inserted in `messages`. No row in `ai_actions`.

### Duplicate
1. POST the same payload twice with the same
   `provider_inbound_id`.
2. Both responses succeed; only one orphan row exists.
3. Second call returns `orphan_created: false`.

### Queue UI
1. Log in as venue user with unresolved orphans for that
   venue.
2. Inbox page shows the amber "Unmatched replies: N" chip.
3. Expand → sender, subject, time-ago, preview, confidence,
   suggestion chip visible.
4. Raw payloads / full headers / provider ids never visible.

### Link
1. Click Link on an orphan with a suggested conversation.
2. Orphan disappears from the list (optimistic).
3. DB: orphan `status='linked'`, `linked_message_id` set.
4. DB: new `messages` row in the target conversation with
   `role='lead'`, metadata includes
   `source='inbound_email_orphan_link'`.
5. No new `ai_actions` row.
6. ConversationThread realtime renders the new bubble on the
   LEFT.

### Dismiss
1. Click Dismiss → pick reason.
2. Orphan disappears from the list.
3. DB: `status='dismissed'`, `dismiss_reason` populated.
4. Row not deleted.

### RLS / cross-tenant
1. Venue A user cannot GET / link / dismiss Venue B's orphan
   (route returns 404).
2. Unauthenticated request rejected.

### Platform orphan (NULL venue)
1. Create a row with `venue_id` NULL via SQL.
2. Venue user does not see it in the queue.
3. Link / dismiss routes return 403 `orphan_unscoped`.

### Manual channels untouched
1. Instagram / The Knot / WeddingWire behavior unchanged.

## Known limitations

- **No in-thread "link this orphan" affordance.** Operators can
  only one-click link when a suggestion is pre-computed. If the
  orphan has no suggestion, they get an italic hint and must
  navigate manually — there's no inline conversation picker
  yet. Future enhancement.
- **No soft-hash dedupe.** Providers that don't include
  `provider_inbound_id` could produce duplicate orphans on
  webhook retry. Workaround: most modern providers do
  include an id.
- **No retention cron.** Dismissed/linked rows accumulate.
  Index on `created_at` is in place for a future
  `inbound-email-orphan-retention` job.
- **No realtime subscription** on the queue card — it loads
  on mount only. An operator who leaves the page open and
  receives a new orphan won't see it until refresh.
  Acceptable for inbox-focused polish; could be a future tap
  of `postgres_changes` on `inbound_email_orphans`.
- **NULL-venue (platform) orphans** are invisible to operators.
  They exist in the table for infra-team manual review via the
  Supabase SQL editor — no UI for them.
- **No "create new lead from orphan"** action. The operator
  must already have a conversation for the lead. If there is
  no matching lead, today's workflow is: dismiss with reason
  `wrong_venue`, manually add the lead via the existing
  AddLeadModal, then wait for the next provider retry (or
  manually copy the body into a new conversation).

## Honesty contract

> The unmatched queue prevents inbound replies from
> disappearing when VenueRise cannot confidently match them
> to a conversation. It does not automatically decide where
> ambiguous replies belong; an operator must review and link
> them. Once linked, the message lands as a lead bubble —
> no AI auto-response, no outbound send. Operators control
> every subsequent action.

## Recommended next phase

**8BR — SMS Outbound Foundation.** Email is now a complete
two-way channel with operator-trustworthy delivery, retry,
fallback, AND a safety net for unmatched replies. SMS is
next: mirror the 8BN/8BP pattern for outbound + delivery
status. After 8BR ships, 8BS (SMS inbound) and 8BT (orphan
SMS queue) become straightforward parallels of 8BO and 8BQ.

---

## Phase 8BR-alt update — inline conversation picker

The "Known limitations" entry above about needing an
in-thread picker is now resolved.

The orphan queue card now renders a search/picker per row so
operators can resolve every orphan, even when no suggestion
was pre-computed:

- **Suggestion exists** → primary **Link suggestion** button
  with a readable label (`Sarah Johnson · sarah@gmail.com ·
  Website · Qualified`) plus a secondary **Choose another**
  toggle that reveals the picker.
- **No suggestion** → picker opens by default with a
  search input and a recent-conversations list.

### Architecture

- **No new API route.** The picker filters the inbox page's
  already-loaded `conversations` list in-browser. Health
  flag `inbound_email_orphan_search` reports `'client_local'`
  to reflect this.
- **Enriched orphan list endpoint**. `/api/inbound-email-orphans`
  now back-fills `suggested_conversations[]` with
  `{ conversation_id, lead_id, lead_name, lead_email, stage,
  source_channel, last_message_at }` previews via a single
  RLS-scoped `IN (...)` lookup. UI never sees raw UUIDs as
  the suggestion label.
- **Server-side ownership re-validation**. The existing
  `/api/inbound-email-orphans/[id]/link` route re-runs the
  full tenant + ownership check on every selected
  conversation id — the picker can never bypass cross-venue
  RLS even if the operator typed a UUID directly.

### UI behavior

- Picker uses progressive disclosure — collapsed by default
  when a suggestion exists.
- Search input has a 250 ms debounce.
- Empty query → most-recent 10 conversations.
- Typed query → substring match on lead name + email (local).
- Selecting a conversation enables the **Link selected**
  button (otherwise disabled).
- Selection state is preserved across keystrokes; clicking
  another result swaps it.
- "No conversations found. Try name, email, or phone."
  empty state.
- 409 `already_resolved` from the link route silently
  removes the orphan from the local list (another tab won).

### Honest copy

> When VenueRise cannot confidently match an inbound email,
> an operator can manually link it to a conversation.
> VenueRise does not auto-decide ambiguous matches.

### Health flags (4 new)

- `inbound_email_orphan_picker: 'mounted'`
- `inbound_email_orphan_search: 'client_local'`
- `inbound_email_orphan_manual_linking: 'mounted'`
- `inbound_email_orphan_picker_no_ai_guard: 'mounted'`

### Scanner deltas

None. No new routes, no new audit actions, no new rate-limit
buckets. The existing link/dismiss routes already audit + rate-
limit. The list route remains a read-only GET (scanner-exempt).

### Known limitations (this phase)

- **Pool is limited to the conversations the inbox server
  page loaded** (currently the venue's entire conversation
  list sorted by `last_message_at`, capped at 200 in the
  prop slice). Venues with > 200 active conversations would
  need server-side search — defer to a future
  `/api/conversations/search` route only if pilot venues
  hit the cap.
- **No phone-number search yet.** The inbox loader joins
  `leads(id, name, email, lead_score)` but not `phone`. If
  operators need phone search, extend the loader's `select`
  + add a phone substring to the local filter.
- **No keyboard nav** in the result list (arrow keys to
  highlight, Enter to select). Click only. Defer if not
  surfaced by pilot feedback.

---

## Phase 8BT update — now multichannel

The queue now holds both email and SMS orphans. Migration 041
added `channel`, `from_phone`, `to_phone` columns to
`inbound_email_orphans`. The table name stays the same for
back-compat; renaming is a low-priority polish.

UI changes:
- Per-row channel icon (Mail vs MessageSquare).
- SMS rows display the sender phone instead of email + name.
- SMS rows show a small blue "SMS reply" chip in place of
  subject.
- Footer copy updated to "Linked replies (email or SMS)…".

API changes:
- `GET /api/inbound-email-orphans` accepts `?channel=email|sms|all`
  (default `all`); response includes `channel`, `from_phone`,
  `to_phone`.
- Link route branches on `orphan.channel` — SMS inserts with
  `channel_type='sms'` metadata.
- Dismiss / audit metadata carry `channel`.

See `docs/SMS-ORPHAN-QUEUE.md`.
