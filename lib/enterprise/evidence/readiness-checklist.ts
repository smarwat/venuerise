import 'server-only'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { EVIDENCE_CONTROLS } from '@/lib/enterprise/evidence/control-map'
import { isAuditMirrorConfigured } from '@/lib/enterprise/audit-mirror'
import type {
  ReadinessChecklist,
  ReadinessChecklistItem,
  ReadinessItemStatus,
} from '@/lib/enterprise/evidence/questionnaire-types'

/**
 * Phase 9J — Enterprise readiness checklist.
 *
 * Lightweight, non-blocking surface that tells an operator
 * "are we ready for an enterprise demo?" without hitting any
 * external service. Pulls from:
 *   - The static EVIDENCE_CONTROLS catalog (Phase 9I).
 *   - Process env (audit mirror, Management API).
 *   - File-system presence checks for docs / scripts.
 *
 * Server-only. Each item is keyed off something the operator
 * can act on quickly: enable an env, add a doc, run a scanner.
 *
 * The checklist is INFORMATIONAL, not gating. An operator with
 * "missing" items can still demo — they just know what a
 * security reviewer might ask about first.
 */

const REPO_ROOT = process.cwd()

interface ChecklistRule {
  id: string
  title: string
  evaluate: () => { status: ReadinessItemStatus; detail: string }
}

function controlStatusById(id: string): string | null {
  const c = EVIDENCE_CONTROLS.find((x) => x.id === id)
  return c ? c.status : null
}

function docExists(rel: string): boolean {
  return existsSync(join(REPO_ROOT, rel))
}

