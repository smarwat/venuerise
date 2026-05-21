import type {
  CommitmentArea,
  CommitmentRecord,
  CommitmentRiskLevel,
  UnsupportedRiskFlag,
} from '@/lib/enterprise/commitments/types'

/**
 * Phase 9P — Commitments policy + unsupported-risk detection.
 *
 * Single source of truth for:
 *   - The standard operator-facing disclaimer.
 *   - The list of capability areas that are currently
 *     partial / readiness-only / not supported, so that a
 *     commitment recorded against them surfaces a warning.
 *
 * Updating any of these constants is a deliberate policy
 * change. Update `docs/CONTRACT-COMMITMENTS.md` in the same
 * PR.
 */

export const COMMITMENTS_DISCLAIMER =
  'This register tracks operator-recorded commitments. It is not legal advice and does not prove contractual compliance. Commitments are operator-recorded and operator-reviewed; the platform does NOT autonomously parse contracts and does NOT auto-create commitments from uploaded documents.'

/**
 * Per-area capability posture today. Areas marked
 * `not_supported` / `partial` will surface as
 * UnsupportedRiskFlag entries when a commitment is recorded
 * against them.
 *
 * Areas not present here are treated as `supported` — no flag.
 */
export type AreaSupportStatus = 'supported' | 'partial' | 'not_supported'

export interface AreaSupportRow {
  area: CommitmentArea
  status: AreaSupportStatus
  reason: string
}

export const COMMITMENT_AREA_SUPPORT: ReadonlyArray<AreaSupportRow> = [
  {
    area: 'sso',
    status: 'partial',
    reason:
      'SSO is in readiness mode. The vendor adapter is a placeholder today; real SAML/OIDC exchange is wired per buyer requirement. Do NOT commit to live SAML/OIDC without confirming the adapter has been activated.',
  },
  {
    area: 'scim',
    status: 'not_supported',
    reason:
      'SCIM provisioning is NOT live in any environment today. Commitments referencing SCIM should remain `at_risk` until the SCIM endpoint is shipped behind the existing SSO connection row.',
  },
  {
    area: 'availability',
    status: 'partial',
    reason:
      'VenueRise does NOT staff a 24/7 on-call rotation and does NOT offer an uptime SLA contract. Internal RTO 4h / RPO 24h are best-effort targets, not contractual commitments.',
  },
  {
    area: 'incident_response',
    status: 'partial',
    reason:
      'Incident alert routing is env-gated and OFF by default. Customer notification requires legal/operator review — there is no automated breach notification flow. Do NOT commit to a fixed-time notification SLA without legal sign-off.',
  },
  {
    area: 'privacy',
    status: 'partial',
    reason:
      'DSR fulfillment is operator + legal reviewed, not automated. Export preview is metadata-only; deletion review is non-destructive. Do NOT commit to a guaranteed DSR fulfillment window without confirming operator capacity.',
  },
  {
    area: 'data_retention',
    status: 'partial',
    reason:
      'Audit / abuse / SSO / incident log retention sweepers are not yet wired; those tables currently accumulate. Commitments to specific retention windows for those categories require operator follow-through.',
  },
  {
    area: 'ai_use',
    status: 'partial',
    reason:
      'AI inference happens at Anthropic. Their contractual posture on training-use / zero-retention is governed by the active Anthropic plan and requires legal verification. Do NOT commit to "no vendor training" without confirmed contract terms.',
  },
  {
    area: 'subprocessor',
    status: 'partial',
    reason:
      'Subprocessor list changes propagate via the operator-recorded vendor registry. There is no automated subprocessor-change notification cron. Commitments to a fixed notice period require operator follow-through.',
  },
  {
    area: 'data_residency',
    status: 'partial',
    reason:
      'Customer data lives in the configured Supabase region (US by default). EU-resident customers can be provisioned on a Supabase EU project on request. Commitments to a specific region need to match the active Supabase project for the venue.',
  },
]

/**
 * Areas where a `critical` risk recorded commitment should
 * carry an additional unsupported flag even if the support
 * status above is `supported` — e.g. a critical-risk
 * `security` commitment deserves a soft prompt to confirm
 * operator review.
 */
export const CRITICAL_REVIEW_AREAS: ReadonlyArray<CommitmentArea> = [
  'security',
  'privacy',
  'incident_response',
  'backup_dr',
]

/**
 * Overclaim trap patterns. These regexes scan the
 * operator-entered title + description for marketing phrases
 * we explicitly do NOT support today, regardless of the
 * area enum the operator picked.
 *
 * Rationale: an operator can record a commitment titled
 * "We are SOC 2 Type 2 certified" under area=`security`
 * with risk=`low`. The area-based detector above will not
 * flag it because `security` is `supported` in
 * COMMITMENT_AREA_SUPPORT. The overclaim trap catches the
 * factual misstatement so the operator is reminded to
 * either restate the commitment or move it to `withdrawn`.
 *
 * Each pattern is intentionally narrow (anchored on a noun +
 * a strong verb / qualifier) to avoid flagging benign
 * mentions like "we are working towards SOC 2 readiness".
 */
