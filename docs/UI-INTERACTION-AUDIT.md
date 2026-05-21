# Phase 9S — UI Interaction Audit

This document is the per-surface inventory of every user-facing
interactive element in VenueRise, the rule that controls whether
it's allowed to render, and the current pass/fail state.

> **Rule of the phase**: every clickable, draggable, or interactive
> element must either **work**, be **intentionally disabled with
> explanatory copy**, be **hidden until it can work**, or be a
> **safe "Coming soon" placeholder**. No silent no-ops. No fake
> clickable UI. No buttons that appear enabled but do nothing.

## How to use this doc

- The `Status` column is the verdict from the 9S pass:
  - `works` — clicked through manually or covered by an existing
    route + audit/rate-limit instrumentation.
  - `fixed` — was broken in some way; 9S corrected it.
  - `disabled-intentionally` — control exists but is `disabled`
    with copy or tooltip explaining why.
  - `hidden-intentionally` — control is conditionally hidden until
    its prerequisites are met.
  - `needs-future-phase` — explicit `Coming soon` copy + tracked
    here as the work item.
- When you add a new surface, add it here too. The scanner is a
  guard, not the spec; this doc is.

## Scanners + runtime QA

Two static scanners ship with 9S. Both run in CI via
`npm run check:ui-interactions` and `npm run check:fetch-routes`.
A Playwright runtime suite ships with **9T** under `tests/e2e/`
covering the core operator workflows — see
`docs/RUNBOOK.md` § Phase 9T for the auth + run instructions:

| Scanner | What it catches |
|---|---|
| `scripts/check-ui-interactions.mjs` | placeholder `href`s, empty `onClick={() => {}}`, `alert()` / `window.confirm()` outside admin destructive flows, `console.log` in client components, JSX placeholder text (`TODO`, `Coming soon`, etc.) |
| `scripts/check-fetch-routes.mjs` | client `fetch('/api/...')` strings that have no matching `route.ts` on disk. Tolerates string-concat + first-segment dynamic templates (info-only). |

### Exemptions

Add `// UI_INTERACTION_EXEMPT: <one-sentence reason>` either on the
same line OR on the immediately preceding non-blank line. The
scanner counts exemptions in its tail line so the reviewer can
verify nothing was blanket-suppressed.

Current allowed exemptions (all narrow + auditable):

| File / Line | Exemption | Why |
|---|---|---|
| `KanbanBoard.tsx` (DragOverlay clone) | `empty_onclick` | DragOverlay renders a visual-only clone during drag; no click target. |
| `LeadDetailDrawer.tsx` (delete lead) | `window_confirm` | Admin-only destructive. Native confirm is intentional friction. |
| `DigestSuppressionsCallout.tsx` (remove, remove-all) | `window_confirm` | Admin-only digest unsuppression. |
| `TrustAccessGrantsCard.tsx` (revoke grant) | `window_confirm` | Admin-only trust grant revoke. |
| `InvitationsTable.tsx` (revoke invite) | `window_confirm` | Admin-only team invitation revoke. |
| `MembersTable.tsx` (remove member) | `window_confirm` | Admin-only workspace member removal. |
| `EditTourDrawer.tsx` (cancel tour) | `window_confirm` | Admin-only tour cancellation. |
| `IncidentResponseCard.tsx` (label text "Send alert (env-gated)") | `alert_usage` | JSX label text false-positive; not a JS `alert(` call. |
| `SettingsTabs.tsx` `KnowledgeBaseTab.handleDelete` | `window_confirm` | Phase 9T-alt — admin-only knowledge entry delete. |

Future destructive admin one-shots are also exempt — keep the
reason text specific so a reviewer can tell intent apart from
laziness.

---

## Findings & fixes (9S pass)

### P0 — dangerous / misleading

