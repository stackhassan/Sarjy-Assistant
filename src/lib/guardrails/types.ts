import type { GuardLayer, GuardVerdict, HistoryMessage } from "@/lib/events";

export type GuardResult = {
  layer: GuardLayer;
  verdict: GuardVerdict;
  reason: string;
  ms: number;
  /** What Sarjy says instead when the verdict is "block" (or "repair"). */
  replacement?: string;
};

export type InputContext = { text: string; history: HistoryMessage[]; signal?: AbortSignal };

export type OutputContext = {
  sentence: string;
  userText: string;
  systemPrompt: string;
  /** Signals from the input guards that make this turn worth an LLM output check. */
  risk: { reasons: string[] };
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
