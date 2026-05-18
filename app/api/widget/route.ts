import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { signInternalRequest, INTERNAL_SIGNATURE_HEADER } from '@/lib/auth/internal-hmac'
import { z } from 'zod'

const isDev = process.env.NODE_ENV === 'development'

const WidgetLeadSchema = z.object({
  venue_id: z.string().uuid(),
  name: z.string().min(1).max(100),
  email: z.string().email(),
  phone: z.string().optional().nullable(),
  event_date: z.string().optional().nullable(),
  guest_count: z.number().int().min(1).max(10000).optional().nullable(),
  budget: z.number().min(0).optional().nullable(),
  message: z.string().optional().nullable(),
})

function devError(error: string, detail?: unknown) {
  if (isDev) return { error, detail }
  return { error }
}

export async function POST(request: NextRequest) {
  // 0. Verify env is loaded
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    if (isDev) {
      console.error('[widget] Missing Supabase env vars', {
        hasUrl: !!process.env.NEXT_PUBLIC_SUPABASE_URL,
        hasServiceKey: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
      })
    }
    return NextResponse.json(
      devError('Server not configured', 'Supabase env vars missing — check .env.local'),
      { status: 500 }
    )
  }

  const supabase = createServiceClient()

  // 1. Parse JSON
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json(devError('Invalid JSON'), { status: 400 })
  }

  if (isDev) {
    const b = body as Record<string, unknown> | null
    console.log('[widget] incoming venue_id:', b?.venue_id, 'email:', b?.email)
  }

  // 2. Validate schema
  const parsed = WidgetLeadSchema.safeParse(body)
  if (!parsed.success) {
    if (isDev) console.error('[widget] schema validation failed:', parsed.error.flatten())
    return NextResponse.json(devError('Invalid payload', parsed.error.flatten()), { status: 400 })
  }

  const { venue_id, name, email, phone, event_date, guest_count, budget, message } = parsed.data

  // 3. Look up venue — distinguish "doesn't exist" vs. "inactive" vs. "db error"
  const { data: venueRow, error: venueErr } = await supabase
    .from('venues')
    .select('id, is_active, name')
    .eq('id', venue_id)
    .maybeSingle()

  if (venueErr) {
    if (isDev) console.error('[widget] Supabase venue lookup error:', venueErr)
    return NextResponse.json(
      devError('Database error while looking up venue', venueErr.message),
      { status: 500 }
    )
  }

  if (!venueRow) {
    if (isDev) console.warn('[widget] No venue with id:', venue_id)
    return NextResponse.json(
      devError(
        'Venue not found',
        `No venue exists with id ${venue_id}. Create one in Supabase or use a different venue_id.`
      ),
      { status: 404 }
    )
  }

  const venue = venueRow as { id: string; is_active: boolean; name: string }

  if (!venue.is_active) {
    if (isDev) console.warn('[widget] Venue exists but is_active=false:', venue.name)
    return NextResponse.json(
      devError(
        'Venue is inactive',
        `Venue "${venue.name}" exists but has is_active=false. Set venues.is_active=true in Supabase.`
      ),
      { status: 403 }
    )
  }

  // 4. Create lead
  const { data: lead, error: leadErr } = await supabase
    .from('leads')
    .insert({
      venue_id,
      name,
      email,
      phone: phone ?? null,
      event_date: event_date ?? null,
      guest_count: guest_count ?? null,
      budget: budget ?? null,
      notes: message ?? null,
      source: 'widget',
      stage: 'new_inquiry',
      lead_score: 0,
      urgency: 'medium',
      ai_active: true,
    })
    .select('id')
    .single()

  if (leadErr || !lead) {
    if (isDev) console.error('[widget] lead insert failed:', leadErr)
    return NextResponse.json(devError('Failed to save lead', leadErr?.message), { status: 500 })
  }

  const leadData = lead as { id: string }

  // 5. Pre-create the conversation row so we can return its id immediately.
  //    The orchestrator is idempotent: if a conversation for this lead already
  //    exists, it will reuse it rather than create a duplicate.
  const { data: conv, error: convErr } = await supabase
    .from('conversations')
    .insert({
      lead_id: leadData.id,
      venue_id,
      sentiment: 'neutral',
      unread_count: 0,
    })
    .select('id')
    .single()

  if (convErr || !conv) {
    // Non-fatal — orchestrator will create one if missing — but log loudly.
    if (isDev) console.error('[widget] conversation pre-create failed (non-fatal):', convErr)
  }

  const conversationId = (conv as { id: string } | null)?.id ?? null

  if (isDev) {
    console.log('[widget] lead created:', leadData.id, 'conv:', conversationId, 'venue:', venue.name)
  }

  // 6. Trigger AI qualification via signed internal call (NOT user-session auth).
  //    Fire-and-forget — the response is returned to the visitor immediately.
  //    This is a temporary bridge until a job queue replaces it.
  triggerQualificationInternal(leadData.id, conversationId)

  return NextResponse.json(
    { success: true, lead_id: leadData.id, conversation_id: conversationId },
    { status: 201 }
  )
}

/**
 * Fire-and-forget signed POST to /api/ai/qualify. Errors are logged in dev
 * but never block the widget response. When this is replaced by a job queue,
 * the only change here will be `await queue.enqueue('qualify-lead', payload)`.
 */
function triggerQualificationInternal(leadId: string, conversationId: string | null) {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000'

  const payload = {
    lead_id: leadId,
    conversation_id: conversationId,
    source: 'internal_widget' as const,
  }

  let signature: string
  try {
    signature = signInternalRequest(payload)
  } catch (err) {
    // Missing INTERNAL_API_SECRET — surface loudly in dev so the operator
    // notices the AI pipeline is dead in the water.
    if (isDev) {
      console.error(
        '[widget] cannot sign internal qualify request — INTERNAL_API_SECRET missing or invalid:',
        err instanceof Error ? err.message : err
      )
    } else {
      console.error('[widget] internal signing failed')
    }
    return
  }

  fetch(`${appUrl}/api/ai/qualify`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      [INTERNAL_SIGNATURE_HEADER]: signature,
    },
    body: JSON.stringify(payload),
  })
    .then(async (res) => {
      if (!res.ok && isDev) {
        const text = await res.text().catch(() => '<unreadable>')
        console.error('[widget] qualify trigger returned', res.status, text)
      }
    })
    .catch((err) => {
      // Network/dns failure. Log but never throw.
      if (isDev) console.error('[widget] qualify trigger network error:', err)
      else console.error('[widget] qualify trigger failed')
    })
}
