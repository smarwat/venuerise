import 'server-only'
import { createServiceClient } from '@/lib/supabase/service'
import { log } from '@/lib/log'
import { captureApiError } from '@/lib/observability/sentry'
import { OnboardingPayloadSchema } from './onboarding-schema'

/**
 * Phase 6C — workspace creation service.
 *
 * Wraps "turn an authenticated user with no data into a usable venue
 * tenant" into a single call. The dashboard, widget, and AI orchestrator
 * all assume the calling user has:
 *   - exactly one row in `venues` (their workspace)
 *   - a matching `venue_members` row with role='owner'
 *   - some starter `knowledge_base` rows the AI can cite
 *   - some `tour_availability` slots so the tour suggester has something to offer
 *
 * This service is the supported way to bootstrap all of that.
 *
 * TRANSACTIONALITY:
 *   Supabase-JS doesn't expose multi-statement transactions over PostgREST.
 *   We compensate two ways:
 *     1. Idempotency check up front — if the user already has a venue,
 *        we return the existing id and skip every write. Safe to retry.
 *     2. Cleanup-on-failure for the most damaging step (the venue insert
 *        succeeded but the owner-member insert failed). We delete the
 *        orphan venue so the next retry isn't blocked by a half-built tenant.
 *
 *   KB and tour_availability inserts are best-effort: if they fail, the
 *   venue + membership still exist and the workspace is usable — the user
 *   just sees an empty KB / no default tour slots until they author their
 *   own. We log + capture but do NOT roll back.
 *
 * SERVICE-ROLE USAGE:
 *   The very first insert into `venue_members` happens BEFORE the user is
 *   a member of anything, so the user-scoped client cannot pass RLS for
 *   that row. We use the service-role client for every write here. This
 *   module is `server-only` so the service-role import cannot leak.
 *
 * Errors throw `OnboardingError` which the route layer maps to HTTP status.
 */

export type OnboardingErrorCode =
  | 'validation_failed'
  | 'venue_insert_failed'
  | 'member_insert_failed'

export class OnboardingError extends Error {
  constructor(
    public readonly code: OnboardingErrorCode,
    public readonly status: 400 | 500,
    public readonly detail?: unknown
  ) {
    super(code)
    this.name = 'OnboardingError'
  }
}

export interface CreateWorkspaceArgs {
  userId: string
  email: string | null
  payload: unknown
  requestId?: string
}

export interface CreateWorkspaceResult {
  venue_id: string
  already_exists: boolean
}

// ---------------------------------------------------------------------------
// Starter content helpers (kept local so the schema knobs above stay tight)
// ---------------------------------------------------------------------------

function starterKnowledgeBase(
  venueId: string,
  args: {
    base_price: number
    capacity_min: number
    capacity_max: number
  }
) {
  return [
    {
      venue_id: venueId,
      category: 'pricing',
      title: 'Pricing overview',
      content: `Our base venue rental fee starts at $${args.base_price.toLocaleString()}. ` +
        `Additional charges may apply for guest counts above the included headcount, ` +
        `peak Saturday dates, and add-on services. We share a full quote after the tour.`,
      priority: 10,
    },
    {
      venue_id: venueId,
      category: 'capacity',
      title: 'Guest capacity',
      content: `We comfortably host ${args.capacity_min}–${args.capacity_max} guests ` +
        `with seated dining and a dance floor. Standing receptions can run larger.`,
      priority: 9,
    },
    {
      venue_id: venueId,
      category: 'tours',
      title: 'Tour scheduling',
      content: 'Tours run Monday–Friday during business hours. We can usually offer ' +
        'something within 5–7 days. Saturday tours are available by request when the venue is not booked.',
      priority: 8,
    },
    {
      venue_id: venueId,
      category: 'payments',
      title: 'Deposits & payments',
      content: 'A non-refundable deposit (typically 25% of the venue fee) secures your date. ' +
        'The remaining balance is due 30 days before the event. We accept ACH and major credit cards.',
      priority: 7,
    },
    {
      venue_id: venueId,
      category: 'catering',
      title: 'Catering & vendor policy',
      content: 'You may bring your own licensed caterer or select from our preferred vendor list. ' +
        'Outside alcohol is permitted with a licensed bartender. Our team handles setup and breakdown.',
      priority: 6,
    },
  ]
}

function starterTourAvailability(venueId: string) {
  // day_of_week: 0=Sun, 1=Mon, ..., 5=Fri, 6=Sat
  const weekdays = [1, 2, 3, 4] // Mon–Thu, 10:00–17:00
  const friday = 5              // Fri, 10:00–15:00

  return [
    ...weekdays.map((dow) => ({
      venue_id: venueId,
      day_of_week: dow,
      start_time: '10:00:00',
      end_time: '17:00:00',
      is_active: true,
    })),
    {
      venue_id: venueId,
      day_of_week: friday,
      start_time: '10:00:00',
      end_time: '15:00:00',
      is_active: true,
    },
  ]
}

// ---------------------------------------------------------------------------
// createWorkspaceForUser
// ---------------------------------------------------------------------------

