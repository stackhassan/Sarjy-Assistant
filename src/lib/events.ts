/**
 * Events streamed from /api/turn to the browser (see PRD §6.3).
 * Shared by server and client, so keep this file free of server-only imports.
 */

export type GuardLayer = "L1_input" | "L2_topic" | "L3_grounding" | "L4_output" | "L5_memory";

export type GuardVerdict = "pass" | "block" | "repair" | "degraded";

export type TurnEvent =
  | { type: "guard"; layer: GuardLayer; verdict: GuardVerdict; reason: string; ms: number }
  | { type: "tool_call"; id: string; name: string; args: string }
  | { type: "tool_result"; id: string; name: string; ok: boolean; data: unknown; ms: number }
  /** Only sentences that passed L4 are emitted, so the client can speak them directly. */
  | { type: "sentence"; idx: number; text: string }
  | { type: "done"; turnId: string; provider?: string; timings: Record<string, number> }
  | { type: "error"; stage: string; message: string; spokenFallback: string };

export type HistoryMessage = { role: "user" | "assistant"; content: string };
