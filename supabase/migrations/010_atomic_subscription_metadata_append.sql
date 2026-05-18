-- ============================================================================
-- VAOS — Phase 7L
-- Migration: 010_atomic_subscription_metadata_append.sql
--
-- Atomic JSONB array append on `subscriptions.metadata`. Closes the
-- read-modify-write race between:
--   - Phase 7H trial-reminder cron (writes `metadata.reminders_sent`)
--   - Phase 7K dunning cron        (writes `metadata.dunning_sent`)
--   - Phase 7C Stripe webhook sync  (overwrites `metadata` wholesale)
--
-- Without this RPC, a webhook sync landing between a cron's `select` and
-- `update` would silently drop the freshly-appended entry. With it, the
-- append happens in a single statement protected by Postgres's per-row
-- locking; the webhook's subsequent overwrite is now temporally well-defined.
--
-- SERVICE-ROLE ONLY:
--   The function is `security definer` with `search_path = public` and is
--   revoked from PUBLIC. Only the `service_role` role can EXECUTE it; the
--   anon + authenticated roles cannot. Billing jobs use the service-role
--   Supabase client, so they're the only callers in practice.
-- ============================================================================

create or replace function public.append_subscription_metadata_array(
  p_subscription_id uuid,
  p_array_key       text,
  p_entry           jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_metadata jsonb;
begin
  if p_array_key is null or length(trim(p_array_key)) = 0 then
    raise exception 'array key is required';
  end if;

  if p_entry is null then
    raise exception 'entry is required';
  end if;

  update public.subscriptions
     set metadata = jsonb_set(
       coalesce(metadata, '{}'::jsonb),
       array[p_array_key],
       coalesce(metadata -> p_array_key, '[]'::jsonb) || jsonb_build_array(p_entry),
       true
     )
   where id = p_subscription_id
   returning metadata into v_metadata;

  if v_metadata is null then
    raise exception 'subscription not found';
  end if;

  return v_metadata;
end;
$$;

comment on function public.append_subscription_metadata_array(uuid, text, jsonb) is
  'Phase 7L — atomic JSONB array append on subscriptions.metadata. Service-role-only. Used by billing cron jobs to avoid races against the Stripe webhook sync which overwrites the metadata column wholesale.';

revoke all on function public.append_subscription_metadata_array(uuid, text, jsonb) from public;
grant execute on function public.append_subscription_metadata_array(uuid, text, jsonb) to service_role;

-- ============================================================================
-- DOWN (manual rollback only):
--
-- revoke execute on function public.append_subscription_metadata_array(uuid, text, jsonb) from service_role;
-- drop function if exists public.append_subscription_metadata_array(uuid, text, jsonb);
-- ============================================================================
