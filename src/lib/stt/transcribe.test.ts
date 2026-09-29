import { describe, expect, it } from "vitest";
import { cleanTranscript } from "./transcribe";

describe("cleanTranscript", () => {
  it("treats punctuation-only output as silence (what Groq returns for noise)", () => {
    expect(cleanTranscript({ text: " .", segments: [{ text: " .", avg_logprob: -0.47 }] })).toEqual({ text: "", filtered: "." });
  });

  it("drops known hallucinations at low confidence", () => {
    expect(cleanTranscript({ text: "Thank you.", segments: [{ text: "Thank you.", avg_logprob: -0.9 }] }).text).toBe("");
  });

  it("keeps a confident, real 'thank you'", () => {
    expect(cleanTranscript({ text: "Thank you!", segments: [{ text: "Thank you!", avg_logprob: -0.2 }] }).text).toBe("Thank you!");
  });

  it("keeps normal speech", () => {
    expect(cleanTranscript({ text: " What's the weather?", segments: [{ text: "", avg_logprob: -0.3 }] }).text).toBe("What's the weather?");
  });
});