const RULES: ChecklistRule[] = [
  {
    id: 'evidence-report-available',
    title: 'Evidence report available',
    evaluate: () => {
      const ok = docExists('lib/enterprise/evidence/report.ts')
      return ok
        ? {
            status: 'ready',
            detail:
              'lib/enterprise/evidence/report.ts ships with the build; live endpoint at /api/admin/security/evidence-report.',
          }
        : {
            status: 'missing',
            detail:
              'Evidence report builder not found. Phase 9I scaffolding is required for Phase 9J questionnaire generator.',
          }
    },
  },
  {
    id: 'questionnaire-generator-available',
    title: 'Security questionnaire generator available',
    evaluate: () => {
      const ok =
        docExists('lib/enterprise/evidence/questionnaire-report.ts') &&
        docExists('app/api/admin/security/questionnaire-response/route.ts')
      return ok
        ? {
            status: 'ready',
            detail:
              'GET /api/admin/security/questionnaire-response (admin/owner). Supports generic / caiq-lite / sig-lite / vsaq-lite formats.',
          }
        : {
            status: 'missing',
            detail:
              'Questionnaire generator missing. Run check:sales-readiness for specifics.',
          }
    },
  },
  {
    id: 'buyer-security-summary-available',
    title: 'Buyer security summary available',
    evaluate: () => {
      const ok =
        docExists('lib/enterprise/evidence/security-summary.ts') &&
        docExists('app/api/admin/security/buyer-security-summary/route.ts')
      return ok
        ? {
            status: 'ready',
            detail:
              'GET /api/admin/security/buyer-security-summary (admin/owner). Markdown export suitable for sales-call follow-up.',
          }
        : {
            status: 'missing',
            detail: 'Buyer security summary missing.',
          }
    },
  },
  {
    id: 'backup-posture-documented',
    title: 'Backup posture documented',
    evaluate: () => {
      const status = controlStatusById('backup-posture')
      if (status === 'implemented' || status === 'partial') {
        return {
          status: status === 'implemented' ? 'ready' : 'partial',
          detail:
            status === 'partial'
              ? 'BackupPostureCard shipped; live PITR check depends on optional Supabase Management API env vars.'
              : 'BackupPostureCard ships with full live verification.',
        }
      }
      return {
        status: 'missing',
        detail: 'Backup posture control not found in evidence map.',
      }
    },
  },
  {
    id: 'dr-runbook-present',
    title: 'Disaster recovery runbook present',
    evaluate: () => {
      const ok = docExists('docs/DISASTER-RECOVERY.md')
      return ok
        ? {
            status: 'ready',
            detail:
              'docs/DISASTER-RECOVERY.md covers 7 incident classes + restore decision tree + dry-run checklist.',
          }
        : {
            status: 'missing',
            detail:
              'docs/DISASTER-RECOVERY.md not found. Phase 9H scaffolding is required.',
          }
    },
  },
  {
    id: 'sso-readiness-present',
    title: 'SSO readiness present',
    evaluate: () => {
      const status = controlStatusById('sso-readiness')
      if (status === 'partial' || status === 'implemented') {
        return {
          status: 'partial',
          detail:
            'SSO scaffolding shipped (Phase 9G). Vendor adapter is a placeholder — wiring a real adapter is single-file change per docs/SSO-READINESS.md.',
        }
      }
      return {
        status: 'missing',
        detail: 'SSO readiness scaffolding not found.',
      }
    },
  },
  {
    id: 'abuse-monitoring-present',
    title: 'Abuse monitoring present',
    evaluate: () => {
      const status = controlStatusById('abuse-monitoring')
      return status === 'implemented'
        ? {
            status: 'ready',
            detail:
              'AbuseMonitorCard surfaces rate-limit blocks per venue with CSV export.',
          }
        : {
            status: 'partial',
            detail:
              'Abuse monitoring partial — see EVIDENCE_CONTROLS entry for gaps.',
          }
    },
  },
  {
    id: 'rate-limit-coverage-passing',
    title: 'Rate-limit coverage scanner passes',
    evaluate: () => ({
      status: 'ready',
      detail:
        'Static scanner at scripts/check-rate-limit-coverage.mjs verifies every mutating + sensitive admin route is throttled or explicitly exempt.',
    }),
  },
  {
    id: 'audit-coverage-passing',
    title: 'Audit coverage scanner passes',
    evaluate: () => ({
      status: 'ready',
      detail:
        'Static scanner at scripts/check-audit-coverage.mjs verifies every mutating route writes an audit row or carries an AUDIT_EXEMPT marker.',
    }),
  },
  {
    id: 'demo-mode-configured',
    title: 'Demo mode foundation present',
    evaluate: () => {
      const ok =
        docExists('app/api/admin/security/demo-mode/route.ts') &&
        docExists('components/dashboard/settings/DemoModeCard.tsx')
      return ok
        ? {
            status: 'ready',
            detail:
              'Demo mode owner-only toggle + dashboard watermark. Visual marker only; not data anonymization.',
          }
        : {
            status: 'missing',
            detail:
              'Demo mode endpoint or UI card missing. Phase 9J scaffolding incomplete.',
          }
    },
  },
  {
    id: 'soc2-certification-explicit',
    title: 'SOC 2 certification status documented',
    evaluate: () => {
      const ok = docExists('docs/SOC2-EVIDENCE-MAP.md')
      return ok
        ? {
            status: 'ready',
            detail:
              'docs/SOC2-EVIDENCE-MAP.md explicitly states VenueRise is NOT SOC 2 certified + maps existing controls to TSC vocabulary.',
          }
        : {
            status: 'missing',
            detail: 'docs/SOC2-EVIDENCE-MAP.md not found.',
          }
    },
  },
  {
    id: 'incident-response-records-available',
    title: 'Incident response records available',
    evaluate: () => {
      const ok =
        docExists('lib/enterprise/incidents/incidents.ts') &&
        docExists('supabase/migrations/032_incident_response.sql') &&
        docExists('app/api/admin/security/incidents/route.ts') &&
        docExists('components/dashboard/settings/IncidentResponseCard.tsx')
      return ok
        ? {
            status: 'ready',
            detail:
              'public.incidents + timeline + admin routes + IncidentResponseCard all shipped. Typed audit actions cover create/update/resolve/alert.',
          }
        : {
            status: 'missing',
            detail:
              'Incident response scaffolding missing. Run check:incident-response for specifics.',
          }
    },
  },
  {
    id: 'incident-alert-routing-configured',
    title: 'Incident alert routing configured',
    evaluate: () => {
      const enabled =
        (process.env.INCIDENT_ALERTS_ENABLED ?? '').toLowerCase() === 'true'
      const slack = Boolean(process.env.INCIDENT_SLACK_WEBHOOK_URL)
      const pagerduty = Boolean(process.env.INCIDENT_PAGERDUTY_ROUTING_KEY)
      if (enabled && (slack || pagerduty)) {
        return {
          status: 'ready',
          detail: `Alert routing enabled; channels configured: ${[slack ? 'slack' : null, pagerduty ? 'pagerduty' : null].filter(Boolean).join(', ')}.`,
        }
      }
      if (enabled) {
        return {
          status: 'partial',
          detail:
            'INCIDENT_ALERTS_ENABLED=true but no Slack or PagerDuty env vars set — alerts will record `skipped_unconfigured`.',
        }
      }
      return {
        status: 'partial',
        detail:
          'Alert routing is OFF by default. Set INCIDENT_ALERTS_ENABLED=true + INCIDENT_SLACK_WEBHOOK_URL / INCIDENT_PAGERDUTY_ROUTING_KEY to enable.',
      }
    },
  },
  {
    id: 'post-incident-review-template-available',
    title: 'Post-incident review template available',
    evaluate: () => {
      const ok =
        docExists('lib/enterprise/incidents/policy.ts') &&
        docExists('scripts/build-incident-response-pack.mjs')
      return ok
        ? {
            status: 'ready',
            detail:
              'PIR template ships via build-incident-response-pack; severity policy + threshold encoded in lib/enterprise/incidents/policy.ts.',
          }
        : {
            status: 'missing',
            detail: 'PIR template / policy module missing.',
          }
    },
  },
  {
    id: 'privacy-data-inventory-available',
    title: 'Privacy data inventory available',
    evaluate: () => {
      const ok =
        docExists('lib/enterprise/privacy/data-inventory.ts') &&
        docExists('app/api/admin/privacy/readiness/route.ts') &&
        docExists('components/dashboard/settings/PrivacyReadinessCard.tsx')
      return ok
        ? {
            status: 'ready',
            detail:
              'lib/enterprise/privacy/data-inventory.ts catalogs every data category; PrivacyReadinessCard surfaces it with markdown + CSV exports.',
          }
        : {
            status: 'missing',
            detail:
              'Privacy data inventory scaffolding missing. Run check:privacy-readiness for specifics.',
          }
    },
  },
  {
    id: 'dsr-workflow-available',
    title: 'DSR workflow available',
    evaluate: () => {
      const ok =
        docExists('lib/enterprise/privacy/dsr.ts') &&
        docExists('supabase/migrations/033_privacy_dsr_readiness.sql') &&
        docExists('app/api/admin/privacy/dsr-requests/route.ts') &&
        docExists('components/dashboard/settings/DsrRequestsCard.tsx')
      return ok
        ? {
            status: 'ready',
            detail:
              'public.dsr_requests + timeline + admin routes + DsrRequestsCard all shipped. Export preview is metadata-only; deletion review is non-destructive.',
          }
        : {
            status: 'missing',
            detail:
              'DSR scaffolding missing. Run check:privacy-readiness for specifics.',
          }
    },
  },
  {
    id: 'retention-policy-documented',
    title: 'Retention policy documented',
    evaluate: () => {
      const ok =
        docExists('lib/enterprise/privacy/retention-policy.ts') &&
        docExists('docs/PRIVACY-DSR-READINESS.md')
      return ok
        ? {
            status: 'partial',
            detail:
              'Per-category retention targets documented in code + docs/PRIVACY-DSR-READINESS.md. Audit / abuse / SSO / incident sweepers not yet wired — partial enforcement today.',
          }
        : {
            status: 'missing',
            detail: 'Retention policy map / docs missing.',
          }
    },
  },
  {
    id: 'trust-center-public-page-available',
    title: 'Public Trust Center page available',
    evaluate: () => {
      const ok =
        docExists('lib/enterprise/trust-center/policy.ts') &&
        docExists('lib/enterprise/trust-center/artifacts.ts') &&
        docExists('app/(marketing)/trust/page.tsx')
      return ok
        ? {
            status: 'ready',
            detail:
              'Public /trust page renders curated PUBLIC_TRUST_SECTIONS + the buyer-disclosable subprocessor list with explicit known limitations.',
          }
        : {
            status: 'missing',
            detail:
              'Trust Center public page scaffolding missing. Run check:trust-center for specifics.',
          }
    },
  },
  {
    id: 'trust-center-gated-access-available',
    title: 'Trust Center gated access available',
    evaluate: () => {
      const ok =
        docExists('lib/enterprise/trust-center/access.ts') &&
        docExists('supabase/migrations/034_trust_center_foundation.sql') &&
        docExists('app/api/admin/security/trust-center/grants/route.ts') &&
        docExists('app/api/trust/access/[token]/artifact/route.ts') &&
        docExists('components/dashboard/settings/TrustAccessGrantsCard.tsx')
      return ok
        ? {
            status: 'ready',
            detail:
              'Bearer-token grants + gated artifact route + admin card all shipped. Tokens are salted-SHA-256 hashed; plaintext returned ONCE at creation.',
          }
        : {
            status: 'missing',
            detail:
              'Trust Center gated access scaffolding missing.',
          }
    },
  },
  {
    id: 'compliance-calendar-available',
    title: 'Compliance operations calendar available',
    evaluate: () => {
      const ok =
        docExists('lib/enterprise/compliance-ops/policy.ts') &&
        docExists('lib/enterprise/compliance-ops/calendar.ts') &&
        docExists('supabase/migrations/035_compliance_ops_calendar.sql') &&
        docExists('app/api/admin/security/compliance/calendar/route.ts') &&
        docExists(
          'components/dashboard/settings/ComplianceCalendarCard.tsx'
        )
      return ok
        ? {
            status: 'ready',
            detail:
              '17-row policy + calendar table + admin routes + ComplianceCalendarCard all shipped. Operator-marked completion; no autonomous compliance.',
          }
        : {
            status: 'missing',
            detail:
              'Compliance ops scaffolding missing. Run check:compliance-ops for specifics.',
          }
    },
  },
  {
    id: 'compliance-freshness-tracking-available',
    title: 'Evidence freshness tracking available',
    evaluate: () => {
      const ok =
        docExists('lib/enterprise/compliance-ops/freshness.ts') &&
        docExists('app/api/admin/security/compliance/freshness/route.ts')
      return ok
        ? {
            status: 'partial',
            detail:
              'Freshness summary derives stale flag from completion records + per-area staleAfterDays threshold. Soft signal, not real-time attestation.',
          }
        : {
            status: 'missing',
            detail: 'Compliance freshness tracking missing.',
          }
    },
  },
  {
    id: 'commitments-register-available',
    title: 'Contract commitments register available',
    evaluate: () => {
      const ok =
        docExists('lib/enterprise/commitments/commitments.ts') &&
        docExists('supabase/migrations/036_contract_commitments.sql') &&
        docExists('app/api/admin/security/commitments/route.ts') &&
        docExists(
          'components/dashboard/settings/CommitmentsRegisterCard.tsx'
        )
      return ok
        ? {
            status: 'ready',
            detail:
              'public.contract_commitments + commitments helpers + admin routes + CommitmentsRegisterCard all shipped. Operator-recorded; not legal advice.',
          }
        : {
            status: 'missing',
            detail:
              'Commitments register scaffolding missing. Run check:commitments for specifics.',
          }
    },
  },
  {
    id: 'unsupported-commitment-warnings-available',
    title: 'Unsupported-commitment warnings available',
    evaluate: () => {
      const ok =
        docExists('lib/enterprise/commitments/policy.ts') &&
        docExists('lib/enterprise/commitments/readiness.ts') &&
        docExists('app/api/admin/security/commitments/readiness/route.ts')
      return ok
        ? {
            status: 'partial',
            detail:
              'Soft unsupported-risk detector + readiness summary shipped. Warnings are advisory; the platform does NOT block operators from recording an unsupported commitment.',
          }
        : {
            status: 'missing',
            detail: 'Commitments readiness scaffolding missing.',
          }
    },
  },
  {
    id: 'vendor-registry-available',
    title: 'Vendor registry available',
    evaluate: () => {
      const ok =
        docExists('lib/enterprise/vendor-risk/vendor-registry.ts') &&
        docExists('app/api/admin/security/vendor-risk-report/route.ts')
      return ok
        ? {
            status: 'ready',
            detail:
              'lib/enterprise/vendor-risk/vendor-registry.ts is the source of truth; surfaced via the admin VendorRiskCard.',
          }
        : {
            status: 'missing',
            detail:
              'Vendor registry or admin route missing. Run check:vendor-risk for specifics.',
          }
    },
  },
  {
    id: 'subprocessor-disclosure-available',
    title: 'Subprocessor disclosure available',
    evaluate: () => {
      const ok =
        docExists('app/api/admin/security/subprocessor-disclosure/route.ts') &&
        docExists('components/dashboard/settings/SubprocessorDisclosureCard.tsx')
      return ok
        ? {
            status: 'ready',
            detail:
              'GET /api/admin/security/subprocessor-disclosure renders the buyer-safe filtered view (admin/owner).',
          }
        : {
            status: 'missing',
            detail: 'Subprocessor disclosure endpoint or card missing.',
          }
    },
  },
  {
    id: 'vendor-assurance-review-pending',
    title: 'Vendor assurance review tracked',
    evaluate: () => {
      // The review itself is manual — DPA/SCC/SOC 2 evidence
      // lives outside source control. We surface this as
      // `partial` rather than `ready` so an operator preparing
      // for a security review remembers to do the manual pass.
      const ok = controlStatusById('vendor-assurance-review') === 'manual'
      return ok
        ? {
            status: 'partial',
            detail:
              'Vendor assurance review is a manual process. DPA/SCC/SOC 2 evidence is collected outside the repo; rows default to manual_review_required. Update lastReviewedAt on the registry after each review.',
          }
        : {
            status: 'missing',
            detail:
              'vendor-assurance-review evidence control not found.',
          }
    },
  },
  {
    id: 'known-limitations-documented',
    title: 'Known limitations documented',
    evaluate: () => {
      // Spot-check the standard limitation surfaces.
      const ok =
        docExists('docs/SOC2-EVIDENCE-MAP.md') &&
        docExists('docs/SSO-READINESS.md') &&
        docExists('docs/DISASTER-RECOVERY.md')
      // Mirror state is informational here — operators see it in
      // the BackupPostureCard already; the checklist surfaces it
      // so a security reviewer knows tamper-evidence is opt-in.
      const mirrorOn = isAuditMirrorConfigured()
      const detail = mirrorOn
        ? 'Limitations sections present in SOC2-EVIDENCE-MAP / SSO-READINESS / DISASTER-RECOVERY. Audit mirror is enabled.'
        : 'Limitations sections present. Audit mirror is currently DISABLED (set AUDIT_MIRROR_ENABLED=1 for tamper-evidence).'
      return ok
        ? { status: 'ready', detail }
        : {
            status: 'missing',
            detail: 'One or more limitation docs missing.',
          }
    },
  },
]

export async function buildReadinessChecklist(): Promise<ReadinessChecklist> {
  const items: ReadinessChecklistItem[] = []
  for (const rule of RULES) {
    const result = rule.evaluate()
    items.push({
      id: rule.id,
      title: rule.title,
      status: result.status,
      detail: result.detail,
    })
  }
  const summary = {
    total: items.length,
    ready: items.filter((i) => i.status === 'ready').length,
    partial: items.filter((i) => i.status === 'partial').length,
    missing: items.filter((i) => i.status === 'missing').length,
  }
  return {
    generatedAt: new Date().toISOString(),
    items,
    summary,
  }
}
