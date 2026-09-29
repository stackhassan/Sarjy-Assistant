import { decodeVariants, HEURISTIC_ASSIST_THRESHOLD, normalize, screenJailbreak } from "./l1-input";
import { MIN_BLOCK_CONFIDENCE, screenTopic } from "./l2-topic";
import type { GuardResult, InputContext } from "./types";

export { checkGrounding } from "./l3-grounding";
export { sanitizeForSpeech, screenOutput } from "./l4-output";

export type InputScreen = {
  results: GuardResult[];
  /** First blocking result, in layer order (L1 before L2). */
  blocked: GuardResult | null;
  /** Reasons the output of this turn deserves an LLM check in L4. */
  risk: { reasons: string[] };
};

/**
 * L1 (jailbreak / injection) and L2 (topic policy) in parallel. Both take
 * ~0.2-0.35 s, and the orchestrator runs this alongside the main LLM call, so
 * on a normal turn they finish before the first sentence is ready.
 */
export async function screenInput(ctx: InputContext): Promise<InputScreen> {
  // Decode once (sync, <1 ms) so L2 judges what an obfuscated message actually asks for.
  const withDecoded = { ...ctx, decoded: ctx.decoded ?? decodeVariants(normalize(ctx.text)) };
  const [l1, l2] = await Promise.all([screenJailbreak(withDecoded), screenTopic(withDecoded)]);
  const results: GuardResult[] = [l1, l2];

  const reasons: string[] = [];
  if (l1.score !== null && l1.score >= HEURISTIC_ASSIST_THRESHOLD) reasons.push(`prompt-guard ${l1.score.toFixed(2)}`);
  if (l2.category && l2.category !== "allowed" && (l2.confidence ?? 0) < MIN_BLOCK_CONFIDENCE) {
    reasons.push(`possible ${l2.category}`);
  }

  return { results, blocked: results.find((r) => r.verdict === "block") ?? null, risk: { reasons } };
}
