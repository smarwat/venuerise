# Meta Messenger Integration

Phase GTM-Meta-OAuth — OAuth scaffold + Page Access Token storage +
gated outbound send helper. Inbound (webhook) was shipped in
Phase 8BF and is independent of this scaffold.

---

## What this phase ships

| Surface | Status | Gated by |
|---|---|---|
| Inbound webhook `POST /api/integrations/meta/webhook` | ✅ Live (Phase 8BF) | `META_APP_SECRET` + `META_WEBHOOK_VERIFY_TOKEN` |
| OAuth start `GET /api/integrations/meta/oauth/start` | ✅ Mounted | `META_APP_ID` + `META_APP_SECRET` + `NEXT_PUBLIC_APP_URL` |
| OAuth callback `GET /api/integrations/meta/oauth/callback` | ✅ Mounted | Same |
| Token storage `meta_oauth_tokens` | ✅ Migration 038 | RLS deny-all (service-role only) |
| Outbound send helper `sendMetaMessage` | ⚠️ Scaffold-only | `META_OUTBOUND_SENDING_ENABLED=true` + caller passes `confirmedAllowedToSend: true` |

**The send helper exists but is dual-gated off.** No code path
wires it into auto-send today. Enable it only after Meta App
Review approves the app.

---

## Environment variables

```bash
# Required for the webhook receiver (Phase 8BF)
META_WEBHOOK_VERIFY_TOKEN=...   # any random string; echo back during Meta's hub verification
META_APP_SECRET=...             # from developers.facebook.com → App → Settings → Basic

# Required for OAuth + Graph API calls (this phase)
META_APP_ID=...                 # from the same page; publicly visible
META_GRAPH_API_VERSION=v20.0    # defaults to v20.0 if unset
NEXT_PUBLIC_APP_URL=https://venuerise.com   # used to derive OAuth callback URL

# Default: OFF. Outbound send helper throws MetaSendDisabledError unless
# both this env AND the caller's `confirmedAllowedToSend` are true.
META_OUTBOUND_SENDING_ENABLED=false
```

If any of `META_APP_ID`, `META_APP_SECRET`, or `NEXT_PUBLIC_APP_URL`
are missing, the OAuth start route returns `503
meta_oauth_not_configured`. The webhook receiver stays functional
because it only needs `META_APP_SECRET` + `META_WEBHOOK_VERIFY_TOKEN`.

---

## How a venue connects (when configured + approved)

1. Operator clicks "Connect Instagram" in `/dashboard/settings/billing`.
   The button hits `GET /api/integrations/meta/oauth/start`.
2. The start route sets a `meta_oauth_state` cookie (httpOnly,
   sameSite=lax, 10-min TTL) and 302s the browser to the Facebook
   OAuth dialog.
3. The user picks their Facebook Page(s) and approves the scopes.
4. Facebook 302s back to `GET /api/integrations/meta/oauth/callback`
   with `code` and `state` query params.
5. The callback validates `state` against the cookie in constant time,
   exchanges `code` → short-lived user token → long-lived user token
   → list of Pages each with a long-lived Page Access Token (~60d).
6. For each Page, the callback:
   - Upserts a `venue_channel_connections` row
     (`channel_type=instagram` if IG Business linked, otherwise
     `facebook`)
   - Inserts a `meta_oauth_tokens` row with the long-lived Page token
   - POSTs to `/{page_id}/subscribed_apps` so future DMs flow to our
     webhook receiver
7. Browser is redirected to `/dashboard/settings/billing?meta=connected&pages=N&ig=M`.

Errors at any step → redirect to `?meta=error&reason=...` (never
JSON-in-browser; the operator always lands on a real page).

---

## Token storage

`meta_oauth_tokens` (migration 038):

| Column | Notes |
|---|---|
| `id` | uuid pk |
| `channel_connection_id` | fk → venue_channel_connections (cascade) |
| `venue_id` | fk → venues (cascade) |
| `page_id` | the Facebook Page ID |
| `token_type` | `'page'` (long-lived) or `'system_user'` (future) |
| `access_token` | the long-lived token; **never log this** |
| `granted_scopes` | text[] of scopes Meta returned at OAuth time |
| `expires_at` | Meta-reported expiry; refresh proactively at expires_at − 10 days |
| `last_refreshed_at`, `last_used_at`, `revoked_at` | lifecycle bookkeeping |

**RLS:** deny-all to `authenticated`. Only `createServiceClient()`
(which bypasses RLS) can read or write. The webhook route, the
outbound send helper, and any future refresh job must use the
service client.

**Why a dedicated table:** the existing sanitizer at
`lib/integrations/channels/meta-connections.ts` explicitly rejects
any key in `venue_channel_connections.metadata` containing
substrings like `'token'`, `'secret'`, `'access_token'`. That
posture is correct — metadata is operator-visible. Tokens must
live somewhere else, which is this table.

---

## Outbound send — gate posture

`lib/integrations/channels/meta-oauth.ts → sendMetaMessage(...)`
throws `MetaSendDisabledError` unless BOTH:

