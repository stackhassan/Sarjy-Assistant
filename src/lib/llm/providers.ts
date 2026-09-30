import { env } from "@/lib/env";
import { chaos, sleep } from "@/lib/reliability/context";
import { MODELS } from "./models";
import type { ChatDelta, ChatMessage, ToolChoice, ToolSpec } from "./types";

type Provider = {
  /** Shown in the Inspector and used as the circuit-breaker key. */
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Provider-specific request fields. */
  extra?: Record<string, unknown>;
  /** Max wait for response headers before failing over. */
  timeoutMs: number;
};

export type StreamChatOptions = {
  messages: ChatMessage[];
  tools?: ToolSpec[];
  toolChoice?: ToolChoice;
  temperature?: number;
  signal?: AbortSignal;
  /** Providers to skip for this call (e.g. one that just dropped mid-stream). */
  exclude?: string[];
  /** Called when a provider fails and the next one is tried. */
  onFailover?: (failed: string, error: Error) => void;
  /** Called when a provider is set aside for being consistently slow. */
  onDemote?: (provider: string, firstContentMs: number) => void;
  /** Override the slow threshold (tests). */
  slowMs?: number;
  /**
   * Latency breakdown of the attempt that answered: request sent, response headers,
   * first reasoning chunk (gpt-oss "thinks" before it writes), and from the final chunk
   * Groq's own queue time and the number of reasoning tokens. Numbers are ms or counts.
   */
  onTiming?: (mark: "llmRequest" | "llmHeaders" | "firstReasoning" | "groqQueueMs" | "reasoningTokens", value?: number) => void;
};

/**
 * Latency-based switching: a provider whose first content takes longer than SLOW_MS on
 * SLOW_STREAK turns in a row is set aside for DEMOTE_MS, so users stop paying for it
 * every turn. One slow turn doesn't count (voice frameworks use the same hysteresis).
 */
const SLOW_MS = 2500;
const SLOW_STREAK = 2;
const DEMOTE_MS = 60_000;
const slowStreak = new Map<string, number>();

export class ProviderError extends Error {
  constructor(
    readonly provider: string,
    readonly status: number | "timeout" | "network" | "stalled" | "dropped",
    message: string,
    /** From a 429: how long the provider asked us to wait. */
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}

/**
 * Groq 429s carry the wait either as a `retry-after` header (seconds) or in the
 * message: "Please try again in 3m59.328s". Daily-quota 429s can ask for minutes.
 */
export function parseRetryAfter(header: string | null, body: string): number | undefined {
  const secs = Number(header);
  if (header && Number.isFinite(secs) && secs > 0) return secs * 1000;
  const m = body.match(/try again in (?:(\d+)h)?(?:(\d+)m(?!s))?(?:([\d.]+)s)?/);
  if (!m || !(m[1] || m[2] || m[3])) return undefined;
  return Math.round((Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0)) * 1000);
}

/** The stream failed after output had started, so it can't be transparently replaced here. */
export class MidStreamError extends Error {
  constructor(
    readonly provider: string,
    readonly cause: unknown,
  ) {
    super(`${provider} failed mid-stream: ${(cause as Error).message}`);
  }
}

/** Max gap between stream chunks before we treat the stream as dead. */
const IDLE_TIMEOUT_MS = 5000;
/**
 * Max time from response headers to the first *usable* delta (text or tool call).
 * gpt-oss streams reasoning chunks first, which keep the idle timer alive, so a
 * model thinking slowly (we measured 9.4 s) never tripped it. Nothing has been
 * spoken at this point, so failing over is invisible to the user.
 */
const FIRST_CONTENT_TIMEOUT_MS = 5000;

/**
 * Circuit breaker: after a provider fails, skip it for a cool-down.
 * State is per server instance, which is fine for serverless — worst case a
 * cold instance retries a provider that is still down once.
 */
const COOLDOWN_MS = 30_000;
const PERMANENT_COOLDOWN_MS = 10 * 60_000;
const openUntil = new Map<string, number>();

/** For tests and evals: forget circuit-breaker state. */
export function resetCircuitBreakers() {
  openUntil.clear();
  slowStreak.clear();
}

