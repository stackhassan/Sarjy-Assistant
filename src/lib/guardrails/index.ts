import { timed, type GuardResult, type InputContext, type OutputContext } from "./types";

/**
 * Guardrail entry points used by the orchestrator. The layers are pass-through
 * placeholders for now so the pipeline and Inspector are wired end to end;
 * each gets its real implementation on Day 2 (PRD §7).
 */

/** L1 (jailbreak / injection) + L2 (topic policy), run in parallel. */
export async function screenInput(ctx: InputContext): Promise<GuardResult[]> {
  void ctx;
  return Promise.all([
    timed("L1_input", async () => ({ verdict: "pass", reason: "not yet implemented" })),
    timed("L2_topic", async () => ({ verdict: "pass", reason: "not yet implemented" })),
  ]);
}

/** L4: screen one sentence before it is allowed to reach TTS. */
export async function screenSentence(ctx: OutputContext): Promise<GuardResult> {
  void ctx;
  return timed("L4_output", async () => ({ verdict: "pass", reason: "not yet implemented" }));
}