1. `process.env.META_OUTBOUND_SENDING_ENABLED === 'true'`
2. The caller passes `confirmedAllowedToSend: true` in the args
   object (the TypeScript type forces the literal `true`)

This is a tripwire. A future Phase wires the helper into the
instant-response pipeline behind these gates so:

- Misconfigured staging deploys never actually message real users.
- Wiring code into auto-send by mistake fails closed.
- After Meta App Review approves the app and the env is flipped,
  every send still requires the calling code to opt-in explicitly.

---

## Meta App Review checklist

(See the long-form walkthrough in the GTM phase handoff. Repeated
here for one-doc convenience.)

### Submit-once paperwork

- [ ] Meta Business Account created at business.facebook.com
- [ ] `venuerise.com` verified (Business Settings → Brand Safety → Domains)
- [ ] Privacy policy published with explicit Meta data-handling section
- [ ] Test Facebook Page + linked Instagram Business account ready
- [ ] **Business Verification submitted** (Security Center → Business Verification)

### Per-app config

- [ ] App created at developers.facebook.com → My Apps → Create App → Business
- [ ] Display name set to something operator-friendly (shows in OAuth dialog)
- [ ] App icon uploaded (1024×1024)
- [ ] Privacy Policy URL filled
- [ ] ToS URL filled
- [ ] User Data Deletion URL filled (instructions page is fine)
- [ ] App Domains includes `venuerise.com`
- [ ] Messenger product added; webhook callback URL set to
      `https://venuerise.com/api/integrations/meta/webhook`
- [ ] Verify Token matches `META_WEBHOOK_VERIFY_TOKEN` env
- [ ] Subscribed fields: `messages`, `messaging_postbacks`,
      `message_deliveries`, `messaging_handovers`
- [ ] Instagram Messaging API product added

### App Review submission (per permission)

For each of `instagram_basic`, `instagram_manage_messages`,
`pages_messaging`, `pages_show_list`, `pages_manage_metadata`,
`business_management`:

- [ ] Written justification per template (see PRODUCT-THESIS doc)
- [ ] Screencast (5–10 min, 1080p, narrated) showing end-to-end use
- [ ] Test credentials: VenueRise account + test IG account username

### After approval

- [ ] Set `META_OUTBOUND_SENDING_ENABLED=true` in production env
- [ ] Wire `sendMetaMessage` into the instant-response pipeline
      (separate phase — explicit code change, not env flip)
- [ ] Monitor `meta_oauth_tokens.expires_at` for tokens approaching
      60-day expiry; build a refresh job

---

## Troubleshooting

### `503 meta_oauth_not_configured`

`META_APP_ID`, `META_APP_SECRET`, or `NEXT_PUBLIC_APP_URL` is unset.
Check the env on the deploy, then redeploy.

### OAuth callback redirects to `?meta=error&reason=csrf_state_mismatch`

The state cookie expired (>10 min between clicking Connect and the
Facebook redirect coming back) OR the browser refused the cookie OR
the user opened the dialog in a different browser. Solution: have
the operator click Connect again.

### `?meta=error&reason=no_pages_granted`

The user clicked through OAuth but unchecked every Page on the
permissions screen. Their account has no Pages we can manage.
Operator needs to: (a) confirm they actually admin a Page, (b)
retry and grant access to that Page.

### Webhook delivers events but no message appears in inbox

Check `meta_oauth_tokens` for a row matching the Page ID from the
webhook payload. If absent, the OAuth flow never persisted the
token (look at the `meta.oauth.token_insert_failed` log line). If
present but `revoked_at` is non-null, the venue re-OAuth'd and the
old row was archived — should still see a newer non-revoked row
for the same Page.

### Audit row reads `channel_meta_oauth_failed` with `outcome: 'graph_error_190'`

Meta error code 190 = invalid access token. The token Meta returned
during OAuth was already invalidated (rare). The operator can
retry — usually transient.

### Long-lived Page token expired

We don't yet have a refresh cron. Until that ships, a venue whose
60-day token lapsed must re-OAuth manually. The Connect Instagram
button handles this gracefully — same flow, fresh token replaces
the old one (the old row gets `revoked_at` set).

---

## Files

| File | Purpose |
|---|---|
| `supabase/migrations/038_meta_oauth_tokens.sql` | Token storage table + RLS deny-all |
| `lib/integrations/channels/meta-oauth.ts` | Helper module (URL builder, token exchanges, page enumeration, send helper) |
| `app/api/integrations/meta/oauth/start/route.ts` | OAuth initiation (admin-only, sets state cookie, 302 to FB) |
| `app/api/integrations/meta/oauth/callback/route.ts` | OAuth completion (validates state, exchanges code, persists tokens) |
| `app/api/integrations/meta/webhook/route.ts` | Inbound webhook receiver (Phase 8BF, unchanged) |
| `lib/integrations/channels/meta-connections.ts` | Existing connection lookup helper (Phase 8BF, unchanged) |
| `lib/integrations/channels/meta-signature.ts` | Existing HMAC verifier (Phase 8BF, unchanged) |
| `lib/integrations/channels/meta-parser.ts` | Existing payload parser (Phase 8BF, unchanged) |
