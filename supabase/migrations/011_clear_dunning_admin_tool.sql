-- ============================================================================
-- VAOS — Phase 7N
-- Migration: 011_clear_dunning_admin_tool.sql
--
-- Operator escape hatch for the rare customer-support case where dunning
-- attempt records need to be reset without hand-editing SQL.
--
-- Mirrors Phase 7L's append RPC's hardening posture:
--   - security definer + explicit search_path
--   - REVOKE from PUBLIC, GRANT only to service_role
--   - input validation raises (rather than silently no-oping) so bad
--     callers don't accidentally clear the wrong array
--
-- Prefix-based filter on the entries' `key` field. The Phase 7K dunning
-- job tags every entry with `dunning:<venue_id>:<period_date>:attempt-N`,
-- so the prefix is enough to scope the removal to a specific period or
-- all periods for a venue.
-- ============================================================================

create or replace function public.remove_subscription_metadata_array_entries(
  p_subscription_id uuid,
  p_array_key       text,
  p_key_prefix      text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_metadata jsonb;
begin
  if p_subscription_id is null then
    raise exception 'subscription id is required';
  end if;

  if p_array_key is null or length(trim(p_array_key)) = 0 then
    raise exception 'array key is required';
  end if;

  if p_key_prefix is null or length(trim(p_key_prefix)) = 0 then
    raise exception 'key prefix is required';
  end if;

  update public.subscriptions
     set metadata = jsonb_set(
       coalesce(metadata, '{}'::jsonb),
       array[p_array_key],
       coalesce(
         (
           select jsonb_agg(e)
             from jsonb_array_elements(
                    coalesce(metadata -> p_array_key, '[]'::jsonb)
                  ) as e
            where not (
              jsonb_typeof(e) = 'object'
              and (e ->> 'key') is not null
              and (e ->> 'key') like p_key_prefix || '%'
            )
         ),
         '[]'::jsonb
       ),
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

comment on function public.remove_subscription_metadata_array_entries(uuid, text, text) is
  'Phase 7N — operator-only RPC. Removes entries whose `key` field begins with the supplied prefix from a named JSONB array on subscriptions.metadata. Service-role-only; called exclusively by /api/admin/billing-events/[id]/clear-dunning. Use the period-date prefix to scope to a single billing period; omit the date suffix to clear all periods for a venue.';

revoke all on function public.remove_subscription_metadata_array_entries(uuid, text, text) from public;
grant execute on function public.remove_subscription_metadata_array_entries(uuid, text, text) to service_role;

-- ============================================================================
-- DOWN (manual rollback only):
--
-- revoke execute on function public.remove_subscription_metadata_array_entries(uuid, text, text) from service_role;
-- drop function if exists public.remove_subscription_metadata_array_entries(uuid, text, text);
-- ============================================================================
