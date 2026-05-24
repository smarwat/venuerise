# Inbox Reply Method + Delivery Awareness QA

## Why this exists

VenueRise receives inquiries across many channels (website,
email, SMS, Instagram, Facebook, Meta lead ads, The Knot,
WeddingWire). The composer used to give zero indication of
where a reply was going. A venue operator typing "thanks, here
are some Saturday slots" couldn't tell if VenueRise would email
it, SMS it, save it internally, or require them to manually
copy it into The Knot. That's risky — the operator can assume
delivery happened when it didn't.

Phase 8BM is a **labeling phase**. It does NOT add real email
or SMS delivery. It surfaces the truth of what the platform can
and cannot do today, channel by channel, in the composer
itself.

## Source channel vs reply method

| Concept | What it means | Examples |
|---|---|---|
| **Source channel** | Where the inquiry originated | Website widget, Instagram DM, The Knot lead |
| **Reply method** | Where the operator's reply will physically go | Email to sarah@gmail.com, Copy into The Knot, Saved in VenueRise only |
| **Delivery mode** | Whether VenueRise sends the reply itself or the operator must | `direct` / `manual` / `internal_only` / `unavailable` |

The reply method is RESOLVED from the source channel + the
lead's contact info + the platform's channel capability matrix.
It's deterministic (pure function, same inputs → same output).

## Delivery modes

| Mode | Tone | When it applies |
|---|---|---|
| `direct` | Emerald | VenueRise sends the reply itself. **Today: no channel resolves to this.** Future: when email/SMS connectors ship. |
| `manual` | Champagne | Operator must copy + send externally. Used for Instagram, Facebook, The Knot, WeddingWire (channels with no two-way API). |
| `internal_only` | Slate | Reply is saved in VenueRise; no external delivery is attempted. Used for website widget (in-product), and for email/SMS until those connectors ship. |
| `unavailable` | Red | No working path. Used for Meta lead ads when neither email nor SMS contact was shared. |

## Resolver behavior

Implemented in `lib/integrations/channels/reply-method.ts`:

```ts
resolveReplyMethod({
  channelType: 'website' | 'instagram' | ...,
  leadEmail: string | null,
  leadPhone: string | null,
  emailDirectDeliveryEnabled?: boolean,  // defaults false
  smsDirectDeliveryEnabled?: boolean,    // defaults false
})
```

Selection priority:
1. If the source channel REQUIRES manual reply
   (instagram / facebook / the_knot / weddingwire /
   meta_lead_ads / manual), pick the channel-native method.
2. Else if the lead has an email, pick `email`.
3. Else if the lead has a phone, pick `sms`.
4. Else if the channel has a native non-manual option (website),
   pick that.
5. Else fall back to `internal` (no contact on file).

The resolver returns:
- The chosen method + its label + destination + delivery mode
- A list of all available options (`switchOptions`) for future
  switching UI
- A one-line `helperText` and an optional `warning` for the bar

## What changes when a real connector ships

When a future phase wires real email or SMS delivery, flip
`EXTERNAL_EMAIL_DELIVERY_DEFAULT` or `EXTERNAL_SMS_DELIVERY_DEFAULT`
to `true` in the resolver (or pass the per-venue override). The
UI doesn't need to change. The pill flips from `Internal` to
`Direct`, the helper text changes from "Saved in VenueRise
only" to "Sends via email when you click send."

## Composer behavior

| Before | After |
|---|---|
| No indication of where reply goes | Reply Method Bar pinned above mode toggle |
| Operator could assume external delivery | Delivery mode pill makes the truth explicit |
| Metadata only carried `source` | Metadata stamps reply_method + reply_delivery_mode + channel_type + reply_destination |

The composer's existing modes are preserved:
- `You` mode → POST `/api/conversations/[id]/messages` →
  inserts `role:'human'`. No AI fires. No external delivery
  today.
- `AI` mode → POST `/api/ai/draft` → returns variants.
  Operator clicks "Use this draft" → loads into textarea →
  flips to `You` mode for manual send.

The Reply Method Bar is visible in both modes. It describes
where the eventual SEND (in `You` mode) will go.

## Manual channel behavior

For Instagram / Facebook / The Knot / WeddingWire:
- Reply Method Bar shows `Manual` pill in champagne tone
- Helper says "Copy this response into [Channel] to reply"
- The existing `ManualChannelReplyBanner` (separate component,
  shown via ConversationThread for messages that need
  `mark-sent-manually` confirmation) is unchanged. The two
  surfaces complement each other — the bar describes the next
  reply, the banner flags drafts that still need confirmation.
- `mark-sent-manually` route + button preserved.

## Metadata schema

The composer's POST body to `/api/conversations/[id]/messages`
now includes:

```json
{
  "body": "...",
  "sender_type": "operator",
  "metadata": {
    "source": "operator_composer",
    "reply_method": "email",
    "reply_delivery_mode": "internal_only",
    "channel_type": "website",
    "reply_destination": "sarah@gmail.com"
  }
}
```

Server-side allowlist in `ApproveMetadataSchema` was extended
to accept these four new keys. Anything else is dropped on the
floor — no arbitrary client metadata flows to the DB.

`reply_destination` may carry PII (email / phone). The audit
events helper already sanitizes message metadata, so audit
rows don't expose raw PII through that surface.

## Manual QA checklist

### Case 1 — Website lead with email
- Source badge: Website
- Reply method: `Email` · sarah@gmail.com
- Delivery pill: **Internal** (slate)
- Helper: "Saved in VenueRise only — email sending is not connected yet."
- Send: row inserted with role:'human', metadata stamped with reply_method='email', reply_delivery_mode='internal_only'.

### Case 2 — Website lead with phone only
- Source: Website
- Reply method: `SMS` · (phone)
- Pill: **Internal**
- Helper: "SMS on file — direct sending is not connected."

