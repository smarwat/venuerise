import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getCurrentVenueForUser } from '@/lib/auth/tenant-access'
import { SALES_ROLES } from '@/lib/auth/roles'
import { rateLimitUserAction, rateLimitedResponse } from '@/lib/rate-limit'
import { log } from '@/lib/log'
import {
  getOrCreateRequestId,
  withRequestIdHeader,
} from '@/lib/observability/request-id'
import { captureApiError } from '@/lib/observability/sentry'
import { format } from 'date-fns'

/**
 * GET /api/dashboard/search  (Phase 8AL → 8AM)
 *
 * Unified backend search for the global CommandPalette. Returns a flat
 * `items[]` list spanning leads, conversations, tours, and (8AM)
 * message bodies that the caller can read. The palette layers these
 * underneath its static command set.
 *
 * Phase 8AM adds the `MESSAGES` group, powered by a pg_trgm GIN index
 * on `messages.content` (migration 021). Match snippets are centered
 * on the query hit and capped at 110 chars.
 *
 * Why a single endpoint instead of three:
 *   - One round-trip from the client → cheaper on the network.
 *   - Centralized auth + venue resolution + rate-limit budget.
 *   - The palette's debounce hits exactly one route — easier to reason
 *     about budget exhaustion (the user types fast).
 *
 * Security posture:
 *   - Authenticated dashboard user (401 unauthorized).
 *   - Caller must have SALES_ROLES on their resolved venue. Sub-SALES
 *     roles (viewer) collapse to `{ items: [] }` rather than 403 so the
 *     palette stays usable for navigation but doesn't surface other
 *     people's leads.
 *   - Rate-limit `dashboard-search:{userId}` — debounced typing on the
 *     palette can fire several queries per second; the standard user-
 *     action limit covers this.
 *   - RLS does the cross-tenant gate at the row level. The route does
 *     NOT use the service client.
 *
 * Result shape (intentionally minimal):
 *   { kind, id, title, subtitle, href, score }
 *
 * Caps:
 *   - max 8 leads
 *   - max 5 conversations
 *   - max 5 tours
 *   - max 5 messages   (Phase 8AM)
 *   - total <= 23 dynamic items
 *
 * Empty `q` (or q.length < 2) → `{ items: [] }`. The palette renders
 * its static command set in that case without a round-trip.
 */

const QuerySchema = z.object({
  q: z.string().min(0).max(80),
})

interface ResultItem {
  id: string
  kind: 'lead' | 'conversation' | 'tour' | 'message'
  title: string
  subtitle: string
  href: string
  score: number
}

/**
 * Phase 8AM — produce a short snippet of `content` centered on the
 * first case-insensitive match of `q`. We collapse whitespace, cap at
 * 110 chars, and ellipsize on either side so the operator sees the
 * matching phrase in context without exposing the full message body.
 */
function buildSnippet(content: string, q: string, maxLen = 110): string {
  if (!content) return ''
  const single = content.replace(/\s+/g, ' ').trim()
  if (single.length <= maxLen) return single
  const lowerContent = single.toLowerCase()
  const lowerQ = q.toLowerCase()
  const matchIdx = lowerContent.indexOf(lowerQ)
  if (matchIdx < 0) {
    // No match in the trimmed/collapsed text (shouldn't happen given
    // the ILIKE predicate, but defensively fall back to head).
    return `${single.slice(0, maxLen - 1)}…`
  }
  const half = Math.floor((maxLen - q.length) / 2)
  let start = Math.max(0, matchIdx - half)
  let end = Math.min(single.length, start + maxLen)
  // Re-anchor if we ran off the end so the snippet still hits maxLen.
  if (end - start < maxLen && start > 0) {
    start = Math.max(0, end - maxLen)
  }
  const prefix = start > 0 ? '…' : ''
  const suffix = end < single.length ? '…' : ''
  return `${prefix}${single.slice(start, end)}${suffix}`
}

// PostgREST `.or()` interprets `,`, `(`, `)` as syntax, so they must be
// stripped from any user-supplied substring before splicing it into the
// filter expression. Backslash-escape ILIKE wildcards (% _) so a query
// like "100%" doesn't degrade into "match anything".
function sanitizeQ(raw: string): string {
  return raw
    .replace(/[\\%_]/g, (m) => `\\${m}`)
    .replace(/[,()]/g, ' ')
    .trim()
}

