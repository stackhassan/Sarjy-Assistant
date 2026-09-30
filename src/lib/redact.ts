import type { TurnEvent } from "@/lib/events";

/**
 * Outside demo mode the browser gets only what it needs to speak and continue the
 * conversation. Guard verdicts, reasons, recovery details and tool data stay on the
 * server: in the red-team rounds, that feedback is what let attacks iterate so fast.
 */
export function redact(e: TurnEvent): TurnEvent | null {
  switch (e.type) {
    case "sentence":
      return e;
    case "done":
      return { type: "done", turnId: e.turnId, timings: {}, assistant: e.assistant };
    case "error":
      return { type: "error", stage: "llm", message: "unavailable", spokenFallback: e.spokenFallback, sig: e.sig };
    default:
      if (e.type === "guard" || e.type === "recovery") console.info("[sarjy]", JSON.stringify(e)); // server-side log only
      return null;
  }
}
