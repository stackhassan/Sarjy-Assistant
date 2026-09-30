-- Red-team round 5 (F2): signed-in users (anonymous ones included) could INSERT/UPDATE
-- facts directly with the public key, skipping the server's L5 memory guard entirely.
-- From now on the browser can read and delete its own facts, but only the Sarjy server
-- can write them: through a function that requires a server-held secret and is still
-- scoped to the caller's own user id (auth.uid()).
-- Run in the Supabase SQL Editor after 0001. Then run supabase/local/set_write_secret.sql.

create extension if not exists pgcrypto with schema extensions;

-- 1. No direct writes from clients.
drop policy if exists "insert own facts" on public.facts;
drop policy if exists "update own facts" on public.facts;
revoke insert, update on public.facts from authenticated, anon;

-- 2. Where the hash of the server's secret lives. Not exposed through the API.
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
create table if not exists private.sarjy_config (
  id                int primary key default 1 check (id = 1),
  write_secret_hash text not null
);

-- 3. The only way to write a fact.
create or replace function public.sarjy_remember_fact(
  p_secret text, p_key text, p_value text, p_category text, p_source text
) returns void
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
begin
  if uid is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  if encode(extensions.digest(p_secret, 'sha256'), 'hex')
     is distinct from (select write_secret_hash from private.sarjy_config where id = 1) then
    raise exception 'facts can only be written by the Sarjy server' using errcode = '42501';
  end if;
  -- Serialise writes per user so the 100-fact cap can't be raced (F5).
  perform pg_advisory_xact_lock(hashtext(uid::text));
  insert into public.facts (user_id, key, value, category, source_turn)
  values (uid, p_key, p_value, p_category, p_source)
  on conflict (user_id, key) do update
    set value = excluded.value, category = excluded.category, source_turn = excluded.source_turn;
end;
$$;

revoke all on function public.sarjy_remember_fact(text, text, text, text, text) from public, anon;
grant execute on function public.sarjy_remember_fact(text, text, text, text, text) to authenticated;

-- 4. The cap trigger also takes the per-user lock (belt and braces).
create or replace function public.facts_enforce_cap()
returns trigger language plpgsql set search_path = '' as $$
begin
  perform pg_advisory_xact_lock(hashtext(new.user_id::text));
  if not exists (select 1 from public.facts where user_id = new.user_id and key = new.key)
     and (select count(*) from public.facts where user_id = new.user_id) >= 100 then
    raise exception 'memory limit reached (100 facts per user)' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
