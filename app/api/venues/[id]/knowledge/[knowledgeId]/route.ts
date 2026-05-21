import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import {
  requireVenueRole,
  TenantAccessError,
} from '@/lib/auth/tenant-access'
import { SALES_ROLES } from '@/lib/auth/roles'
import {
  getOrCreateRequestId,
  withRequestIdHeader,
} from '@/lib/observability/request-id'
import { captureApiError } from '@/lib/observability/sentry'
import { log } from '@/lib/log'
import { recordAuditEvent } from '@/lib/enterprise/audit-events'
import { AUDIT_ACTIONS } from '@/lib/enterprise/audit-actions'
import { rateLimitUserAction, rateLimitedResponse } from '@/lib/rate-limit'

/**
 * Phase 9T-alt — Knowledge Base per-entry mutations.
 *
 * `/api/venues/[id]/knowledge/[knowledgeId]`
 *   - PATCH  — partial update (title / content / category /
 *              priority / is_active). Empty bodies are rejected.
 *              When only `is_active` flips we record the action as
 *              `KNOWLEDGE_ENTRY_TOGGLED` so admins can tell a
 *              quick enable/disable apart from a substantive edit.
 *   - DELETE — remove the row.
 *
 * Cross-tenant safety mirrors the availability route: verify both
 * that the caller has SALES_ROLES on the URL venue AND that the
 * entry row belongs to that venue. Mismatch collapses to 404.
 */

const TITLE_MAX = 160
const CONTENT_MAX = 8_000
const CATEGORY_MAX = 80
const PRIORITY_MIN = 0
const PRIORITY_MAX = 100

const UpdateEntrySchema = z.object({
  title: z.string().trim().min(1).max(TITLE_MAX).optional(),
  content: z.string().trim().min(1).max(CONTENT_MAX).optional(),
  category: z.string().trim().min(1).max(CATEGORY_MAX).optional(),
  priority: z.number().int().min(PRIORITY_MIN).max(PRIORITY_MAX).optional(),
  is_active: z.boolean().optional(),
})

const SELECT_COLUMNS =
  'id, venue_id, category, title, content, priority, is_active, created_at, updated_at'

interface RouteContext {
  params: Promise<{ id: string; knowledgeId: string }>
}

interface AuthorizedContext {
  ok: true
  userId: string
  venueId: string
  knowledgeId: string
  previous: KnowledgeRow
}

interface KnowledgeRow {
  id: string
  venue_id: string
  category: string
  title: string
  content: string
  priority: number
  is_active: boolean
  created_at: string
  updated_at: string
}

async function authorize(
  request: NextRequest,
  context: RouteContext
): Promise<AuthorizedContext | { ok: false; response: Response }> {
  const requestId = getOrCreateRequestId(request)
  const respond = <T extends Response>(r: T) =>
    withRequestIdHeader(r, requestId)
  const { id: venueId, knowledgeId } = await context.params
  if (
    !z.string().uuid().safeParse(venueId).success ||
    !z.string().uuid().safeParse(knowledgeId).success
  ) {
    return {
      ok: false,
      response: respond(
        NextResponse.json({ error: 'validation_failed' }, { status: 400 })
      ),
    }
  }
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return {
      ok: false,
      response: respond(
        NextResponse.json({ error: 'unauthorized' }, { status: 401 })
      ),
    }
  }
  try {
    await requireVenueRole(user.id, venueId, SALES_ROLES)
  } catch (err) {
    if (err instanceof TenantAccessError) {
      const status = err.status === 403 ? 404 : err.status
      return {
        ok: false,
        response: respond(
          NextResponse.json({ error: err.code }, { status })
        ),
      }
    }
    throw err
  }
  // Cross-tenant guard: ensure the entry belongs to the URL venue.
  // Mismatch (entry exists but on a different venue) collapses to 404
  // so we don't leak existence across tenants.
  const { data: row } = await supabase
    .from('knowledge_base')
    .select(SELECT_COLUMNS)
    .eq('id', knowledgeId)
    .maybeSingle()
  if (!row || (row as { venue_id: string }).venue_id !== venueId) {
    return {
      ok: false,
      response: respond(
        NextResponse.json({ error: 'not_found' }, { status: 404 })
      ),
    }
  }
  return {
    ok: true,
    userId: user.id,
    venueId,
    knowledgeId,
    previous: row as KnowledgeRow,
  }
}

