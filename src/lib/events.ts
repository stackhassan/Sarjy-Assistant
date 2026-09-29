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
  /**
   * Only sentences that passed L4 are emitted. `sig` is required by /api/tts,
   * so unscreened text can't be voiced even by a modified client.
   */
  | { type: "sentence"; idx: number; text: string; sig: string }
  /** A failure that was handled: failover, retry, fallback source, degraded guard, etc. */
  | { type: "recovery"; stage: "llm" | "tool" | "guard" | "stt" | "tts"; action: string; detail: string }
  | {
      type: "done";
      turnId: string;
      provider?: string;
      timings: Record<string, number>;
      guardsBypassed?: boolean;
      /** Everything Sarjy said this turn, chain-signed; the client sends it back as history. */
      assistant: { text: string; sig: string; prev: string };
    }
  | { type: "error"; stage: string; message: string; spokenFallback: string; sig: string };

/** Assistant turns must carry the server's `sig` and `prev` from `done.assistant`, or they are dropped. */
export type HistoryMessage = { role: "user" | "assistant"; content: string; sig?: string; prev?: string };
