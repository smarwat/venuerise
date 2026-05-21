import type {
  BackupProvider,
} from '@/lib/enterprise/disaster-recovery/types'

/**
 * Phase 9H — Disaster recovery policy.
 *
 * Conservative enterprise defaults. The exact numbers are
 * editable — bump them when the underlying Supabase plan
 * supports tighter SLAs or when a procurement contract
 * mandates stricter targets.
 *
 * What this file is NOT:
 *   - Not a contract. The targets here are the system's
 *     INTERNAL aim; legal commitments live in customer MSAs.
 *   - Not a guarantee. Real restore behavior is bounded by
 *     Supabase plan + region + the specific point-in-time.
 *
 * What this file IS:
 *   - The single source of truth the BackupPostureCard +
 *     getBackupPosture() helper read when deciding whether a
 *     check passes.
 *   - Documented in docs/DISASTER-RECOVERY.md so a future
 *     operator (or auditor) can pin the numbers we held
 *     ourselves to at any point in time.
 */

export interface BackupPosturePolicy {
  provider: BackupProvider
  /** Recovery Time Objective — how long to be back up. */
  rtoHours: number
  /** Recovery Point Objective — max acceptable data loss window. */
  rpoHours: number
  /** Minimum PITR / backup retention in days. */
  minRetentionDays: number
  /**
   * Max age (in hours) of the most recent backup before the
   * `RECENT_BACKUP_OK` check flips to warning/critical.
   */
  maxBackupAgeHours: number
  /**
   * Recommended dry-run cadence. Surfaced on the BackupPostureCard
   * + checked by `scripts/check-backup-posture.mjs` for the
   * `DRY_RUN_SCHEDULE_PRESENT` check.
   */
  dryRunCadence: 'quarterly' | 'monthly' | 'biannual'
  /**
   * Customer-facing summary used by `docs/DISASTER-RECOVERY.md` +
   * sales/security questionnaire snippets. Kept here so doc + UI
   * + questionnaire stay in lockstep.
   */
  customerSummary: string
}

/**
 * Conservative enterprise defaults. These are the numbers a
 * procurement reviewer should see + that the BackupPostureCard
 * holds the system to.
 */
export const BACKUP_POSTURE_POLICY: BackupPosturePolicy = {
  provider: 'supabase',
  // 4 hours — typical mid-market SaaS RTO. Real restore from
  // Supabase point-in-time is usually faster, but we budget for
  // investigation + verification + comms before declaring "back."
  rtoHours: 4,
  // 24 hours — matches the default Supabase daily backup cadence.
  // Real PITR can give much tighter recovery points; this is the
  // conservative ceiling we'll commit to in writing.
  rpoHours: 24,
  // 7 days — the floor for any project we'd put in production.
  // Supabase's Pro plan ships 7-day PITR by default; the Team
  // plan extends it. Bump this constant if/when the project's
  // plan supports more.
  minRetentionDays: 7,
  // 24h aligns with the RPO target.
  maxBackupAgeHours: 24,
  // Quarterly dry-runs — long enough to be sustainable, frequent
  // enough that the muscle memory stays warm.
  dryRunCadence: 'quarterly',
  customerSummary:
    'Daily managed backups with point-in-time recovery. Recovery Time Objective: 4 hours. Recovery Point Objective: 24 hours. Quarterly disaster-recovery dry runs. Restores are performed through approved Supabase workflows by VenueRise staff; the product UI never executes a restore.',
}

/**
 * Helper for warning thresholds. The BackupPostureCard renders a
 * check as `warning` (not yet `critical`) when the observed age
 * is between the SLA and `warningMultiplier * SLA`. Anything past
 * `criticalMultiplier * SLA` is hard `critical`.
 *
 * These multipliers live with the policy so they're editable in
 * one place + visible in the doc.
 */
export const BACKUP_POSTURE_THRESHOLDS = {
  warningMultiplier: 1.5,
  criticalMultiplier: 2.0,
} as const