| File | What was broken | Fix |
|---|---|---|
| `components/dashboard/SettingsTabs.tsx` `KnowledgeBaseTab` | "Add Entry" / Toggle / Delete buttons POST/PATCH/DELETE'd `/api/venues/[id]/knowledge` + `/api/venues/[id]/knowledge/[id]` — **neither route exists**. Buttons appeared live but were silent no-ops on success path (route returned 404). | Removed dead handlers. "Add Entry" is now `disabled` with `coming soon` tooltip. Per-item toggle + delete buttons removed. Read-only display preserved + added a yellow "Read-only in this release" callout explaining the path: contact support to seed or edit. |
| `components/dashboard/MessageComposer.tsx` Paperclip (`Attach`) + Mic (`Voice`) buttons | Decorative `<button>` with no handler. Rendered as enabled icons with hover styles. | Both are now `disabled` with explicit tooltip + `aria-label` explaining "not yet enabled". `cursor-not-allowed` + dimmed color signals the state. |

### P1 — core operator workflow

No silent breakage found in the core operator surfaces that 9S
inspected (LeadDetailDrawer actions, Kanban board, Inbox composer
send + manual-mark-sent, Availability CRUD, Blackout CRUD,
PaymentMethodsCard, SubscriptionPlansCard). Each has:

- proper async `disabled`-while-loading state,
- inline error rendering (humanised codes),
- success acknowledgement (toast / state update / hard redirect for
  Stripe),
- ADMIN_ROLES gate on the route (server) AND disabled-with-notice
  on the client (no 403 round-trip).

### P2 — enterprise card polish

The 47 enterprise cards on `/dashboard/settings/billing` were
audited row-by-row via grep + spot-check. Every CSV / Markdown
export button issues a real `fetch`/`download` to a known route.
Realtime refresh layers (`RealtimeDigestSendsLayer`,
`RealtimeTourStatusLayer`, `RealtimeAIDraftAuditLayer`) all wire
into existing Supabase realtime channels. No dead exports found.

### P3 — non-critical polish

- The MessageComposer `You` / `AI` pill toggle changes a UI
  highlight but does not change the `/api/ai/chat` payload (the
  route infers role from session). Not a dead button — clicks do
  toggle visible state — but the visible effect is cosmetic only.
  Documented here for a future polish phase; not fixed in 9S.

### Fetch-route mismatches

The original fetch scanner reported 4 hits in `SettingsTabs.tsx`:

1. `fetch(`/api/${path}/${venueId}`, ...)` — fully templated,
   resolves at runtime to `/api/venues/{id}` (knowledge / settings
   /etc). **Unverifiable** by static scan; updated scanner now
   tolerates "first segment is a template var" with no warning.
2. Three `fetch('/api/venues/' + id + '/knowledge[...]')` — these
   pointed at the **non-existent knowledge route** (see P0). Fixed
   by removing the calls (handlers removed alongside the buttons).
   Scanner's "string ends in `/` and continues with `+`" branch
   now tolerates legitimate string-concat patterns elsewhere.

After fixes + scanner improvements: `✓ Fetch-route scan clean —
117 routes detected, 4 dynamic fetches (info-only).`

---

## Per-surface inventory

The table below is *not* exhaustive line-by-line — it captures the
interactive contracts of each surface and the verification status.

### `/dashboard` (Overview)

| Control | Expected behavior | Status |
|---|---|---|
| AIBriefCard "Review" links | Open lead drawer via `?lead=<id>` | works |
| WeeklyToursStrip day cells | Filter tours by day | works |
| OverviewRecentLeads row click | Open lead drawer | works |
| RevenueLeakageBrief filter chips | Deep-link to `/dashboard/leads?leakage=<key>` | works |
| ReactivationQueueCard / RecoveryQueueCard / TourConfirmationQueueCard CTAs | Deep-link to leads board with matching filter | works |
| AttributionPerformanceCard / BookedRevenueAttributionCard / SourceRevenueLeakageCard "View leads" CTAs | Deep-link `?source=<label>` | works (Phase 8BJ) |

### `/dashboard/leads` (Kanban board)

