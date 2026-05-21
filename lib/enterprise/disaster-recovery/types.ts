/**
 * Phase 9H — Disaster recovery types.
 *
 * Shape for the backup posture surface + the restore-intent audit
 * helper. NOTHING in this file (or any module that imports it)
 * performs a real restore. The product UI is INTENTIONALLY
 * read-only on this surface; real restores happen via the
 * Supabase dashboard or support runbook per
 * `docs/DISASTER-RECOVERY.md`.
 */

// ── Identifiers ──────────────────────────────────────────────────────────

export type BackupProvider = 'supabase' | 'manual'

/**
 * Overall posture status. Mirrors the existing `/api/health`
 * status vocabulary so the BackupPostureCard can render the same
 * colored chip variants.
 *
 *   healthy  — every check passed
 *   warning  — at least one check is below SLA but not yet
 *              critical (e.g. last backup older than policy +
 *              50% but younger than policy + 200%)
 *   critical — at least one check failed hard
 *   unknown  — metadata unavailable (Management API not
 *              configured); checks could not be evaluated
 */
export type BackupPostureStatus =
  | 'healthy'
  | 'warning'
  | 'critical'
  | 'unknown'

/**
 * Stable codes for individual checks. The card renders them as
 * human-readable rows; the audit feed stores them verbatim so a
 * future regression in posture is greppable.
 *
 * Codes never change shape; new codes append.
 */
export type BackupCheckCode =
  | 'PITR_ENABLED'
  | 'RETENTION_WINDOW_OK'
  | 'RECENT_BACKUP_OK'
  | 'MANAGEMENT_API_CONFIGURED'
  | 'RESTORE_RUNBOOK_PRESENT'
  | 'DRY_RUN_SCHEDULE_PRESENT'

/**
 * Per-check result. `status` matches the overall posture vocabulary
 * so the card can mix-and-match without a separate shape.
 */
export interface BackupPostureCheck {
  code: BackupCheckCode
  status: BackupPostureStatus
  /** Operator-readable explanation. NEVER includes raw tokens. */
  message: string
  /**
   * Optional small metadata blob. Examples:
   *   { observed_retention_days: 7, target_retention_days: 7 }
   *   { last_backup_at: '...', target_max_age_hours: 24 }
   * NEVER stores raw Management API responses or secrets.
   */
  metadata?: Record<string, unknown>
}

/**
 * Summary returned by `getBackupPosture()` + surfaced via the
 * admin route + the card.
 */
export interface BackupPostureSummary {
  status: BackupPostureStatus
  provider: BackupProvider
  /** Hours target — see policy.ts for the conservative default. */
  rtoHours: number
  /** Hours target. */
  rpoHours: number
  /** Days target. */
  retentionDays: number
  /** Recommended cadence (e.g. 'quarterly'). */
  dryRunCadence: string
  /** When the helper last computed this summary. */
  lastCheckedAt: string
  /** Per-check breakdown. */
  checks: BackupPostureCheck[]
  /**
   * Optional vendor-side metadata. Populated only when the
   * Supabase Management API call succeeds. Examples:
   *   { project_ref: '...', region: '...' }
   * NEVER contains tokens.
   */
  providerMetadata?: Record<string, unknown>
}

// ── Restore intent (audit only — NEVER executes a restore) ──────────────

/**
 * Restore intent scope. Discriminates between "single lead got
 * deleted" (small blast radius) and "we need to restore the whole
 * project" (huge blast radius). The DR runbook routes each scope
 * to a different decision tree.
 */
export type RestoreIntentScope =
  | 'lead'
  | 'venue'
  | 'billing'
  | 'full_project'
  | 'unknown'

/**
 * Where an intent is in its workflow. The product NEVER moves an
 * intent past `requested` automatically — operators flip status
 * via the audit feed (no destructive product action).
 *
 *   requested            — operator just filed the intent
 *   review_required      — another owner needs to confirm
 *                          before any Supabase-side action
 *   cancelled            — operator decided not to restore
 *   completed_outside_app — restore happened via Supabase
 *                          dashboard / support; operator
 *                          logs the outcome back here for
 *                          audit completeness
 */
export type RestoreIntentStatus =
  | 'requested'
  | 'review_required'
  | 'cancelled'
  | 'completed_outside_app'

/**
 * Input to `recordRestoreIntent`. Routes parse + validate body
 * shape; the helper just trusts what it gets + sanitizes through
 * the audit pipeline.
 */
export interface RestoreIntentInput {
  scope: RestoreIntentScope
  status?: RestoreIntentStatus
  /**
   * Operator-supplied free-text reason. Capped at 500 chars by
   * the route's Zod schema.
   */
  reason: string
  /**
   * ISO timestamp the operator wants to restore to. Optional —
   * a `lead` scope investigation may not have a target time yet.
   */
  requestedRestorePoint?: string | null
  affectedVenueId?: string | null
  affectedResourceId?: string | null
  /** Operator's note — additional context. Capped at 500 chars. */
  operatorNote?: string | null
  /** Caller's user id — required for the audit row. */
  actorUserId: string
  /** Phase 9A request id for cross-system correlation. */
  requestId: string
  /** Raw IP — helper hashes it before persisting. */
  ip?: string | null
  /** User-Agent header — truncated by the audit helper. */
  userAgent?: string | null
}