function providers(): Provider[] {
  const e = env();
  const groq = { baseUrl: "https://api.groq.com/openai/v1", apiKey: e.GROQ_API_KEY };
  // gpt-oss is a reasoning model; low effort keeps time-to-first-token voice-friendly.
  const lowReasoning = { reasoning_effort: "low" };
  const list: Provider[] = [
    // Header latency for gpt-oss-120b is usually ~1-3 s but spikes past that on busy periods.
    { name: "groq/gpt-oss-120b", ...groq, model: MODELS.chat, extra: lowReasoning, timeoutMs: 6000 },
    // Same key, smaller model: survives 120b capacity issues without needing a second provider.
    { name: "groq/gpt-oss-20b", ...groq, model: MODELS.fast, extra: lowReasoning, timeoutMs: 5000 },
  ];
  // Other providers, so a Groq-wide outage isn't a Sarjy-wide outage. SambaNova runs the
  // same gpt-oss-120b (same personality); its free tier has a small daily cap, so it
  // comes after Groq's second model and mostly sees traffic only when Groq is down.
  if (e.SAMBANOVA_API_KEY) {
    list.push({ name: "sambanova/gpt-oss-120b", baseUrl: "https://api.sambanova.ai/v1", apiKey: e.SAMBANOVA_API_KEY, model: MODELS.sambanovaChat, timeoutMs: 6000 });
  }
  if (e.MISTRAL_API_KEY) {
    list.push({ name: "mistral", baseUrl: "https://api.mistral.ai/v1", apiKey: e.MISTRAL_API_KEY, model: MODELS.mistralChat, timeoutMs: 6000 });
  }
  if (e.GEMINI_API_KEY) {
    list.push({
      name: "gemini",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
      apiKey: e.GEMINI_API_KEY,
      model: MODELS.fallbackChat,
      timeoutMs: 6000,
    });
  }
  return list;
}

/**
 * Streams a chat completion, failing over to the next provider if one errors,
 * times out, or dies before producing any output. Once a provider has produced
 * output we never splice another provider's text onto it here; the caller gets
 * a MidStreamError and decides (the orchestrator retries if nothing was spoken).
 */
export async function* streamChat(opts: StreamChatOptions): AsyncGenerator<ChatDelta & { provider: string }> {
  const ordered = providers();
  const primary = ordered[0].name;
  const all = ordered.filter((p) => !opts.exclude?.includes(p.name));
  let candidates = all.filter((p) => (openUntil.get(p.name) ?? 0) < Date.now());
  if (candidates.length === 0) candidates = all; // all tripped: try anyway rather than fail
  let lastError: unknown = new Error("No LLM provider available");

  for (const p of candidates) {
    const isPrimary = p.name === primary;
    let yielded = false;
    const t0 = Date.now();
    let firstContentMs: number | undefined;
    try {
      const res = await openStream(p, opts, {
        fail: chaos("llm_all_down") || (isPrimary && chaos("llm_primary_down")) || (p.name.startsWith("groq/") && chaos("llm_groq_down")),
        stall: isPrimary && chaos("llm_slow"),
      });
      for await (const delta of parseStream(res, p.name, isPrimary && chaos("llm_midstream_drop"), opts.onTiming)) {
        if (!yielded && (delta.type === "text" || delta.type === "tool_call")) firstContentMs = Date.now() - t0;
        yielded = true;
        yield { ...delta, provider: p.name };
      }
      openUntil.delete(p.name);
      if (firstContentMs !== undefined) {
        const streak = firstContentMs > (opts.slowMs ?? SLOW_MS) ? (slowStreak.get(p.name) ?? 0) + 1 : 0;
        slowStreak.set(p.name, streak);
        if (streak >= SLOW_STREAK && candidates.length > 1) {
          slowStreak.set(p.name, 0);
          openUntil.set(p.name, Date.now() + DEMOTE_MS);
          opts.onDemote?.(p.name, firstContentMs);
        }
      }
      return;
    } catch (err) {
      if (opts.signal?.aborted) throw err;
      // Honour the provider's own retry-after (e.g. a daily token cap asks for minutes),
      // so we don't spend a doomed request on it every turn.
      // Auth/billing errors (bad key, "payment method required") don't fix themselves: bench for longer.
      const permanent = err instanceof ProviderError && (err.status === 401 || err.status === 402 || err.status === 403);
      const wait = permanent ? PERMANENT_COOLDOWN_MS : err instanceof ProviderError && err.retryAfterMs ? Math.max(err.retryAfterMs, COOLDOWN_MS) : COOLDOWN_MS;
      openUntil.set(p.name, Date.now() + wait);
      if (yielded) throw new MidStreamError(p.name, err);
      lastError = err;
      opts.onFailover?.(p.name, err as Error);
    }
  }
  throw lastError;
}

