import 'server-only'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { createServiceClient } from '@/lib/supabase/service'
import { log } from '@/lib/log'
import { captureApiError } from '@/lib/observability/sentry'
import { maskIpForAudit } from '@/lib/enterprise/audit-events'
import {
  DEFAULT_GRANT_EXPIRY_DAYS,
  TRUST_CENTER_PRODUCT_NAME,
  validateExpiryDays,
} from '@/lib/enterprise/trust-center/policy'
import {
  TRUST_ACCESS_SCOPES,
  type TrustAccessEventType,
  type TrustAccessGrant,
  type TrustAccessGrantCounts,
  type TrustAccessGrantCreateInput,
  type TrustAccessGrantUpdateInput,
  type TrustAccessScope,
  type TrustAccessStatus,
  type TrustAccessValidation,
  type TrustArtifactFormat,
  type TrustArtifactType,
} from '@/lib/enterprise/trust-center/types'

/**
 * Phase 9N — Trust Center access helpers.
 *
 * All functions are server-only and use the SERVICE-role
 * client. Callers MUST perform their own RBAC check first.
 *
 * Token handling:
 *   - `generateTrustToken()` uses 32 bytes of crypto-random
 *     entropy encoded as URL-safe base64. ~256 bits of
 *     entropy — comparable to a session token.
 *   - `hashTrustToken()` reuses the audit IP hash secret as
 *     the per-environment salt and returns hex SHA-256. Same
 *     primitive as `maskIpForAudit` so a single secret
 *     rotation invalidates trust tokens + audit IP hashes
 *     atomically.
 *   - `validateTrustAccessToken()` constant-time compares the
 *     inbound hash against the stored hash.
 *
 * Honesty:
 *   - The plaintext token leaves the server ONCE at creation
 *     via the return value of `createTrustAccessGrant`. It is
 *     NEVER logged. The admin UI shows it once and warns the
 *     operator about bearer-token semantics.
 *   - Best-effort writers throughout — failures log + Sentry
 *     but never throw, so a buyer access attempt can't be
 *     blocked by a transient DB error on the audit path.
 */

type RowGrant = {
  id: string
  venue_id: string | null
  buyer_name: string | null
  buyer_email: string | null
  buyer_company: string | null
  scope: string
  status: string
  token_hash: string
  expires_at: string
  created_by: string | null
  revoked_by: string | null
  revoked_at: string | null
  last_accessed_at: string | null
  access_count: number
  metadata: Record<string, unknown> | null
  created_at: string
  updated_at: string
}

