import { afterEach, describe, expect, it, vi } from "vitest";

process.env.GROQ_API_KEY = "test";
const { streamChat } = await import("./providers");

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
});
