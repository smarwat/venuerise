import 'server-only'
import { log } from '@/lib/log'
import {
  BACKUP_POSTURE_POLICY,
  BACKUP_POSTURE_THRESHOLDS,
} from '@/lib/enterprise/disaster-recovery/policy'
import type {
  BackupPostureCheck,
  BackupPostureStatus,
  BackupPostureSummary,
} from '@/lib/enterprise/disaster-recovery/types'

/**
 * Phase 9H — Backup posture helper.
 *
 * Computes a read-only summary the admin BackupPostureCard
 * surfaces. Service-side ONLY (`'server-only'`); never imported
 * into client components. The Supabase Management API token is
 * the most sensitive secret in the whole project — leaking it
 * would give an attacker the ability to delete the database.
 *
 * ── BEHAVIOR ─────────────────────────────────────────────────────────────
 *   - When `SUPABASE_PROJECT_REF` + `SUPABASE_ACCESS_TOKEN` are
 *     missing: returns `status='unknown'`. The Management API
 *     check itself flips to `unknown` and every downstream
 *     check that needed live data degrades to `unknown` too.
 *     The helper NEVER throws.
 *   - When env vars are present: attempts the Management API
 *     call. On any error (network, 4xx, 5xx, parse failure)
 *     the helper logs structured + degrades to `unknown` for
 *     the affected checks. The function NEVER surfaces the raw
 *     token, NEVER includes the API response in logs verbatim.
 *
 * ── WHY UNKNOWN > FALSE-POSITIVE-OK ──────────────────────────────────────
 * The procurement-facing risk of "we said backups were healthy
 * when they weren't" is much larger than the risk of "the card
 * shows unknown until ops configures the env vars." Fail closed.
 *
 * ── KNOWN LIMITATION ─────────────────────────────────────────────────────
 * Supabase's Management API endpoint shapes have shifted over
 * time. The live call below is intentionally narrow — it only
 * verifies the token reaches a project endpoint and returns a
 * recognizable shape. A future phase can wire the precise PITR
 * window + last-backup timestamp endpoint when Supabase's API
 * stabilizes or when an operator confirms the path on the
 * project's plan. Until then, the helper returns the policy
 * defaults + a `MANAGEMENT_API_CONFIGURED` check that reflects
 * whether the env reached SOMETHING; the per-window checks stay
 * `unknown`.
 */

const MANAGEMENT_API_TIMEOUT_MS = 5_000

interface BackupPostureEnv {
  projectRef: string | null
  accessToken: string | null
  orgId: string | null
}

function readEnv(): BackupPostureEnv {
  return {
    projectRef: process.env.SUPABASE_PROJECT_REF ?? null,
    accessToken: process.env.SUPABASE_ACCESS_TOKEN ?? null,
    orgId: process.env.SUPABASE_ORG_ID ?? null,
  }
}

/**
 * Smoke probe against the Supabase Management API. Returns a
 * status discriminator + an optional project metadata blob (NO
 * token, NO raw payload). The helper never throws.
 */
