import { env } from "@/lib/env";
import { MODELS } from "@/lib/llm/models";
import { chaos } from "@/lib/reliability/context";
import { hedge } from "@/lib/reliability/hedge";

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
  /**
   * L4's LLM check on one sentence. 1.8 s was hit at p95 under a slow primary (the backup
   * starts at 700 ms and needs ~0.5-1.4 s), so 2.2 s. Normal days: p95 0.3-0.6 s.
   */
  output: 2200,
  /** L5's checks on a fact being saved or read back. */
  memory: 3000,
} as const;
/** Don't start a backup with less than this left: it couldn't answer in time anyway. */
const MIN_ATTEMPT_MS = 300;

/**
 * Hedging: if the primary hasn't answered by then, the first backup starts *alongside* it
 * and the first good answer wins. Without it, a primary that hangs (rather than failing
 * fast) used most of the budget before its own timeout, leaving the backups no time: the
 * turn went to safe mode although a backup was healthy. Set above each primary's normal
 * p95 (Prompt Guard ~280 ms, safeguard ~200-400 ms), so on a normal day it rarely fires
 * and costs no extra calls.
 */
export const GUARD_HEDGE_MS = { promptGuard: 500, policy: 700 } as const;

/** `guard_slow` fault: the primary hangs until its timeout (or the request is cancelled). */
async function stall(ms: number, signal?: AbortSignal): Promise<never> {
  await new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      resolve();
    });
  });
  throw new ClassifierError("primary: timed out (chaos: guard_slow)");
}

const noSignal = new AbortController().signal;

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
  const attempt = (ep: Endpoint, isPrimary: boolean, chunk: string) => async (sig: AbortSignal) => {
    const ms = timeout(ep.timeoutMs);
    if (ms === null) throw new ClassifierError(`${ep.name}: time budget (${budgetMs} ms) spent`);
    if (isPrimary && chaos("guard_primary_down")) throw new ClassifierError(`${ep.name}: simulated outage (chaos)`);
    if (isPrimary && chaos("guard_slow")) return stall(ms, sig);
    const out = await chat({ ...ep, timeoutMs: ms }, { messages: [{ role: "user", content: chunk }] }, sig);
    const s = Number.parseFloat(out);
    if (!Number.isFinite(s)) throw new ClassifierError(`${ep.name} returned ${JSON.stringify(out)}`);
    return s;
  };
  const score = async (chunk: string) => {
    try {
      const { value } = await hedge(attempt(primary, true, chunk), attempt(backup, false, chunk), {
        delayMs: GUARD_HEDGE_MS.promptGuard,
        signal: signal ?? noSignal,
      });
      return value;
    } catch (err) {
      throw asClassifierError(err);
    }
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
  const budgetMs = opts.budgetMs ?? GUARD_BUDGET_MS.input;
  const timeout = deadline(budgetMs);
  const attempt = (ep: Endpoint, i: number) => async (sig: AbortSignal): Promise<Classified<T>> => {
    const ms = timeout(i === 0 ? opts.timeoutMs : ep.timeoutMs);
    if (ms === null) throw new ClassifierError(`time budget (${budgetMs} ms) spent before ${ep.name}`);
    if (i === 0 && chaos("guard_primary_down")) throw new ClassifierError(`${ep.name}: simulated outage (chaos)`);
    if (i === 0 && chaos("guard_slow")) return stall(ms, sig);
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
      sig,
    );
    return { value: parseJsonObject<T>(out), model: ep.name };
  };

  const eps = policyEndpoints();
  const signal = opts.signal ?? noSignal;
  const errors: string[] = [];
  // 1. Primary, hedged with the first backup.
  try {
    if (eps.length === 1) return await attempt(eps[0], 0)(signal);
    return (await hedge(attempt(eps[0], 0), attempt(eps[1], 1), { delayMs: GUARD_HEDGE_MS.policy, signal })).value;
  } catch (err) {
    if (signal.aborted) throw err;
    errors.push(asClassifierError(err).message);
  }
  // 2. Both failed: the other providers, one at a time, while the budget lasts.
  for (const [i, ep] of eps.entries()) {
    if (i < 2) continue;
    try {
      return await attempt(ep, i)(signal);
    } catch (err) {
      if (signal.aborted) throw err;
      errors.push(asClassifierError(err).message);
      if (/time budget/.test(errors.at(-1)!)) break;
    }
  }
  throw new ClassifierError(errors.join("; "));
}

/** hedge() rejects with an AggregateError of both attempts; flatten to one ClassifierError. */
function asClassifierError(err: unknown): ClassifierError {
  if (err instanceof ClassifierError) return err;
  if (err instanceof AggregateError) {
    const inner = err.errors.map((e) => asClassifierError(e));
    return new ClassifierError(inner.map((e) => e.message).join("; "));
  }
  // Anything else (a bug, not an outage) must not be mistaken for "classifier unavailable".
  throw err;
}