export async function createWorkspaceForUser(
  args: CreateWorkspaceArgs
): Promise<CreateWorkspaceResult> {
  const { userId, payload, requestId } = args
  const reqLog = log.child({ requestId, userId, op: 'onboarding.create_workspace' })

  // 1. Validate
  const parsed = OnboardingPayloadSchema.safeParse(payload)
  if (!parsed.success) {
    reqLog.warn({ issues: parsed.error.flatten() }, 'onboarding.validation_failed')
    throw new OnboardingError('validation_failed', 400, parsed.error.flatten())
  }
  const data = parsed.data

  const svc = createServiceClient()

  // 2. Idempotency — membership row wins.
  const { data: existingMember } = await svc
    .from('venue_members')
    .select('venue_id')
    .eq('user_id', userId)
    .order('created_at')
    .limit(1)
    .maybeSingle()

  if (existingMember) {
    const venueId = (existingMember as { venue_id: string }).venue_id
    reqLog.info({ venueId }, 'onboarding.already_exists_membership')
    return { venue_id: venueId, already_exists: true }
  }

  // 2b. Legacy fallback — user owns a venue but has no membership row yet
  //     (e.g. created before Phase 6A seed ran for them). Seed the member
  //     row and return; don't create a duplicate venue.
  const { data: legacyVenue } = await svc
    .from('venues')
    .select('id')
    .eq('owner_user_id', userId)
    .order('created_at')
    .limit(1)
    .maybeSingle()

  if (legacyVenue) {
    const venueId = (legacyVenue as { id: string }).id
    const { error: seedErr } = await svc
      .from('venue_members')
      .upsert(
        { venue_id: venueId, user_id: userId, role: 'owner' },
        { onConflict: 'venue_id,user_id' }
      )
    if (seedErr) {
      reqLog.error(
        { err: seedErr, venueId },
        'onboarding.legacy_member_seed_failed'
      )
      captureApiError(seedErr, { requestId, route: 'onboarding', userId, venueId })
      // Still report already_exists so retries are stable; the venue is there.
    } else {
      reqLog.info({ venueId }, 'onboarding.legacy_venue_seeded')
    }
    return { venue_id: venueId, already_exists: true }
  }

  // 3. Create venue
  const { data: venueRow, error: venueErr } = await svc
    .from('venues')
    .insert({
      owner_user_id: userId,
      name: data.venue_name,
      description: data.description,
      capacity_min: data.capacity_min,
      capacity_max: data.capacity_max,
      base_price: data.base_price,
      price_per_guest: data.price_per_guest ?? null,
      style_tags: data.style_tags,
      amenities: data.amenities,
      timezone: data.timezone,
      ai_persona_name: data.ai_persona_name,
      ai_tone: data.ai_tone,
    })
    .select('id')
    .single()

  if (venueErr || !venueRow) {
    reqLog.error({ err: venueErr }, 'onboarding.venue_insert_failed')
    captureApiError(venueErr, { requestId, route: 'onboarding', userId })
    throw new OnboardingError('venue_insert_failed', 500, venueErr?.message)
  }
  const venueId = (venueRow as { id: string }).id

  // 4. Create owner member row. Cleanup the orphan venue if this fails.
  const { error: memErr } = await svc
    .from('venue_members')
    .insert({ venue_id: venueId, user_id: userId, role: 'owner' })

  if (memErr) {
    reqLog.error(
      { err: memErr, venueId },
      'onboarding.member_insert_failed'
    )
    const { error: cleanupErr } = await svc
      .from('venues')
      .delete()
      .eq('id', venueId)
    if (cleanupErr) {
      // Surface in observability — operator may need to manually remove.
      reqLog.error(
        { err: cleanupErr, venueId },
        'onboarding.cleanup_failed'
      )
      captureApiError(cleanupErr, {
        requestId,
        route: 'onboarding',
        userId,
        venueId,
      })
    }
    captureApiError(memErr, { requestId, route: 'onboarding', userId, venueId })
    throw new OnboardingError('member_insert_failed', 500, memErr.message)
  }

  // 5. Seed knowledge base (best-effort)
  const kbRows = starterKnowledgeBase(venueId, {
    base_price: data.base_price,
    capacity_min: data.capacity_min,
    capacity_max: data.capacity_max,
  })
  const { error: kbErr } = await svc.from('knowledge_base').insert(kbRows)
  if (kbErr) {
    reqLog.warn(
      { err: kbErr, venueId },
      'onboarding.knowledge_base_seed_failed'
    )
    captureApiError(kbErr, { requestId, route: 'onboarding', userId, venueId })
  }

  // 6. Seed tour availability (best-effort)
  const slots = starterTourAvailability(venueId)
  const { error: taErr } = await svc.from('tour_availability').insert(slots)
  if (taErr) {
    reqLog.warn(
      { err: taErr, venueId },
      'onboarding.tour_availability_seed_failed'
    )
    captureApiError(taErr, { requestId, route: 'onboarding', userId, venueId })
  }

  reqLog.info(
    { venueId, kbCount: kbRows.length, slotCount: slots.length },
    'onboarding.created'
  )
  return { venue_id: venueId, already_exists: false }
}
