import { describe, expect, it } from "vitest";
import { SilenceTrimmer, WavStreamDecoder } from "./pcm";

const RATE = 1000; // 10-sample frames keep the arithmetic readable

function wav(samples: number[], rate = 24000): Uint8Array {
  const b = new Uint8Array(44 + samples.length * 2);
  const v = new DataView(b.buffer);
  const w = (o: number, s: string) => [...s].forEach((c, i) => (b[o + i] = c.charCodeAt(0)));
  w(0, "RIFF");
  v.setUint32(4, 0xffffffff, true); // streamed: placeholder size
  w(8, "WAVE");
  w(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  w(36, "data");
  v.setUint32(40, 0xffffffff, true);
  samples.forEach((s, i) => v.setInt16(44 + i * 2, s, true));
  return b;
}

describe("WavStreamDecoder", () => {
  it("decodes a WAV split at awkward byte boundaries, including mid-header and mid-sample", () => {
    const bytes = wav([0, 16384, -16384, 32767, -32768]);
    const d = new WavStreamDecoder();
    const out: number[] = [];
    for (const cut of [[0, 7], [7, 45], [45, 48], [48, 49], [49, bytes.length]]) {
      out.push(...d.push(bytes.subarray(cut[0], cut[1])));
    }
    expect(d.sampleRate).toBe(24000);
    expect(out).toEqual([0, 0.5, -0.5, 32767 / 32768, -1]);
  });

  it("refuses formats it can't stream, so the caller can fall back", () => {
    const bytes = wav([0]);
    new DataView(bytes.buffer).setUint16(34, 24, true);
    expect(() => new WavStreamDecoder().push(bytes)).toThrow(/unsupported/);
  });
});

describe("SilenceTrimmer", () => {
  const quiet = (ms: number) => new Float32Array(ms).fill(0.001);
  const loud = (ms: number) => new Float32Array(ms).fill(0.5);

  it("cuts long padding at both ends down to a short lead and a natural tail pause", () => {
    const t = new SilenceTrimmer({ sampleRate: RATE, keepLeadS: 0.05, keepTailS: 0.2 });
    const out = [...t.push(quiet(400)), ...t.push(loud(300)), ...t.push(quiet(500)), ...t.end()];
    expect(out.length).toBe(50 + 300 + 200);
  });

  it("keeps pauses between words but caps very long ones", () => {
    const t = new SilenceTrimmer({ sampleRate: RATE, keepLeadS: 0, keepTailS: 0, maxPauseS: 0.3 });
    const out = [...t.push(loud(100)), ...t.push(quiet(150)), ...t.push(loud(100)), ...t.push(quiet(900)), ...t.push(loud(100)), ...t.end()];
    expect(out.length).toBe(100 + 150 + 100 + 300 + 100);
  });

  it("works on tiny chunks that don't line up with frames", () => {
    const t = new SilenceTrimmer({ sampleRate: RATE, keepLeadS: 0, keepTailS: 0 });
    const src = [...quiet(200), ...loud(100)];
    const out: number[] = [];
    for (let i = 0; i < src.length; i += 7) out.push(...t.push(Float32Array.from(src.slice(i, i + 7))));
    out.push(...t.end());
    expect(out.length).toBe(100);
  });

  it("returns nothing for a clip that is all silence", () => {
    const t = new SilenceTrimmer({ sampleRate: RATE });
    expect(t.push(quiet(500)).length + t.end().length).toBe(0);
  });
});
