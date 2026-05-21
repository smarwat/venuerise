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
 * Phase 9T-alt — Knowledge Base CRUD (list + create).
 *
 * `/api/venues/[id]/knowledge`
 *   - GET  → `{ items: KnowledgeBaseRow[] }` (any venue member; RLS
 *            already gates SELECT to members via migration 005)
 *   - POST → `{ success: true, item }`            (SALES_ROLES)
 *
 * Per-entry mutations live on the sibling
 * `/[knowledgeId]/route.ts` (PATCH + DELETE).
 *
 * The previous Settings → Knowledge Base UI shipped Add/Toggle/Delete
 * buttons but no routes (Phase 9S audit caught the dead handlers and
 * disabled the surface). 9T-alt brings the routes online + restores
 * the management UI behind the same auth + audit + rate-limit posture
 * as the availability surface.
 *
 * Honesty:
 *   - Knowledge entries influence AI replies via the orchestrator's
 *     KB read. Operator-edited.
 *   - The audit row captures `title`, `category`, `priority`,
 *     `is_active`, and `content_length`; full `content` is NOT
 *     mirrored to the audit feed to keep operator-pasted text out of
 *     the read-from-elsewhere posture. Operators are warned via UI
 *     copy not to paste secrets here.
 */

const TITLE_MAX = 160
const CONTENT_MAX = 8_000
const CATEGORY_MAX = 80
const PRIORITY_MIN = 0
const PRIORITY_MAX = 100

const CreateEntrySchema = z.object({
  title: z.string().trim().min(1, 'title required').max(TITLE_MAX),
  content: z.string().trim().min(1, 'content required').max(CONTENT_MAX),
  category: z.string().trim().min(1).max(CATEGORY_MAX).default('FAQ'),
  priority: z
    .number()
    .int()
    .min(PRIORITY_MIN)
    .max(PRIORITY_MAX)
    .optional()
    .default(5),
  is_active: z.boolean().optional().default(true),
})

const SELECT_COLUMNS =
  'id, venue_id, category, title, content, priority, is_active, created_at, updated_at'

interface RouteContext {
  params: Promise<{ id: string }>
}

export async function GET(
  request: NextRequest,
  { params }: RouteContext
): Promise<Response> {
  const requestId = getOrCreateRequestId(request)
  const respond = <T extends Response>(r: T) =>
    withRequestIdHeader(r, requestId)
  const reqLog = log.child({
    requestId,
    route: '/api/venues/[id]/knowledge',
    op: 'venue.knowledge.list',
  })

  const { id: venueId } = await params
  if (!z.string().uuid().safeParse(venueId).success) {
    return respond(
      NextResponse.json({ error: 'validation_failed' }, { status: 400 })
    )
  }

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return respond(
      NextResponse.json({ error: 'unauthorized' }, { status: 401 })
    )
  }

  // Any venue member can read knowledge entries — they're the same
  // rows the AI orchestrator reads on every conversation turn, and
  // the Settings tab is the operator-facing surface. Cross-tenant
  // forbidden collapses to 404 in line with the rest of the API.
  try {
    await requireVenueRole(user.id, venueId, SALES_ROLES)
  } catch (err) {
    if (err instanceof TenantAccessError) {
      const status = err.status === 403 ? 404 : err.status
      return respond(NextResponse.json({ error: err.code }, { status }))
    }
    throw err
  }

  // Phase 9F — per-user rate limit. List is read-only but the
  // Settings tab can polling-refresh; bucketed per user.
  const rl = await rateLimitUserAction(
    request,
    `venues:knowledge:list:${user.id}`,
    {
      route: '/api/venues/[id]/knowledge',
      method: 'GET',
      userId: user.id,
      venueId,
      requestId,
    }
  )
  if (!rl.allowed) {
    reqLog.warn({ userId: user.id, retryMs: rl.retryAfterMs }, 'rate_limit.blocked')
    return respond(rateLimitedResponse(rl))
  }

  const { data, error } = await supabase
    .from('knowledge_base')
    .select(SELECT_COLUMNS)
    .eq('venue_id', venueId)
    .order('priority', { ascending: false })
    .order('created_at', { ascending: false })
  if (error) {
    reqLog.error({ err: error, venueId }, 'venue.knowledge.list_failed')
    captureApiError(error, {
      requestId,
      route: '/api/venues/[id]/knowledge',
      userId: user.id,
      venueId,
    })
    return respond(
      NextResponse.json({ error: 'unexpected_error' }, { status: 500 })
    )
  }

  return respond(NextResponse.json({ items: data ?? [] }))
}

