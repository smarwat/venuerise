-- ============================================================================
-- VAOS — Phase 7C
-- Migration: 007_billing_foundation.sql
--
-- Adds the bare-minimum billing tables required to wire Stripe Checkout +
-- Customer Portal + webhook-driven subscription sync. NO subscription
-- gating is applied to the product yet — that lands in Phase 7D.
--
-- Tables:
--   billing_customers  — 1:1 with venues; maps venue → Stripe customer id.
--   subscriptions      — N rows per venue (history); the row whose status
--                        is 'active'/'trialing' is the live one.
--
-- Privacy posture for billing rows:
--   Billing information (current period dates, cancellation flags, trial
--   end) is sensitive — viewers don't need it. We gate SELECT to
--   ADMIN_ROLES (owner + admin). Writes are service-role only, driven by
--   the Stripe webhook handler.
--
-- Stripe is the source of truth. These tables are a *cache* — we never
-- mutate them from product code outside the webhook path; the webhook
-- replays state from Stripe on every relevant event.
-- ============================================================================

create table if not exists public.billing_customers (
  id                  uuid primary key default gen_random_uuid(),
  venue_id            uuid not null references public.venues(id) on delete cascade,
  stripe_customer_id  text not null unique,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (venue_id)
);

create table if not exists public.subscriptions (
  id                       uuid primary key default gen_random_uuid(),
  venue_id                 uuid not null references public.venues(id) on delete cascade,
  stripe_customer_id       text not null,
  stripe_subscription_id   text unique,
  stripe_price_id          text,
  status                   text not null default 'incomplete',
  current_period_start     timestamptz,
  current_period_end       timestamptz,
  cancel_at_period_end     boolean not null default false,
  canceled_at              timestamptz,
  trial_start              timestamptz,
  trial_end                timestamptz,
  metadata                 jsonb not null default '{}'::jsonb,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

-- ----------------------------------------------------------------------------
-- Indexes
-- ----------------------------------------------------------------------------

create index if not exists billing_customers_venue_id_idx
  on public.billing_customers (venue_id);

create index if not exists subscriptions_venue_id_idx
  on public.subscriptions (venue_id);

create index if not exists subscriptions_status_idx
  on public.subscriptions (status);

create index if not exists subscriptions_stripe_customer_id_idx
  on public.subscriptions (stripe_customer_id);

-- ----------------------------------------------------------------------------
-- updated_at triggers (reuses public.update_updated_at from migration 001)
-- ----------------------------------------------------------------------------

drop trigger if exists billing_customers_updated_at on public.billing_customers;
create trigger billing_customers_updated_at
  before update on public.billing_customers
  for each row execute function public.update_updated_at();

drop trigger if exists subscriptions_updated_at on public.subscriptions;
create trigger subscriptions_updated_at
  before update on public.subscriptions
  for each row execute function public.update_updated_at();

-- ----------------------------------------------------------------------------
-- Row Level Security
-- ----------------------------------------------------------------------------

alter table public.billing_customers enable row level security;
alter table public.subscriptions     enable row level security;

-- billing_customers: ADMIN_ROLES SELECT only. Writes service-role only.
drop policy if exists "billing_customers: select for admin roles" on public.billing_customers;
create policy "billing_customers: select for admin roles"
  on public.billing_customers
  for select
  to authenticated
  using ( public.has_venue_role(venue_id, auth.uid(), array['owner','admin']) );

-- subscriptions: ADMIN_ROLES SELECT only. Writes service-role only.
drop policy if exists "subscriptions: select for admin roles" on public.subscriptions;
create policy "subscriptions: select for admin roles"
  on public.subscriptions
  for select
  to authenticated
  using ( public.has_venue_role(venue_id, auth.uid(), array['owner','admin']) );

-- ============================================================================
-- DOWN (manual rollback only):
--
-- drop policy if exists "subscriptions: select for admin roles" on public.subscriptions;
-- drop policy if exists "billing_customers: select for admin roles" on public.billing_customers;
-- drop trigger if exists subscriptions_updated_at on public.subscriptions;
-- drop trigger if exists billing_customers_updated_at on public.billing_customers;
-- drop table if exists public.subscriptions;
-- drop table if exists public.billing_customers;
-- ============================================================================
