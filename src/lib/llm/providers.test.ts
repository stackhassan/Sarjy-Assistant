import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

process.env.GROQ_API_KEY = "test";
const { parseRetryAfter, resetCircuitBreakers, streamChat } = await import("./providers");

function sse(text: string) {
  const body = [
    `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}`,
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}`,
    "data: [DONE]",
    "",
  ].join("\n");
  return new Response(body, { status: 200 });
}

async function collect(gen: AsyncGenerator<{ type: string; provider?: string; text?: string }>) {
  const out = [];
  for await (const d of gen) out.push(d);
  return out;
}

afterEach(() => vi.unstubAllGlobals());
beforeEach(() => resetCircuitBreakers());

describe("latency-based switching", () => {
  it("sets a provider aside after 2 consecutive slow turns, not after 1", async () => {
    resetCircuitBreakers();
    const models: string[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      const { model } = JSON.parse(init.body as string);
      models.push(model);
      if (model === "openai/gpt-oss-120b") await new Promise((r) => setTimeout(r, 60)); // "slow"
      return sse("hi");
    });
    const demoted: string[] = [];
    const run = () => collect(streamChat({ messages: [{ role: "user", content: "x" }], slowMs: 40, onDemote: (p) => demoted.push(p) }));
    await run(); // slow #1: still primary next time
    await run(); // slow #2: set aside
    await run(); // served by the backup
    expect(models).toEqual(["openai/gpt-oss-120b", "openai/gpt-oss-120b", "openai/gpt-oss-20b"]);
    expect(demoted).toEqual(["groq/gpt-oss-120b"]);
  });

  it("a fast turn resets the streak", async () => {
    resetCircuitBreakers();
    let slow = true;
    const models: string[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      const { model } = JSON.parse(init.body as string);
      models.push(model);
      if (slow) await new Promise((r) => setTimeout(r, 60));
      return sse("hi");
    });
    const run = () => collect(streamChat({ messages: [{ role: "user", content: "x" }], slowMs: 40 }));
    await run(); // slow
    slow = false;
    await run(); // fast: streak reset
    slow = true;
    await run(); // slow again: only 1 in a row
    await run();
    expect(models.every((m) => m === "openai/gpt-oss-120b")).toBe(true);
  });
});

describe("parseRetryAfter", () => {
  it("reads the header, or Groq's message", () => {
    expect(parseRetryAfter("7", "")).toBe(7000);
    expect(parseRetryAfter(null, "Please try again in 3m59.328s. Need more tokens?")).toBe(239328);
    expect(parseRetryAfter(null, "try again in 1h2m3s")).toBe(3723000);
    expect(parseRetryAfter(null, "overloaded")).toBeUndefined();
  });
});

describe("streamChat failover", () => {
  it("falls back to the next model when the first errors, then skips the tripped one", async () => {
    const models: string[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      const { model } = JSON.parse(init.body as string);
      models.push(model);
      return model === "openai/gpt-oss-120b" ? new Response("overloaded", { status: 503 }) : sse("hi");
    });

    const first = await collect(streamChat({ messages: [{ role: "user", content: "hey" }] }));
    expect(models).toEqual(["openai/gpt-oss-120b", "openai/gpt-oss-20b"]);
    expect(first[0]).toMatchObject({ type: "text", text: "hi", provider: "groq/gpt-oss-20b" });

    // Circuit breaker: the failed model is skipped on the next call.
    models.length = 0;
    await collect(streamChat({ messages: [{ role: "user", content: "again" }] }));
    expect(models).toEqual(["openai/gpt-oss-20b"]);
  });

  it("keeps skipping a model for as long as its 429 asked (daily token cap)", async () => {
    resetCircuitBreakers();
    const models: string[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      const { model } = JSON.parse(init.body as string);
      models.push(model);
      return model === "openai/gpt-oss-120b"
        ? new Response('{"error":{"message":"Rate limit reached on tokens per day (TPD). Please try again in 3m59.328s."}}', { status: 429 })
        : sse("hi");
    });
    await collect(streamChat({ messages: [{ role: "user", content: "a" }] }));
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 60_000); // past the default 30 s cool-down, inside the 4 min wait
    models.length = 0;
    await collect(streamChat({ messages: [{ role: "user", content: "b" }] }));
    vi.useRealTimers();
    expect(models).toEqual(["openai/gpt-oss-20b"]);
  });
});
