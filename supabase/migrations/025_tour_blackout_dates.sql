-- ============================================================================
-- Phase 8BC — Tour blackout dates
--
-- Backs the "Blackout dates" section of Settings → Availability and the
-- `blackoutDates` argument of `suggestTourSlots`. Operators add a row
-- per calendar date they want to block out (holidays, private events,
-- closures) — the slot-suggestion helper drops any candidate whose
-- local date matches one of these rows.
--
-- Safety posture (echoes the docs):
--   - Blackouts only AFFECT SUGGESTIONS. They do NOT cancel existing
--     tours, do NOT block the operator from manually scheduling a
--     tour on a blackout date, and do NOT touch the lead → message
--     send path.
--   - Per-venue. No global blackouts. Cross-tenant isolation enforced
--     by the foreign key + RLS (mirrors `tour_availability`).
--
-- Why a dedicated table instead of `venues.metadata.revenue_os`:
--   - blackouts can churn (operator adds 8 holidays at start of year);
--     metadata writes are pessimistic and re-serialize the whole jsonb
--   - unique `(venue_id, blackout_date)` is enforceable at the storage
--     layer here; jsonb dedup would be brittle
--   - keeps the Settings → Availability tab queryable without
--     re-parsing a metadata blob
-- ============================================================================

create table if not exists public.tour_blackouts (
  id uuid primary key default gen_random_uuid(),
  venue_id uuid not null references public.venues(id) on delete cascade,
  blackout_date date not null,
  reason text,
  created_at timestamptz not null default now(),
  unique (venue_id, blackout_date)
);

-- Lookup-by-venue + date-range: the LeadDetailDrawer reads the next 60
-- days of blackouts for the venue; the settings card lists all rows
-- for the venue. Both paths benefit from the composite index over
-- venue_id + blackout_date.
create index if not exists tour_blackouts_venue_date_idx
  on public.tour_blackouts (venue_id, blackout_date);

-- ---------------------------------------------------------------------------
-- RLS — mirrors tour_availability:
--   SELECT for sales-role members (so the LeadDetailDrawer + Settings
--   card can read in-browser).
--   INSERT/UPDATE/DELETE for owner/admin only — coordinators don't
--   manage blackouts. Service-role bypasses RLS for the admin routes.
-- ---------------------------------------------------------------------------

alter table public.tour_blackouts enable row level security;

drop policy if exists "tour_blackouts: select for sales roles"
  on public.tour_blackouts;
create policy "tour_blackouts: select for sales roles"
  on public.tour_blackouts
  for select
  using (
    public.has_venue_role(
      venue_id,
      auth.uid(),
      array['owner', 'admin', 'sales_manager', 'coordinator']
    )
  );

drop policy if exists "tour_blackouts: insert for admins"
  on public.tour_blackouts;
create policy "tour_blackouts: insert for admins"
  on public.tour_blackouts
  for insert
  with check (
    public.has_venue_role(venue_id, auth.uid(), array['owner', 'admin'])
  );

drop policy if exists "tour_blackouts: update for admins"
  on public.tour_blackouts;
create policy "tour_blackouts: update for admins"
  on public.tour_blackouts
  for update
  using (
    public.has_venue_role(venue_id, auth.uid(), array['owner', 'admin'])
  )
  with check (
    public.has_venue_role(venue_id, auth.uid(), array['owner', 'admin'])
  );

drop policy if exists "tour_blackouts: delete for admins"
  on public.tour_blackouts;
create policy "tour_blackouts: delete for admins"
  on public.tour_blackouts
  for delete
  using (
    public.has_venue_role(venue_id, auth.uid(), array['owner', 'admin'])
  );

-- Rollback (commented; do not run unless explicitly requested):
-- drop policy if exists "tour_blackouts: delete for admins"
--   on public.tour_blackouts;
-- drop policy if exists "tour_blackouts: update for admins"
--   on public.tour_blackouts;
-- drop policy if exists "tour_blackouts: insert for admins"
--   on public.tour_blackouts;
-- drop policy if exists "tour_blackouts: select for sales roles"
--   on public.tour_blackouts;
-- drop index if exists public.tour_blackouts_venue_date_idx;
-- drop table if exists public.tour_blackouts;