export async function PATCH(
  request: NextRequest,
  context: RouteContext
): Promise<Response> {
  const requestId = getOrCreateRequestId(request)
  const respond = <T extends Response>(r: T) =>
    withRequestIdHeader(r, requestId)
  const reqLog = log.child({
    requestId,
    route: '/api/venues/[id]/knowledge/[knowledgeId]',
    op: 'venue.knowledge.update',
  })

  const auth = await authorize(request, context)
  if (!auth.ok) return auth.response
  const { userId, venueId, knowledgeId, previous } = auth

  const rl = await rateLimitUserAction(
    request,
    `venues:knowledge:update:${userId}`,
    {
      route: '/api/venues/[id]/knowledge/[knowledgeId]',
      method: 'PATCH',
      userId,
      venueId,
      requestId,
    }
  )
  if (!rl.allowed) {
    reqLog.warn({ userId, retryMs: rl.retryAfterMs }, 'rate_limit.blocked')
    return respond(rateLimitedResponse(rl))
  }

  const body = await request.json().catch(() => null)
  const parsed = UpdateEntrySchema.safeParse(body ?? {})
  if (!parsed.success) {
    return respond(
      NextResponse.json(
        { error: 'validation_failed', detail: parsed.error.flatten() },
        { status: 400 }
      )
    )
  }

  const patch: Record<string, unknown> = {}
  if (parsed.data.title !== undefined) patch.title = parsed.data.title
  if (parsed.data.content !== undefined) patch.content = parsed.data.content
  if (parsed.data.category !== undefined) patch.category = parsed.data.category
  if (parsed.data.priority !== undefined) patch.priority = parsed.data.priority
  if (parsed.data.is_active !== undefined) patch.is_active = parsed.data.is_active
  if (Object.keys(patch).length === 0) {
    return respond(
      NextResponse.json(
        { error: 'validation_failed', detail: 'no fields to update' },
        { status: 400 }
      )
    )
  }

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('knowledge_base')
    .update(patch)
    .eq('id', knowledgeId)
    .eq('venue_id', venueId)
    .select(SELECT_COLUMNS)
    .single()
  if (error) {
    reqLog.error(
      { err: error, venueId, knowledgeId },
      'venue.knowledge.update_failed'
    )
    captureApiError(error, {
      requestId,
      route: '/api/venues/[id]/knowledge/[knowledgeId]',
      userId,
      venueId,
    })
    return respond(
      NextResponse.json({ error: 'unexpected_error' }, { status: 500 })
    )
  }

  // Phase 9T-alt — when the only changed field is `is_active`, log a
  // distinct `KNOWLEDGE_ENTRY_TOGGLED` action so admins can filter
  // enable/disable churn apart from substantive content edits. Both
  // actions carry the same before/after metadata shape.
  const isToggleOnly =
    Object.keys(patch).length === 1 && 'is_active' in patch
  const action = isToggleOnly
    ? AUDIT_ACTIONS.KNOWLEDGE_ENTRY_TOGGLED
    : AUDIT_ACTIONS.KNOWLEDGE_ENTRY_UPDATED
  const updated = data as KnowledgeRow
  void recordAuditEvent({
    venueId,
    actorUserId: userId,
    actorKind: 'operator',
    route: '/api/venues/[id]/knowledge/[knowledgeId]',
    action,
    targetTable: 'knowledge_base',
    targetId: knowledgeId,
    requestId,
    ip: request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
    userAgent: request.headers.get('user-agent'),
    before: {
      title: previous.title,
      category: previous.category,
      priority: previous.priority,
      is_active: previous.is_active,
      content_length: previous.content?.length ?? 0,
    },
    after: {
      title: updated.title,
      category: updated.category,
      priority: updated.priority,
      is_active: updated.is_active,
      content_length: updated.content?.length ?? 0,
    },
    metadata: { fields: Object.keys(patch) },
  })
  return respond(NextResponse.json({ success: true, item: data }))
}

export async function DELETE(
  request: NextRequest,
  context: RouteContext
): Promise<Response> {
  const requestId = getOrCreateRequestId(request)
  const respond = <T extends Response>(r: T) =>
    withRequestIdHeader(r, requestId)
  const reqLog = log.child({
    requestId,
    route: '/api/venues/[id]/knowledge/[knowledgeId]',
    op: 'venue.knowledge.delete',
  })

  const auth = await authorize(request, context)
  if (!auth.ok) return auth.response
  const { userId, venueId, knowledgeId, previous } = auth

  const rl = await rateLimitUserAction(
    request,
    `venues:knowledge:delete:${userId}`,
    {
      route: '/api/venues/[id]/knowledge/[knowledgeId]',
      method: 'DELETE',
      userId,
      venueId,
      requestId,
    }
  )
  if (!rl.allowed) {
    reqLog.warn({ userId, retryMs: rl.retryAfterMs }, 'rate_limit.blocked')
    return respond(rateLimitedResponse(rl))
  }

  const supabase = await createClient()
  const { error } = await supabase
    .from('knowledge_base')
    .delete()
    .eq('id', knowledgeId)
    .eq('venue_id', venueId)
  if (error) {
    reqLog.error(
      { err: error, venueId, knowledgeId },
      'venue.knowledge.delete_failed'
    )
    captureApiError(error, {
      requestId,
      route: '/api/venues/[id]/knowledge/[knowledgeId]',
      userId,
      venueId,
    })
    return respond(
      NextResponse.json({ error: 'unexpected_error' }, { status: 500 })
    )
  }
  void recordAuditEvent({
    venueId,
    actorUserId: userId,
    actorKind: 'operator',
    route: '/api/venues/[id]/knowledge/[knowledgeId]',
    action: AUDIT_ACTIONS.KNOWLEDGE_ENTRY_DELETED,
    targetTable: 'knowledge_base',
    targetId: knowledgeId,
    requestId,
    ip: request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
    userAgent: request.headers.get('user-agent'),
    before: {
      title: previous.title,
      category: previous.category,
      priority: previous.priority,
      is_active: previous.is_active,
      content_length: previous.content?.length ?? 0,
    },
  })
  return respond(NextResponse.json({ success: true }))
}
