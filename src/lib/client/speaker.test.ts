import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { APP_LINES } from "@/lib/lines";
import { Speaker } from "./speaker";

/** Minimal browser audio stubs: records what the browser voice says; Orpheus "plays" instantly. */
let spoken: string[];
beforeEach(() => {
  spoken = [];
  vi.stubGlobal("window", { location: { search: "" }, speechSynthesis: {} });
  vi.stubGlobal("speechSynthesis", {
    speak: (u: { text: string; onstart?: () => void; onend?: () => void }) => {
      spoken.push(u.text);
      u.onstart?.();
      setTimeout(() => u.onend?.(), 0);
    },
    cancel: () => {},
    getVoices: () => [{ name: "Samantha", lang: "en-US" }],
  });
  vi.stubGlobal(
    "SpeechSynthesisUtterance",
    class {
      voice: unknown;
      rate = 1;
      onstart?: () => void;
      onend?: () => void;
      onerror?: () => void;
      constructor(public text: string) {}
    },
  );
  vi.stubGlobal(
    "Audio",
    class {
      src = "";
      onplaying?: () => void;
      onended?: () => void;
      onerror?: () => void;
      pause() {}
      play() {
        this.onplaying?.();
        setTimeout(() => this.onended?.(), 0);
        return Promise.resolve();
      }
    },
  );
  vi.stubGlobal("URL", { createObjectURL: () => "blob:x", revokeObjectURL: () => {} });
});
afterEach(() => vi.unstubAllGlobals());

const idle = (s: Speaker) => new Promise<void>((r) => {
  const tick = () => (s.speaking ? setTimeout(tick, 5) : r());
  tick();
});

function tts(status: number) {
  const bodies: unknown[] = [];
  vi.stubGlobal("fetch", async (_: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    return status === 200 ? new Response(new Blob(["wav"]), { status: 200 }) : new Response("", { status });
  });
  return bodies;
}

describe("Speaker fallback UX", () => {
  it("announces a voice switch once, and keeps the rest of the answer on the fallback voice", async () => {
    const bodies = tts(503);
    const voices: string[] = [];
    const s = new Speaker({ onVoice: (v) => voices.push(v) });
    s.beginTurn();
    s.enqueue({ text: "First sentence.", sig: "a" });
    await idle(s);
    s.enqueue({ text: "Second sentence.", sig: "b" });
    await idle(s);
    expect(spoken).toEqual([`${APP_LINES.voiceChange} First sentence.`, "Second sentence."]);
    expect(bodies).toHaveLength(1); // no second Orpheus attempt mid-answer
    expect(voices.every((v) => v === "browser")).toBe(true);
  });

  it("tries Orpheus again on the next answer, and a later outage gets its own notice", async () => {
    tts(503);
    const s = new Speaker();
    s.beginTurn();
    s.enqueue({ text: "One.", sig: "a" });
    await idle(s);
    tts(200); // recovered
    s.beginTurn();
    s.enqueue({ text: "Two.", sig: "b" });
    await idle(s);
    tts(503); // down again
    s.beginTurn();
    s.enqueue({ text: "Three.", sig: "c" });
    await idle(s);
    expect(spoken).toEqual([`${APP_LINES.voiceChange} One.`, `${APP_LINES.voiceChange} Three.`]);
  });

  it("voices app lines by id, in a request of their own", async () => {
    const bodies = tts(200);
    const s = new Speaker();
    s.beginTurn();
    s.enqueue({ text: APP_LINES.reprompt1, line: "reprompt1" });
    s.enqueue({ text: "Hi.", sig: "a" });
    await idle(s);
    expect(bodies).toEqual([{ line: "reprompt1" }, { sentences: [{ text: "Hi.", sig: "a" }] }]);
  });

  it("reports 'none' and stays silent when no voice can speak", async () => {
    tts(503);
    vi.stubGlobal("window", { location: { search: "" } }); // no speechSynthesis
    const voices: string[] = [];
    const s = new Speaker({ onVoice: (v) => voices.push(v) });
    s.beginTurn();
    s.enqueue({ text: "Hello.", sig: "a" });
    await idle(s);
    expect(voices).toContain("none");
    expect(spoken).toEqual([]);
  });
});
