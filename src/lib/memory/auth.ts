import { supabaseStore, type MemoryStore } from "./store";

/**
 * The caller's memory store, from their Supabase access token (Authorization: Bearer …).
 * X-Sarjy-Memory-Rev is the browser's memory version: part of the cache key (see store.ts).
 */
export function memoryFromRequest(request: Request): MemoryStore | null {
  const auth = request.headers.get("authorization") ?? "";
  const token = auth.match(/^Bearer\s+([\w-]+\.[\w-]+\.[\w-]+)$/)?.[1];
  const rev = request.headers.get("x-sarjy-memory-rev")?.match(/^[0-9a-z]{1,24}$/)?.[0] ?? "";
  return token ? supabaseStore(token, rev) : null;
}
