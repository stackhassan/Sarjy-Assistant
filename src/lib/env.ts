import { z } from "zod";

/** Blank lines copied from .env.example (`KEY=`) mean "not set". */
const optional = <T extends z.ZodType>(s: T) => z.preprocess((v) => (v === "" ? undefined : v), s.optional());

const schema = z.object({
  GROQ_API_KEY: z.string().min(1, "GROQ_API_KEY is required"),
  GEMINI_API_KEY: optional(z.string()),
  /** Backup providers, all OpenAI-compatible and optional. */
  SAMBANOVA_API_KEY: optional(z.string()),
  MISTRAL_API_KEY: optional(z.string()),
  /** Signs screened sentences for /api/tts. Derived from GROQ_API_KEY if unset. */
  TTS_SIGNING_SECRET: optional(z.string().min(16)),
  NEXT_PUBLIC_SUPABASE_URL: optional(z.string().url()),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: optional(z.string()),
});

export type Env = z.infer<typeof schema>;

let cached: { env: Env; key: string } | undefined;

/**
 * Server-side env, validated on first use so a missing key fails loudly.
 * Re-validated whenever any of its variables change, so a rotated or newly added
 * key in .env.local takes effect on Next's env reload without a server restart.
 */
export function env(): Env {
  const key = JSON.stringify(Object.keys(schema.shape).map((k) => process.env[k] ?? ""));
  if (!cached || cached.key !== key) cached = { env: schema.parse(process.env), key };
  return cached.env;
}
