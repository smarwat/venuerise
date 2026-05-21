/**
 * Phase 9D — Lead PII redaction.
 *
 * Pure functions that compute a "before-snapshot" + a redaction
 * patch for a single lead row. Soft redaction by design:
 *
 *   - The lead row is NOT deleted.
 *   - Referential integrity to `conversations`, `messages`, `tours`,
 *     `ai_actions`, `audit_events` is preserved.
 *   - Operational columns (stage, lead_score, urgency, source,
 *     created_at, ai_active) stay intact — the venue can still
 *     report on funnel shape after redaction.
 *
 * ── REDACTION TARGETS ────────────────────────────────────────────────────
 *   - `name`   → 'Redacted Lead' (column is NOT NULL in 001)
 *   - `email`  → `redacted+<leadId>@redacted.local` (NOT NULL in 001;
 *                synthetic so existing uniqueness constraints don't
 *                trip if the venue has multiple redactions)
 *   - `phone`  → null (nullable)
 *   - `notes`  → null (nullable; operator-supplied free text — could
 *                contain customer PII, redact in full)
 *   - `metadata.pii.*` → removed (any keys under a `pii` namespace)
 *   - `metadata.lost_reason_note` → null when present (operator free
 *                text on lost-lead reasoning may name the customer)
 *
 * ── PRESERVED ────────────────────────────────────────────────────────────
 *   - `stage`, `lead_score`, `urgency`, `event_date`, `guest_count`,
 *     `budget`, `source`, `ai_active`, `created_at`, `updated_at`
 *   - `metadata.lost_reason` (taxonomy value, not free text)
 *   - `metadata.lost_reason_set_at`
 *   - Everything else in `metadata` that ISN'T under `pii.*` and
 *     ISN'T `lost_reason_note`
 *
 * ── AUDIT POSTURE ────────────────────────────────────────────────────────
 * The route at `/api/admin/leads/[leadId]/redact-pii` takes the
 * `redactLeadPiiSnapshot` output as the audit row's `before` field
 * — that goes through the helper's existing sanitizer (sensitive-
 * key drop + 4 KB cap). The audit row's `after` is the patch itself.
 * Operators can reconstruct "this lead was X before redaction" from
 * the audit row WITHOUT the raw email + phone landing in production
 * logs (the sanitizer drops common sensitive key names; email +
 * phone are NOT in the dropped list, so they DO land in the audit
 * snapshot — that's deliberate: forensic reconstruction needs them).
 */

export interface RedactLeadPatchArgs {
  /** Free-text reason from the operator. Capped 240 chars at the route layer. */
  reason: string
  /** Used to stamp `pii_redacted_by` on the metadata. */
  requestedByUserId: string
}

/**
 * Compute the "before" snapshot for the audit row. We deliberately
 * narrow to PII fields here — we DON'T include the entire lead row
 * because:
 *   - Operational fields (stage, lead_score, ...) didn't change; no
 *     point storing them in the audit `before` snapshot.
 *   - The full row would push past the helper's 4 KB cap quickly on
 *     leads with large notes.
 *
 * The snapshot retains email + phone because the audit row IS the
 * forensic record of what was redacted — an auditor reviewing a
 * redaction needs to see what was there. The sanitizer applies
 * sensitive-key drop after this returns; email + phone aren't in
 * the drop list, so they land in the snapshot intentionally.
 */
export function redactLeadPiiSnapshot(
  lead: Record<string, unknown>
): Record<string, unknown> {
  const snapshot: Record<string, unknown> = {
    id: lead.id ?? null,
    name: lead.name ?? null,
    email: lead.email ?? null,
    phone: lead.phone ?? null,
    notes: typeof lead.notes === 'string' ? lead.notes.slice(0, 500) : null,
  }
  // Pull just the metadata fields that are PII-shaped so the audit
  // `before` row stays compact + readable.
  if (lead.metadata && typeof lead.metadata === 'object') {
    const md = lead.metadata as Record<string, unknown>
    const piiMetadata: Record<string, unknown> = {}
    if (md.lost_reason_note) piiMetadata.lost_reason_note = md.lost_reason_note
    if (md.pii) piiMetadata.pii = md.pii
    if (Object.keys(piiMetadata).length > 0) {
      snapshot.metadata = piiMetadata
    }
  }
  return snapshot
}

/**
 * Compute the `update` patch the route applies to `leads`. The
 * patch:
 *   - Replaces NOT NULL columns (name, email) with synthetic
 *     redacted values.
 *   - Nulls nullable PII columns (phone, notes).
 *   - Stamps `pii_redacted_*` markers under `metadata`.
 *
 * The metadata patch is a SHALLOW merge intent — the route applies
 * it by reading the current metadata first, redacting the `pii.*`
 * subtree + `lost_reason_note`, and stamping the new keys. We
 * cannot do that deep merge in a pure function without a lead id
 * (for the synthetic email), so the route handles the merge; this
 * helper returns the FLAT scalar+metadata stamps the route should
 * apply.
 */
export function buildLeadPiiRedactionPatch(
  args: RedactLeadPatchArgs
): Record<string, unknown> {
  const nowIso = new Date().toISOString()
  // The metadata key names are stable + documented in the route's
  // header comment + in docs/AUDIT-COVERAGE.md.
  return {
    name: 'Redacted Lead',
    phone: null,
    notes: null,
    metadata_stamps: {
      pii_redacted: true,
      pii_redacted_at: nowIso,
      pii_redacted_by: args.requestedByUserId,
      pii_redaction_reason: args.reason,
    },
  }
}

/**
 * Synthetic email helper — kept separate from `buildLeadPiiRedactionPatch`
 * because it needs the leadId (which the route owns) to produce a
 * unique value that won't collide with other redactions on the same
 * venue.
 */
export function buildRedactedEmail(leadId: string): string {
  return `redacted+${leadId}@redacted.local`
}

/**
 * Apply the metadata-redaction subtree drop. Returns a new object;
 * never mutates input.
 */
export function dropPiiMetadataKeys(
  metadata: Record<string, unknown> | null
): Record<string, unknown> {
  if (!metadata || typeof metadata !== 'object') return {}
  const next: Record<string, unknown> = { ...metadata }
  // Drop the entire `pii` subtree if present — any free-form
  // customer data the operator stashed there comes out.
  if ('pii' in next) delete next.pii
  // Drop the operator-written lost_reason_note (taxonomy
  // lost_reason stays).
  if ('lost_reason_note' in next) delete next.lost_reason_note
  return next
}
