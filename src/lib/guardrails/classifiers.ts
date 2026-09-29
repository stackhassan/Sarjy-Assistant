import { env } from "@/lib/env";
import { MODELS } from "@/lib/llm/models";
import { chaos } from "@/lib/reliability/context";

const GROQ_CHAT = "https://api.groq.com/openai/v1/chat/completions";

export class ClassifierError extends Error {}

async function groqChat(body: Record<string, unknown>, timeoutMs: number, signal?: AbortSignal): Promise<string> {
  if (chaos("guard_down")) throw new ClassifierError("guard model unavailable (chaos)");
  const sig = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]);
  let res: Response;
  try {
    res = await fetch(GROQ_CHAT, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${env().GROQ_API_KEY}` },
      body: JSON.stringify(body),
      signal: sig,
    });
  } catch (err) {
    throw new ClassifierError(`${body.model}: ${(err as Error).name === "TimeoutError" ? "timed out" : "network error"}`);
  }
  if (!res.ok) throw new ClassifierError(`${body.model}: HTTP ${res.status}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? "";
}

/** Prompt Guard 2 accepts ~512 tokens; longer text is scored in chunks and the max taken. */
const PROMPT_GUARD_CHUNK = 1800;

/**
 * Llama Prompt Guard 2: probability (0-1) that `text` is a jailbreak or prompt
 * injection. ~0.2-0.35 s on Groq.
 */
export async function promptGuardScore(text: string, signal?: AbortSignal): Promise<number> {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += PROMPT_GUARD_CHUNK) chunks.push(text.slice(i, i + PROMPT_GUARD_CHUNK));
  const scores = await Promise.all(
    chunks.map(async (chunk) => {
      const out = await groqChat({ model: MODELS.promptGuard, messages: [{ role: "user", content: chunk }] }, 1200, signal);
      const score = Number.parseFloat(out);
      if (!Number.isFinite(score)) throw new ClassifierError(`prompt guard returned ${JSON.stringify(out)}`);
      return score;
    }),
  );
  return Math.max(0, ...scores);
}

/**
 * gpt-oss-safeguard: classifies `content` against a written policy and returns
 * the parsed JSON verdict. ~0.2-0.25 s on Groq with low reasoning effort.
 */
export async function safeguardClassify<T>(
  policy: string,
  content: string,
  opts: { timeoutMs: number; signal?: AbortSignal },
): Promise<T> {
  const out = await groqChat(
    {
      model: MODELS.safeguard,
      messages: [
        { role: "system", content: policy },
        { role: "user", content },
      ],
      temperature: 0,
      reasoning_effort: "low",
      response_format: { type: "json_object" },
      max_completion_tokens: 300,
    },
    opts.timeoutMs,
    opts.signal,
  );
  try {
    return JSON.parse(out) as T;
  } catch {
    throw new ClassifierError(`safeguard returned non-JSON: ${out.slice(0, 80)}`);
  }
}
