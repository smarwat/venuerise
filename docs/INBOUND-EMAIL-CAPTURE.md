# Inbound Email Reply Capture

Phase 8BO — closes the email loop opened in Phase 8BN. When a
lead replies to an email VenueRise sent, the reply now lands back
in the conversation thread as `role: 'lead'` on the LEFT side of
the thread (instead of disappearing into the configured Reply-To
inbox).

## What this phase does

```
Lead ──reply──> Reply-To inbox ──webhook──> /api/inbound/email
                                                    │
                                                    ▼
                                  match by In-Reply-To /
                                  References header →
                                  outbound_messages.provider_message_id
                                                    │
                                                    ▼
                                  insert messages row as role:'lead'
                                  with parse_confidence + needs_review
                                                    │
                                                    ▼
                                  ConversationThread realtime
                                  subscription renders it
                                  on the LEFT, next to the
                                  operator's earlier "Sent via Email"
```

## What this phase does NOT do

- **No AI auto-trigger.** Captured replies do not fire the AI
  orchestrator. The operator sees the new message and replies
  manually. Will revisit once threading is proven reliable.
- **No attachment capture.** Inbound attachments are dropped.
- **No multi-tenant Gmail/Outlook OAuth.** A single platform
  Reply-To address is sufficient for early pilots; per-venue
  inbound is a later phase.
- **No replying TO the captured email automatically.** The reply
  becomes the trigger for the operator to compose a new
  outbound send (which then uses 8BN's direct email delivery).
- **No spam scoring.** We assume the provider's inbound webhook
  already filtered obvious spam.
- **No new admin route.** All ingestion happens via the
  anonymous (HMAC-authenticated) public webhook.

## Provider compatibility

The webhook accepts a normalized JSON payload. Most inbound
providers can be configured to POST this exact shape via their
webhook transform / template feature:

| Provider | Compatibility | Notes |
|---|---|---|
| **Resend Inbound** | ✅ | Configure their inbound webhook with the transform mapping below |
| **Postmark Inbound** | ✅ | Their "Set Webhook URL" supports JSON transforms |
| **SendGrid Inbound Parse** | ✅ | Use the JSON option, transform to our shape |
| **Cloudflare Email Workers** | ✅ | Worker script composes the payload directly |
| **AWS SES + Lambda** | ✅ | Lambda composes the payload |
| **Mailgun Routes** | ⚠️ | Their POST shape differs; needs a small transform layer |
| **IMAP polling** | ❌ | Out of scope; webhook is the trust boundary |

## Environment variables

| Var | Required | Default | Purpose |
|---|---|---|---|
| `INBOUND_EMAIL_ENABLED` | ✅ | `0` | Kill switch. `1`/`true` to enable; anything else returns 503 to the provider. |
| `INBOUND_EMAIL_WEBHOOK_SECRET` | ✅ | — | Shared HMAC-SHA256 secret. Generate with `openssl rand -hex 32`. Configure the same value in the provider's webhook config. |

When the kill switch is off, the route returns **503** — not 404
— so a misconfigured upstream provider gets a loud signal in its
dashboard instead of silently dropping replies on the floor.

## Webhook payload shape

`POST /api/inbound/email`

Headers:
- `x-inbound-email-signature: sha256=<hex>` (or `x-webhook-signature: <hex>`)
  — HMAC-SHA256 of the raw body, computed with the shared secret.
- `content-type: application/json`

Body:

```json
{
  "provider": "resend",
  "provider_inbound_id": "inbound_abc123",
  "from": "Sarah Johnson <sarah@gmail.com>",
  "from_name": "Sarah Johnson",
  "to": "reply@yourdomain.com",
  "cc": [],
  "subject": "Re: Your inquiry with VenueRise Demo Venue",
  "text": "Sounds great! Saturday the 14th works for us...",
  "html": "<p>Sounds great...</p>",
  "headers": {
    "message_id": "<inbound-id@gmail.com>",
    "in_reply_to": "<re-12345@resend.dev>",
    "references": "<re-12345@resend.dev>"
  },
  "received_at": "2026-05-24T18:14:22.000Z"
}
```

All fields except `from`, `to`, and one of `text`/`html` are
optional. The route validates the schema with zod.

## Matching strategy

Two paths, tried in priority order:

### 1. Header match (HIGH — confidence 95)

Parse `In-Reply-To` + `References` for any RFC 5322 message ids.
Look them up against `outbound_messages.provider_message_id`. The
Phase 8BN composer route stamps the Resend email id onto that
column for every direct send, so the recipient's reply (which
preserves `In-Reply-To` verbatim in every modern mail client)
matches deterministically.

