import { describe, expect, it } from "vitest";
import type { TurnEvent } from "@/lib/events";
import { redact } from "./redact";

describe("redact (production: no guard internals reach the browser)", () => {
  const events: TurnEvent[] = [
    { type: "guard", layer: "L2_topic", verdict: "block", reason: "politics (0.95)", ms: 200 },
    { type: "recovery", stage: "guard", action: "safe mode", detail: "input guards unavailable" },
    { type: "tool_call", id: "1", name: "get_weather", args: "{}" },
    { type: "tool_result", id: "1", name: "get_weather", ok: true, data: { secret: 1 }, ms: 10 },
    { type: "sentence", idx: 0, text: "Hi!", sig: "s" },
    { type: "error", stage: "llm", message: "groq 429: org_123 tokens per day", spokenFallback: "Sorry…", sig: "e" },
    { type: "done", turnId: "t", provider: "groq/gpt-oss-120b", timings: { total: 900 }, assistant: { text: "Hi!", sig: "a", prev: "" } },
  ];
  const out = events.map(redact).filter(Boolean) as TurnEvent[];

  it("keeps only what the client needs to speak and continue", () => {
    expect(out.map((e) => e.type)).toEqual(["sentence", "error", "done"]);
  });

  it("strips provider, timings and upstream error details", () => {
    const json = JSON.stringify(out);
    expect(json).not.toMatch(/politics|safe mode|get_weather|org_123|gpt-oss|900/);
    expect(out.find((e) => e.type === "done")).toMatchObject({ assistant: { text: "Hi!", sig: "a", prev: "" } });
  });
});
