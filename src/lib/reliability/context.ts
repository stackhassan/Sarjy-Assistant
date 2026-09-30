import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Fault-injection flags ("chaos") for demoing and testing failure handling.
 * Each flag only affects the request that carries it, so it is safe to leave
 * enabled on the public demo: a reviewer can break their own turn, nobody else's.
 */
export const CHAOS_FLAGS = [
  "llm_primary_down", // primary chat model returns 503
  "llm_all_down", // every chat provider fails
  "llm_groq_down", // every Groq chat model fails (exercises cross-provider failover)
  "llm_slow", // primary chat model stalls past its timeout
  "llm_midstream_drop", // primary stream dies after its first chunk
  "weather_down", // primary weather API (Open-Meteo forecast) fails
  "weather_all_down", // every weather source fails
  "weather_slow", // primary weather API stalls past its timeout
  "guard_down", // guard classifier models fail
  "guard_primary_down", // only the primary guard models fail (backups should take over)
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

/**
 * Faults that weaken a guard. Taking the classifiers offline is, in effect, a
 * guard bypass (the red-team used it to get medical dosing), so over HTTP these
 * are honoured only outside production or with an explicit server-side opt-in.
 */
export const GUARD_FAULTS: ReadonlySet<ChaosFlag> = new Set(["guard_down", "guard_primary_down"]);

export function guardFaultsAllowed(): boolean {
  return process.env.NODE_ENV !== "production" || process.env.CHAOS_ALLOW_GUARD_FAULTS === "1";
}

/** Parses the `x-sarjy-chaos` header (comma-separated flags); unknown or disallowed flags are ignored. */
export function chaosFromRequest(request: Request): Set<ChaosFlag> {
  const raw = request.headers.get("x-sarjy-chaos") ?? "";
  const allowGuardFaults = guardFaultsAllowed();
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim())
      .filter((s): s is ChaosFlag => (CHAOS_FLAGS as readonly string[]).includes(s))
      .filter((f) => allowGuardFaults || !GUARD_FAULTS.has(f)),
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