When matched, we derive:
- `venue_id` from the outbound row
- `lead_id` from the outbound row
- `conversation_id` from `outbound_messages.related_id` (which
  is the source `messages.id` for composer sends) → join to
  `messages.conversation_id`

### 2. Recent recipient match (MEDIUM — confidence 70)

No matching header. Fall back to:

```sql
SELECT id, venue_id, lead_id
FROM outbound_messages
WHERE to_address = $from_email
  AND channel = 'email'
  AND created_at > now() - interval '30 days'
ORDER BY created_at DESC
LIMIT 1
```

This catches replies whose headers got stripped by an over-eager
forwarding rule or a less-common webmail client. 30-day window
prevents stale lead emails from spuriously matching new
conversations.

### 3. No signal (LOW — confidence 30)

Email captured BUT stored with `parse_needs_review: true`. The
inbox UI's existing 8BG `ParseReviewBadge` lights up next to the
message. The operator can manually re-link or dismiss.

Today we 200 + skip these (no venue context to write the row
against). Future: a dead-letter "orphan replies" queue surfaced
in admin.

### Confidence penalties

- **Suppressed sender** (-10): the reply came from an address
  on the platform suppression list. Usually means an
  autoresponder/bounce — we capture the reply for the audit
  trail but penalize trust.

## Honesty contract

| Allowed copy | Not allowed |
|---|---|
| "Reply captured via email" | "Lead replied" (we may have low confidence) |
| "Needs review — matched by recent recipient" | "Verified reply" |
| "Possible orphan reply — no thread match" | Silent ingestion without confidence flag |

The `parse_needs_review` flag is the single source of truth. The
existing inbox `ParseReviewBadge` (Phase 8BG) renders it without
modification.

## Insertion metadata

Every captured reply lands on `messages.metadata` with:

```json
{
  "source": "inbound_email",
  "channel_type": "email",
  "parser_version": "8BO_v1",
  "parse_confidence": 95,
  "parse_needs_review": false,
  "parse_confidence_reasons": ["header_match:in_reply_to"],
  "inbound_provider": "resend",
  "inbound_provider_message_id": "inbound_abc123",
  "inbound_matched_outbound_message_id": "uuid-of-source-outbound-row",
  "inbound_matched_provider_message_id": "re-12345@resend.dev",
  "inbound_matched_conversation_id": "uuid-of-conversation",
  "inbound_subject": "Re: Your inquiry with...",
  "inbound_raw_body_preview": "first 500 chars of raw body",
  "inbound_referenced_message_ids": ["re-12345@resend.dev"],
  "inbound_from_email": "sarah@gmail.com",
  "inbound_from_name": "Sarah Johnson",
  "inbound_to_email": "reply@yourdomain.com"
}
```

The `inbound_raw_body_preview` is capped at 500 chars and kept
for audit — operators can verify what the original body looked
like before reply-quote stripping.

## Reply-quote stripping

We strip the most common reply-quote patterns so the operator
sees only the lead's new text:

- `On Mon, Jan 1, 2025 at 10:00 AM, X wrote:`
- `On 2025-01-01 10:00, X wrote:`
- `-----Original Message-----`
- Outlook `From: / Sent: / To:` header blocks
- Trailing `> ` quoted lines

The original body is preserved on `inbound_raw_body_preview`.

## Security posture

- **HMAC verification before parse.** Raw body bytes are
  required to match the signature — no JSON re-serialization
  between verify + parse.
- **Timing-safe comparison** via `node:crypto.timingSafeEqual`.
- **503 (not 404) on kill switch off** — loud misconfiguration
  signal.
