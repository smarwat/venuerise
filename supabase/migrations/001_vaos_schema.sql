-- ================================================================
-- VAOS — VenueRise Agentic Operating System
-- Migration: 001_vaos_schema.sql
-- Run this in your Supabase SQL editor
-- ================================================================

-- Enable required extensions
create extension if not exists "uuid-ossp";

-- ================================================================
-- ENUMS
-- ================================================================

create type lead_stage as enum (
  'new_inquiry',
  'qualified',
  'tour_scheduled',
  'tour_completed',
  'negotiation',
  'booked',
  'lost'
);

create type tour_status as enum (
  'scheduled',
  'confirmed',
  'completed',
  'cancelled',
  'no_show'
);

create type message_role as enum ('lead', 'ai', 'human', 'system');

create type sentiment as enum ('positive', 'neutral', 'negative', 'urgent');

create type urgency as enum ('low', 'medium', 'high', 'critical');

-- ================================================================
-- updated_at TRIGGER FUNCTION
-- ================================================================

create or replace function update_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

-- ================================================================
-- VENUES
-- ================================================================

create table venues (
  id                    uuid primary key default uuid_generate_v4(),
  owner_user_id         uuid not null references auth.users(id) on delete cascade,
  name                  text not null,
  description           text,
  capacity_min          int,
  capacity_max          int,
  base_price            numeric(10,2),
  price_per_guest       numeric(10,2),
  style_tags            text[] default '{}',
  amenities             text[] default '{}',
  timezone              text not null default 'America/New_York',
  ai_persona_name       text not null default 'Alex',
  ai_tone               text not null default 'warm_professional',
  response_time_target  int not null default 5, -- minutes
  is_active             boolean not null default true,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create trigger venues_updated_at before update on venues
  for each row execute function update_updated_at();

alter table venues enable row level security;

create policy "Venues: owner full access"
  on venues for all
  using (owner_user_id = auth.uid())
  with check (owner_user_id = auth.uid());

-- ================================================================
-- LEADS
-- ================================================================

create table leads (
  id            uuid primary key default uuid_generate_v4(),
  venue_id      uuid not null references venues(id) on delete cascade,
  name          text not null,
  email         text not null,
  phone         text,
  stage         lead_stage not null default 'new_inquiry',
  lead_score    int not null default 0 check (lead_score >= 0 and lead_score <= 100),
  urgency       urgency not null default 'medium',
  event_date    date,
  guest_count   int,
  budget        numeric(10,2),
  source        text not null default 'widget',
  ai_active     boolean not null default true,
  notes         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index leads_venue_id_idx on leads(venue_id);
create index leads_stage_idx on leads(stage);
create index leads_created_at_idx on leads(created_at desc);

create trigger leads_updated_at before update on leads
  for each row execute function update_updated_at();

alter table leads enable row level security;

create policy "Leads: venue owner access"
  on leads for all
  using (
    exists (
      select 1 from venues
      where venues.id = leads.venue_id
        and venues.owner_user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from venues
      where venues.id = leads.venue_id
        and venues.owner_user_id = auth.uid()
    )
  );

-- ================================================================
-- CONVERSATIONS
-- ================================================================

create table conversations (
  id               uuid primary key default uuid_generate_v4(),
  lead_id          uuid not null references leads(id) on delete cascade,
  venue_id         uuid not null references venues(id) on delete cascade,
  sentiment        sentiment not null default 'neutral',
  unread_count     int not null default 0,
  last_message_at  timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index conversations_venue_id_idx on conversations(venue_id);
create index conversations_lead_id_idx on conversations(lead_id);

create trigger conversations_updated_at before update on conversations
  for each row execute function update_updated_at();

alter table conversations enable row level security;

create policy "Conversations: venue owner access"
  on conversations for all
  using (
    exists (
      select 1 from venues
      where venues.id = conversations.venue_id
        and venues.owner_user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from venues
      where venues.id = conversations.venue_id
        and venues.owner_user_id = auth.uid()
    )
  );

-- ================================================================
-- MESSAGES
-- ================================================================

create table messages (
  id                uuid primary key default uuid_generate_v4(),
  conversation_id   uuid not null references conversations(id) on delete cascade,
  lead_id           uuid not null references leads(id) on delete cascade,
  venue_id          uuid not null references venues(id) on delete cascade,
  role              message_role not null,
  content           text not null,
  metadata          jsonb,
  created_at        timestamptz not null default now()
);

create index messages_conversation_id_idx on messages(conversation_id);
create index messages_created_at_idx on messages(created_at);

alter table messages enable row level security;

create policy "Messages: venue owner access"
  on messages for all
  using (
    exists (
      select 1 from venues
      where venues.id = messages.venue_id
        and venues.owner_user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from venues
      where venues.id = messages.venue_id
        and venues.owner_user_id = auth.uid()
    )
  );

-- ================================================================
-- TOURS
-- ================================================================

create table tours (
  id                   uuid primary key default uuid_generate_v4(),
  lead_id              uuid not null references leads(id) on delete cascade,
  venue_id             uuid not null references venues(id) on delete cascade,
  scheduled_at         timestamptz not null,
  duration_minutes     int not null default 60,
  status               tour_status not null default 'scheduled',
  location_notes       text,
  reminder_24h_sent    boolean not null default false,
  reminder_2h_sent     boolean not null default false,
  outcome              text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

create index tours_venue_id_idx on tours(venue_id);
create index tours_scheduled_at_idx on tours(scheduled_at);

create trigger tours_updated_at before update on tours
  for each row execute function update_updated_at();

alter table tours enable row level security;

create policy "Tours: venue owner access"
  on tours for all
  using (
    exists (
      select 1 from venues
      where venues.id = tours.venue_id
        and venues.owner_user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from venues
      where venues.id = tours.venue_id
        and venues.owner_user_id = auth.uid()
    )
  );

-- ================================================================
-- FOLLOW-UP SCHEDULES
-- ================================================================

create table follow_up_schedules (
  id            uuid primary key default uuid_generate_v4(),
  lead_id       uuid not null references leads(id) on delete cascade,
  venue_id      uuid not null references venues(id) on delete cascade,
  touch_number  int not null check (touch_number >= 1 and touch_number <= 5),
  scheduled_at  timestamptz not null,
  sent_at       timestamptz,
  status        text not null default 'pending' check (status in ('pending', 'sent', 'cancelled')),
  subject       text,
  body          text,
  created_at    timestamptz not null default now()
);

create index follow_up_schedules_lead_id_idx on follow_up_schedules(lead_id);
create index follow_up_schedules_scheduled_at_idx on follow_up_schedules(scheduled_at) where status = 'pending';

alter table follow_up_schedules enable row level security;

create policy "Follow-ups: venue owner access"
  on follow_up_schedules for all
  using (
    exists (
      select 1 from venues
      where venues.id = follow_up_schedules.venue_id
        and venues.owner_user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from venues
      where venues.id = follow_up_schedules.venue_id
        and venues.owner_user_id = auth.uid()
    )
  );

-- ================================================================
-- AI ACTIONS (audit log)
-- ================================================================

create table ai_actions (
  id               uuid primary key default uuid_generate_v4(),
  venue_id         uuid not null references venues(id) on delete cascade,
  lead_id          uuid references leads(id) on delete set null,
  agent            text not null,
  action           text not null,
  input_summary    text,
  output_summary   text,
  latency_ms       int,
  tokens_used      int,
  success          boolean not null default true,
  error_message    text,
  created_at       timestamptz not null default now()
);

create index ai_actions_venue_id_idx on ai_actions(venue_id);
create index ai_actions_lead_id_idx on ai_actions(lead_id);

alter table ai_actions enable row level security;

create policy "AI actions: venue owner access"
  on ai_actions for all
  using (
    exists (
      select 1 from venues
      where venues.id = ai_actions.venue_id
        and venues.owner_user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from venues
      where venues.id = ai_actions.venue_id
        and venues.owner_user_id = auth.uid()
    )
  );

-- ================================================================
-- KNOWLEDGE BASE
-- ================================================================

create table knowledge_base (
  id          uuid primary key default uuid_generate_v4(),
  venue_id    uuid not null references venues(id) on delete cascade,
  category    text not null,
  title       text not null,
  content     text not null,
  priority    int not null default 5,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index knowledge_base_venue_id_idx on knowledge_base(venue_id);

create trigger knowledge_base_updated_at before update on knowledge_base
  for each row execute function update_updated_at();

alter table knowledge_base enable row level security;

create policy "Knowledge base: venue owner access"
  on knowledge_base for all
  using (
    exists (
      select 1 from venues
      where venues.id = knowledge_base.venue_id
        and venues.owner_user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from venues
      where venues.id = knowledge_base.venue_id
        and venues.owner_user_id = auth.uid()
    )
  );

-- ================================================================
-- TOUR AVAILABILITY
-- ================================================================

create table tour_availability (
  id            uuid primary key default uuid_generate_v4(),
  venue_id      uuid not null references venues(id) on delete cascade,
  day_of_week   int not null check (day_of_week >= 0 and day_of_week <= 6), -- 0=Sunday
  start_time    time not null,
  end_time      time not null,
  is_active     boolean not null default true,
  created_at    timestamptz not null default now()
);

create index tour_availability_venue_id_idx on tour_availability(venue_id);

alter table tour_availability enable row level security;

create policy "Tour availability: venue owner access"
  on tour_availability for all
  using (
    exists (
      select 1 from venues
      where venues.id = tour_availability.venue_id
        and venues.owner_user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from venues
      where venues.id = tour_availability.venue_id
        and venues.owner_user_id = auth.uid()
    )
  );

-- ================================================================
-- REALTIME
-- ================================================================

alter publication supabase_realtime add table leads;
alter publication supabase_realtime add table messages;
alter publication supabase_realtime add table conversations;
alter publication supabase_realtime add table tours;