### Case 3 — Instagram lead
- Source: Instagram
- Reply method: `Instagram` (no destination)
- Pill: **Manual** (champagne)
- Helper: "Copy this response into Instagram to reply."
- Operator types reply → saves as `human` with metadata reply_method='instagram', reply_delivery_mode='manual'. No false "sent" claim.

### Case 4 — The Knot lead
- Source: The Knot
- Reply method: `The Knot`
- Pill: **Manual**
- Helper: "Copy this response into The Knot to reply."

### Case 5 — WeddingWire lead
- Source: WeddingWire
- Reply method: `WeddingWire`
- Pill: **Manual**

### Case 6 — Meta lead ad with no email or phone
- Source: Meta Lead Ad
- Reply method: `Meta lead ad`
- Pill: **Unavailable** (red)
- Helper: "Lead-ad replies are not connected yet — use email or SMS if shared."

### Case 7 — Lead with both email and phone
- Reply method picks Email as the default
- `canSwitch === true` in the resolver result
- (Switching UI deferred to a future phase; the data is there for it.)

### Case 8 — Human mode behavior preserved
- After typing and sending: role:'human' inserted, renders on RIGHT, no AI auto-response (P0 fix from prior pass).

### Case 9 — AI mode behavior preserved
- Toggling to AI: bar still visible, draft generated via `/api/ai/draft`, no claim of external send.

### Case 10 — Realtime
- Send → page refresh → message stays on right, no duplicates.
- Metadata reply_method / reply_delivery_mode persists.

## Honesty contract

Phrases that ARE acceptable:
- "Replying via Email" / "Replying via SMS"
- "Replying manually on The Knot"
- "Saved in VenueRise only"
- "Direct sending not connected"
- "Copy this response into Instagram"
- "SMS on file — sending not connected"

Phrases that are NOT acceptable (today):
- "Sent via Instagram" / "Sent via SMS" / "Sent via Email"
- "Delivered"
- "Auto-sent"
- "Connected" (as a delivery claim)
- "Fully automated"

The resolver + bar enforce these by construction — there's no
code path that surfaces a "sent" claim without a working
backend, because the delivery mode comes from the channel
capability matrix.

## Files modified

- `lib/integrations/channels/reply-method.ts` (NEW)
- `components/dashboard/messages/ReplyMethodBar.tsx` (NEW)
- `components/dashboard/MessageComposer.tsx` — accepts
  `replyMethod` prop, renders bar, stamps metadata
- `app/(dashboard)/dashboard/inbox/[leadId]/page.tsx` —
  resolves reply method server-side, passes to composer
- `app/api/conversations/[id]/messages/route.ts` — extends
  metadata allowlist with 4 new keys
- `app/api/health/route.ts` — 4 new flags

No DB schema changes. No new admin routes.

## Known limitations

- **No switching UI yet.** The resolver returns
  `switchOptions` with all available methods, but the bar
  always uses the default. Adding a dropdown would be ~1 hour
  of UI work; deferred to keep the diff small.
- **`emailDirectDeliveryEnabled` / `smsDirectDeliveryEnabled`
  flags are platform-wide.** A future per-venue override
  would let early-pilot venues opt into beta email delivery
  before the platform-wide flip.
- **No backfill of `reply_method` metadata on existing
  messages.** Only new operator-composer messages get the
  stamp. Historical rows continue to render with whatever
  metadata they had.
- **`ReplyMethodBar` doesn't show the operator's own
  recent-reply history.** A future "you replied via email
  yesterday" hint could pull from `messages.metadata.reply_method`.

## Recommended next phase

The natural follow-on is **Phase 8BN — real email outbound
delivery via Resend or per-tenant SMTP**. Plumbing for the
honest UI is in place; flipping
`EXTERNAL_EMAIL_DELIVERY_DEFAULT` will be a one-line change
once the connector ships.

Until then, this bar makes the existing manual-channel
workflow obvious so operators don't accidentally assume
delivery they didn't get.

---

## Phase 8BN update — direct email delivery now wired

Phase 8BN shipped the first real outbound integration on top of
this resolver. See `docs/OUTBOUND-EMAIL-DELIVERY.md` for the
full spec.

**What changed for the bar:**

- A new server-only helper
  `isOutboundEmailConfigured()` (in
  `lib/integrations/delivery/email.ts`) reads
  `OUTBOUND_EMAIL_DELIVERY_ENABLED` and Resend config.
- The inbox thread page passes its result as
  `emailDirectDeliveryEnabled` into `resolveReplyMethod`.
- When both the kill switch is on AND Resend is configured,
  email-bearing leads now resolve to `deliveryMode: 'direct'` —
  the bar flips to the emerald "Direct" pill with helper text
  "Sends via email when you click send."
- When either is missing, behavior is unchanged from 8BM —
  email-bearing leads stay on the slate "Internal" pill with
  "Saved in VenueRise only…".

**What changed for the conversation thread:**

- Operator `role:'human'` messages now render a
  `DeliveryStatusPill` (`Sent via Email` / `Sending…` /
  `Email failed` / `Saved in VenueRise` / `Manual reply
  required`) read from new `delivery_status` metadata stamped
  by `/api/conversations/[id]/messages`.

**What did NOT change:**

- Manual-channel resolution (Instagram / Facebook / The Knot /
  WeddingWire / Meta lead ads). Those still resolve to
  `manual` / `unavailable` and require operator-side copy.
- SMS resolution. Still `internal_only` until the SMS connector
  ships.
- The `EXTERNAL_EMAIL_DELIVERY_DEFAULT` constant in
  `reply-method.ts` (still `false`) — per-call override is
  preferred so per-venue toggles work in the future without
  touching the module-level constant.
