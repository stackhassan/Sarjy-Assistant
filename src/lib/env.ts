import { z } from "zod";

const schema = z.object({
  GROQ_API_KEY: z.string().min(1, "GROQ_API_KEY is required"),
  GEMINI_API_KEY: z.string().optional(),
  NEXT_PUBLIC_SUPABASE_URL: z.string().url().optional(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().optional(),
});

export type Env = z.infer<typeof schema>;

let cached: Env | undefined;

/** Server-side env, validated on first use so a missing key fails loudly. */
export function env(): Env {
  if (!cached) cached = schema.parse(process.env);
  return cached;
}