| Control | Expected behavior | Status |
|---|---|---|
| Add Lead button → AddLeadModal | Open + POST `/api/leads` | works |
| Search input | Client-side filter by name/email | works |
| Stage drag-and-drop | PATCH `/api/leads/[id]` with new stage | works |
| Stage drag-and-drop while filtered | Disabled with explanatory pill | works |
| Leakage filter pill clear | Strip `?leakage=` from URL | works |
| Source filter pill clear | Strip `?source=` from URL | works (Phase 8BJ) |
| Card click → LeadDetailDrawer | Open drawer + push `?lead=<id>` | works |
| Drawer close | Strip `?lead=` from URL | works |
| DragOverlay clone | Visual only | `disabled-intentionally` |

### `/dashboard/inbox` + `/dashboard/inbox/[leadId]`

| Control | Expected behavior | Status |
|---|---|---|
| ConversationList search | RPC + client filter | works |
| ConversationList row click | Navigate to `/dashboard/inbox/[leadId]` | works |
| ConversationThread message click (search deep-link) | Scroll + highlight | works |
| MessageComposer Send | POST `/api/ai/chat` | works |
| MessageComposer Attach (Paperclip) | — | `disabled-intentionally` (9S fix) |
| MessageComposer Voice (Mic) | — | `disabled-intentionally` (9S fix) |
| MessageComposer You/AI pill | Cosmetic toggle only | works (visible effect only — P3 note) |
| Parse review badge (parser-flagged inbound) | Read-only badge | works |
| Manual-reply external channels | Mark-sent affordance, never direct-send | works |

### `/dashboard/tours`

| Control | Expected behavior | Status |
|---|---|---|
| Month navigation arrows | Update `?month=YYYY-MM` | works |
| Day cell click | Open ScheduleTourDrawer | works |
| ScheduleTourDrawer save | POST `/api/tours` | works |
| EditTourDrawer save | PATCH `/api/tours/[id]` | works |
| EditTourDrawer cancel tour | DELETE / status-set with native confirm | works (exempt) |
| TourAuditDrawer open via `?audit_tour=` | Server-render drawer | works |
| TourPausedBanner CTA | Open billing settings | works |

### `/dashboard/analytics`

All charts are display-only. KPI tiles are static. No mutating
controls. The "Last 30 days" button is a non-interactive label
that ships ahead of a range picker; documented as `disabled` via
outline-only styling.

### `/dashboard/settings/billing` — billing cards

| Card | Mutating controls | Status |
|---|---|---|
| BillingStatusCard | Manage billing / Resume / Start | works |
| PaymentMethodsCard (Phase 9Q) | Manage payment method / Set up billing | works |
| SubscriptionPlansCard (Phase 9R) | Per-plan Start/Upgrade/Switch + Enterprise mailto | works |
| PauseHistoryTable | — (read-only) | works |
| DigestPreferencesCard | Save preferences + Send sample | works |
| DigestSuppressionsCallout | Remove + Remove all (native confirm) | works (exempt) |
| DigestAuditFeed | Filter + CSV | works |
| DigestAuditLogCard | Filter + Load older + CSV | works |
| EnterpriseAuditEventsCard | Drawer + filters + cursor pagination | works |
| DataLifecycleCard | Export data / Redact PII (lead-level) | works |
| AbuseMonitorCard | Refresh | works |
| SsoConnectionsCard / SsoLoginEventsCard | Create draft / Refresh / Open events | works (no real OAuth — clearly labelled "readiness") |
| BackupPostureCard / RestoreIntentCard | Refresh / Record intent | works (records intent only — never restores) |
| SecurityEvidenceCenter | Markdown / CSV export + refresh | works |
| SecurityQuestionnaireCard / BuyerSecuritySummaryCard | Markdown export | works |
| DemoModeCard | Toggle | works |
| EnterpriseReadinessCard | Refresh | works |
| VendorRiskCard / SubprocessorDisclosureCard | Markdown + CSV + refresh | works |
| IncidentResponseCard | Create / mark / Send alert (env-gated) | works |
| PrivacyReadinessCard / DsrRequestsCard | Create / Mark complete / Export preview | works |
| TrustCenterCard / TrustAccessGrantsCard | Create grant (one-time show URL) / Revoke (native confirm) | works (exempt) |
| ComplianceCalendarCard | Mark complete / waive | works |
| CommitmentsRegisterCard / CommitmentsReadinessCard | Create / refresh | works |
| ChannelConnectionsCard | Add connection (Meta + email + Knot + Wedding Wire) | works (no autonomous outbound; manual-required posture preserved) |
| BrandVoiceCalibrationPanel / AIDraftAuditCard / AutopilotReadinessScorecard / AutopilotReviewQueue / AutopilotSimulationPanel | Filters + cursor + label actions | works |
| RevenueOsSettingsCard | Save thresholds + brand voice | works |
| SpeedToLeadRollupCard / RecoveryRollupCard / TourConversionRollupCard | — (read-only) | works |

