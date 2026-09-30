import { env } from "@/lib/env";
import { MODELS } from "@/lib/llm/models";
import { chaos } from "@/lib/reliability/context";

export class ClassifierError extends Error {}

type Endpoint = { name: string; url: string; key: string; model: string; extra?: Record<string, unknown>; timeoutMs: number };

const GROQ_CHAT = "https://api.groq.com/openai/v1/chat/completions";
const GEMINI_CHAT = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";
const MISTRAL_CHAT = "https://api.mistral.ai/v1/chat/completions";

/**
 * One overall time budget per guard call, shared by the primary model and every backup.
 * Backups used to be tried one after another, each with its own timeout, so a slow outage
 * could hold a sentence for 1.5 + 3 + 3 + 3 ≈ 10.5 s (review feedback). Now a backup is
 * only tried if enough budget is left, and running out counts as "classifier unavailable",
 * which the layers already handle (keyword fallback, degraded, fail-closed safe mode).
 */
export const GUARD_BUDGET_MS = {
  /** L1 + L2 on the user's message (they run in parallel, each within this). */
  input: 2500,
  /** L4's LLM check on one sentence. */
  output: 1800,
  /** L5's checks on a fact being saved or read back. */
  memory: 3000,
} as const;
/** Don't start a backup with less than this left: it couldn't answer in time anyway. */
const MIN_ATTEMPT_MS = 300;

/** Tracks what's left of a budget; `timeout(n)` is n capped to the remainder, or null when spent. */
function deadline(budgetMs: number) {
  const end = performance.now() + budgetMs;
  return (wanted: number): number | null => {
    const left = end - performance.now();
    return left < MIN_ATTEMPT_MS ? null : Math.floor(Math.min(wanted, left)); // AbortSignal.timeout wants an integer
  };
}

/** Endpoints benched after an auth/billing error (401/402/403), which won't fix themselves. */
const benchedUntil = new Map<string, number>();
const BENCH_MS = 10 * 60_000;