export async function GET(request: NextRequest): Promise<Response> {
  const requestId = getOrCreateRequestId(request)
  const reqLog = log.child({
    requestId,
    route: '/api/dashboard/search',
    op: 'dashboard.search',
  })
  const respond = <T extends Response>(r: T) =>
    withRequestIdHeader(r, requestId)

  // 1. Auth.
  const supabase = await createClient()
  const {
    data: { user },
    error: userErr,
  } = await supabase.auth.getUser()
  if (userErr || !user) {
    return respond(
      NextResponse.json({ error: 'unauthorized' }, { status: 401 })
    )
  }

  // 2. Parse + cap q early. We accept empty strings (return [] rows) so
  // a caller can probe the route shape without a 400.
  const { searchParams } = new URL(request.url)
  const parsed = QuerySchema.safeParse({
    q: searchParams.get('q') ?? '',
  })
  if (!parsed.success) {
    return respond(
      NextResponse.json({ error: 'validation_failed' }, { status: 400 })
    )
  }
  const trimmed = parsed.data.q.trim()
  // Sub-2-char queries skip the database entirely. Avoids burning the
  // trigram-less ILIKE bandwidth on a one-keystroke debounce flush.
  if (trimmed.length < 2) {
    return respond(NextResponse.json({ items: [] }))
  }

  // 3. Rate-limit BEFORE venue resolution so a torrent of palette
  // keystrokes can't whale on the venue-membership probe.
  const rl = await rateLimitUserAction(
    request,
    `dashboard-search:${user.id}`
  )
  if (!rl.allowed) {
    reqLog.warn(
      { userId: user.id, retryMs: rl.retryAfterMs },
      'rate_limit.blocked'
    )
    return respond(rateLimitedResponse(rl))
  }

  // 4. Venue + role gate. Viewers collapse to an empty result rather
  // than a 403 — the palette stays usable for static navigation, but
  // they don't see other tenants' rows.
  const venue = await getCurrentVenueForUser(user.id)
  if (!venue) {
    return respond(NextResponse.json({ items: [] }))
  }
  if (!(SALES_ROLES as readonly string[]).includes(venue.role)) {
    return respond(NextResponse.json({ items: [] }))
  }
  const venueId = venue.venueId

  // 5. Build the ILIKE wildcard. PostgREST `.or()` takes a single
  // expression string, so we splice the escaped term into ilike clauses
  // per column.
  const esc = sanitizeQ(trimmed)
  if (esc.length < 2) {
    // Sanitization stripped the whole term (e.g. operator typed "()").
    return respond(NextResponse.json({ items: [] }))
  }
  const ilike = `%${esc}%`

  // 6. Fire all four queries in parallel. Per-table caps + RLS make
  // the response bounded; we don't materialize more than ~23 rows.
  try {
    const [leadsRes, convsRes, toursRes, messagesRes] = await Promise.all([
      supabase
        .from('leads')
        .select('id, name, email, phone, stage, updated_at')
        .eq('venue_id', venueId)
        .or(
          `name.ilike.${ilike},email.ilike.${ilike},phone.ilike.${ilike}`
        )
        .order('updated_at', { ascending: false })
        .limit(8),
      // Conversation search is lead-name/email driven (operators
      // search conversations by who they're talking to). We pull
      // `leads(name, email)` via the foreign key + filter on the
      // nested fields via PostgREST's relational ilike syntax. The
      // `!inner` join ensures rows without a lead don't slip through.
      supabase
        .from('conversations')
        .select(
          'id, lead_id, last_message_at, leads!inner(name, email)'
        )
        .eq('venue_id', venueId)
        .or(
          `name.ilike.${ilike},email.ilike.${ilike}`,
          { referencedTable: 'leads' }
        )
        .order('last_message_at', { ascending: false })
        .limit(5),
      supabase
        .from('tours')
        .select(
          'id, lead_id, scheduled_at, status, leads!inner(name, email)'
        )
        .eq('venue_id', venueId)
        .or(
          `name.ilike.${ilike},email.ilike.${ilike}`,
          { referencedTable: 'leads' }
        )
        .order('scheduled_at', { ascending: false })
        .limit(5),
      // Phase 8AM → 8AN — message-body search. The Phase 8AM ILIKE
      // path is replaced by a similarity-ranked RPC
      // (search_messages_for_dashboard, migration 022) so the 5
      // result slots go to the most relevant matches rather than
      // the most recent ones. The RPC is SECURITY DEFINER + service-
      // role-only; we invoke it via the service client AFTER auth +
      // SALES_ROLES + venue resolution have all passed, and the
      // function itself re-asserts `m.venue_id = p_venue_id` as a
      // defense-in-depth boundary.
      createServiceClient().rpc('search_messages_for_dashboard', {
        p_venue_id: venueId,
        p_q: trimmed,
        p_limit: 5,
      }),
    ])

    const items: ResultItem[] = []

    // Leads — primary identifier is the operator's natural "I want
    // Sarah's profile" mental model. Subtitle blends email + stage so
    // duplicate names are disambiguated.
    if (leadsRes.data) {
      for (const raw of leadsRes.data as Array<{
        id: string
        name: string
        email: string
        phone: string | null
        stage: string
      }>) {
        items.push({
          id: `lead:${raw.id}`,
          kind: 'lead',
          title: raw.name,
          subtitle: `${raw.email}${raw.phone ? ` · ${raw.phone}` : ''} · ${raw.stage.replace(/_/g, ' ')}`,
          href: `/dashboard/leads?lead=${encodeURIComponent(raw.id)}`,
          score: 0,
        })
      }
    }

    // Conversations — surfaces the inbox thread for the lead. Same
    // lead always appears as a single conversation row (by design,
    // venues have one conversation per lead today).
    if (convsRes.data) {
      for (const raw of convsRes.data as Array<{
        id: string
        lead_id: string
        last_message_at: string | null
        leads: { name?: string | null; email?: string | null } | null
      }>) {
        const leadName = raw.leads?.name ?? 'Unknown'
        const leadEmail = raw.leads?.email ?? ''
        const stamp = raw.last_message_at
          ? format(new Date(raw.last_message_at), 'MMM d, h:mm a')
          : 'no messages yet'
        items.push({
          id: `conversation:${raw.id}`,
          kind: 'conversation',
          title: `Conversation · ${leadName}`,
          subtitle: leadEmail ? `${leadEmail} · ${stamp}` : stamp,
          href: `/dashboard/inbox/${encodeURIComponent(raw.lead_id)}`,
          score: 0,
        })
      }
    }

    // Tours — deep-link to the audit drawer on the matching month.
    if (toursRes.data) {
      for (const raw of toursRes.data as Array<{
        id: string
        lead_id: string
        scheduled_at: string
        status: string
        leads: { name?: string | null; email?: string | null } | null
      }>) {
        const dt = new Date(raw.scheduled_at)
        const monthSlug = format(dt, 'yyyy-MM')
        const when = format(dt, 'MMM d, h:mm a')
        const leadName = raw.leads?.name ?? 'Unknown'
        items.push({
          id: `tour:${raw.id}`,
          kind: 'tour',
          title: `Tour · ${leadName}`,
          subtitle: `${when} · ${raw.status.replace(/_/g, ' ')}`,
          href: `/dashboard/tours?month=${encodeURIComponent(monthSlug)}&audit_tour=${encodeURIComponent(raw.id)}`,
          score: 0,
        })
      }
    }

    // Phase 8AM → 8AN — message-body matches. RPC returns a flat
    // shape (lead_name / lead_email lifted via the join inside the
    // function) + a `similarity` real that we surface in `score` so
    // a future UI pass can render relevance hints. Snippet still
    // centered on the query hit via `buildSnippet`. Deep-link
    // includes `?message=<id>` so the inbox thread scrolls +
    // highlights on arrival.
    if (messagesRes.data) {
      for (const raw of messagesRes.data as Array<{
        id: string
        conversation_id: string
        lead_id: string
        lead_name: string | null
        lead_email: string | null
        role: string
        content: string
        created_at: string
        similarity: number | null
      }>) {
        const leadName = raw.lead_name ?? 'Unknown'
        const snippet = buildSnippet(raw.content ?? '', trimmed, 110)
        const when = format(new Date(raw.created_at), 'MMM d')
        const roleTag =
          raw.role === 'lead'
            ? 'Lead'
            : raw.role === 'ai'
              ? 'AI'
              : raw.role === 'human'
                ? 'Operator'
                : 'System'
        items.push({
          id: `message:${raw.id}`,
          kind: 'message',
          title: `${leadName} · ${roleTag}`,
          subtitle: `${when} · ${snippet}`,
          href: `/dashboard/inbox/${encodeURIComponent(raw.lead_id)}?message=${encodeURIComponent(raw.id)}`,
          score: typeof raw.similarity === 'number' ? raw.similarity : 0,
        })
      }
    }

    // Hard cap at 23 — the per-table caps already enforce this, but a
    // belt-and-suspenders splice keeps the API contract explicit if a
    // future query expansion forgets to set `.limit(...)`.
    const capped = items.slice(0, 23)

    reqLog.info(
      {
        qLen: trimmed.length,
        leadCount: leadsRes.data?.length ?? 0,
        convCount: convsRes.data?.length ?? 0,
        tourCount: toursRes.data?.length ?? 0,
        messageCount: messagesRes.data?.length ?? 0,
        total: capped.length,
      },
      'dashboard.search.served'
    )

    return respond(NextResponse.json({ items: capped }))
  } catch (err) {
    reqLog.error({ err, q: trimmed }, 'dashboard.search.failed')
    captureApiError(err, {
      requestId,
      route: '/api/dashboard/search',
      userId: user.id,
      venueId,
    })
    // Swallow the failure into an empty result so a transient Postgres
    // hiccup doesn't break the palette UX. The reqLog/Sentry capture
    // preserves operator observability.
    return respond(NextResponse.json({ items: [] }))
  }
}
