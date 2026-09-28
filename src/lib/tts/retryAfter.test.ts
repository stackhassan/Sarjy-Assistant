import { describe, expect, it } from "vitest";
import { retryAfterSeconds } from "./retryAfter";

describe("retryAfterSeconds", () => {
  it("prefers retry-after", () => {
    expect(retryAfterSeconds(new Headers({ "retry-after": "7" }))).toBe(7);
  });
  it("parses Groq reset hints", () => {
    expect(retryAfterSeconds(new Headers({ "x-ratelimit-reset-requests": "1h12m0s" }))).toBe(4320);
    expect(retryAfterSeconds(new Headers({ "x-ratelimit-reset-requests": "2m30s" }))).toBe(150);
    expect(retryAfterSeconds(new Headers({ "x-ratelimit-reset-tokens": "12.2s" }))).toBe(13);
  });
  it("defaults to a minute", () => {
    expect(retryAfterSeconds(new Headers())).toBe(60);
  });
});
