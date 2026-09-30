import { createHash } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { env } from "@/lib/env";
import { chaos } from "@/lib/reliability/context";
import { TtlCache } from "@/lib/reliability/ttlCache";

export const FACT_CATEGORIES = ["preference", "personal", "location", "other"] as const;
export type FactCategory = (typeof FACT_CATEGORIES)[number];
export type Fact = { key: string; value: string; category: FactCategory; source_turn?: string | null };

/** What the orchestrator needs from memory. A fake implements it in tests. */
export interface MemoryStore {
  list(): Promise<Fact[]>;
  upsert(fact: Fact): Promise<void>;
  remove(key: string): Promise<boolean>;
  removeAll(): Promise<number>;
}

export class MemoryError extends Error {}

/**
 * Facts for one user, cached per access token. Reads measured at ~0.9 s from a dev
 * machine, so we don't pay that on every turn: the cache is refreshed on every write.
 */
const cache = new TtlCache<Fact[]>(1000, 5 * 60_000);

/**
 * A store acting *as the user*: the request carries their Supabase access token, so
 * Postgres Row Level Security limits every query to their own rows. The server never
 * uses a service-role key, so a bug here can't read another user's memories.
 */
export function supabaseStore(accessToken: string): MemoryStore | null {
  const e = env();
  if (!e.NEXT_PUBLIC_SUPABASE_URL || !e.NEXT_PUBLIC_SUPABASE_ANON_KEY) return null;
  const db = createClient(e.NEXT_PUBLIC_SUPABASE_URL, e.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` }, fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(4000) }) },
  });
  const facts = () => db.from("facts");
  // Cache keyed by a hash, so raw access tokens are never kept as map keys.
  const cacheKey = createHash("sha256").update(accessToken).digest("base64url");
  const fail = (op: string, msg: string) => new MemoryError(`memory ${op} failed: ${msg}`);
  const down = () => {
    if (chaos("memory_down")) throw fail("request", "simulated outage (chaos)");
  };

  return {
    async list() {
      down();
      const hit = cache.get(cacheKey);
      if (hit) return hit;
      const { data, error } = await facts().select("key,value,category,source_turn").order("updated_at", { ascending: false }).limit(100);
      if (error) throw fail("read", error.message);
      cache.set(cacheKey, data as Fact[]);
      return data as Fact[];
    },
    async upsert(fact) {
      down();
      const { error } = await facts().upsert(fact, { onConflict: "user_id,key" });
      if (error) throw fail("write", error.message);
      cache.delete(cacheKey);
    },
    async remove(key) {
      down();
      const { data, error } = await facts().delete().eq("key", key).select("key");
      if (error) throw fail("delete", error.message);
      cache.delete(cacheKey);
      return (data?.length ?? 0) > 0;
    },
    async removeAll() {
      down();
      const { data, error } = await facts().delete().neq("key", "").select("key");
      if (error) throw fail("delete", error.message);
      cache.delete(cacheKey);
      return data?.length ?? 0;
    },
  };
}
