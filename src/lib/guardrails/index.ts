import { decodeVariants, HEURISTIC_ASSIST_THRESHOLD, normalize, screenJailbreak } from "./l1-input";
import { MIN_BLOCK_CONFIDENCE, screenTopic } from "./l2-topic";
import type { GuardResult, InputContext } from "./types";

export { checkGrounding } from "./l3-grounding";
export { sanitizeForSpeech, screenOutput } from "./l4-output";

/**
 * Requests to repeat, translate or continue earlier text: the shape of every
 * system-prompt extraction the red-team landed. These turns get L4's LLM check.
 */
const REPLAY_REQUEST =
  /\b(translat(e|ion)|tradu\w*|übersetz\w*|continue|continuez|contin[uú]a|repeat|recite|verbatim|word for word|everything above|where you (left off|stopped)|carry on|keep going|summari[sz]e (your|the) (rules|instructions|guidelines))\b|^\s*go on\b/i;

export type InputScreen = {
  results: GuardResult[];
  /** First blocking result, in layer order (L1 before L2). */
  blocked: GuardResult | null;
  /** Reasons the output of this turn deserves an LLM check in L4, and whether input was screened blind. */
  risk: { reasons: string[]; degraded: boolean };
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
  // Blind input screening means the output must be screened harder (L4 fails closed on sensitive wording).
  const degraded = results.some((r) => r.verdict === "degraded");
  if (REPLAY_REQUEST.test(ctx.text)) reasons.push("asks to repeat/translate/continue");
  if (l1.score !== null && l1.score >= HEURISTIC_ASSIST_THRESHOLD) reasons.push(`prompt-guard ${l1.score.toFixed(2)}`);
  if (l2.category && l2.category !== "allowed" && (l2.confidence ?? 0) < MIN_BLOCK_CONFIDENCE) {
    reasons.push(`possible ${l2.category}`);
  }

  return { results, blocked: results.find((r) => r.verdict === "block") ?? null, risk: { reasons, degraded } };
}
