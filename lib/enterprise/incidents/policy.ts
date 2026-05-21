import type {
  AlertRoute,
  IncidentSeverity,
} from '@/lib/enterprise/incidents/types'

/**
 * Phase 9L — Incident response policy.
 *
 * The numbers below are TARGETS, not contractual SLAs. They
 * describe the operator's intent and are surfaced in the
 * IncidentResponseCard + the static runbook so a reviewer can
 * see what "good" looks like.
 *
 * Honesty disclaimer carried in the runbook + readiness
 * checklist:
 *
 *   > These targets describe the operator's intended response.
 *   > VenueRise does NOT currently staff a 24/7 on-call rotation
 *   > and does NOT offer an uptime SLA contract. Targets are
 *   > best-effort.
 *
 * Adjusting any of the constants here is a deliberate policy
 * change. Update `docs/INCIDENT-RESPONSE.md` in the same PR so
 * the buyer-facing artifacts stay in sync.
 */

export interface SeverityPolicy {
  severity: IncidentSeverity
  label: string
  /** Plain-language definition the operator uses to triage. */
  definition: string
  /** Target first-response time (operator engaged + triage started). */
  targetFirstResponseMinutes: number
  /** Target update cadence while incident is open. */
  targetUpdateCadenceMinutes: number
  /** Target time-to-mitigation. */
  targetMitigationMinutes: number
  /** Whether a post-incident review is required. */
  postIncidentReviewRequired: boolean
  /** Customer notification posture default. Always legal review-gated. */
  customerNotification:
    | 'required_legal_review'
    | 'recommended_legal_review'
    | 'operator_discretion'
    | 'not_required'
  /** Escalation guidance — who to engage. */
  escalation: string
  examples: string[]
}

export const SEVERITY_POLICY: ReadonlyArray<SeverityPolicy> = [
  {
    severity: 'sev1',
    label: 'SEV1 — Critical',
    definition:
      'Confirmed customer data breach, full platform outage, irreversible data loss, or active account takeover with operator confirmation.',
    targetFirstResponseMinutes: 15,
    targetUpdateCadenceMinutes: 60,
    targetMitigationMinutes: 240,
    postIncidentReviewRequired: true,
    customerNotification: 'required_legal_review',
    escalation:
      'Owner + platform on-call. Legal review for any customer notification BEFORE sending. No public statements without operator sign-off.',
    examples: [
      'Confirmed unauthorized access to customer data.',
      'Platform unavailable for >30 minutes affecting all venues.',
      'Backup posture has failed with no recoverable snapshot.',
    ],
  },
  {
    severity: 'sev2',
    label: 'SEV2 — Major',
    definition:
      'Major tenant impact, suspected unauthorized access pending confirmation, backup posture in critical state, or widespread degradation.',
    targetFirstResponseMinutes: 60,
    targetUpdateCadenceMinutes: 240,
    targetMitigationMinutes: 1440,
    postIncidentReviewRequired: true,
    customerNotification: 'recommended_legal_review',
    escalation:
      'Owner + platform team. Engage legal if customer-facing notification likely. Update prospects in active procurement reviews if affected.',
    examples: [
      'Repeated SSO failures from a known buyer domain over a multi-hour window.',
      'Rate-limit storm affecting widget intake for a high-traffic venue.',
      'Backup posture check returning `critical` with operator-verifiable evidence.',
    ],
  },
  {
    severity: 'sev3',
    label: 'SEV3 — Minor',
    definition:
      'Suspicious pattern, repeated SSO failures within a single tenant, abuse spike, vendor security concern, or single-tenant impact.',
    targetFirstResponseMinutes: 240,
    targetUpdateCadenceMinutes: 1440,
    targetMitigationMinutes: 4320,
    postIncidentReviewRequired: false,
    customerNotification: 'operator_discretion',
    escalation:
      'Venue owner + platform team during business hours. Document in the timeline and resolve within the target window.',
    examples: [
      'Single-venue abuse spike attributed to a misconfigured embed.',
      'Vendor security advisory affecting a non-critical subprocessor.',
      'CSP report cluster indicating a third-party script issue.',
    ],
  },
  {
    severity: 'sev4',
    label: 'SEV4 — Informational',
    definition:
      'Informational or manual-review item that the operator wants tracked. No customer impact expected.',
    targetFirstResponseMinutes: 1440,
    targetUpdateCadenceMinutes: 10080,
    targetMitigationMinutes: 10080,
    postIncidentReviewRequired: false,
    customerNotification: 'not_required',
    escalation:
      'Owner discretion. Track in the IncidentResponseCard so the audit trail exists.',
    examples: [
      'Scheduled vendor review noted as an incident for traceability.',
      'Tabletop exercise outcomes captured for the runbook.',
    ],
  },
]

