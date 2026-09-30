-- Long-term memory: typed facts about each user (Supabase anonymous or permanent). See PRD §8.
-- Run once in the Supabase dashboard: SQL Editor → New query → paste → Run. Safe to re-run.

create table if not exists public.facts (
  id          uuid primary key default gen_random_uuid(),
  -- The signed-in user (anonymous sign-in counts). Deleting the user deletes their memories.
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  -- Short machine key, e.g. "favorite_color", "home_city".
  key         text not null check (key ~ '^[a-z][a-z0-9_]{0,63}$'),
  value       text not null check (char_length(value) between 1 and 280),
  category    text not null check (category in ('preference', 'personal', 'location', 'other')),
  -- The utterance the fact came from (for transparency in the memory drawer).
  source_turn text check (char_length(source_turn) <= 500),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (user_id, key)
);

-- Row Level Security: the publishable/anon key is public by design; RLS is what protects data.
alter table public.facts enable row level security;

drop policy if exists "users manage their own facts" on public.facts;
drop policy if exists "read own facts" on public.facts;
drop policy if exists "insert own facts" on public.facts;
drop policy if exists "update own facts" on public.facts;
drop policy if exists "delete own facts" on public.facts;

-- Only signed-in users (incl. anonymous sign-ins), and only their own rows.
create policy "read own facts" on public.facts
  for select to authenticated using (user_id = (select auth.uid()));
create policy "insert own facts" on public.facts
  for insert to authenticated with check (user_id = (select auth.uid()));
create policy "update own facts" on public.facts
  for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "delete own facts" on public.facts
  for delete to authenticated using (user_id = (select auth.uid()));

-- Not-signed-in requests get nothing at all.
revoke all on public.facts from anon;

-- Keep updated_at current on upserts ("actually my favorite color is green").
create or replace function public.facts_touch_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists facts_touch_updated_at on public.facts;
create trigger facts_touch_updated_at
  before update on public.facts
  for each row execute function public.facts_touch_updated_at();

-- At most 100 facts per user, so a script can't fill the database through one account.
create or replace function public.facts_enforce_cap()
returns trigger language plpgsql set search_path = '' as $$
begin
  -- Upserts of an existing key are updates, not new facts: always allowed.
  if not exists (select 1 from public.facts where user_id = new.user_id and key = new.key)
     and (select count(*) from public.facts where user_id = new.user_id) >= 100 then
    raise exception 'memory limit reached (100 facts per user)' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists facts_enforce_cap on public.facts;
create trigger facts_enforce_cap
  before insert on public.facts
  for each row execute function public.facts_enforce_cap();
