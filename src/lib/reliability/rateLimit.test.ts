import { describe, expect, it } from "vitest";
import { rateLimit } from "./rateLimit";

describe("rateLimit", () => {
  it("allows up to the limit per window, then asks the client to wait", () => {
    const t = 1_000_000;
    for (let i = 0; i < 3; i++) expect(rateLimit("a", 3, 60_000, t + i).ok).toBe(true);
    const r = rateLimit("a", 3, 60_000, t + 10);
    expect(r).toEqual({ ok: false, retryAfterS: 60 });
    expect(rateLimit("a", 3, 60_000, t + 60_001).ok).toBe(true); // window slid
    expect(rateLimit("b", 3, 60_000, t).ok).toBe(true); // other clients unaffected
  });
});
