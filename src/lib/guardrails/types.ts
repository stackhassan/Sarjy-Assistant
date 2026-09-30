import type { GuardLayer, GuardVerdict, HistoryMessage } from "@/lib/events";

export type GuardResult = {
  layer: GuardLayer;
  verdict: GuardVerdict;
  reason: string;
  ms: number;
  /** What Sarjy says instead when the verdict is "block" (or "repair"). */
  replacement?: string;
};

export type InputContext = {
  text: string;
  history: HistoryMessage[];
  signal?: AbortSignal;
  /** De-obfuscated payloads found in `text` (base64, hex, rot13, leetspeak), computed once for L1 and L2. */
  decoded?: string[];
};

export type OutputContext = {
  sentence: string;
  userText: string;
  systemPrompt: string;
  /**
   * Signals from the input guards. `reasons` make this turn worth an LLM output check;
   * `degraded` (input screened blind) makes sensitive sentences fail closed.
   */
  risk: { reasons: string[]; degraded?: boolean };
  /** Sentences already approved this turn, and earlier replies, for whole-text leak tripwires. */
  spokenSoFar?: string;
  priorReplies?: string;
  signal?: AbortSignal;
};

export async function timed(
  layer: GuardLayer,
  fn: () => Promise<Omit<GuardResult, "layer" | "ms">>,
): Promise<GuardResult> {
  const t0 = performance.now();
  const r = await fn();
  return { layer, ms: Math.round(performance.now() - t0), ...r };
}