/** Severities at or above this threshold REQUIRE a post-incident review. */
export const POSTMORTEM_REQUIRED_AT_OR_ABOVE: IncidentSeverity = 'sev2'

/**
 * Lookup helper. Returns the policy row for a severity; throws
 * only when given a value outside the typed union (callers
 * should never do that — typed throughout).
 */
export function severityPolicy(s: IncidentSeverity): SeverityPolicy {
  const row = SEVERITY_POLICY.find((r) => r.severity === s)
  if (!row) {
    throw new Error(`unknown_severity:${String(s)}`)
  }
  return row
}

/**
 * Ordinal comparison helper. SEV1 < SEV2 numerically but is
 * MORE severe. We expose a single helper so callers don't have
 * to remember the inversion.
 *
 * Returns:
 *   - negative when `a` is MORE severe than `b`
 *   - 0 when equal
 *   - positive when `a` is LESS severe than `b`
 */
export function compareSeverity(
  a: IncidentSeverity,
  b: IncidentSeverity
): number {
  const order: Record<IncidentSeverity, number> = {
    sev1: 0,
    sev2: 1,
    sev3: 2,
    sev4: 3,
  }
  return order[a] - order[b]
}

/** True when `a` is AT LEAST as severe as `b` (lower ordinal). */
export function severityAtLeast(
  a: IncidentSeverity,
  b: IncidentSeverity
): boolean {
  return compareSeverity(a, b) <= 0
}

// ── Detector defaults ────────────────────────────────────────────────────

export interface DetectorDefaults {
  /** Observation window in minutes. */
  windowMinutes: number
  /** Minimum count of source rows to consider a candidate. */
  minRows: number
  /** Suggested severity when the threshold is crossed. */
  suggestedSeverity: IncidentSeverity
}

export const DETECTOR_DEFAULTS = {
  abuseSpike: {
    windowMinutes: 60,
    minRows: 25,
    suggestedSeverity: 'sev3' as IncidentSeverity,
  },
  ssoFailureSpike: {
    windowMinutes: 60,
    minRows: 10,
    suggestedSeverity: 'sev3' as IncidentSeverity,
  },
  backupPosture: {
    // Posture-based — count is irrelevant; threshold is "status
    // is degraded/critical".
    windowMinutes: 1440,
    minRows: 1,
    suggestedSeverity: 'sev2' as IncidentSeverity,
  },
  healthCheck: {
    windowMinutes: 60,
    minRows: 1,
    suggestedSeverity: 'sev2' as IncidentSeverity,
  },
} as const

// ── Alert routes ─────────────────────────────────────────────────────────

/**
 * The default alert routing matrix. The actual delivery is
 * env-gated; routes here describe INTENT.
 *
 * - Slack receives every severity (informational ↑ critical).
 *   Operators tune the channel to the noise floor they want.
 * - PagerDuty is reserved for SEV1 + SEV2 by default. SEV3/4
 *   would page on-call unnecessarily if routed automatically.
 * - Sentry receives every severity as a breadcrumb / capture
 *   for cross-correlation, again env-gated.
 *
 * Operators can edit this constant; the alert-routing helper
 * iterates these rows and only attempts delivery when the
 * matching env var is set.
 */
export const DEFAULT_ALERT_ROUTES: ReadonlyArray<AlertRoute> = [
  {
    channel: 'slack',
    targetLabel: '#incident-alerts',
    minSeverity: 'sev3',
  },
  {
    channel: 'pagerduty',
    targetLabel: 'venuerise-platform',
    minSeverity: 'sev2',
  },
  {
    channel: 'sentry',
    targetLabel: 'venuerise (issues)',
    minSeverity: 'sev3',
  },
]

/**
 * The honesty paragraph carried inside the runbook + the
 * incident response evidence control. Identical string so
 * downstream consumers can grep for it.
 */
export const INCIDENT_RESPONSE_DISCLAIMER =
  'These targets describe VenueRise\'s intended incident response. VenueRise does NOT currently staff a 24/7 on-call rotation and does NOT offer an uptime SLA contract. Detectors are conservative + operator-triggered; no autonomous remediation occurs. Customer notification for any security event requires legal/operator review before sending.'
