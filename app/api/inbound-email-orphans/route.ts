// Phase 8BQ — List unresolved inbound email orphans for the
// current operator's venue.
//
// Read-only GET. Reuses the existing RLS policy from migration
// 040 (venue sales roles see their venue's rows; NULL-venue
// rows are invisible). We still go through the user-scoped
// Supabase client so RLS is the trust boundary; the API merely
// shapes the payload.
//
// AUDIT_EXEMPT: read-only; no mutating side effects.
// Rate-limit: GET routes are exempt from the rate-limit
// scanner; the underlying Supabase project enforces its own
// PostgREST rate limit.

import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { log } from '@/lib/log'
import {
  getOrCreateRequestId,
  withRequestIdHeader,
} from '@/lib/observability/request-id'
import { toSafeOrphanRow } from '@/lib/integrations/inbound/orphans'

const QuerySchema = z.object({
  status: z
    .enum(['unresolved', 'linked', 'dismissed', 'ignored', 'all'])
    .default('unresolved'),
  limit: z.coerce.number().int().min(1).max(50).default(20),
})

export async function GET(request: NextRequest): Promise<Response> {
  const requestId = getOrCreateRequestId(request)
  const reqLog = log.child({
    requestId,
    route: '/api/inbound-email-orphans',
    op: 'inbound-email-orphans.list',
  })
  const respond = <T extends Response>(r: T) => withRequestIdHeader(r, requestId)

  const supabase = await createClient()
  const {
    data: { user },
    error: userErr,
  } = await supabase.auth.getUser()
  if (userErr || !user) {
    return respond(NextResponse.json({ error: 'unauthorized' }, { status: 401 }))
  }

  const url = new URL(request.url)
  const parsed = QuerySchema.safeParse({
    status: url.searchParams.get('status') ?? undefined,
    limit: url.searchParams.get('limit') ?? undefined,
  })
  if (!parsed.success) {
    return respond(
      NextResponse.json(
        { error: 'invalid_query', detail: parsed.error.flatten() },
        { status: 400 }
      )
    )
  }

  // Build the query. RLS limits to the user's venues + non-null
  // venue_id automatically.
  let q = supabase
    .from('inbound_email_orphans')
    .select(
      'id, status, from_email, from_name, subject, stripped_body, raw_body_preview, received_at, parsed_at, match_confidence, suggested_conversation_ids, suggested_lead_ids, linked_conversation_id, linked_lead_id, linked_message_id, dismissed_at, dismiss_reason'
    )
    .order('created_at', { ascending: false })
    .limit(parsed.data.limit)
  if (parsed.data.status !== 'all') {
    q = q.eq('status', parsed.data.status)
  }

  const { data, error } = await q
  if (error) {
    reqLog.error({ errorMessage: error.message }, 'inbound-email-orphans.list_failed')
    return respond(
      NextResponse.json({ error: 'unexpected_error' }, { status: 500 })
    )
  }

  const rows = (data ?? []) as Array<Record<string, unknown>>
  // Headline counts so the inbox card can show a chip without
  // a second round trip when status='unresolved'.
  const { count: unresolvedCount } = await supabase
    .from('inbound_email_orphans')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'unresolved')

  return respond(
    NextResponse.json({
      orphans: rows.map(toSafeOrphanRow),
      unresolved_count: unresolvedCount ?? 0,
    })
  )
}
