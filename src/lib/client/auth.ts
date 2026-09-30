import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { memoryRev } from "./memoryRev";

let client: SupabaseClient | null | undefined;

function supabase(): SupabaseClient | null {
  if (client !== undefined) return client;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  // The publishable/anon key is public by design: Row Level Security protects the data.
  client = url && key ? createClient(url, key, { auth: { persistSession: true, autoRefreshToken: true } }) : null;
  return client;
}

let signingIn: Promise<string | null> | null = null;

/**
 * An access token for this browser's user, signing in anonymously the first time.
 * The session lives in localStorage, so memories persist across visits on this browser.
 * Returns null if Supabase isn't configured or unreachable; Sarjy then works without memory.
 */
export async function accessToken(): Promise<string | null> {
  const sb = supabase();
  if (!sb) return null;
  const { data } = await sb.auth.getSession();
  if (data.session) return data.session.access_token;
  signingIn ??= sb.auth
    .signInAnonymously()
    .then(({ data: d, error }) => (error ? null : (d.session?.access_token ?? null)))
    .catch(() => null)
    .finally(() => {
      signingIn = null;
    });
  return signingIn;
}

export async function authHeaders(): Promise<Record<string, string>> {
  const token = await accessToken();
  return token ? { Authorization: `Bearer ${token}`, "X-Sarjy-Memory-Rev": memoryRev() } : {};
}