### `/dashboard/settings` (workspace)

| Tab | Controls | Status |
|---|---|---|
| Workspace | Save venue metadata | works |
| Availability | Add/Edit/Delete slots | works |
| Tour Blackouts | Add/Delete blackouts | works |
| Knowledge Base | Add / Edit / Toggle / Delete | `fixed` (Phase 9T-alt — POST/PATCH/DELETE wired; per-row save/toggle/delete states; native confirm on delete is exempt) |

### Command palette + top nav

| Control | Behavior | Status |
|---|---|---|
| `/` to open palette | Focus the input | works |
| Lead search results | Open drawer via `?lead=` | works |
| Message search results | Navigate to inbox + highlight | works |
| "Add lead" quick action | Dispatch `venuerise:open-new-lead-modal` event | works |
| Sidebar links | Navigate | works |
| Notification dot | Indicator only | `disabled-intentionally` |

### Public surfaces

| Surface | Controls | Status |
|---|---|---|
| `/widget/[venueId]` | Multi-step form submit → POST `/api/widget` | works |
| `public/widget.js` | iframe wrapper, captures attribution | works |
| `/trust` | Read-only marketing | works |
| `/trust/access/[token]` | Token-gated download | works |
| `/tour/confirm` + `/tour/cancel` | Public token routes | works |

---

## Step 8 — honesty copy verified

These claims are kept restrained and surfaced inline next to the
controls they describe. None overclaim; all match the shipped
posture.

| Surface | Approved copy |
|---|---|
| Meta / Instagram outbound | "Manual reply required" |
| SSO | "SSO readiness only — no real OAuth exchange." |
| Backup restore intent | "Records intent only. Does not restore." |
| Trust packet | "Review before sharing." |
| Compliance calendar | "Operator-marked. Not continuous compliance." |
| PaymentMethodsCard | "Managed by Stripe. VenueRise does not store full card details." |
| Autopilot panels | "Simulation only. Autonomous sending disabled." |
| SubscriptionPlansCard | "Plan limits are product controls, not legal or compliance guarantees." |

---

## QA checklist

Before promoting to production:

1. `npm run check:ui-interactions` — 0 findings, exempt count
   matches the table above.
2. `npm run check:fetch-routes` — 0 unknown routes (info-only OK).
3. `./node_modules/.bin/tsc --noEmit` — exit 0.
4. `npm run check:audit-coverage` — clean.
5. `npm run check:rate-limit-coverage` — clean.
6. `npm run check:no-console-server` — clean.
7. `npm run build` — all routes built.
8. Manual click-through of the surfaces in this doc per their
   `Status` column; any new control added since the last 9S pass
   is documented here.

---

## Recommended follow-ups (not done in 9S)

- ~~**Knowledge base management UI**~~ — **Done in Phase 9T-alt.**
  CRUD routes shipped with SALES_ROLES gate, audit + rate-limit
  coverage, and a per-row UI with edit / toggle / delete states.
- **Composer attachments + voice** — wire to a real upload /
  transcription path; flip the disabled buttons back on.
- **MessageComposer mode toggle** — either remove the toggle or
  pass `mode` to `/api/ai/chat` so the visible toggle has a
  visible effect.
- **Annual / monthly toggle on SubscriptionPlansCard** — route +
  catalog already support `interval=annual`; UI defaults to
  monthly today.