- **401 on missing secret** in production.
- **Rate-limited by IP** via `rateLimitWidget` (shared with
  other anonymous public webhooks).
- **AUDIT_EXEMPT** — every captured row writes a `messages` +
  `external_messages` pair which together constitute the
  forensic trail. Mirrors the lead-forwarding posture
  documented in `docs/AUDIT-COVERAGE.md`.
- **Body size capped at 200KB text / 400KB html** at the zod
  layer. Large attachments would be dropped — they're not
  supported in this phase anyway.
- **No body logged at error level.** Only ids + metadata.

## QA checklist

### With `INBOUND_EMAIL_ENABLED=0`

1. POST a valid signed payload → expect **503** with
   `{ "error": "inbound_email_disabled" }`.
2. Health route reports `inbound_email_capture: 'disabled'`.

### With `INBOUND_EMAIL_ENABLED=1` + valid secret + header match

1. Send a Phase 8BN composer-direct email to a real address.
2. Reply to that email from the recipient inbox.
3. Configure the provider to POST normalized JSON.
4. New `messages` row appears on the LEFT of the inbox thread
   for the same conversation, marked as `role: 'lead'`.
5. `messages.metadata.parse_confidence === 95`.
6. `messages.metadata.parse_needs_review === false`.
7. No AI auto-reply fires.

### Header-less fallback

1. Strip In-Reply-To from the test payload.
2. POST → still ingested. Metadata shows
   `parse_confidence: 70`, reason `recipient_match:recent_outbound`.

### Invalid signature

1. POST with a wrong HMAC → **401** `invalid_signature`.

### Duplicate replay

1. POST the same payload twice with the same
   `provider_inbound_id`.
2. Second POST returns `{ deduplicated: true, message_id: ... }`.
   No duplicate row created.

### Suppressed sender

1. Add a sender to `email_suppressions`.
2. POST a reply from that sender → still ingested, but
   `parse_confidence` reduced by 10 and reason includes
   `suppression_penalty`.

### Orphan reply

1. POST a reply with no matching header AND no recent outbound.
2. Returns `200 { captured: false, reason: 'no_venue_match' }`.
3. Pino log line `inbound.email.no_venue_match` written.

## Known limitations

- **No orphan reply review queue UI.** Today, unmatched
  replies are logged + dropped (200 to the provider). A future
  admin card could list them so operators can manually relink.
- **No attachment capture.** Body-only.
- **No inbound-only auto-create.** If a lead emails us at the
  Reply-To address with NO prior outbound (cold inbound), we
  drop. The 30-day recent-recipient match is the closest we
  come to handling cold inbound — and only if the lead happened
  to receive an outbound at some point.
- **No reply-rate-limit per sender.** A spammy lead replying
  100 times in a minute hits the IP rate limit but not a
  per-sender one. Future enhancement.
- **No spam scoring.** We trust the provider to drop obvious
  spam before the webhook fires.
- **Single platform Reply-To.** Per-venue inbound addresses
  would let venues use their own brand domain end-to-end —
  deferred to a later phase.

## File map

- `lib/integrations/inbound/email.ts` — pure helpers (header
  parsing, quote stripping, confidence scoring, metadata
  builder). No I/O.
- `app/api/inbound/email/route.ts` — webhook receiver. HMAC
  verification → schema → normalize → match → ingest via
  `normalizeInboundChannelMessage`.
- `lib/rate-limit-catalog.ts` — new `inboundChannel.inboundEmailReply`
  entry.
- `app/api/health/route.ts` — four new flags
  (`inbound_email_capture`, etc.).
- `.env.example` — `INBOUND_EMAIL_ENABLED`,
  `INBOUND_EMAIL_WEBHOOK_SECRET` documented.

## Recommended next phases

- **8BP — Failed email retry + delivery polish.** Now that the
  loop is closed, the natural next gap is operator UX around
  failed outbound sends (retry button, error explainer).
- **8BQ — Per-venue verified sending domain.** Replace the
  platform-wide From with per-venue verified domains.
- **8BR — SMS outbound** (mirrors 8BN's pattern for SMS).
- **8BT — Reply method switching UI** (the resolver already
  returns `switchOptions`; just needs the dropdown).
