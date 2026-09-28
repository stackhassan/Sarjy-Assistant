-- Long-term memory: typed facts about each (anonymous) user. See PRD §8.
create table if not exists public.facts (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  key         text not null check (char_length(key) <= 64),
  value       text not null check (char_length(value) <= 280),
  category    text not null check (category in ('preference', 'personal', 'location', 'other')),
  source_turn text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (user_id, key)
);

alter table public.facts enable row level security;

create policy "users manage their own facts" on public.facts
  for all
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
