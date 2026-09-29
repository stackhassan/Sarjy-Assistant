import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { expect, it } from "vitest";
import { promptGuardScore, safeguardClassify } from "@/lib/guardrails/classifiers";
import { TOPIC_POLICY } from "@/lib/guardrails/l2-topic";
import { MODELS, TTS_VOICE } from "@/lib/llm/models";
import { sleep } from "@/lib/reliability/context";
import { transcribe } from "@/lib/stt/transcribe";
import { PRIMARY, fmt, pct, runCase, stamp, writeResults, type TurnRun } from "./lib/harness";

const CHAT = [
  "Hi Sarjy, how's it going?",
  "Tell me a fun fact about octopuses.",
  "What's the capital of Australia?",
  "Give me one tip for sleeping better.",
  "Recommend a good book for a long flight.",
  "What's a quick healthy breakfast idea?",
];
const WEATHER = [
  "What's the weather in Lahore today?",
  "Will it rain in London tomorrow?",
  "How warm is it in Tokyo right now?",
  "What's the forecast for New York this week?",
];
const REPS = Number(process.env.LATENCY_REPS ?? 3);
const FIXTURE = "evals/fixtures/weather-question.wav";

type Sample = { prompt: string; kind: "chat" | "weather"; guards: boolean; run: TurnRun };

async function time<T>(fn: () => Promise<T>): Promise<number> {
  const t0 = performance.now();
  await fn();
  return Math.round(performance.now() - t0);
}

async function orpheus(text: string): Promise<{ ttfb: number; total: number; bytes: ArrayBuffer }> {
  const t0 = performance.now();
  const res = await fetch("https://api.groq.com/openai/v1/audio/speech", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
    body: JSON.stringify({ model: MODELS.tts, voice: TTS_VOICE, input: text, response_format: "wav" }),
  });
  const ttfb = Math.round(performance.now() - t0);
  if (!res.ok) throw new Error(`orpheus ${res.status}: ${await res.text()}`);
  const bytes = await res.arrayBuffer();
  return { ttfb, total: Math.round(performance.now() - t0), bytes };
}

it("latency: guards on vs off, plus per-component timings", async () => {
  // ---- end-to-end turns, alternating guard order to cancel out drift ----
  const samples: Sample[] = [];
  const prompts = [...CHAT.map((p) => ({ p, kind: "chat" as const })), ...WEATHER.map((p) => ({ p, kind: "weather" as const }))];
  for (let rep = 0; rep < REPS; rep++) {
    for (const [i, { p, kind }] of prompts.entries()) {
      const order = (rep + i) % 2 === 0 ? [true, false] : [false, true];
      for (const guards of order) {
        const run = await runCase(p, { bypassGuards: !guards });
        samples.push({ prompt: p, kind, guards, run });
        console.log(`${guards ? "ON " : "OFF"} ${kind.padEnd(7)} ttfs=${run.timings.firstSentence}ms wait=${run.timings.guardWait ?? "-"} ${run.provider}  ${p}`);
      }
    }
  }

  // ---- guard models in isolation ----
  const pgMs: number[] = [];
  const sgMs: number[] = [];
  for (let i = 0; i < 8; i++) {
    pgMs.push(await time(() => promptGuardScore("What's the weather like in Lahore today?")));
    sgMs.push(await time(() => safeguardClassify(TOPIC_POLICY, "USER MESSAGE: What's the weather like in Lahore today?", { timeoutMs: 5000 })));
    await sleep(1500);
  }

  // ---- speech: STT on a fixed clip, Orpheus on a typical first sentence ----
  if (!existsSync(FIXTURE)) writeFileSync(FIXTURE, Buffer.from((await orpheus("What's the weather in Lahore today?")).bytes));
  const clip = new Blob([readFileSync(FIXTURE)], { type: "audio/wav" });
  const sttMs: number[] = [];
  const sttText: string[] = [];
  for (let i = 0; i < 5; i++) {
    const t = await transcribe(clip, "weather-question.wav");
    sttMs.push(t.ms);
    sttText.push(t.text);
    await sleep(1000);
  }
  const ttsTtfb: number[] = [];
  const ttsTotal: number[] = [];
  for (let i = 0; i < 4; i++) {
    const r = await orpheus("In Lahore it's twenty-six degrees and clear right now.");
    ttsTtfb.push(r.ttfb);
    ttsTotal.push(r.total);
    await sleep(1000);
  }

  writeResults(
    "latency",
    report(samples, { pgMs, sgMs, sttMs, sttText, ttsTtfb, ttsTotal }),
    { samples: samples.map((s) => ({ ...s, run: { timings: s.run.timings, guardMs: s.run.guardMs, provider: s.run.provider, spoken: s.run.spoken } })), pgMs, sgMs, sttMs, ttsTtfb, ttsTotal },
  );
  expect(samples.length).toBe(prompts.length * REPS * 2);
});

