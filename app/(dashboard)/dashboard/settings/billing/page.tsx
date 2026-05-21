import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getCurrentVenueForUser } from '@/lib/auth/tenant-access'
import { ADMIN_ROLES } from '@/lib/auth/roles'
import { getVenueSubscriptionStatus } from '@/lib/billing/subscription-status'
import PageHeader from '@/components/dashboard/PageHeader'
import BillingStatusCard from '@/components/dashboard/billing/BillingStatusCard'
import PaymentMethodsCard from '@/components/dashboard/settings/PaymentMethodsCard'
import SubscriptionPlansCard from '@/components/dashboard/settings/SubscriptionPlansCard'
import { getCurrentPlanForVenue } from '@/lib/billing/current-plan'
import PauseHistoryTable, {
  type PauseHistoryCurrent,
  type PauseHistoryItem,
} from '@/components/dashboard/settings/PauseHistoryTable'
import TourStatusActivityFeed from '@/components/dashboard/settings/TourStatusActivityFeed'
import DigestPreferencesCard from '@/components/dashboard/settings/DigestPreferencesCard'
import DigestAuditFeed from '@/components/dashboard/settings/DigestAuditFeed'
import DigestAuditLogCard from '@/components/dashboard/settings/DigestAuditLogCard'
import EnterpriseAuditEventsCard from '@/components/dashboard/settings/EnterpriseAuditEventsCard'
import DataLifecycleCard from '@/components/dashboard/settings/DataLifecycleCard'
import AbuseMonitorCard from '@/components/dashboard/settings/AbuseMonitorCard'
import SsoConnectionsCard from '@/components/dashboard/settings/SsoConnectionsCard'
import SsoLoginEventsCard from '@/components/dashboard/settings/SsoLoginEventsCard'
import BackupPostureCard from '@/components/dashboard/settings/BackupPostureCard'
import RestoreIntentCard from '@/components/dashboard/settings/RestoreIntentCard'
import SecurityEvidenceCenter from '@/components/dashboard/settings/SecurityEvidenceCenter'
import SecurityQuestionnaireCard from '@/components/dashboard/settings/SecurityQuestionnaireCard'
import BuyerSecuritySummaryCard from '@/components/dashboard/settings/BuyerSecuritySummaryCard'
import DemoModeCard from '@/components/dashboard/settings/DemoModeCard'
import RevenueRecoveryDemoCard from '@/components/dashboard/settings/RevenueRecoveryDemoCard'
import RevenueRecoveryLoadDemoCard from '@/components/dashboard/settings/RevenueRecoveryLoadDemoCard'
import InstantResponseTrainingCard from '@/components/dashboard/settings/InstantResponseTrainingCard'
import EnterpriseReadinessCard from '@/components/dashboard/settings/EnterpriseReadinessCard'
import VendorRiskCard from '@/components/dashboard/settings/VendorRiskCard'
import SubprocessorDisclosureCard from '@/components/dashboard/settings/SubprocessorDisclosureCard'
import IncidentResponseCard from '@/components/dashboard/settings/IncidentResponseCard'
import PrivacyReadinessCard from '@/components/dashboard/settings/PrivacyReadinessCard'
import DsrRequestsCard from '@/components/dashboard/settings/DsrRequestsCard'
import TrustCenterCard from '@/components/dashboard/settings/TrustCenterCard'
import TrustAccessGrantsCard from '@/components/dashboard/settings/TrustAccessGrantsCard'
import ComplianceCalendarCard from '@/components/dashboard/settings/ComplianceCalendarCard'
import CommitmentsRegisterCard from '@/components/dashboard/settings/CommitmentsRegisterCard'
import CommitmentsReadinessCard from '@/components/dashboard/settings/CommitmentsReadinessCard'
import ChannelConnectionsCard from '@/components/dashboard/settings/ChannelConnectionsCard'
import { isAuditMirrorConfigured } from '@/lib/enterprise/audit-mirror'
import AIDraftAuditCard from '@/components/dashboard/settings/AIDraftAuditCard'
import AutopilotReadinessScorecard from '@/components/dashboard/settings/AutopilotReadinessScorecard'
import AutopilotReviewQueue from '@/components/dashboard/settings/AutopilotReviewQueue'
import AutopilotSimulationPanel from '@/components/dashboard/settings/AutopilotSimulationPanel'
import BrandVoiceCalibrationPanel from '@/components/dashboard/settings/BrandVoiceCalibrationPanel'
import RealtimeAIDraftAuditLayer from '@/components/dashboard/settings/RealtimeAIDraftAuditLayer'
import RevenueOsSettingsCard from '@/components/dashboard/settings/RevenueOsSettingsCard'
import SpeedToLeadRollupCard from '@/components/dashboard/settings/SpeedToLeadRollupCard'
import RecoveryRollupCard from '@/components/dashboard/settings/RecoveryRollupCard'
import TourConversionRollupCard from '@/components/dashboard/settings/TourConversionRollupCard'
import DigestSuppressionsCallout from '@/components/dashboard/settings/DigestSuppressionsCallout'
import DigestCronHealthCard from '@/components/dashboard/settings/DigestCronHealthCard'
import RealtimeDigestSendsLayer from '@/components/dashboard/settings/RealtimeDigestSendsLayer'
import RealtimeTourStatusLayer from '@/components/dashboard/tours/RealtimeTourStatusLayer'
import type {
  TourStatusActorKind,
  TourStatusEvent,
} from '@/components/dashboard/tours/tour-audit-types'

