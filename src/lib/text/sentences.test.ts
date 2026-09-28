import { describe, expect, it } from "vitest";
import { SentenceSplitter } from "./sentences";

function splitAll(chunks: string[]) {
  const s = new SentenceSplitter();
  const out = chunks.flatMap((c) => s.push(c));
  const rest = s.flush();
  return rest ? [...out, rest] : out;
}

describe("SentenceSplitter", () => {
  it("emits sentences as soon as they complete across chunks", () => {
    const s = new SentenceSplitter();
    expect(s.push("It's sunny in Lah")).toEqual([]);
    expect(s.push("ore. Tomorrow ")).toEqual(["It's sunny in Lahore."]);
    expect(s.push("rain! Bring")).toEqual(["Tomorrow rain!"]);
    expect(s.flush()).toBe("Bring");
  });

  it("keeps decimals intact", () => {
    expect(splitAll(["It's 21.5 degrees. Nice."])).toEqual(["It's 21.5 degrees.", "Nice."]);
  });

  it("does not split on common abbreviations", () => {
    expect(splitAll(["Ask Dr. Smith today. Okay?"])).toEqual(["Ask Dr. Smith today.", "Okay?"]);
  });

  it("handles closing quotes", () => {
    expect(splitAll(['She said "hi." Then left.'])).toEqual(['She said "hi."', "Then left."]);
  });
});
