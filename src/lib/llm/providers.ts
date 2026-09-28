import { env } from "@/lib/env";
import { MODELS } from "./models";
import type { ChatDelta, ChatMessage, ToolChoice, ToolSpec } from "./types";

type Provider = {
  name: "groq" | "gemini";
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Provider-specific request fields. */
  extra?: Record<string, unknown>;
};

export type StreamChatOptions = {
  messages: ChatMessage[];
  tools?: ToolSpec[];
  toolChoice?: ToolChoice;
  temperature?: number;
  signal?: AbortSignal;
  /** Max wait for the provider to start streaming before we fail over. */
  firstTokenTimeoutMs?: number;
};

export class ProviderError extends Error {
  constructor(
    readonly provider: string,
    readonly status: number | "timeout" | "network",
    message: string,
  ) {
    super(message);
  }
}

/**
 * Circuit breaker: after a provider fails, skip it for a cool-down.
 * State is per server instance, which is fine for serverless — worst case a
 * cold instance retries a provider that is still down once.
 */
const COOLDOWN_MS = 60_000;
const openUntil = new Map<string, number>();

function providers(): Provider[] {
  const e = env();
  const list: Provider[] = [
    {
      name: "groq",
      baseUrl: "https://api.groq.com/openai/v1",
      apiKey: e.GROQ_API_KEY,
      model: MODELS.chat,
      // gpt-oss is a reasoning model; low effort keeps time-to-first-token voice-friendly.
      extra: { reasoning_effort: "low" },
    },
  ];
  if (e.GEMINI_API_KEY) {
    list.push({
      name: "gemini",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
      apiKey: e.GEMINI_API_KEY,
      model: MODELS.fallbackChat,
    });
  }
  return list;
}

/**
 * Streams a chat completion, failing over to the next provider if one errors
 * or doesn't respond in time. Failover only happens before the first byte —
 * once a provider is streaming we never splice two providers' output together.
 */
export async function* streamChat(opts: StreamChatOptions): AsyncGenerator<ChatDelta & { provider?: string }> {
  const candidates = providers().filter((p) => (openUntil.get(p.name) ?? 0) < Date.now());
  if (candidates.length === 0) candidates.push(...providers()); // all tripped: try anyway
  let lastError: unknown;

  for (const p of candidates) {
    let res: Response;
    try {
      res = await openStream(p, opts);
    } catch (err) {
      lastError = err;
      if (opts.signal?.aborted) throw err;
      openUntil.set(p.name, Date.now() + COOLDOWN_MS);
      continue;
    }
    openUntil.delete(p.name);
    for await (const delta of parseStream(res)) yield { ...delta, provider: p.name };
    return;
  }
  throw lastError ?? new Error("No LLM provider available");
}

async function openStream(p: Provider, opts: StreamChatOptions): Promise<Response> {
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), opts.firstTokenTimeoutMs ?? 3000);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout.signal]) : timeout.signal;

  try {
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
      throw new ProviderError(p.name, res.status, `${p.name} ${res.status}: ${await res.text().catch(() => "")}`);
    }
    return res;
  } catch (err) {
    if (err instanceof ProviderError) throw err;
    if (timeout.signal.aborted) throw new ProviderError(p.name, "timeout", `${p.name} timed out`);
    throw new ProviderError(p.name, "network", `${p.name}: ${(err as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
}

/** Parses an OpenAI-style SSE body into text / tool-call / finish deltas. */
async function* parseStream(res: Response): AsyncGenerator<ChatDelta> {
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value;
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") return;
      const choice = JSON.parse(data).choices?.[0];
      if (!choice) continue;
      const d = choice.delta ?? {};
      if (d.content) yield { type: "text", text: d.content };
      for (const tc of d.tool_calls ?? []) {
        yield { type: "tool_call", index: tc.index ?? 0, id: tc.id, name: tc.function?.name, args: tc.function?.arguments };
      }
      if (choice.finish_reason) yield { type: "finish", reason: choice.finish_reason };
    }
  }
}