function report(
  samples: Sample[],
  c: { pgMs: number[]; sgMs: number[]; sttMs: number[]; sttText: string[]; ttsTtfb: number[]; ttsTotal: number[] },
): string {
  const clean = samples.filter((s) => s.run.provider === PRIMARY && s.run.timings.firstSentence !== undefined);
  const dropped = samples.length - clean.length;
  const pick = (kind: Sample["kind"] | "all", guards: boolean, key: string) =>
    clean.filter((s) => (kind === "all" || s.kind === kind) && s.guards === guards).map((s) => s.run.timings[key] ?? s.run.guardMs[key]).filter((n) => n !== undefined);

  const row = (label: string, kind: Sample["kind"] | "all", key: string) => {
    const on = pick(kind, true, key);
    const off = pick(kind, false, key);
    const d50 = pct(on, 50) - pct(off, 50);
    return `| ${label} | ${fmt(pct(on, 50))} / ${fmt(pct(on, 95))} | ${fmt(pct(off, 50))} / ${fmt(pct(off, 95))} | ${Number.isFinite(d50) ? (d50 >= 0 ? "+" : "") + fmt(d50) : "–"} | ${on.length} / ${off.length} |`;
  };
  const one = (label: string, xs: number[]) => `| ${label} | ${fmt(pct(xs, 50))} | ${fmt(pct(xs, 95))} | ${xs.length} |`;
  const guardWait = pick("all", true, "guardWait");
  const inputGuards = pick("all", true, "inputGuards");
  const firstToken = pick("all", true, "firstToken");
  const l4 = clean.filter((s) => s.guards).map((s) => s.run.guardMs.L4_output).filter((n) => n !== undefined);
  const ttfs50 = pct(pick("chat", true, "firstSentence"), 50);
  const ttfsW50 = pct(pick("weather", true, "firstSentence"), 50);

  return `# Latency: guardrails on vs off

_Generated by \`npm run evals:latency\` on ${stamp()} — ${samples.length} live turns (${REPS} reps × ${CHAT.length + WEATHER.length} prompts × guards on/off, order alternated). ${dropped} turn(s) served by a fallback model because of free-tier rate limits were excluded so both arms use the same model._

All times in ms, measured server-side from request start. "First sentence" is when the first screened, signed sentence is emitted, the moment the client can start TTS.

## End to end: guards ON vs OFF

| Metric | ON p50 / p95 | OFF p50 / p95 | Δ p50 | n (on/off) |
|---|---|---|---|---|
${row("**First sentence**, chat", "chat", "firstSentence")}
${row("**First sentence**, weather (tool call)", "weather", "firstSentence")}
${row("First token, all", "all", "firstToken")}
${row("Total turn, all", "all", "total")}

## Where guard time goes (guards ON)

| Measure | p50 | p95 | n |
|---|---|---|---|
${one("L1 + L2 input guards (parallel), wall time", inputGuards)}
${one("LLM first token (runs concurrently with the above)", firstToken)}
${one("**guardWait**: first sentence ready → allowed out", guardWait)}
${one("L4 per sentence (deterministic tier; LLM tier only on risk)", l4)}
${one("Prompt Guard 2, standalone", c.pgMs)}
${one("gpt-oss-safeguard (topic policy), standalone", c.sgMs)}

**Reading this:** input guards take ~${fmt(pct(inputGuards, 50))} ms but run *alongside* the LLM, whose first token takes ~${fmt(pct(firstToken, 50))} ms, so by the time a sentence is ready the guards are usually done. \`guardWait\` is the real cost users feel. If the guards ran *before* the LLM (the naive design) every turn would pay the full ~${fmt(pct(inputGuards, 50))} ms up front.

## Time to first audio, broken down (p50)

| Stage | ms |
|---|---|
| Speech-to-text (Whisper turbo, ~2 s clip) | ${fmt(pct(c.sttMs, 50))} |
| Server: request → first screened sentence (chat / weather) | ${fmt(ttfs50)} / ${fmt(ttfsW50)} |
| TTS: Orpheus first byte / full first clip | ${fmt(pct(c.ttsTtfb, 50))} / ${fmt(pct(c.ttsTotal, 50))} |
| **Estimated time to first audio (chat / weather)** | **${fmt(pct(c.sttMs, 50) + ttfs50 + pct(c.ttsTotal, 50))} / ${fmt(pct(c.sttMs, 50) + ttfsW50 + pct(c.ttsTotal, 50))}** |

STT transcripts of the fixed clip: ${[...new Set(c.sttText)].map((t) => `"${t}"`).join(", ")}.

The client plays a clip once it is fully downloaded, so TTS contributes its full clip time. Streaming WAV playback would cut that toward the first-byte time (see \`docs/guardrails.md\` → next steps).
`;
}