async function openStream(
  p: Provider,
  opts: StreamChatOptions,
  inject: { fail: boolean; stall: boolean },
): Promise<Response> {
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), p.timeoutMs);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout.signal]) : timeout.signal;

  try {
    if (inject.fail) throw new ProviderError(p.name, 503, `${p.name} 503: simulated outage (chaos)`);
    if (inject.stall) await sleep(p.timeoutMs + 1000, signal);
    opts.onTiming?.("llmRequest");
    const res = await fetch(`${p.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${p.apiKey}` },
      body: JSON.stringify({
        model: p.model,
        messages: opts.messages,
        tools: opts.tools?.length ? opts.tools : undefined,
        tool_choice: opts.tools?.length ? (opts.toolChoice ?? "auto") : undefined,
        temperature: opts.temperature ?? 0.4,
        stream: true,
        ...p.extra,
      }),
      signal,
    });
    if (!res.ok || !res.body) {
      const body = await res.text().catch(() => "");
      const retryAfterMs = res.status === 429 ? parseRetryAfter(res.headers.get("retry-after"), body) : undefined;
      throw new ProviderError(p.name, res.status, `${p.name} ${res.status}: ${body.slice(0, 200)}`, retryAfterMs);
    }
    opts.onTiming?.("llmHeaders");
    return res;
  } catch (err) {
    if (err instanceof ProviderError) throw err;
    if (timeout.signal.aborted) throw new ProviderError(p.name, "timeout", `${p.name} timed out after ${p.timeoutMs} ms`);
    if (opts.signal?.aborted) throw err;
    throw new ProviderError(p.name, "network", `${p.name}: ${(err as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
}

/** Parses an OpenAI-style SSE body into text / tool-call / finish deltas, with stall detection. */
async function* parseStream(
  res: Response,
  provider: string,
  dropAfterFirst: boolean,
  onTiming?: StreamChatOptions["onTiming"],
): AsyncGenerator<ChatDelta> {
  let reasoningSeen = false;
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  let emitted = 0;
  const openedAt = Date.now();
  try {
    while (true) {
      if (emitted === 0 && Date.now() - openedAt > FIRST_CONTENT_TIMEOUT_MS) {
        throw new ProviderError(provider, "stalled", `${provider} produced no content within ${FIRST_CONTENT_TIMEOUT_MS} ms`);
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const limit = emitted === 0 ? Math.min(IDLE_TIMEOUT_MS, FIRST_CONTENT_TIMEOUT_MS - (Date.now() - openedAt)) : IDLE_TIMEOUT_MS;
      const idle = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new ProviderError(provider, "stalled", `${provider} stream stalled (${emitted === 0 ? "no content" : "idle"} for ${limit} ms)`)),
          Math.max(0, limit),
        );
      });
      const { value, done } = await Promise.race([reader.read(), idle]).finally(() => clearTimeout(timer));
      if (done) return;
      buf += value;
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") return;
        const chunk = JSON.parse(data);
        const usage = chunk.x_groq?.usage ?? chunk.usage;
        if (usage) {
          if (typeof usage.queue_time === "number") onTiming?.("groqQueueMs", Math.round(usage.queue_time * 1000));
          const r = usage.completion_tokens_details?.reasoning_tokens;
          if (typeof r === "number") onTiming?.("reasoningTokens", r);
        }
        const choice = chunk.choices?.[0];
        if (!choice) continue;
        const d = choice.delta ?? {};
        if (!reasoningSeen && (d.reasoning || d.reasoning_content)) {
          reasoningSeen = true;
          onTiming?.("firstReasoning");
        }
        if (d.content) {
          if (dropAfterFirst && emitted > 0) {
            throw new ProviderError(provider, "dropped", `${provider} connection dropped (chaos)`);
          }
          emitted++;
          yield { type: "text", text: d.content };
        }
        for (const tc of d.tool_calls ?? []) {
          emitted++;
          yield { type: "tool_call", index: tc.index ?? 0, id: tc.id, name: tc.function?.name, args: tc.function?.arguments, extra: tc.extra_content };
        }
        if (choice.finish_reason) yield { type: "finish", reason: choice.finish_reason };
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}