function rowToGrant(row: RowGrant): TrustAccessGrant {
  return {
    id: row.id,
    venueId: row.venue_id,
    buyerName: row.buyer_name,
    buyerEmail: row.buyer_email,
    buyerCompany: row.buyer_company,
    scope: row.scope as TrustAccessScope,
    status: row.status as TrustAccessStatus,
    tokenHash: row.token_hash,
    expiresAt: row.expires_at,
    createdBy: row.created_by,
    revokedBy: row.revoked_by,
    revokedAt: row.revoked_at,
    lastAccessedAt: row.last_accessed_at,
    accessCount: row.access_count,
    metadata: row.metadata ?? {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

// ── Token primitives ─────────────────────────────────────────────────────

export function generateTrustToken(): string {
  // 32 random bytes -> 43-char URL-safe base64 (no padding).
  return randomBytes(32).toString('base64url')
}

function getSalt(): string {
  // Reuse AUDIT_IP_HASH_SECRET so a rotation invalidates all
  // bearer artefacts at once. Falls back to a dev-only
  // constant when the env is unset — matches the audit-event
  // helper's behaviour.
  return (
    process.env.AUDIT_IP_HASH_SECRET ??
    process.env.SUPABASE_JWT_SECRET ??
    'venuerise-dev-salt'
  )
}

export function hashTrustToken(token: string): string {
  return createHash('sha256').update(`${getSalt()}::${token}`).digest('hex')
}

function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  try {
    return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'))
  } catch {
    return false
  }
}

function maskUserAgent(ua: string | null | undefined): string | null {
  if (!ua) return null
  return createHash('sha256').update(`${getSalt()}::ua::${ua}`).digest('hex')
}

function buildGrantUrl(token: string): string | null {
  const base = process.env.NEXT_PUBLIC_APP_URL
  if (!base) return null
  return `${base.replace(/\/+$/, '')}/trust/access/${token}`
}

// ── Create / update / revoke ─────────────────────────────────────────────

export async function createTrustAccessGrant(
  input: TrustAccessGrantCreateInput
): Promise<
  | {
      ok: true
      grantId: string
      token: string
      url: string | null
      expiresAt: string
      productName: string
    }
  | { ok: false; code: string; message: string }
> {
  if (!input.venueId) {
    return { ok: false, code: 'validation_failed', message: 'venueId' }
  }
  const scope: TrustAccessScope = input.scope ?? 'standard_packet'
  if (!(TRUST_ACCESS_SCOPES as ReadonlyArray<string>).includes(scope)) {
    return { ok: false, code: 'validation_failed', message: 'scope' }
  }
  const expiresInDays = validateExpiryDays(
    input.expiresInDays ?? DEFAULT_GRANT_EXPIRY_DAYS
  )
  const token = generateTrustToken()
  const tokenHash = hashTrustToken(token)
  const expiresAt = new Date(
    Date.now() + expiresInDays * 24 * 60 * 60 * 1000
  ).toISOString()

  const supabase = createServiceClient()
  try {
    const { data, error } = await supabase
      .from('trust_access_grants')
      .insert({
        venue_id: input.venueId,
        buyer_name: input.buyerName ?? null,
        buyer_email: input.buyerEmail ?? null,
        buyer_company: input.buyerCompany ?? null,
        scope,
        status: 'active',
        token_hash: tokenHash,
        expires_at: expiresAt,
        created_by: input.createdBy,
        metadata: input.metadata ?? {},
      })
      .select('*')
      .single()
    if (error || !data) {
      log.error(
        { err: error, venueId: input.venueId },
        'trust_grant.create.insert_failed'
      )
      captureApiError(error ?? new Error('insert_failed'), {
        venueId: input.venueId ?? undefined,
      })
      return {
        ok: false,
        code: 'insert_failed',
        message: error?.message ?? 'unknown',
      }
    }
    const grant = rowToGrant(data as RowGrant)

    void recordTrustAccessEvent({
      grantId: grant.id,
      venueId: grant.venueId,
      eventType: 'grant_created',
      artifactType: null,
      format: null,
      ip: null,
      userAgent: null,
      metadata: { scope: grant.scope, expires_in_days: expiresInDays },
    })

    return {
      ok: true,
      grantId: grant.id,
      token,
      url: buildGrantUrl(token),
      expiresAt,
      productName: TRUST_CENTER_PRODUCT_NAME,
    }
  } catch (err) {
    log.error({ err }, 'trust_grant.create.unexpected')
    captureApiError(err)
    return { ok: false, code: 'unexpected_error', message: 'create_failed' }
  }
}

export async function updateTrustAccessGrant(
  input: TrustAccessGrantUpdateInput
): Promise<
  | { ok: true; grant: TrustAccessGrant; revoked: boolean }
  | { ok: false; code: string; message: string }
> {
  if (!input.grantId) {
    return { ok: false, code: 'validation_failed', message: 'grantId' }
  }
  const supabase = createServiceClient()
  try {
    const { data: before, error: beforeErr } = await supabase
      .from('trust_access_grants')
      .select('*')
      .eq('id', input.grantId)
      .maybeSingle()
    if (beforeErr || !before) {
      return { ok: false, code: 'not_found', message: 'grant' }
    }
    const beforeRow = before as RowGrant

    const patch: Record<string, unknown> = {}
    if (input.buyerName !== undefined) patch.buyer_name = input.buyerName
    if (input.buyerEmail !== undefined) patch.buyer_email = input.buyerEmail
    if (input.buyerCompany !== undefined) {
      patch.buyer_company = input.buyerCompany
    }
    if (input.metadata !== undefined) patch.metadata = input.metadata
    if (input.revoke) {
      if (beforeRow.status === 'revoked') {
        return { ok: false, code: 'already_revoked', message: 'grant' }
      }
      patch.status = 'revoked'
      patch.revoked_at = new Date().toISOString()
      patch.revoked_by = input.actorUserId
    }
    if (Object.keys(patch).length === 0) {
      return { ok: false, code: 'validation_failed', message: 'no_changes' }
    }
    const { data: afterRow, error: updErr } = await supabase
      .from('trust_access_grants')
      .update(patch)
      .eq('id', input.grantId)
      .select('*')
      .single()
    if (updErr || !afterRow) {
      log.error(
        { err: updErr, grantId: input.grantId },
        'trust_grant.update.failed'
      )
      captureApiError(updErr ?? new Error('update_failed'))
      return {
        ok: false,
        code: 'update_failed',
        message: updErr?.message ?? 'unknown',
      }
    }
    const grant = rowToGrant(afterRow as RowGrant)
    if (input.revoke) {
      void recordTrustAccessEvent({
        grantId: grant.id,
        venueId: grant.venueId,
        eventType: 'grant_revoked',
        artifactType: null,
        format: null,
        ip: null,
        userAgent: null,
        metadata: {},
      })
    }
    return { ok: true, grant, revoked: Boolean(input.revoke) }
  } catch (err) {
    log.error({ err }, 'trust_grant.update.unexpected')
    captureApiError(err)
    return { ok: false, code: 'unexpected_error', message: 'update_failed' }
  }
}

// ── List ─────────────────────────────────────────────────────────────────

export interface ListGrantFilters {
  venueId: string | null
  status?: TrustAccessStatus | null
  buyerEmail?: string | null
  limit?: number
}

export interface TrustGrantListSummary {
  generatedAt: string
  counts: TrustAccessGrantCounts
  grants: TrustAccessGrant[]
  warnings: string[]
}

export async function listTrustAccessGrants(
  filters: ListGrantFilters
): Promise<TrustGrantListSummary> {
  const warnings: string[] = []
  const supabase = createServiceClient()
  const limit = Math.min(Math.max(filters.limit ?? 100, 1), 500)
  try {
    let q = supabase
      .from('trust_access_grants')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit)
    if (filters.venueId) q = q.eq('venue_id', filters.venueId)
    if (filters.status) q = q.eq('status', filters.status)
    if (filters.buyerEmail) q = q.eq('buyer_email', filters.buyerEmail)
    const { data, error } = await q
    if (error) {
      warnings.push(`list_failed:${error.message}`)
      log.error({ err: error }, 'trust_grants.list.failed')
      return emptyListSummary(warnings)
    }
    const grants = (data ?? []).map((r) => rowToGrant(r as RowGrant))
    const counts = computeCounts(grants)
    return {
      generatedAt: new Date().toISOString(),
      counts,
      grants,
      warnings,
    }
  } catch (err) {
    log.error({ err }, 'trust_grants.list.unexpected')
    captureApiError(err)
    warnings.push('unexpected_error')
    return emptyListSummary(warnings)
  }
}

function emptyListSummary(warnings: string[]): TrustGrantListSummary {
  return {
    generatedAt: new Date().toISOString(),
    counts: {
      total: 0,
      active: 0,
      expired: 0,
      revoked: 0,
      accessedLast30d: 0,
    },
    grants: [],
    warnings,
  }
}

function computeCounts(
  grants: ReadonlyArray<TrustAccessGrant>
): TrustAccessGrantCounts {
  const counts: TrustAccessGrantCounts = {
    total: grants.length,
    active: 0,
    expired: 0,
    revoked: 0,
    accessedLast30d: 0,
  }
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000
  const now = Date.now()
  for (const g of grants) {
    if (g.status === 'revoked') {
      counts.revoked += 1
    } else if (g.status === 'expired' || Date.parse(g.expiresAt) < now) {
      counts.expired += 1
    } else {
      counts.active += 1
    }
    if (g.lastAccessedAt && Date.parse(g.lastAccessedAt) >= cutoff) {
      counts.accessedLast30d += 1
    }
  }
  return counts
}

// ── Validate ─────────────────────────────────────────────────────────────

export async function validateTrustAccessToken(
  token: string | null | undefined
): Promise<TrustAccessValidation> {
  if (!token || typeof token !== 'string' || token.length < 32) {
    return { ok: false, reason: 'invalid', grant: null }
  }
  const hash = hashTrustToken(token)
  const supabase = createServiceClient()
  try {
    const { data: row, error } = await supabase
      .from('trust_access_grants')
      .select('*')
      .eq('token_hash', hash)
      .maybeSingle()
    if (error || !row) {
      return { ok: false, reason: 'invalid', grant: null }
    }
    const grant = rowToGrant(row as RowGrant)
    // Defensive constant-time compare on the hash.
    if (!safeEqualHex(grant.tokenHash, hash)) {
      return { ok: false, reason: 'invalid', grant: null }
    }
    if (grant.status === 'revoked') {
      return { ok: false, reason: 'revoked', grant }
    }
    if (Date.parse(grant.expiresAt) < Date.now()) {
      // Mark expired in the DB so the admin counts reflect it.
      void supabase
        .from('trust_access_grants')
        .update({ status: 'expired' })
        .eq('id', grant.id)
        .then(() => undefined)
      return { ok: false, reason: 'expired', grant }
    }
    if (grant.status !== 'active') {
      return { ok: false, reason: 'unknown', grant }
    }
    // Best-effort: bump last_accessed_at + access_count.
    void supabase
      .from('trust_access_grants')
      .update({
        last_accessed_at: new Date().toISOString(),
        access_count: grant.accessCount + 1,
      })
      .eq('id', grant.id)
      .then(() => undefined)
    return { ok: true, reason: 'ok', grant }
  } catch (err) {
    log.warn({ err }, 'trust_token.validate.unexpected')
    return { ok: false, reason: 'invalid', grant: null }
  }
}

// ── Access events ────────────────────────────────────────────────────────

export interface RecordTrustAccessEventArgs {
  grantId: string | null
  venueId: string | null
  eventType: TrustAccessEventType
  artifactType: TrustArtifactType | null
  format: TrustArtifactFormat | null
  ip: string | null
  userAgent: string | null
  metadata?: Record<string, unknown> | null
}

export async function recordTrustAccessEvent(
  args: RecordTrustAccessEventArgs
): Promise<void> {
  try {
    const supabase = createServiceClient()
    const { error } = await supabase.from('trust_access_events').insert({
      grant_id: args.grantId,
      venue_id: args.venueId,
      event_type: args.eventType,
      artifact_type: args.artifactType,
      format: args.format,
      ip_hash: maskIpForAudit(args.ip),
      user_agent_hash: maskUserAgent(args.userAgent),
      metadata: args.metadata ?? {},
    })
    if (error) {
      log.warn(
        { err: error, eventType: args.eventType },
        'trust_access_event.insert_failed'
      )
    }
  } catch (err) {
    log.warn({ err }, 'trust_access_event.unexpected')
  }
}

export interface ListAccessEventsFilters {
  venueId: string | null
  grantId?: string | null
  eventType?: TrustAccessEventType | null
  since?: string | null
  occurredBefore?: string | null
  limit?: number
}

export async function listTrustAccessEvents(
  filters: ListAccessEventsFilters
): Promise<{
  generatedAt: string
  events: Array<{
    id: string
    grantId: string | null
    venueId: string | null
    eventType: TrustAccessEventType
    artifactType: TrustArtifactType | null
    format: TrustArtifactFormat | null
    ipHash: string | null
    userAgentHash: string | null
    metadata: Record<string, unknown>
    createdAt: string
  }>
  warnings: string[]
}> {
  const warnings: string[] = []
  const supabase = createServiceClient()
  const limit = Math.min(Math.max(filters.limit ?? 100, 1), 500)
  try {
    let q = supabase
      .from('trust_access_events')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit)
    if (filters.venueId) q = q.eq('venue_id', filters.venueId)
    if (filters.grantId) q = q.eq('grant_id', filters.grantId)
    if (filters.eventType) q = q.eq('event_type', filters.eventType)
    if (filters.since) q = q.gte('created_at', filters.since)
    if (filters.occurredBefore) q = q.lte('created_at', filters.occurredBefore)
    const { data, error } = await q
    if (error) {
      warnings.push(`list_failed:${error.message}`)
      return { generatedAt: new Date().toISOString(), events: [], warnings }
    }
    const events = (data ?? []).map((r) => {
      const row = r as {
        id: string
        grant_id: string | null
        venue_id: string | null
        event_type: string
        artifact_type: string | null
        format: string | null
        ip_hash: string | null
        user_agent_hash: string | null
        metadata: Record<string, unknown> | null
        created_at: string
      }
      return {
        id: row.id,
        grantId: row.grant_id,
        venueId: row.venue_id,
        eventType: row.event_type as TrustAccessEventType,
        artifactType: row.artifact_type as TrustArtifactType | null,
        format: row.format as TrustArtifactFormat | null,
        ipHash: row.ip_hash,
        userAgentHash: row.user_agent_hash,
        metadata: row.metadata ?? {},
        createdAt: row.created_at,
      }
    })
    return { generatedAt: new Date().toISOString(), events, warnings }
  } catch (err) {
    log.error({ err }, 'trust_access_events.list.unexpected')
    captureApiError(err)
    warnings.push('unexpected_error')
    return { generatedAt: new Date().toISOString(), events: [], warnings }
  }
}
