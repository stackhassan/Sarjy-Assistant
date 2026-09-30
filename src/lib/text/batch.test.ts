import { describe, expect, it } from "vitest";
import { splitLong, takeBatch } from "./batch";

describe("takeBatch", () => {
  it("packs sentences up to the limit and leaves the rest queued", () => {
    const q = [{ text: "a".repeat(90) }, { text: "b".repeat(90) }, { text: "c".repeat(30) }];
    expect(takeBatch(q, 200).map((s) => s.text[0])).toEqual(["a", "b"]);
    expect(q.map((s) => s.text[0])).toEqual(["c"]);
  });

  it("always takes at least one item", () => {
    const q = [{ text: "x".repeat(250) }];
    expect(takeBatch(q, 200)).toHaveLength(1);
    expect(q).toHaveLength(0);
  });
});

describe("splitLong", () => {
  it("leaves short text alone", () => {
    expect(splitLong("Hello there.")).toEqual(["Hello there."]);
  });

  it("splits at clause boundaries within the limit", () => {
    const text = `${"word ".repeat(30).trim()}, ${"more ".repeat(20).trim()}.`;
    const parts = splitLong(text, 200);
    expect(parts.every((p) => p.length <= 200)).toBe(true);
    expect(parts[0].endsWith(",")).toBe(true);
    expect(parts.join(" ")).toBe(text);
  });
});

describe("takeBatch with app lines", () => {
  it("never merges an app line with other text", () => {
    const q = [{ text: "a", line: "reprompt1" }, { text: "b", sig: "x" }, { text: "c", sig: "y" }];
    expect(takeBatch(q).map((s) => s.text)).toEqual(["a"]);
    expect(takeBatch(q).map((s) => s.text)).toEqual(["b", "c"]);
  });
});
