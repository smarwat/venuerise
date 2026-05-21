import 'server-only'
import { createServiceClient } from '@/lib/supabase/service'
import { log } from '@/lib/log'
import { getBackupPosture } from '@/lib/enterprise/disaster-recovery/backup-posture'
import { DETECTOR_DEFAULTS } from '@/lib/enterprise/incidents/policy'
import type {
  DetectorRunResult,
  IncidentCandidate,
  IncidentSource,
} from '@/lib/enterprise/incidents/types'

/**
 * Phase 9L — Conservative + operator-triggered incident detectors.
 *
 * Every detector:
 *   - Reads from a single signal source (abuse_events,
 *     sso_login_events, backup posture, health flags).
 *   - Returns CANDIDATES with a fingerprint so the same window
 *     doesn't produce duplicates when the operator re-runs
 *     detection within the window.
 *   - Degrades cleanly when the source table or env is
 *     unavailable — returns `{ candidates: [], warnings: [...] }`
 *     instead of throwing.
 *
 * The detectors NEVER create incidents on their own. The
 * `/api/admin/security/incidents/detect` route surfaces the
 * candidate list; the operator decides whether to materialise
 * via the `create=true` flag.
 *
 * Operator discipline:
 *   - Thresholds in `policy.ts` are intentionally conservative.
 *     A noisy detector is worse than a missed one — fix the
 *     real noise before tuning the threshold down.
 *   - Detector output ONLY includes operational metadata
 *     (counts, route, limiter key, posture status). NEVER
 *     customer payload, NEVER raw IPs (the upstream tables
 *     already mask), NEVER conversation content.
 */

function nowMs(): number {
  return Date.now()
}

function isoSince(windowMs: number): string {
  return new Date(nowMs() - windowMs).toISOString()
}

function fingerprintFromParts(...parts: Array<string | number>): string {
  return parts.map((p) => String(p)).join('|')
}

// ── Abuse spike ──────────────────────────────────────────────────────────

export async function detectAbuseSpike(
  venueId: string | null
): Promise<DetectorRunResult> {
  const cfg = DETECTOR_DEFAULTS.abuseSpike
  const windowMs = cfg.windowMinutes * 60 * 1000
  const warnings: string[] = []
  const candidates: IncidentCandidate[] = []
  try {
    const supabase = createServiceClient()
    let q = supabase
      .from('abuse_events')
      .select('route,limiter_key,reason,created_at')
      .gte('created_at', isoSince(windowMs))
      .limit(2000)
    if (venueId) q = q.eq('venue_id', venueId)
    const { data, error } = await q
    if (error) {
      warnings.push(`abuse_events_query_failed:${error.message}`)
      return { source: 'abuse_events', candidates, warnings, windowMs }
    }
    const rows = (data ?? []) as Array<{
      route: string
      limiter_key: string
      reason: string | null
      created_at: string
    }>
    // Group by (route, reason). A reason cluster on a single
    // route is the most actionable signal.
    const buckets = new Map<
      string,
      { route: string; reason: string; count: number }
    >()
    for (const row of rows) {
      const reason = row.reason ?? 'rate_limited'
      const key = `${row.route}::${reason}`
      const bucket = buckets.get(key) ?? {
        route: row.route,
        reason,
        count: 0,
      }
      bucket.count += 1
      buckets.set(key, bucket)
    }
    for (const bucket of buckets.values()) {
      if (bucket.count < cfg.minRows) continue
      const fp = fingerprintFromParts(
        'abuse',
        bucket.route,
        bucket.reason,
        Math.floor(nowMs() / windowMs)
      )
      candidates.push({
        fingerprint: fp,
        source: 'abuse_events',
        category: 'security',
        suggestedSeverity: cfg.suggestedSeverity,
        title: `Abuse spike on ${bucket.route} (${bucket.count} blocks in ${cfg.windowMinutes}m)`,
        description: `Rate-limiter blocks on ${bucket.route} with reason="${bucket.reason}" crossed ${cfg.minRows} in the last ${cfg.windowMinutes} minutes. Inspect the AbuseMonitorCard for offending limiter keys.`,
        evidence: {
          route: bucket.route,
          reason: bucket.reason,
          count: bucket.count,
          windowMinutes: cfg.windowMinutes,
        },
      })
    }
    return { source: 'abuse_events', candidates, warnings, windowMs }
  } catch (err) {
    log.warn({ err }, 'detectors.abuse_spike.unexpected')
    warnings.push('unexpected_error')
    return { source: 'abuse_events', candidates, warnings, windowMs }
  }
}

// ── SSO failure spike ────────────────────────────────────────────────────

