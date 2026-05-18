-- ============================================================================
-- VAOS — Phase 6B
-- Migration: 005_widen_rls_to_members.sql
--
-- Widens RLS on every tenant-scoped table to honor `venue_members` (added in
-- migration 004) instead of the legacy `venues.owner_user_id` chain.
--
-- SAFETY PATTERN (applied to each table):
--   1. CREATE the new member-aware policies (additive — Postgres OR's them).
--   2. DROP the legacy "venue owner access" policy.
--   Net effect: at no point in the migration does the table lose its
--   RLS coverage. If step 2 fails, the table is over-permissive for a
--   moment (members AND legacy owners both allowed) which is safer than
--   the inverse.
--
-- ROLE MODEL:
--   SELECT  → any member (READONLY_ROLES — every role can read)
--   WRITE   → SALES_ROLES = owner | admin | sales_manager | coordinator
--   System tables (ai_actions, outbound_messages) → SELECT for members,
--                                                   writes service-role only
--   venues UPDATE → ADMIN_ROLES = owner | admin
--
-- BACKWARD COMPATIBILITY:
--   `venues` SELECT keeps an OR for `owner_user_id = auth.uid()` so any
--   future venue created before its membership row is seeded still works.
--   The other tables don't need the OR because Phase 6A seeded every
--   existing owner into venue_members.
--
-- NOTHING IS DROPPED:
--   `venues.owner_user_id` stays. Service-role writes stay. Existing
--   policies on venue_members / venue_invitations from migration 004 stay.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- venues
-- ----------------------------------------------------------------------------

-- SELECT: members OR legacy owner (so a venue without a members row still
-- shows up — defense against a misconfigured seed).
drop policy if exists "venues: select for members or owner" on public.venues;
create policy "venues: select for members or owner"
  on public.venues
  for select
  to authenticated
  using (
    public.is_venue_member(id, auth.uid())
    or owner_user_id = auth.uid()
  );

-- INSERT: owner_user_id = auth.uid(). New-venue creation goes via the user's
-- own row so they own it from inception. (No write role check yet because
-- the user is creating the venue — they're not yet a "member of it".)
drop policy if exists "venues: insert by authed user" on public.venues;
create policy "venues: insert by authed user"
  on public.venues
  for insert
  to authenticated
  with check ( owner_user_id = auth.uid() );

-- UPDATE: ADMIN_ROLES only — destructive settings changes.
drop policy if exists "venues: update for admin roles" on public.venues;
create policy "venues: update for admin roles"
  on public.venues
  for update
  to authenticated
  using      ( public.has_venue_role(id, auth.uid(), array['owner','admin']) )
  with check ( public.has_venue_role(id, auth.uid(), array['owner','admin']) );

-- DELETE: owner only. Belt-and-suspenders — we don't expose a delete-venue
-- endpoint yet, but RLS should fail-closed if a future one is added.
drop policy if exists "venues: delete for owner only" on public.venues;
create policy "venues: delete for owner only"
  on public.venues
  for delete
  to authenticated
  using ( public.has_venue_role(id, auth.uid(), array['owner']) );

drop policy if exists "Venues: owner full access" on public.venues;

-- ----------------------------------------------------------------------------
-- leads
-- ----------------------------------------------------------------------------

drop policy if exists "leads: select for members" on public.leads;
create policy "leads: select for members"
  on public.leads
  for select
  to authenticated
  using ( public.is_venue_member(venue_id, auth.uid()) );

drop policy if exists "leads: write for sales roles" on public.leads;
create policy "leads: write for sales roles"
  on public.leads
  for all
  to authenticated
  using      ( public.has_venue_role(venue_id, auth.uid(), array['owner','admin','sales_manager','coordinator']) )
  with check ( public.has_venue_role(venue_id, auth.uid(), array['owner','admin','sales_manager','coordinator']) );

drop policy if exists "Leads: venue owner access" on public.leads;

-- ----------------------------------------------------------------------------
-- conversations
-- ----------------------------------------------------------------------------

drop policy if exists "conversations: select for members" on public.conversations;
create policy "conversations: select for members"
  on public.conversations
  for select
  to authenticated
  using ( public.is_venue_member(venue_id, auth.uid()) );

drop policy if exists "conversations: write for sales roles" on public.conversations;
create policy "conversations: write for sales roles"
  on public.conversations
  for all
  to authenticated
  using      ( public.has_venue_role(venue_id, auth.uid(), array['owner','admin','sales_manager','coordinator']) )
  with check ( public.has_venue_role(venue_id, auth.uid(), array['owner','admin','sales_manager','coordinator']) );

drop policy if exists "Conversations: venue owner access" on public.conversations;

-- ----------------------------------------------------------------------------
-- messages
--   Sales roles can write so a future "send manual reply" UI works
--   without another migration. Today the orchestrator writes via service role.
-- ----------------------------------------------------------------------------

drop policy if exists "messages: select for members" on public.messages;
create policy "messages: select for members"
  on public.messages
  for select
  to authenticated
  using ( public.is_venue_member(venue_id, auth.uid()) );

drop policy if exists "messages: write for sales roles" on public.messages;
create policy "messages: write for sales roles"
  on public.messages
  for all
  to authenticated
  using      ( public.has_venue_role(venue_id, auth.uid(), array['owner','admin','sales_manager','coordinator']) )
  with check ( public.has_venue_role(venue_id, auth.uid(), array['owner','admin','sales_manager','coordinator']) );

drop policy if exists "Messages: venue owner access" on public.messages;

-- ----------------------------------------------------------------------------
-- tours
-- ----------------------------------------------------------------------------

drop policy if exists "tours: select for members" on public.tours;
create policy "tours: select for members"
  on public.tours
  for select
  to authenticated
  using ( public.is_venue_member(venue_id, auth.uid()) );

drop policy if exists "tours: write for sales roles" on public.tours;
create policy "tours: write for sales roles"
  on public.tours
  for all
  to authenticated
  using      ( public.has_venue_role(venue_id, auth.uid(), array['owner','admin','sales_manager','coordinator']) )
  with check ( public.has_venue_role(venue_id, auth.uid(), array['owner','admin','sales_manager','coordinator']) );

drop policy if exists "Tours: venue owner access" on public.tours;

-- ----------------------------------------------------------------------------
-- follow_up_schedules
-- ----------------------------------------------------------------------------

drop policy if exists "follow_up_schedules: select for members" on public.follow_up_schedules;
create policy "follow_up_schedules: select for members"
  on public.follow_up_schedules
  for select
  to authenticated
  using ( public.is_venue_member(venue_id, auth.uid()) );

drop policy if exists "follow_up_schedules: write for sales roles" on public.follow_up_schedules;
create policy "follow_up_schedules: write for sales roles"
  on public.follow_up_schedules
  for all
  to authenticated
  using      ( public.has_venue_role(venue_id, auth.uid(), array['owner','admin','sales_manager','coordinator']) )
  with check ( public.has_venue_role(venue_id, auth.uid(), array['owner','admin','sales_manager','coordinator']) );

drop policy if exists "Follow-ups: venue owner access" on public.follow_up_schedules;

-- ----------------------------------------------------------------------------
-- ai_actions
--   System-managed audit log. Members can READ for debugging; only
--   service role writes (no INSERT/UPDATE/DELETE policy for authenticated).
-- ----------------------------------------------------------------------------

drop policy if exists "ai_actions: select for members" on public.ai_actions;
create policy "ai_actions: select for members"
  on public.ai_actions
  for select
  to authenticated
  using ( public.is_venue_member(venue_id, auth.uid()) );

drop policy if exists "AI actions: venue owner access" on public.ai_actions;

-- ----------------------------------------------------------------------------
-- knowledge_base
-- ----------------------------------------------------------------------------

drop policy if exists "knowledge_base: select for members" on public.knowledge_base;
create policy "knowledge_base: select for members"
  on public.knowledge_base
  for select
  to authenticated
  using ( public.is_venue_member(venue_id, auth.uid()) );

drop policy if exists "knowledge_base: write for sales roles" on public.knowledge_base;
create policy "knowledge_base: write for sales roles"
  on public.knowledge_base
  for all
  to authenticated
  using      ( public.has_venue_role(venue_id, auth.uid(), array['owner','admin','sales_manager','coordinator']) )
  with check ( public.has_venue_role(venue_id, auth.uid(), array['owner','admin','sales_manager','coordinator']) );

drop policy if exists "Knowledge base: venue owner access" on public.knowledge_base;

-- ----------------------------------------------------------------------------
-- tour_availability
-- ----------------------------------------------------------------------------

drop policy if exists "tour_availability: select for members" on public.tour_availability;
create policy "tour_availability: select for members"
  on public.tour_availability
  for select
  to authenticated
  using ( public.is_venue_member(venue_id, auth.uid()) );

drop policy if exists "tour_availability: write for sales roles" on public.tour_availability;
create policy "tour_availability: write for sales roles"
  on public.tour_availability
  for all
  to authenticated
  using      ( public.has_venue_role(venue_id, auth.uid(), array['owner','admin','sales_manager','coordinator']) )
  with check ( public.has_venue_role(venue_id, auth.uid(), array['owner','admin','sales_manager','coordinator']) );

drop policy if exists "Tour availability: venue owner access" on public.tour_availability;

-- ----------------------------------------------------------------------------
-- outbound_messages
--   System-managed log (orchestrator + webhook write via service role).
--   Members read only. No INSERT/UPDATE/DELETE policy for authenticated.
-- ----------------------------------------------------------------------------

drop policy if exists "outbound_messages: select for members" on public.outbound_messages;
create policy "outbound_messages: select for members"
  on public.outbound_messages
  for select
  to authenticated
  using ( public.is_venue_member(venue_id, auth.uid()) );

drop policy if exists "outbound_messages: venue owner access" on public.outbound_messages;

-- ============================================================================
-- DOWN (kept as comment for safe manual rollback — restores Phase 1 owner
-- model. Drop the new policies and re-create the legacy ones from migrations
-- 001 / 004B. Not auto-applied because rollbacks during a member-active
-- deploy would lock non-owner members out of their own data.)
-- ============================================================================