export interface OverclaimPattern {
  /** Stable id surfaced into UnsupportedRiskFlag.reason metadata. */
  id: string
  /** Case-insensitive regex tested against `${title}\n${description}`. */
  pattern: RegExp
  /** Human-readable reason rendered in the flag. */
  reason: string
}

export const OVERCLAIM_PATTERNS: ReadonlyArray<OverclaimPattern> = [
  {
    id: 'soc2-certification',
    pattern:
      /\bSOC\s*2\b[^.]{0,80}\b(certified|certification|attested|attestation|compliant|compliance|report\s+ready|Type\s*(?:I|II|1|2))\b/i,
    reason:
      'VenueRise is NOT SOC 2 certified or attested. Do not commit to SOC 2 certification, Type I/II reports, or "SOC 2 compliant" language. Restate the commitment in terms of operator-recorded controls + evidence map.',
  },
  {
    id: 'iso27001-certification',
    pattern: /\bISO[\s-]?27001\b/i,
    reason:
      'VenueRise is NOT ISO 27001 certified. Do not commit to ISO 27001 certification.',
  },
  {
    id: 'hipaa-compliance',
    pattern: /\bHIPAA\b[^.]{0,40}\b(compliant|compliance|ready|certified)\b/i,
    reason:
      'VenueRise does NOT claim HIPAA compliance. Do not commit to HIPAA compliance without a signed BAA + legal review.',
  },
  {
    id: 'pci-dss-compliance',
    pattern:
      /\bPCI[\s-]?DSS\b[^.]{0,40}\b(compliant|compliance|certified|attested)\b/i,
    reason:
      'VenueRise does NOT process or store cardholder data. PCI DSS compliance claims are not in scope.',
  },
  {
    id: 'gdpr-compliance',
    pattern:
      /\bGDPR\b[^.]{0,40}\b(compliant|compliance|certified|fully)\b/i,
    reason:
      'GDPR compliance is operator + legal asserted, not platform-attested. Do not claim "GDPR compliant" without legal sign-off. The DSR workflow is operator-reviewed, not automated.',
  },
  {
    id: 'ccpa-compliance',
    pattern:
      /\bCCPA\b[^.]{0,40}\b(compliant|compliance|certified|fully)\b/i,
    reason:
      'CCPA compliance is operator + legal asserted, not platform-attested. Do not claim "CCPA compliant" without legal sign-off.',
  },
  {
    id: 'continuous-compliance',
    pattern:
      /\b(continuous|real[-\s]?time)\b[^.]{0,30}\b(compliance|monitoring|attestation|control\s+verification)\b/i,
    reason:
      'VenueRise does NOT provide continuous compliance monitoring or real-time control attestation. Phase 9O calendar tracks operator-recorded reviews on cadence, not live controls.',
  },
  {
    id: 'sso-live',
    pattern:
      /\b(real|live|production|enterprise)\b[^.]{0,40}\b(SAML|OIDC|SSO)\b/i,
    reason:
      'Real/live SAML/OIDC is NOT enabled by default. The SSO adapter is a placeholder until provisioned per buyer. Do not commit to live SSO without confirming the adapter is active.',
  },
  {
    id: 'scim-live',
    pattern:
      /\b(SCIM)\b[^.]{0,40}\b(live|enabled|production|provisioning|supported|ready)\b/i,
    reason:
      'SCIM provisioning is NOT live in any environment today. Do not commit to SCIM availability.',
  },
  {
    id: 'twenty-four-seven-support',
    pattern:
      /\b(24\s*[\/x×]\s*7|24\s*[\/x×]\s*365|twenty[-\s]four[-\s]seven|around[-\s]the[-\s]clock)\b[^.]{0,40}\b(support|monitoring|on[-\s]call|response|rotation|coverage)\b/i,
    reason:
      'VenueRise does NOT staff a 24/7 on-call rotation. Support coverage and monitoring are best-effort during business hours.',
  },
  {
    id: 'uptime-sla',
    pattern:
      /\b(99\.9{1,3}\s*%|99\s*%\s+uptime|four\s+nines|five\s+nines|zero\s+downtime|guaranteed\s+(uptime|availability))\b/i,
    reason:
      'VenueRise does NOT offer a contractual uptime SLA. RTO 4h / RPO 24h are internal best-effort targets, not customer-facing guarantees.',
  },
  {
    id: 'automated-breach-notification',
    pattern:
      /\b(automated|automatic|real[-\s]?time)\b[^.]{0,40}\b(breach|incident)\b[^.]{0,40}\b(notification|notify|notice|disclosure)\b/i,
    reason:
      'There is NO automated breach notification flow. Customer notification requires legal + operator review. Do not commit to a fixed-time automated notification SLA.',
  },
  {
    id: 'automated-dsr-fulfillment',
    pattern:
      /\b(automated|automatic|self[-\s]?service)\b[^.]{0,40}\b(DSR|data\s+subject\s+request|right[-\s]to[-\s]be[-\s]forgotten|right[-\s]to[-\s]erasure|right[-\s]of[-\s]access)\b/i,
    reason:
      'DSR fulfillment is operator + legal reviewed, NOT automated. Export preview is metadata-only; deletion review is non-destructive. Do not commit to automated DSR fulfillment.',
  },
  {
    id: 'autonomous-ai-sending',
    pattern:
      /\b(autonomous|fully\s+automated|unattended)\b[^.]{0,40}\b(AI|agent|send(?:ing)?|outbound|outreach|email|sms|message)\b/i,
    reason:
      'Autonomous outbound AI sending is DISABLED by default — `autonomous_sending_still_disabled` is mounted as a permanent health flag. Do not commit to fully autonomous AI outreach.',
  },
  {
    id: 'guaranteed-data-residency',
    pattern:
      /\b(guaranteed|strict|enforced)\b[^.]{0,40}\b(data\s+residency|EU\s+residency|US\s+residency|regional\s+isolation)\b/i,
    reason:
      'Data residency depends on the active Supabase project region for the venue (US by default, EU on request). Do not commit to "guaranteed" residency without confirming the project region.',
  },
  {
    id: 'no-vendor-training',
    pattern:
      /\b(no|zero|never)\b[^.]{0,30}\b(vendor|model|LLM|Anthropic|OpenAI)\b[^.]{0,30}\b(train(?:ing)?|fine[-\s]?tun(?:e|ing))\b/i,
    reason:
      'Vendor training-use posture is governed by the active Anthropic contract and requires legal verification. Do not commit to "no model training" without confirming the contractual terms.',
  },
]

