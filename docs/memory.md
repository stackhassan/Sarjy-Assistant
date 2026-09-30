# Memory

Sarjy remembers facts about you across conversations ("What's my favorite color?" works tomorrow).

## How it works

```
browser ── anonymous sign-in (Supabase) ── access token (localStorage)
   │  Authorization: Bearer <token>
   ▼
/api/turn ── store acting AS the user (anon key + token, so Row Level Security applies)
   ├─ load facts (cached 5 min per user; ~0.9 s uncached) → <user_facts> block in the prompt
   ├─ model calls remember_fact / forget_fact / forget_everything
   │     └─ remember_fact → L5 memory guard → upsert (user_id, key)
   └─ weather: a remembered home_city counts as a place the user named
/api/memory ── memory drawer: list, delete one, forget everything (same RLS)
```

- **Identity:** Supabase anonymous sign-in gives each browser its own user, with no account needed. Clearing browser data starts fresh; Supabase can later convert an anonymous user into a permanent one.
- **Isolation:** Postgres RLS allows only `user_id = auth.uid()`, per operation, for signed-in users only; the `anon` role has no access. The server never uses a service-role key, so a server bug can't read another user's facts. Verified live: a second user sees nothing, and inserting a row as another user is rejected.
- **Writes only through the server.** The browser never writes facts directly, so every write passes the L5 guard (see [guardrails.md](guardrails.md)).
- **Recall:** facts go into a `<user_facts>` block marked as data, not instructions. Leak checks exclude it, since Sarjy repeating your own facts back is the point.
- **Limits:** 100 facts per user (updates always allowed), 280 characters per value, snake_case keys.
- **Forget:** by voice ("forget my favorite color", "forget everything") or with the drawer's × and "Forget everything". Deleting the user deletes their facts (cascade).

## Failure handling

| Failure | What happens |
|---|---|
| Supabase down or slow (4 s timeout) | The turn continues without memory. The prompt says memory is unavailable, so Sarjy says so if asked to remember; the memory tools aren't offered. `recovery: memory unavailable` |
| Not signed in / Supabase not configured | Memory is off; everything else works |
| Write rejected by L5 | Nothing is stored; Sarjy says it won't keep that |

Fault flag: `memory_down`.

## Setup

1. Run `supabase/migrations/0001_facts.sql` in the Supabase SQL editor.
2. Enable **Authentication → Anonymous sign-ins**.
3. Recommended for production: enable CAPTCHA (Turnstile) for sign-ins, so scripts can't mass-create anonymous users.
4. Set `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` (the publishable key is public by design; RLS is what protects the data).