export const dynamic = 'force-dynamic'

/**
 * Phase 7D — /dashboard/settings/billing
 *
 * Server-rendered. Reads the venue's subscription status via the helper
 * (service-role internally, request-memoized) and renders a single status
 * card with the right action set. The card is pure UI — all server →
 * Stripe round-trips happen via BillingActions → /api/billing/{checkout,portal}.
 */
export default async function BillingSettingsPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const venue = await getCurrentVenueForUser(user.id)
  if (!venue) redirect('/onboarding')

  // Tolerate a transient status read failure — the card falls through to
  // its "unknown" state and the user can still hit the manage-billing CTA.
  let status: Awaited<ReturnType<typeof getVenueSubscriptionStatus>>
  try {
    status = await getVenueSubscriptionStatus(venue.venueId)
  } catch {
    status = { kind: 'unknown', raw_status: 'read_failed' }
  }

  // Phase 9R — resolve the current plan once for SubscriptionPlansCard.
  // The helper request-memoizes; falls through to `null` ("Not set")
  // on a read failure so the page still renders.
  const currentPlan = await getCurrentPlanForVenue(venue.venueId)

  // Phase 8I — pause history audit surface. We only render the table for
  // admins/owners; sales/coordinator/viewer roles see the existing billing
  // card alone. The read uses the service client because `subscriptions`
  // SELECT is ADMIN_ROLES-only via RLS (migration 007), and parsing the
  // metadata server-side keeps the client component pure presentation.
  const isAdmin = (ADMIN_ROLES as readonly string[]).includes(venue.role)
  let pauseCurrent: PauseHistoryCurrent = {
    paused_at: null,
    paused_reason: null,
    paused_count: null,
    resumed_at: null,
    resumed_reason: null,
  }
  let pauseItems: PauseHistoryItem[] = []
  if (isAdmin) {
    const svc = createServiceClient()
    const { data: subRaw } = await svc
      .from('subscriptions')
      .select('metadata')
      .eq('venue_id', venue.venueId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    const md =
      (subRaw as { metadata?: Record<string, unknown> | null } | null)?.metadata ?? null
    if (md) {
      const readStr = (k: string): string | null => {
        const v = md[k]
        return typeof v === 'string' && v.length > 0 ? v : null
      }
      const readNum = (k: string): number | null => {
        const v = md[k]
        return typeof v === 'number' && Number.isFinite(v) ? v : null
      }
      pauseCurrent = {
        paused_at: readStr('tours_paused_at'),
        paused_reason: readStr('tours_paused_reason'),
        paused_count: readNum('tours_paused_count'),
        resumed_at: readStr('tours_resumed_at'),
        resumed_reason: readStr('tours_resumed_reason'),
      }
      const rawHistory = (md as { tour_pause_history?: unknown }).tour_pause_history
      if (Array.isArray(rawHistory)) {
        const parsed: PauseHistoryItem[] = []
        for (const entry of rawHistory) {
          if (!entry || typeof entry !== 'object') continue
          const e = entry as Record<string, unknown>
          const paused_at = typeof e.paused_at === 'string' ? e.paused_at : null
          const resumed_at = typeof e.resumed_at === 'string' ? e.resumed_at : null
          const archived_at = typeof e.archived_at === 'string' ? e.archived_at : null
          if (!paused_at || !resumed_at || !archived_at) continue
          parsed.push({
            paused_at,
            resumed_at,
            archived_at,
            paused_reason: typeof e.paused_reason === 'string' ? e.paused_reason : null,
            resumed_reason:
              typeof e.resumed_reason === 'string' ? e.resumed_reason : null,
            paused_count: typeof e.paused_count === 'number' ? e.paused_count : null,
          })
        }
        // Newest first — same display order as the admin endpoint.
        parsed.reverse()
        pauseItems = parsed.slice(0, 10)
      }
    }
  }

  // Phase 8N — server-fetched tour status activity feed. Admins/owners
  // only. Reads directly from `public.tour_status_events` via the service
  // client because this is a Server Component and forwarding cookies to
  // the admin HTTP endpoint would just add latency for the same data.
  // The Phase 8M RLS policy still applies as defense in depth — but with
  // the service client we rely on the application-level `isAdmin` gate
  // above to enforce access.
  const VALID_ACTOR_KINDS: ReadonlySet<TourStatusActorKind> = new Set([
    'lead_token',
    'operator',
    'cron',
    'system',
  ])
  let tourStatusEvents: TourStatusEvent[] = []
  if (isAdmin) {
    const svc = createServiceClient()
    const { data: eventsRaw } = await svc
      .from('tour_status_events')
      .select(
        'id, venue_id, tour_id, lead_id, actor_kind, actor_id, action, previous_status, new_status, source_ip, user_agent, reason, metadata, occurred_at'
      )
      .eq('venue_id', venue.venueId)
      .order('occurred_at', { ascending: false })
      .limit(25)
    tourStatusEvents = ((eventsRaw ?? []) as Array<Record<string, unknown>>)
      .filter((row): row is Record<string, unknown> & { actor_kind: string } => {
        return (
          typeof row.actor_kind === 'string' &&
          VALID_ACTOR_KINDS.has(row.actor_kind as TourStatusActorKind)
        )
      })
      .map((row) => ({
        id: String(row.id),
        venue_id: String(row.venue_id),
        tour_id: String(row.tour_id),
        lead_id: typeof row.lead_id === 'string' ? row.lead_id : null,
        actor_kind: row.actor_kind as TourStatusActorKind,
        actor_id: typeof row.actor_id === 'string' ? row.actor_id : null,
        action: typeof row.action === 'string' ? row.action : 'unknown',
        previous_status:
          typeof row.previous_status === 'string' ? row.previous_status : null,
        new_status: typeof row.new_status === 'string' ? row.new_status : 'unknown',
        source_ip: typeof row.source_ip === 'string' ? row.source_ip : null,
        user_agent: typeof row.user_agent === 'string' ? row.user_agent : null,
        reason: typeof row.reason === 'string' ? row.reason : null,
        metadata:
          row.metadata && typeof row.metadata === 'object'
            ? (row.metadata as Record<string, unknown>)
            : {},
        occurred_at:
          typeof row.occurred_at === 'string'
            ? row.occurred_at
            : new Date().toISOString(),
      }))
  }

  return (
    <div className="p-6 lg:p-8 animate-slide-up">
      <PageHeader
        title="Billing"
        subtitle="Manage your subscription, payment method, and invoice history."
      />
      <div className="space-y-6">
        <BillingStatusCard status={status} />
        {/* Phase 9Q — Payment methods surface. Sits directly below
            the subscription status card so operators reading
            top-to-bottom see "Your subscription is active" then
            "Here's how to manage the card behind it" before any
            of the deeper enterprise cards. The card is rendered
            for all roles — non-admins see disabled CTAs + an
            inline notice rather than a 403 round-trip. */}
        <PaymentMethodsCard status={status} isAdmin={isAdmin} />
        {/* Phase 9R — Subscription plans foundation. Rendered for
            all roles (non-admins see disabled CTAs + inline notice).
            The card reads the current plan via
            getCurrentPlanForVenue() (subscription metadata first,
            stripe_price_id reverse-lookup second). Plan limits are
            product controls only — NOT enforced globally; see
            lib/billing/plan-gates.ts. */}
        <SubscriptionPlansCard
          status={status}
          isAdmin={isAdmin}
          currentPlanId={currentPlan?.planId ?? null}
          currentInterval={currentPlan?.interval ?? null}
        />
        {isAdmin && (
          <PauseHistoryTable current={pauseCurrent} items={pauseItems} />
        )}
        {isAdmin && <TourStatusActivityFeed events={tourStatusEvents} />}
        {/* Phase 8T — daily/weekly/off cadence picker (admins/owners
            only — the route + the card itself both enforce the gate). */}
        {isAdmin && <DigestPreferencesCard />}
        {/* Phase 8AB — cron health indicator. Sits next to the
            preferences card so an operator who just changed their
            cadence preference can sanity-check that the cron
            actually fired recently. Heuristic — explains itself
            inline; see RUNBOOK if the dot turns amber/red. */}
        {isAdmin && <DigestCronHealthCard />}
        {/* Phase 8Z — suppression triage callout. Sits between the
            preferences card and the audit feed so operators see
            "1 admin email is suppressed" BEFORE they wonder why
            the feed shows status='suppressed' rows. Renders nothing
            when no admin emails are suppressed. */}
        {isAdmin && <DigestSuppressionsCallout />}
        {/* Phase 8Y — digest send audit feed. Reads /api/admin/digest/sends
            with a kind filter chip set + CSV export link. Admin/owner
            only; the endpoint also returns 401/403 for non-admins. */}
        {isAdmin && <DigestAuditFeed />}
        {/* Phase 8AC — operator + cron audit log over digest_audit_events.
            Distinct from DigestAuditFeed: that shows digest SENDS;
            this shows ACTIONS (suppression removes, retention runs). */}
        {isAdmin && <DigestAuditLogCard />}
        {/* Phase 9A — Enterprise audit log over `public.audit_events`
            (migration 027). Cross-cutting security log — leads,
            tours, settings, AI safety, digest, pause. Drawer fetches
            sanitized before/after snapshots on demand. The
            `autonomous_sending_still_disabled` flag stays mounted
            — this card observes only, never acts. */}
        {isAdmin && (
          <EnterpriseAuditEventsCard
            auditMirrorEnabled={isAuditMirrorConfigured()}
          />
        )}
        {/* Phase 9D — Data lifecycle controls. Owner-requested
            JSON export, lead-level PII redaction info, retention
            posture summary. No autonomous behavior; operator
            actions only. The mirror + retention flags read from
            process.env on the server. */}
        {isAdmin && (
          <DataLifecycleCard
            auditMirrorEnabled={isAuditMirrorConfigured()}
            digestRetentionEnabled={
              process.env.DIGEST_AUDIT_RETENTION_ENABLED === '1'
            }
          />
        )}
        {/* Phase 9F — Rate-limit blocks per venue. Reads
            `/api/admin/security/abuse-events`. Public-route blocks
            (widget, CSP) are intentionally not shown here — they're
            in the `abuse_events` table with venue_id NULL and are
            inspectable via Supabase SQL editor. */}
        {isAdmin && <AbuseMonitorCard />}
        {/* Phase 9G — Enterprise SSO readiness. Connection list +
            owner-only draft creation; event feed for initiate /
            callback attempts. No real auth exchange happens yet —
            the vendor adapter is a placeholder that returns
            structured SSO_* error codes. The
            `autonomous_sending_still_disabled` flag stays mounted. */}
        {isAdmin && <SsoConnectionsCard />}
        {isAdmin && <SsoLoginEventsCard />}
        {/* Phase 9H — Backup posture + restore-intent audit.
            Read-only posture card surfaces RTO/RPO targets +
            per-check breakdown; owner-only intent card records
            the decision to investigate or perform a restore.
            Neither card triggers a real restore — that work
            happens via Supabase-approved runbooks per
            docs/DISASTER-RECOVERY.md. The
            `autonomous_sending_still_disabled` flag stays mounted. */}
        {isAdmin && <BackupPostureCard />}
        {isAdmin && <RestoreIntentCard />}
        {/* Phase 9I — Security evidence center. Consolidates the
            audit, RBAC, abuse, SSO, backup, and data lifecycle
            posture into one auditor-facing surface. Read-only;
            markdown + CSV exports audit (evidence_report_exported)
            so a security questionnaire response is traceable.
            Not a SOC 2 attestation — formal certification needs
            an auditor + observation period; see
            docs/SOC2-EVIDENCE-MAP.md. The
            `autonomous_sending_still_disabled` flag stays mounted. */}
        {isAdmin && <SecurityEvidenceCenter />}
        {/* Phase 9J — Enterprise sales readiness. Questionnaire
            generator, buyer summary, demo mode toggle, and
            readiness checklist. All cards explicitly state that
            outputs require operator review before sending and
            that demo mode is a visual marker (not anonymization).
            The `autonomous_sending_still_disabled` flag stays
            mounted. */}
        {isAdmin && <SecurityQuestionnaireCard />}
        {isAdmin && <BuyerSecuritySummaryCard />}
        {isAdmin && <DemoModeCard />}
        {/* GTM-0A — Revenue Recovery demo seed. Sister of
            DemoModeCard (visual banner); this one writes the rich
            seeded dataset. Admin-only via the route — surfaced
            here next to its sibling so operators find both demo
            controls in one place. */}
        {isAdmin && <RevenueRecoveryDemoCard />}
        {/* GTM-0A.2 — Revenue Recovery LOAD/Stress demo. Same gating
            as the hand-crafted demo above (admin-only via the
            route). Reset isolated by `demo_seed_type='load'` so the
            two demos never delete each other's rows. */}
        {isAdmin && <RevenueRecoveryLoadDemoCard />}
        {isAdmin && <EnterpriseReadinessCard />}
        {/* Phase 9K — Vendor risk + subprocessor disclosure. The
            VendorRiskCard surfaces the full admin registry
            (criticality, risk tier, assurance status,
            production-use). The SubprocessorDisclosureCard
            renders the buyer-safe filtered view that ships in a
            procurement response. DPA/SCC/SOC 2 status defaults to
            manual_review_required — we never claim "compliant".
            Markdown + CSV exports audit; JSON refreshes don't.
            The `autonomous_sending_still_disabled` flag stays
            mounted. */}
        {isAdmin && <VendorRiskCard />}
        {isAdmin && <SubprocessorDisclosureCard />}
        {/* Phase 9L — Incident response. Consolidates abuse,
            audit, SSO failure, backup posture, and vendor risk
            signals into first-class incident records. Detectors
            are conservative + operator-triggered; no autonomous
            remediation. Alert routing is env-gated
            (INCIDENT_ALERTS_ENABLED + Slack / PagerDuty webhook
            env vars) and degrades to `skipped_unconfigured` when
            absent. The `autonomous_sending_still_disabled` flag
            stays mounted. */}
        {isAdmin && <IncidentResponseCard />}
        {/* Phase 9M — Privacy + DSR readiness. PrivacyReadinessCard
            surfaces the static data inventory + retention policy +
            live DSR counts. DsrRequestsCard tracks Data Subject
            Requests with operator-only workflow: every export +
            deletion routes through legal review. Export preview is
            metadata-only; deletion review is non-destructive.
            We do NOT claim GDPR/CCPA compliance and we do NOT
            auto-fulfill DSRs. The
            `autonomous_sending_still_disabled` flag stays mounted. */}
        {isAdmin && <PrivacyReadinessCard />}
        {isAdmin && <DsrRequestsCard />}
        {/* Phase 9N — Trust Center foundation. Public buyer-facing
            page at /trust + gated bearer-token packets for active
            procurement reviews. TrustCenterCard previews + exports
            packet manifests; TrustAccessGrantsCard manages buyer
            grants with one-time-show URLs + revoke. Trust materials
            are NOT a SOC 2 certification — operator + legal review
            before sending. The `autonomous_sending_still_disabled`
            flag stays mounted. */}
        {isAdmin && <TrustCenterCard />}
        {isAdmin && <TrustAccessGrantsCard />}
        {/* Phase 9O — Compliance operations calendar. Tracks
            operator-initiated reviews against the static 17-row
            COMPLIANCE_REVIEW_POLICY: vendor risk / privacy / DR /
            backup / incident / trust center / questionnaire /
            evidence pack / SSO / coverage scanners / RBAC /
            headers / data lifecycle. Calendar does NOT prove
            continuous compliance — completion is operator-marked,
            waivers carry an explicit reason, freshness is a soft
            signal. The `autonomous_sending_still_disabled` flag
            stays mounted. */}
        {isAdmin && <ComplianceCalendarCard />}
        {/* Phase 9P — Contract commitments register. Operator-
            recorded customer-specific commitments + readiness
            snapshot with unsupported-risk flags. NOT legal advice
            and NOT contractual compliance proof. No autonomous
            contract parsing, no auto-promise generation. The
            `autonomous_sending_still_disabled` flag stays mounted. */}
        {isAdmin && <CommitmentsRegisterCard />}
        {isAdmin && <CommitmentsReadinessCard />}
        {/* Phase 8BE — Omnichannel channel connections.
            Operator-facing inventory of supported channels +
            posture (inbound/outbound/manual-required). No OAuth,
            no tokens — connection metadata only. Manual-required
            channels carry an explicit "Manual reply" pill. */}
        {isAdmin && <ChannelConnectionsCard />}
        {/* Phase 8AN — AI Draft Activity. Reads the last 25
            ai_actions rows where agent='venuerise' AND
            action='draft_regenerate' via the browser client (RLS-
            scoped). Surfaces instruction, variant count, accepted
            variant (via messages.metadata.ai_action_id join), latency.
            Admin-only; no new admin route required. */}
        {/* Phase 8AW — Brand Voice Calibration panel. Sits ABOVE the
            AIDraftAuditCard so the operator sees the trust signal
            before scrolling through individual rows. Shares the same
            realtime refresh event as the card below. */}
        {isAdmin && <BrandVoiceCalibrationPanel venueId={venue.venueId} />}
        {/* Phase 8BA — Autopilot Readiness Scorecard. Sits ABOVE
            the simulation panel so the operator sees the
            single-glance eligibility verdict before scrolling
            into the underlying ratios. Read-only — no toggle,
            no autonomy. The `autonomous_sending_still_disabled`
            health flag is still mounted. */}
        {isAdmin && <AutopilotReadinessScorecard venueId={venue.venueId} />}
        {/* Phase 8AY — Autopilot Simulation panel. Wider window
            (30 days) than the AIDraftAuditCard page slice; renders
            "would the AI have been safe to send?" plus the
            readiness signal. Observation only — no autonomous
            sending was added. */}
        {isAdmin && <AutopilotSimulationPanel venueId={venue.venueId} />}
        {/* Phase 8AZ — Autopilot Shadow Evaluation review queue.
            Lets operators label every place autopilot and the
            human disagreed. Labels are calibration evidence only;
            they don't enable autonomy or auto-tune guardrails. */}
        {isAdmin && <AutopilotReviewQueue venueId={venue.venueId} />}
        {isAdmin && <AIDraftAuditCard venueId={venue.venueId} />}
        {/* Phase 8AQ — Revenue OS thresholds. Powers
            RevenueLeakageBrief + Speed-to-Lead chip + leads-board
            ?leakage= filter. Admin-only; the route also enforces
            requireAdmin() so a non-admin who somehow lands here
            sees 401/403 on the network call. */}
        {isAdmin && <RevenueOsSettingsCard />}
        {/* Phase GTM-ILR — Instant Response training. Sibling of
            RevenueOsSettingsCard above; both write to the same
            venues.metadata.revenue_os block via the existing
            settings endpoint. Auto-send defaults OFF and the card
            explicitly says so. */}
        {isAdmin && <InstantResponseTrainingCard />}
        {/* Phase 8AR — owner-facing weekly Speed-to-Lead roll-up.
            Server-rendered, derived from existing leads + messages
            tables (no new storage); reads venue settings so the
            thresholds shown match what the operator set on the
            RevenueOsSettingsCard above. */}
        {isAdmin && <SpeedToLeadRollupCard venueId={venue.venueId} />}
        {/* Phase 8AS — owner-facing recovery pipeline counts.
            Companion to RecoveryQueueCard on /dashboard; shares the
            same helper so the metrics match across surfaces. */}
        {isAdmin && <RecoveryRollupCard venueId={venue.venueId} />}
        {/* Phase 8AT — Tour Booking conversion roll-up. Derived
            from leads + tours over the last 30 days; companion to
            the Overview TourConfirmationQueueCard. */}
        {isAdmin && <TourConversionRollupCard venueId={venue.venueId} />}
      </div>
      {/* Phase 8Z — realtime layer for digest send inserts. Toasts on
          every new outbound digest row + debounces router.refresh() by
          1000ms so a cron burst coalesces into a single page rebuild.
          Requires outbound_messages in supabase_realtime publication;
          see RUNBOOK "Digest audit feed not updating live". */}
      {isAdmin && <RealtimeDigestSendsLayer venueId={venue.venueId} />}
      {/* Phase 8O — realtime audit subscription. Admins/owners only — the
          layer's only side-effects are a toast + router.refresh(), which
          rebuilds the server-fetched events slice above and surfaces
          any newly-arrived audit rows without manual reload. */}
      {isAdmin && <RealtimeTourStatusLayer venueId={venue.venueId} />}
      {/* Phase 8AO — realtime layer for ai_actions inserts.
          Dispatches `venuerise:ai-draft-audit-fired` on a 1s
          trailing debounce; the AIDraftAuditCard listens and
          shows an inline "New draft activity recorded" notice.
          Requires `ai_actions` in the supabase_realtime
          publication — see RUNBOOK "AI draft audit not updating
          live". */}
      {isAdmin && <RealtimeAIDraftAuditLayer venueId={venue.venueId} />}
    </div>
  )
}
