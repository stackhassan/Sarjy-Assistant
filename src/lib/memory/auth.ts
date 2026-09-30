import { supabaseStore, type MemoryStore } from "./store";

/** The caller's memory store, from their Supabase access token (Authorization: Bearer …). */
export function memoryFromRequest(request: Request): MemoryStore | null {
  const auth = request.headers.get("authorization") ?? "";
  const token = auth.match(/^Bearer\s+([\w-]+\.[\w-]+\.[\w-]+)$/)?.[1];
  return token ? supabaseStore(token) : null;
}