/**
 * Detect overclaim flags by scanning title + description for
 * the forbidden marketing phrases above. Pure function.
 */
export function detectOverclaimFlags(
  commitments: ReadonlyArray<CommitmentRecord>
): UnsupportedRiskFlag[] {
  const out: UnsupportedRiskFlag[] = []
  for (const c of commitments) {
    if (
      c.status === 'fulfilled' ||
      c.status === 'expired' ||
      c.status === 'withdrawn'
    ) {
      continue
    }
    const haystack = `${c.title}\n${c.description}`
    for (const pat of OVERCLAIM_PATTERNS) {
      if (pat.pattern.test(haystack)) {
        out.push({
          commitmentId: c.id,
          area: c.commitmentArea,
          title: c.title,
          riskLevel: c.riskLevel,
          reason: `[overclaim:${pat.id}] ${pat.reason}`,
        })
      }
    }
  }
  return out
}

/**
 * Compute the unsupported-risk flag list for a set of
 * commitments. Pure function — no DB calls.
 *
 * Combines:
 *   1. Area-based flags (COMMITMENT_AREA_SUPPORT).
 *   2. Critical-risk flags (CRITICAL_REVIEW_AREAS).
 *   3. Overclaim flags (OVERCLAIM_PATTERNS) — text scan of
 *      title + description for forbidden marketing phrases.
 * Dedup is by (commitmentId, reason) — the same row can
 * surface multiple flags so the operator sees each distinct
 * gap.
 */
export function detectUnsupportedRiskFlags(
  commitments: ReadonlyArray<CommitmentRecord>
): UnsupportedRiskFlag[] {
  const out: UnsupportedRiskFlag[] = []
  const seen = new Set<string>()
  const push = (flag: UnsupportedRiskFlag) => {
    const key = `${flag.commitmentId}::${flag.reason}`
    if (seen.has(key)) return
    seen.add(key)
    out.push(flag)
  }

  const supportByArea = new Map(
    COMMITMENT_AREA_SUPPORT.map((row) => [row.area, row])
  )
  for (const c of commitments) {
    // Skip terminal-state rows — fulfilled / expired /
    // withdrawn commitments aren't actionable signals.
    if (
      c.status === 'fulfilled' ||
      c.status === 'expired' ||
      c.status === 'withdrawn'
    ) {
      continue
    }
    const support = supportByArea.get(c.commitmentArea)
    if (support && support.status !== 'supported') {
      push({
        commitmentId: c.id,
        area: c.commitmentArea,
        title: c.title,
        riskLevel: c.riskLevel,
        reason: support.reason,
      })
    } else if (
      c.riskLevel === 'critical' &&
      (CRITICAL_REVIEW_AREAS as ReadonlyArray<string>).includes(
        c.commitmentArea
      )
    ) {
      push({
        commitmentId: c.id,
        area: c.commitmentArea,
        title: c.title,
        riskLevel: c.riskLevel,
        reason:
          'Critical-risk commitment in a sensitive area. Confirm operator + legal review and a documented evidence URL before marking active.',
      })
    }
  }

  // Overclaim trap pass — runs across every non-terminal row
  // regardless of area, since these are factual misstatements
  // about platform posture.
  for (const flag of detectOverclaimFlags(commitments)) {
    push(flag)
  }

  return out
}

/**
 * Risk-tier sort helper for stable display.
 */
const RISK_ORDER: Record<CommitmentRiskLevel, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
}

export function sortByRisk(
  commitments: ReadonlyArray<CommitmentRecord>
): CommitmentRecord[] {
  return [...commitments].sort(
    (a, b) => RISK_ORDER[a.riskLevel] - RISK_ORDER[b.riskLevel]
  )
}
