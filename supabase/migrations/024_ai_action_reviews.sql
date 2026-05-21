-- ============================================================================
-- Phase 8AZ — Autopilot Shadow Evaluation review storage
--
-- Backs the AutopilotReviewQueue surface on /dashboard/settings/billing
-- (Phase 8AZ). Each row is an operator/admin's verdict on a single
-- ai_actions row where the Phase 8AX autopilot guardrail and the Phase
-- 8AW operator outcome disagreed. The label answers: "was the guardrail
-- wrong, was the operator wrong, or do we not know yet?"
--
-- Critical safety posture (echoes the docs):
--   - Labels DO NOT auto-tune guardrails. A row labeled
--     `confirmed_guardrail_too_strict` does not weaken the
--     `pricing_risk` rule on its own.
--   - Labels DO NOT auto-block operators. A row labeled
--     `confirmed_operator_error` does not change what the operator can
--     send on the next draft.
--   - There is still no autonomous sending. This phase is observation +
--     calibration data collection only.
--
-- Why a dedicated table instead of `ai_actions.metadata`:
--   - reviews have their own audit lifecycle (who labeled, when,
--     whether they changed their mind later)
--   - unique on `ai_action_id` makes "relabel" semantics clear at the
--     storage layer — upsert by `ai_action_id`, not insert-and-pile-up
--   - we can index for queue surfaces without touching the much-hotter
--     ai_actions row
-- ============================================================================

create table if not exists public.ai_action_reviews (
  id uuid primary key default gen_random_uuid(),
  venue_id uuid not null references public.venues(id) on delete cascade,
  ai_action_id uuid not null references public.ai_actions(id) on delete cascade,
  reviewer_user_id uuid references auth.users(id) on delete set null,
  review_state text not null check (
    review_state in (
      'needs_review',
      'confirmed_guardrail_too_strict',
      'confirmed_guardrail_correct',
      'confirmed_operator_error',
      'deferred'
    )
  ),
  note text,
  metadata jsonb not null default '{}'::jsonb,
  reviewed_at timestamptz not null default now(),
  unique (ai_action_id)
);

-- Queue-by-venue: the AutopilotReviewQueue scrolls by `reviewed_at desc`
-- within a single venue. Composite index keeps that path cheap as the
-- table grows.
create index if not exists ai_action_reviews_venue_reviewed_idx
  on public.ai_action_reviews (venue_id, reviewed_at desc);

-- State filter: the queue lets the operator pick "Needs review" / "Too
-- strict" / etc.; the filter chips translate to a `where review_state = …`
-- followed by the same `reviewed_at desc` order.
create index if not exists ai_action_reviews_state_reviewed_idx
  on public.ai_action_reviews (review_state, reviewed_at desc);

-- Lookup-by-action: the queue join + the simulation endpoint both pull
-- the review row for an `ai_action_id`. Unique constraint above already
-- creates this implicitly, but keeping an explicit index here makes the
-- intent obvious to a future reader.
create index if not exists ai_action_reviews_action_idx
  on public.ai_action_reviews (ai_action_id);

-- ---------------------------------------------------------------------------
-- RLS — SELECT for venue admins/owners; writes go through the service-role
-- route after explicit requireAdmin + requireVenueRole checks.
-- ---------------------------------------------------------------------------

alter table public.ai_action_reviews enable row level security;

drop policy if exists "ai_action_reviews_select_venue_admin"
  on public.ai_action_reviews;

create policy "ai_action_reviews_select_venue_admin"
  on public.ai_action_reviews
  for select
  using (
    public.has_venue_role(venue_id, auth.uid(), array['owner', 'admin'])
  );

-- No INSERT/UPDATE/DELETE policies are defined. Writes happen via
-- `service_role` in the admin POST route at
-- `/api/admin/ai/autopilot-reviews/[aiActionId]`, which performs its own
-- `requireAdmin()` + `requireVenueRole(ADMIN_ROLES)` + cross-tenant
-- collapse-to-404. Authenticated browser clients can read (above) but
-- never write directly.

-- Down (commented; do not run unless explicitly requested):
-- drop policy if exists "ai_action_reviews_select_venue_admin"
--   on public.ai_action_reviews;
-- drop index if exists public.ai_action_reviews_action_idx;
-- drop index if exists public.ai_action_reviews_state_reviewed_idx;
-- drop index if exists public.ai_action_reviews_venue_reviewed_idx;
-- drop table if exists public.ai_action_reviews;