async function chat(ep: Endpoint, body: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
  if (chaos("guard_down")) throw new ClassifierError("guard model unavailable (chaos)");
  if ((benchedUntil.get(ep.name) ?? 0) > Date.now()) throw new ClassifierError(`${ep.name}: benched after auth/billing error`);
  const sig = AbortSignal.any([AbortSignal.timeout(ep.timeoutMs), ...(signal ? [signal] : [])]);
  let res: Response | undefined;
  // One retry on a short 429 (per-minute burst): a degraded guard is worse than 0.3 s.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      res = await fetch(ep.url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${ep.key}` },
        body: JSON.stringify({ ...body, model: ep.model, ...ep.extra }),
        signal: sig,
      });
    } catch (err) {
      throw new ClassifierError(`${ep.name}: ${(err as Error).name === "TimeoutError" ? "timed out" : "network error"}`);
    }
    const wait = Number(res.headers.get("retry-after"));
    if (res.status !== 429 || attempt === 1 || !(wait >= 0 && wait <= 0.5)) break;
    await new Promise((r) => setTimeout(r, Math.max(wait * 1000, 150)));
  }
  if (res && [401, 402, 403].includes(res.status)) benchedUntil.set(ep.name, Date.now() + BENCH_MS);
  if (!res || !res.ok) throw new ClassifierError(`${ep.name}: HTTP ${res?.status}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? "";
}

// ---------- L1: Prompt Guard ----------

/** Prompt Guard 2 accepts ~512 tokens; longer text is scored in chunks and the max taken. */
const PROMPT_GUARD_CHUNK = 1800;

function promptGuardEndpoints(): Endpoint[] {
  const key = env().GROQ_API_KEY;
  return [
    { name: "prompt-guard-86m", url: GROQ_CHAT, key, model: MODELS.promptGuard, timeoutMs: 1200 },
    // Smaller sibling: separate capacity, same scoring. Used when the 86m model fails.
    { name: "prompt-guard-22m", url: GROQ_CHAT, key, model: "meta-llama/llama-prompt-guard-2-22m", timeoutMs: 1000 },
  ];
}

/**
 * Llama Prompt Guard 2: probability (0-1) that `text` is a jailbreak or prompt
 * injection. ~0.2-0.35 s on Groq. Falls back to the 22m model before giving up.
 */
export async function promptGuardScore(text: string, signal?: AbortSignal, budgetMs: number = GUARD_BUDGET_MS.input): Promise<number> {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += PROMPT_GUARD_CHUNK) chunks.push(text.slice(i, i + PROMPT_GUARD_CHUNK));
  const [primary, backup] = promptGuardEndpoints();
  const timeout = deadline(budgetMs);
  const score = async (chunk: string) => {
    let lastErr: unknown = new ClassifierError("prompt guard: time budget spent");
    for (const ep of [primary, backup]) {
      const ms = timeout(ep.timeoutMs);
      if (ms === null) break;
      try {
        if (ep === primary && chaos("guard_primary_down")) throw new ClassifierError(`${ep.name}: simulated outage (chaos)`);
        const out = await chat({ ...ep, timeoutMs: ms }, { messages: [{ role: "user", content: chunk }] }, signal);
        const s = Number.parseFloat(out);
        if (!Number.isFinite(s)) throw new ClassifierError(`${ep.name} returned ${JSON.stringify(out)}`);
        return s;
      } catch (err) {
        if (!(err instanceof ClassifierError)) throw err;
        lastErr = err;
      }
    }
    throw lastErr;
  };
  const scores = await Promise.all(chunks.map(score));
  return Math.max(0, ...scores);
}

// ---------- L2 / L4: policy classifier ----------

function policyEndpoints(): Endpoint[] {
  const e = env();
  const low = { reasoning_effort: "low" };
  const list: Endpoint[] = [
    { name: "safeguard-20b", url: GROQ_CHAT, key: e.GROQ_API_KEY, model: MODELS.safeguard, extra: low, timeoutMs: 1500 },
    // Same written policy on a general model: measured 6/6 correct on the probe set, but
    // 0.6-2.8 s, so it's a backup, not the primary.
    { name: "gpt-oss-20b", url: GROQ_CHAT, key: e.GROQ_API_KEY, model: MODELS.fast, extra: low, timeoutMs: 3000 },
  ];
  // Different providers entirely: the only backups that survive a Groq outage.
  if (e.MISTRAL_API_KEY) {
    list.push({ name: "mistral", url: MISTRAL_CHAT, key: e.MISTRAL_API_KEY, model: MODELS.mistralChat, timeoutMs: 3000 });
  }
  if (e.GEMINI_API_KEY) {
    list.push({ name: "gemini", url: GEMINI_CHAT, key: e.GEMINI_API_KEY, model: MODELS.fallbackChat, timeoutMs: 3000 });
  }
  return list;
}

/** Pulls the first JSON object out of a model reply (tolerates prose or code fences around it). */
export function parseJsonObject<T>(text: string): T {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new ClassifierError(`no JSON in reply: ${text.slice(0, 60)}`);
  try {
    return JSON.parse(text.slice(start, end + 1)) as T;
  } catch {
    throw new ClassifierError(`bad JSON in reply: ${text.slice(start, start + 60)}`);
  }
}

export type Classified<T> = { value: T; model: string };

/**
 * Classifies `content` against a written policy and returns the parsed JSON verdict,
 * trying gpt-oss-safeguard, then gpt-oss-20b, then Gemini (if configured).
 *
 * No strict JSON mode, and a generous token budget: with Groq's json_object mode and 300
 * tokens, the reasoning model sometimes spent the whole budget thinking and returned
 * nothing (HTTP 400 json_validate_failed), which degraded guards on benign questions.
 */
export async function safeguardClassify<T>(
  policy: string,
  content: string,
  /** `timeoutMs`: the primary model's own timeout. `budgetMs`: total for primary + backups. */
  opts: { timeoutMs: number; budgetMs?: number; signal?: AbortSignal },
): Promise<Classified<T>> {
  const errors: string[] = [];
  const budgetMs = opts.budgetMs ?? GUARD_BUDGET_MS.input;
  const timeout = deadline(budgetMs);
  for (const [i, ep] of policyEndpoints().entries()) {
    const ms = timeout(i === 0 ? opts.timeoutMs : ep.timeoutMs);
    if (ms === null) {
      errors.push(`time budget (${budgetMs} ms) spent before ${ep.name}`);
      break;
    }
    try {
      if (i === 0 && chaos("guard_primary_down")) throw new ClassifierError(`${ep.name}: simulated outage (chaos)`);
      const out = await chat(
        { ...ep, timeoutMs: ms },
        {
          messages: [
            { role: "system", content: `${policy}\n\nReply with the JSON object only.` },
            { role: "user", content },
          ],
          temperature: 0,
          max_completion_tokens: 800,
        },
        opts.signal,
      );
      return { value: parseJsonObject<T>(out), model: ep.name };
    } catch (err) {
      if (!(err instanceof ClassifierError) || opts.signal?.aborted) throw err;
      errors.push(err.message);
    }
  }
  throw new ClassifierError(errors.join("; "));
}
