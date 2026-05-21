/**
 * Phase 9F — Rate-limit key catalog.
 *
 * Single source of truth for the per-route identifier prefixes that
 * land at the Upstash limiter. Each value is the EXACT string a
 * route passes to `rateLimitUserAction(req, key)` or
 * `rateLimitAi(req, key)` — `:${userId}` / `:${userId}:${convId}`
 * etc. get suffixed by the caller.
 *
 * ── ADOPTION POLICY ──────────────────────────────────────────────────────
 * Routes added or modified in Phase 9F+ MUST import the canonical
 * value from this catalog. Pre-9F routes keep their literal strings
 * — the strings resolve to identical UTF-8 sequences so there's no
 * behavior delta. Incremental migration as files are next opened.
 *
 * ── BUCKET TYPE LEGEND ───────────────────────────────────────────────────
 * Each entry documents how the caller composes the per-request
 * identifier. Same prefix can be sharded by different identity
 * dimensions in different places — that's deliberate.
 *
 *   USER      — `${prefix}:${userId}` per authenticated user.
 *   USER+RES  — `${prefix}:${userId}:${resourceId}` per user-resource.
 *   IP        — `${prefix}:${ip}` keyed on raw client IP.
 *   IP+VENUE  — `${prefix}:${ip}:${venueId}` per IP per venue.
 *
 * Notes appear inline on entries with non-default behavior.
 */