export async function POST(
  request: NextRequest,
  { params }: RouteContext
): Promise<Response> {
  const requestId = getOrCreateRequestId(request)
  const respond = <T extends Response>(r: T) =>
    withRequestIdHeader(r, requestId)
  const reqLog = log.child({
    requestId,
    route: '/api/venues/[id]/knowledge',
    op: 'venue.knowledge.create',
  })

  const { id: venueId } = await params
  if (!z.string().uuid().safeParse(venueId).success) {
    return respond(
      NextResponse.json({ error: 'validation_failed' }, { status: 400 })
    )
  }

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return respond(
      NextResponse.json({ error: 'unauthorized' }, { status: 401 })
    )
  }

  // SALES_ROLES matches migration 005's RLS write policy on
  // `knowledge_base` (owner / admin / sales_manager / coordinator).
  try {
    await requireVenueRole(user.id, venueId, SALES_ROLES)
  } catch (err) {
    if (err instanceof TenantAccessError) {
      const status = err.status === 403 ? 404 : err.status
      return respond(NextResponse.json({ error: err.code }, { status }))
    }
    throw err
  }

  const rl = await rateLimitUserAction(
    request,
    `venues:knowledge:create:${user.id}`,
    {
      route: '/api/venues/[id]/knowledge',
      method: 'POST',
      userId: user.id,
      venueId,
      requestId,
    }
  )
  if (!rl.allowed) {
    reqLog.warn({ userId: user.id, retryMs: rl.retryAfterMs }, 'rate_limit.blocked')
    return respond(rateLimitedResponse(rl))
  }

  const body = await request.json().catch(() => null)
  const parsed = CreateEntrySchema.safeParse(body ?? {})
  if (!parsed.success) {
    return respond(
      NextResponse.json(
        { error: 'validation_failed', detail: parsed.error.flatten() },
        { status: 400 }
      )
    )
  }

  const { data, error } = await supabase
    .from('knowledge_base')
    .insert({
      venue_id: venueId,
      title: parsed.data.title,
      content: parsed.data.content,
      category: parsed.data.category,
      priority: parsed.data.priority,
      is_active: parsed.data.is_active,
    })
    .select(SELECT_COLUMNS)
    .single()
  if (error) {
    reqLog.error(
      { err: error, venueId },
      'venue.knowledge.create_failed'
    )
    captureApiError(error, {
      requestId,
      route: '/api/venues/[id]/knowledge',
      userId: user.id,
      venueId,
    })
    return respond(
      NextResponse.json({ error: 'unexpected_error' }, { status: 500 })
    )
  }

  // Phase 9T-alt — audit row carries operator-safe metadata only.
  // We deliberately do NOT mirror `content` to the audit feed so
  // operator-pasted text (which might include pricing notes that
  // belong only in the AI context) doesn't leak into the
  // admin-readable audit log. Length is kept so a reviewer can
  // tell if an entry was substantive vs. empty.
  void recordAuditEvent({
    venueId,
    actorUserId: user.id,
    actorKind: 'operator',
    route: '/api/venues/[id]/knowledge',
    action: AUDIT_ACTIONS.KNOWLEDGE_ENTRY_CREATED,
    targetTable: 'knowledge_base',
    targetId: (data as { id?: string } | null)?.id ?? null,
    requestId,
    ip: request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
    userAgent: request.headers.get('user-agent'),
    after: {
      title: parsed.data.title,
      category: parsed.data.category,
      priority: parsed.data.priority,
      is_active: parsed.data.is_active,
      content_length: parsed.data.content.length,
    },
  })

  return respond(NextResponse.json({ success: true, item: data }))
}