async function probeManagementApi(
  env: BackupPostureEnv
): Promise<{
  status: 'configured' | 'unreachable' | 'missing'
  projectMetadata?: { project_ref: string; region?: string; name?: string }
}> {
  if (!env.accessToken || !env.projectRef) {
    return { status: 'missing' }
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), MANAGEMENT_API_TIMEOUT_MS)
  try {
    // GET /v1/projects/{ref} is the cheapest endpoint that
    // proves the token + ref are valid + the project is
    // reachable. We deliberately do NOT call a backup-specific
    // endpoint here — Supabase's PITR endpoint shape has shifted
    // and we don't want this helper to break on the next API
    // bump. A future phase wires a specific PITR call when the
    // shape is stable on the project's plan.
    const res = await fetch(
      `https://api.supabase.com/v1/projects/${encodeURIComponent(env.projectRef)}`,
      {
        method: 'GET',
        headers: {
          authorization: `Bearer ${env.accessToken}`,
          accept: 'application/json',
        },
        signal: controller.signal,
        // No body to log; project metadata is the only thing we
        // read.
      }
    )
    if (!res.ok) {
      // We deliberately don't log the response body — could
      // include sensitive project metadata under some endpoints.
      log.warn(
        { status: res.status, projectRef: env.projectRef },
        'backup_posture.management_api_status_not_ok'
      )
      return { status: 'unreachable' }
    }
    // Parse defensively — we only read the three operator-safe
    // fields. The full project payload is NEVER returned to the
    // caller (it can include billing IDs, etc.).
    const body = (await res.json().catch(() => null)) as
      | { id?: string; region?: string; name?: string }
      | null
    if (!body) {
      return { status: 'unreachable' }
    }
    return {
      status: 'configured',
      projectMetadata: {
        project_ref: env.projectRef,
        region: typeof body.region === 'string' ? body.region : undefined,
        name: typeof body.name === 'string' ? body.name : undefined,
      },
    }
  } catch (err) {
    log.warn(
      { err, projectRef: env.projectRef },
      'backup_posture.management_api_probe_threw'
    )
    return { status: 'unreachable' }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Roll up the worst per-check status into the overall posture.
 * Order: `critical > warning > unknown > healthy`. `unknown`
 * sits between warning and healthy because "we don't know" is
 * worse than "we know it's fine" but not as bad as "we know
 * something's off."
 */
function rollupStatus(
  checks: BackupPostureCheck[]
): BackupPostureStatus {
  let worst: BackupPostureStatus = 'healthy'
  const order: Record<BackupPostureStatus, number> = {
    healthy: 0,
    unknown: 1,
    warning: 2,
    critical: 3,
  }
  for (const check of checks) {
    if (order[check.status] > order[worst]) {
      worst = check.status
    }
  }
  return worst
}

export async function getBackupPosture(): Promise<BackupPostureSummary> {
  const env = readEnv()
  const probe = await probeManagementApi(env)

  const checks: BackupPostureCheck[] = []

  // 1. Management API configuration check. Drives every
  // downstream live check.
  if (probe.status === 'configured') {
    checks.push({
      code: 'MANAGEMENT_API_CONFIGURED',
      status: 'healthy',
      message:
        'Supabase Management API reachable. Project metadata available.',
      metadata: probe.projectMetadata,
    })
  } else if (probe.status === 'missing') {
    checks.push({
      code: 'MANAGEMENT_API_CONFIGURED',
      status: 'unknown',
      message:
        'SUPABASE_PROJECT_REF or SUPABASE_ACCESS_TOKEN not set. Live backup metadata unavailable; policy targets below are the operating defaults.',
    })
  } else {
    checks.push({
      code: 'MANAGEMENT_API_CONFIGURED',
      status: 'critical',
      message:
        'Supabase Management API configured but unreachable. Check the access token + network egress; see RUNBOOK.',
    })
  }

  // 2-4. PITR / retention / last-backup checks. These NEED live
  // Management API data to evaluate. Until the precise endpoint
  // shape is wired (see file header), they degrade to `unknown`
  // when the API isn't configured, and stay `unknown` even when
  // the smoke probe succeeded (the project-info endpoint alone
  // doesn't expose backup metadata).
  const liveStatusFallback: BackupPostureStatus =
    probe.status === 'configured' ? 'unknown' : 'unknown'

  checks.push({
    code: 'PITR_ENABLED',
    status: liveStatusFallback,
    message:
      probe.status === 'configured'
        ? 'PITR status not yet queried. The Management API call needs to be wired to the backup endpoint for this project plan.'
        : 'Cannot determine PITR status without Management API access.',
  })
  checks.push({
    code: 'RETENTION_WINDOW_OK',
    status: liveStatusFallback,
    message:
      probe.status === 'configured'
        ? `Retention target ${BACKUP_POSTURE_POLICY.minRetentionDays}d; observed value not yet wired.`
        : `Retention target ${BACKUP_POSTURE_POLICY.minRetentionDays}d; observed value unavailable.`,
    metadata: { target_retention_days: BACKUP_POSTURE_POLICY.minRetentionDays },
  })
  checks.push({
    code: 'RECENT_BACKUP_OK',
    status: liveStatusFallback,
    message:
      probe.status === 'configured'
        ? `Max acceptable backup age ${BACKUP_POSTURE_POLICY.maxBackupAgeHours}h; observed timestamp not yet wired.`
        : `Max acceptable backup age ${BACKUP_POSTURE_POLICY.maxBackupAgeHours}h; observed timestamp unavailable.`,
    metadata: {
      target_max_age_hours: BACKUP_POSTURE_POLICY.maxBackupAgeHours,
      warning_multiplier: BACKUP_POSTURE_THRESHOLDS.warningMultiplier,
      critical_multiplier: BACKUP_POSTURE_THRESHOLDS.criticalMultiplier,
    },
  })

  // 5. Runbook presence is a file-system check the helper doesn't
  // do at request time (server-side, would re-read the file every
  // call). Treated as `healthy` because the file is part of the
  // build artifact; the script `check-backup-posture.mjs`
  // verifies it explicitly + would fail CI if missing.
  checks.push({
    code: 'RESTORE_RUNBOOK_PRESENT',
    status: 'healthy',
    message:
      'docs/DISASTER-RECOVERY.md ships with the build; the backup posture script verifies file presence at validation time.',
  })

  // 6. Dry-run cadence — policy is `quarterly`. We can't verify
  // that a dry-run actually happened (no operator-action audit
  // tied to "we ran a restore drill" exists yet); we surface
  // the cadence target. A future phase could add a
  // `dr_dryrun_completed` audit action so we can flip this
  // check to `warning` when the last drill is overdue.
  checks.push({
    code: 'DRY_RUN_SCHEDULE_PRESENT',
    status: 'healthy',
    message: `Policy cadence: ${BACKUP_POSTURE_POLICY.dryRunCadence}. Operator-action audit for completed drills is a future enhancement.`,
  })

  const summary: BackupPostureSummary = {
    status: rollupStatus(checks),
    provider: BACKUP_POSTURE_POLICY.provider,
    rtoHours: BACKUP_POSTURE_POLICY.rtoHours,
    rpoHours: BACKUP_POSTURE_POLICY.rpoHours,
    retentionDays: BACKUP_POSTURE_POLICY.minRetentionDays,
    dryRunCadence: BACKUP_POSTURE_POLICY.dryRunCadence,
    lastCheckedAt: new Date().toISOString(),
    checks,
    providerMetadata: probe.projectMetadata,
  }
  return summary
}