export async function detectSsoFailureSpike(
  venueId: string | null
): Promise<DetectorRunResult> {
  const cfg = DETECTOR_DEFAULTS.ssoFailureSpike
  const windowMs = cfg.windowMinutes * 60 * 1000
  const warnings: string[] = []
  const candidates: IncidentCandidate[] = []
  try {
    const supabase = createServiceClient()
    let q = supabase
      .from('sso_login_events')
      .select('outcome,reason,domain,created_at')
      .gte('created_at', isoSince(windowMs))
      .in('outcome', ['failed', 'blocked'])
      .limit(2000)
    if (venueId) q = q.eq('venue_id', venueId)
    const { data, error } = await q
    if (error) {
      warnings.push(`sso_login_events_query_failed:${error.message}`)
      return { source: 'sso_login_events', candidates, warnings, windowMs }
    }
    const rows = (data ?? []) as Array<{
      outcome: string
      reason: string | null
      domain: string | null
      created_at: string
    }>
    if (rows.length < cfg.minRows) {
      return { source: 'sso_login_events', candidates, warnings, windowMs }
    }
    const byDomain = new Map<string, number>()
    for (const r of rows) {
      const d = r.domain ?? '(unknown)'
      byDomain.set(d, (byDomain.get(d) ?? 0) + 1)
    }
    const topDomain = [...byDomain.entries()].sort((a, b) => b[1] - a[1])[0]
    const fp = fingerprintFromParts(
      'sso_failure',
      topDomain?.[0] ?? '(unknown)',
      Math.floor(nowMs() / windowMs)
    )
    candidates.push({
      fingerprint: fp,
      source: 'sso_login_events',
      category: 'access_control',
      suggestedSeverity: cfg.suggestedSeverity,
      title: `SSO failure spike (${rows.length} failures in ${cfg.windowMinutes}m)`,
      description: `sso_login_events recorded ${rows.length} failed/blocked outcomes in the last ${cfg.windowMinutes} minutes. Top domain: ${topDomain?.[0] ?? '(unknown)'} with ${topDomain?.[1] ?? 0} failures.`,
      evidence: {
        totalFailures: rows.length,
        topDomain: topDomain?.[0] ?? null,
        topDomainCount: topDomain?.[1] ?? 0,
        windowMinutes: cfg.windowMinutes,
      },
    })
    return { source: 'sso_login_events', candidates, warnings, windowMs }
  } catch (err) {
    log.warn({ err }, 'detectors.sso_failure_spike.unexpected')
    warnings.push('unexpected_error')
    return { source: 'sso_login_events', candidates, warnings, windowMs }
  }
}

// ── Backup posture ───────────────────────────────────────────────────────

export async function detectBackupPostureIncident(): Promise<DetectorRunResult> {
  const cfg = DETECTOR_DEFAULTS.backupPosture
  const warnings: string[] = []
  const candidates: IncidentCandidate[] = []
  const windowMs = cfg.windowMinutes * 60 * 1000
  try {
    const posture = await getBackupPosture()
    if (!posture) {
      warnings.push('backup_posture_unavailable')
      return { source: 'backup_posture', candidates, warnings, windowMs }
    }
    // Inspect overall status. Treat 'unknown' as non-actionable
    // (env not set); only 'degraded' / 'critical' produce a
    // candidate.
    const status = (posture as { status?: string }).status ?? 'unknown'
    // BackupPostureStatus = 'healthy' | 'warning' | 'critical' | 'unknown'.
    // Only 'warning' + 'critical' produce a candidate. 'unknown'
    // is non-actionable (env not set) and 'healthy' is the
    // expected state.
    if (status === 'warning' || status === 'critical') {
      const severity =
        status === 'critical' ? 'sev2' : cfg.suggestedSeverity
      const fp = fingerprintFromParts(
        'backup_posture',
        status,
        Math.floor(nowMs() / windowMs)
      )
      candidates.push({
        fingerprint: fp,
        source: 'backup_posture',
        category: 'availability',
        suggestedSeverity: severity,
        title: `Backup posture: ${status}`,
        description: `BackupPostureCard reports overall status="${status}". Review the per-check breakdown + Phase 9H runbook before resolving.`,
        evidence: {
          status,
        },
      })
    }
    return { source: 'backup_posture', candidates, warnings, windowMs }
  } catch (err) {
    log.warn({ err }, 'detectors.backup_posture.unexpected')
    warnings.push('unexpected_error')
    return { source: 'backup_posture', candidates, warnings, windowMs }
  }
}

// ── Health-check stub ────────────────────────────────────────────────────

/**
 * Health-flag detector. Currently a stub — `/api/health` flags
 * are static strings ('mounted'); a true runtime check would
 * need to ping each surface. The stub returns an empty
 * candidate list + a warning so the route can surface what's
 * actually implemented.
 *
 * Operators who want richer health detection can extend this
 * helper to call into specific posture endpoints (backup,
 * abuse counts, audit mirror availability) the same way the
 * other detectors do.
 */
export async function detectHealthFlagIncident(): Promise<DetectorRunResult> {
  const cfg = DETECTOR_DEFAULTS.healthCheck
  const windowMs = cfg.windowMinutes * 60 * 1000
  return {
    source: 'health_check',
    candidates: [],
    warnings: [
      'health_flag_detector_is_static — runtime health probing is on the planned-improvements list. Use the BackupPostureCard / AbuseMonitorCard / EnterpriseAuditEventsCard for live signal.',
    ],
    windowMs,
  }
}

// ── Run all ──────────────────────────────────────────────────────────────

export interface RunAllDetectorsArgs {
  venueId: string | null
  sources?: ReadonlyArray<IncidentSource>
}

/**
 * Operator-triggered roll-up. Returns the union of candidates
 * from the requested sources. Default is the four implemented
 * detectors.
 */
export async function runAllDetectors(
  args: RunAllDetectorsArgs
): Promise<DetectorRunResult[]> {
  const sources: ReadonlyArray<IncidentSource> = args.sources ?? [
    'abuse_events',
    'sso_login_events',
    'backup_posture',
    'health_check',
  ]
  const results: DetectorRunResult[] = []
  for (const src of sources) {
    if (src === 'abuse_events') {
      results.push(await detectAbuseSpike(args.venueId))
    } else if (src === 'sso_login_events') {
      results.push(await detectSsoFailureSpike(args.venueId))
    } else if (src === 'backup_posture') {
      results.push(await detectBackupPostureIncident())
    } else if (src === 'health_check') {
      results.push(await detectHealthFlagIncident())
    } else {
      results.push({
        source: src,
        candidates: [],
        warnings: [`detector_not_implemented:${src}`],
        windowMs: 0,
      })
    }
  }
  return results
}
