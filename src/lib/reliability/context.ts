import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Fault-injection flags ("chaos") for demoing and testing failure handling.
 * Each flag only affects the request that carries it, so it is safe to leave
 * enabled on the public demo: a reviewer can break their own turn, nobody else's.
 */
export const CHAOS_FLAGS = [
  "llm_primary_down", // primary chat model returns 503
  "llm_all_down", // every chat provider fails
  "llm_slow", // primary chat model stalls past its timeout
  "llm_midstream_drop", // primary stream dies after its first chunk
  "weather_down", // primary weather API (Open-Meteo forecast) fails
  "weather_all_down", // every weather source fails
  "weather_slow", // primary weather API stalls past its timeout
  "guard_down", // guard classifier models fail
  "stt_down", // primary speech-to-text model fails
  "tts_down", // text-to-speech fails
] as const;

export type ChaosFlag = (typeof CHAOS_FLAGS)[number];

export type RequestContext = {
  chaos: ReadonlySet<ChaosFlag>;
  /**
   * Skip all guardrail layers. Used only by the latency benchmark and evals to
   * measure the baseline; never honoured from an HTTP request.
   */
  bypassGuards: boolean;
};

const storage = new AsyncLocalStorage<RequestContext>();
const DEFAULT: RequestContext = { chaos: new Set(), bypassGuards: false };

export function withContext<T>(ctx: Partial<RequestContext>, fn: () => T): T {
  return storage.run({ ...DEFAULT, ...ctx }, fn);
}

export function context(): RequestContext {
  return storage.getStore() ?? DEFAULT;
}

export function chaos(flag: ChaosFlag): boolean {
  return context().chaos.has(flag);
}

/** Parses the `x-sarjy-chaos` header (comma-separated flags); unknown flags are ignored. */
export function chaosFromRequest(request: Request): Set<ChaosFlag> {
  const raw = request.headers.get("x-sarjy-chaos") ?? "";
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim())
      .filter((s): s is ChaosFlag => (CHAOS_FLAGS as readonly string[]).includes(s)),
  );
}

export const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(signal.reason);
      },
      { once: true },
    );
  });