export const RATE_LIMIT_DOMAINS = {
  // ── Admin surfaces — USER bucket via `rateLimitUserAction`. ────────────
  admin: {
    auditEvents:          'admin:audit-events',
    dataExport:           'admin:data-export',
    leadRedactPii:        'admin:lead-redact-pii',
    revenueOsSettings:    'admin:revenue-os-settings',
    aiDraftAudit:         'admin:ai-draft-audit',
    aiAutopilotReview:    'admin:ai-autopilot-review',
    aiAutopilotReviews:   'admin:ai-autopilot-reviews',
    aiAutopilotSimulation:'admin:ai-autopilot-simulation',
    aiAutopilotReadiness: 'admin:ai-autopilot-readiness',
    digestPreferences:    'admin:digest-preferences',
    digestPreview:        'admin:digest-preview',
    digestSend:           'admin:digest-send',
    digestSuppressionsRemove:    'admin:digest-suppressions-remove',
    digestSuppressionsRemoveAll: 'admin:digest-suppressions-remove-all',
    suppressions:         'admin:suppressions',
    toursBulkCancel:      'admin:tours-bulk-cancel',
    toursClearPause:      'admin:tours-clear-pause',
    toursPausedVenues:    'admin:tours-paused-venues',
    billingEventClearDunning: 'admin:billing-events-clear-dunning',
    billingEventReplay:   'admin:billing-event-replay',
    demoSeed:             'admin:demo-seed',
    demoReset:            'admin:demo-reset',
    testSend:             'admin:test-send',
    anthropicProbe:       'admin:anthropic-probe',
    securityAbuseEvents:  'admin:security-abuse-events',
  },

  // ── AI generation — USER+RES bucket via `rateLimitAi`. ─────────────────
  ai: {
    draftRegenerate: 'ai:draft-regenerate',
    chatPost:        'ai:chat:post',
    chatGet:         'ai:chat:get',
    qualify:         'ai:qualify',
    followup:        'ai:followup',
  },

  // ── Lead / tour / venue / conversation operator surfaces. ──────────────
  resource: {
    leadCreate:           'leads:create',
    leadUpdate:           'leads:update',
    leadDelete:           'leads:delete',
    tourCreate:           'tours:create',
    tourUpdate:           'tours:update',
    venueUpdate:          'venues:update',
    availabilityCreate:   'venues:availability:create',
    availabilityUpdate:   'venues:availability:update',
    availabilityDelete:   'venues:availability:delete',
    blackoutCreate:       'venues:blackouts:create',
    blackoutDelete:       'venues:blackouts:delete',
    // Phase 9T-alt — Knowledge Base CRUD. List is a hot path
    // (one GET per Settings → Knowledge Base render); writes are
    // per-operator and bursty (operators usually add 5–20 entries
    // at onboarding). All four keys are user-scoped.
    knowledgeList:        'venues:knowledge:list',
    knowledgeCreate:      'venues:knowledge:create',
    knowledgeUpdate:      'venues:knowledge:update',
    knowledgeDelete:      'venues:knowledge:delete',
    conversationMessage:  'conversations:message',
    aiActionReject:       'ai-actions:reject',
  },

  // ── Billing user surfaces (NOT webhooks). ──────────────────────────────
  billing: {
    checkout: 'billing:checkout',
    portal:   'billing:portal',
  },

  // ── Team / RBAC. ───────────────────────────────────────────────────────
  team: {
    invitationCreate: 'team:invite',
    invitationRevoke: 'team:invite:revoke',
    invitationAccept: 'team:accept',
    memberRemove:     'team:member:remove',
    memberRoleUpdate: 'team:role',
  },

  // ── Onboarding. ────────────────────────────────────────────────────────
  onboarding: {
    workspaceCreate: 'onboarding:create',
  },

  // ── Public — IP-keyed. ─────────────────────────────────────────────────
  public: {
    widget:             'public:widget',
    widgetConfig:       'public:widget-config',
    cspReport:          'public:csp-report',
    digestUnsubscribe:  'public:digest-unsubscribe',
    digestResubscribe:  'public:digest-resubscribe',
    tourConfirm:        'public:tour-confirm',
    tourCancel:         'public:tour-cancel',
  },

  // ── SSO / auth (Phase 9G). ─────────────────────────────────────────────
  // Anonymous IP-keyed for initiate/callback (user isn't authenticated
  // yet); USER-keyed for the admin connection-management surface.
  auth: {
    ssoInitiate: 'auth:sso:initiate',
    ssoCallback: 'auth:sso:callback',
  },
  adminSso: {
    connectionsList:   'admin:sso-connections:list',
    connectionsCreate: 'admin:sso-connections:create',
    connectionsUpdate: 'admin:sso-connections:update',
    connectionsDelete: 'admin:sso-connections:delete',
    loginEventsList:   'admin:sso-login-events:list',
  },

  // ── Disaster recovery (Phase 9H) — USER bucket. ────────────────────────
  // Read endpoint is cheap (no Management API call when env is
  // unset; one HTTP call when set), so the userAction 30/min
  // ceiling is generous. The write endpoint is owner-only +
  // audit-only — no real restore happens — so 30/min still fits.
  adminDr: {
    backupPostureRead:   'admin:backup-posture:read',
    restoreIntentCreate: 'admin:restore-intent:create',
  },

  // ── Evidence packaging (Phase 9I) — USER bucket. ───────────────────────
  // The endpoint can return a markdown/CSV download, so the cap
  // is the standard userAction 30/min. A burst of operator
  // downloads (e.g. during a security review) stays well under.
  adminEvidence: {
    evidenceReportRead: 'admin:evidence-report:read',
  },

  // ── Sales readiness (Phase 9J) — USER bucket. ──────────────────────────
  // Questionnaire + buyer-summary endpoints are read-only and
  // operator-initiated. 30/min matches the rest of the admin
  // surface; burst downloads during a security review stay
  // under cap.
  adminQuestionnaire: {
    questionnaireResponseRead: 'admin:questionnaire-response:read',
    buyerSecuritySummaryRead:  'admin:buyer-security-summary:read',
  },

  // ── Demo mode (Phase 9J) — USER bucket. ────────────────────────────────
  // PATCH is owner-only (enforced at the route); the budget is
  // the same as the rest of the admin surface. Read is cheap.
  adminDemo: {
    demoModeRead:   'admin:demo-mode:read',
    demoModeUpdate: 'admin:demo-mode:update',
    // GTM-0A — Revenue Recovery Demo seed. User-scoped + low cap;
    // a seed run is heavy (~24 leads + messages + tours + channel
    // rows + audit) and should not be hammered.
    revenueRecoverySeed: 'admin:demo:revenue-recovery-seed',
    // GTM-0A.2 — Revenue Recovery LOAD/STRESS seed. Same surface
    // as the GTM-0A seed but generates 25–1000 leads + thousands
    // of messages per call. User-scoped + low cap so a misclick
    // doesn't fan out to thousands of inserts in a tight loop.
    revenueRecoveryLoadSeed: 'admin:demo:revenue-recovery-load-seed',
  },

  // ── Vendor risk + subprocessor disclosure (Phase 9K) — USER bucket. ────
  // Read-only endpoints. Markdown/CSV exports leave the building
  // and are audited; JSON refreshes are not. 30/min budget matches
  // the rest of the admin surface.
  adminVendor: {
    vendorRiskReportRead:        'admin:vendor-risk-report:read',
    subprocessorDisclosureRead:  'admin:subprocessor-disclosure:read',
  },

  // ── Incident response (Phase 9L) — USER bucket. ─────────────────────────
  // Six routes, all operator-triggered and admin/owner-gated:
  //   - list / create / read / update / detect / alert.
  // The `detect` and `alert` keys carry tighter labels because
  // they fan out to source-table queries or external webhooks;
  // the route comments document the rationale alongside the
  // rateLimitUserAction call. Standard 30/min userAction budget
  // applies; bursts during an active incident stay under cap.
  adminIncident: {
    incidentList:    'admin:incident:list',
    incidentCreate:  'admin:incident:create',
    incidentRead:    'admin:incident:read',
    incidentUpdate:  'admin:incident:update',
    incidentDetect:  'admin:incident:detect',
    incidentAlert:   'admin:incident:alert',
  },

  // ── Privacy + DSR readiness (Phase 9M) — USER bucket. ───────────────────
  // Seven routes, all operator-triggered and admin/owner-gated.
  // None of them fetch raw subject data — the export preview is
  // metadata-only and the deletion review is non-destructive,
  // so the standard 30/min userAction budget is appropriate.
  adminPrivacy: {
    privacyReadinessRead: 'admin:privacy-readiness:read',
    dsrList:              'admin:dsr:list',
    dsrCreate:            'admin:dsr:create',
    dsrRead:              'admin:dsr:read',
    dsrUpdate:            'admin:dsr:update',
    dsrExportPreview:     'admin:dsr:export-preview',
    dsrDeletionReview:    'admin:dsr:deletion-review',
  },

  // ── Trust Center (Phase 9N) ─────────────────────────────────────────────
  // Admin surfaces run on userAction (30/min); the gated
  // download endpoint is an authenticated-but-not-logged-in
  // surface (bearer token), so it uses the widget bucket
  // identified by the token hash to limit a leaked token's
  // blast radius without hitting userAction (which expects an
  // authenticated user id).
  adminTrust: {
    trustGrantList:         'admin:trust-grant:list',
    trustGrantCreate:       'admin:trust-grant:create',
    trustGrantUpdate:       'admin:trust-grant:update',
    trustAccessEventsList:  'admin:trust-access-events:list',
    trustPacketPreview:     'admin:trust-packet:preview',
  },
  publicTrust: {
    trustArtifactDownload:  'public:trust-artifact:download',
  },

  // ── Compliance ops (Phase 9O) — USER bucket. ────────────────────────────
  // All routes admin/owner-gated. Standard 30/min userAction
  // budget — no payload heavier than a per-venue calendar list,
  // no fan-out to external sources. The `freshness` route
  // re-runs the policy evaluator on every call so we want it
  // capped to keep busy admin dashboards quiet.
  adminCompliance: {
    calendarList:    'admin:compliance-calendar:list',
    calendarAction:  'admin:compliance-calendar:action',
    calendarUpdate:  'admin:compliance-calendar:update',
    freshnessRead:   'admin:compliance-freshness:read',
  },

  // ── Contract commitments register (Phase 9P) — USER bucket. ─────────────
  // Three admin routes (list/create + read/update + readiness).
  // No external fan-out. Standard 30/min userAction budget.
  adminCommitments: {
    list:        'admin:commitments:list',
    create:      'admin:commitments:create',
    update:      'admin:commitments:update',
    readiness:   'admin:commitments:readiness',
  },

  // ── Omnichannel inbox foundation (Phase 8BE) — USER bucket on admin
  //    surfaces, IP+VENUE bucket on public inbound routes. Inbound
  //    routes pass venue_id where present so abuse is per-(IP,venue).
  adminIntegrations: {
    channelsRead:        'admin:integrations:channels:read',
    channelsWrite:       'admin:integrations:channels:write',
    // Phase 8BG — admin lead-forwarding QA endpoint. Pure
    // parse — no DB write, no lead creation. Strict per-user
    // budget so demo runs don't burn anyone's quota.
    leadForwardingTest:  'admin:integrations:lead-forwarding:test',
    // Phase 8BF — admin Meta-webhook payload QA endpoint. Pure
    // parser run; no DB write. Strict per-user budget.
    metaWebhookTest:     'admin:integrations:meta:webhook-test',
  },

  // ── Public inbound channel forwarding (Phase 8BE) — IP+VENUE bucket.
  //    `website` keeps using `widget:` from rateLimitWidget; these prefixes
  //    are for the lead-forwarding routes added in Phase 8BE plus the
  //    operator manual-send confirmation. Manual-send reuses USER bucket.
  inboundChannel: {
    websiteMessage:        'inbound:channel:website',
    leadForwardTheKnot:    'inbound:channel:the-knot',
    leadForwardWeddingWire:'inbound:channel:weddingwire',
    metaWebhook:           'inbound:channel:meta-webhook',
  },
  manualChannel: {
    markSentManually:      'channel:manual-sent',
  },
} as const

export type RateLimitDomain = typeof RATE_LIMIT_DOMAINS
