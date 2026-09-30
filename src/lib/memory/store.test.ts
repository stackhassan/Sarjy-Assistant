import { afterEach, describe, expect, it, vi } from "vitest";
import { memoryFromRequest } from "./auth";

process.env.GROQ_API_KEY ??= "test";
process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon";

const TOKEN = "aaa.bbb.ccc";

function countReads(rows: unknown[]) {
  let reads = 0;
  vi.stubGlobal("fetch", async () => {
    reads++;
    return Response.json(rows);
  });
  return () => reads;
}

const request = (rev?: string) =>
  new Request("http://localhost/api/turn", { headers: { authorization: `Bearer ${TOKEN}`, ...(rev ? { "x-sarjy-memory-rev": rev } : {}) } });

afterEach(() => vi.unstubAllGlobals());

describe("fact cache", () => {
  it("serves repeat reads from cache, but a new memory version is a fresh read", async () => {
    // Round 7 report: on Vercel a delete through /api/memory can land on a different
    // instance than /api/turn, whose cache would keep the old list for 5 minutes.
    const reads = countReads([{ key: "favorite_fruit", value: "mango", category: "preference" }]);
    await memoryFromRequest(request("v1"))!.list();
    await memoryFromRequest(request("v1"))!.list();
    expect(reads()).toBe(1);
    await memoryFromRequest(request("v2"))!.list();
    expect(reads()).toBe(2);
  });

  it("ignores a malformed version header rather than trusting it", async () => {
    const reads = countReads([]);
    await memoryFromRequest(request("x".repeat(40)))!.list();
    await memoryFromRequest(request())!.list();
    expect(reads()).toBe(1); // both fell back to the same (empty) version
  });
});
