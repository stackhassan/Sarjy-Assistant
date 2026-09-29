import { env } from "@/lib/env";
import { MODELS } from "@/lib/llm/models";
import { chaos } from "@/lib/reliability/context";

/** Primary is fast; the full model is slower but independent capacity on the same key. */
const MODELS_IN_ORDER = [
  { model: MODELS.stt, timeoutMs: 4000 },
  { model: "whisper-large-v3", timeoutMs: 6000 },
] as const;

/**
 * Phrases Whisper is known to produce from silence or noise (learned from
 * subtitle training data). Groq returns no_speech_prob = 0 even for pure noise
 * (measured), so we can't rely on it; we drop these only when confidence is low.
 */
const HALLUCINATIONS = new Set([
  "thank you",
  "thanks",
  "thank you for watching",
  "thanks for watching",
  "you",
  "bye",
  "okay",
  "subtitles by the amara org community",
  "please subscribe",
]);
const LOW_CONFIDENCE_LOGPROB = -0.6;

type VerboseSegment = { text: string; avg_logprob: number };
type VerboseTranscript = { text: string; segments?: VerboseSegment[] };

export type Transcript = { text: string; model: string; ms: number; filtered?: string; failovers: string[] };

export class SttError extends Error {}

export async function transcribe(audio: Blob, filename: string, signal?: AbortSignal): Promise<Transcript> {
  const failovers: string[] = [];
  for (const [i, { model, timeoutMs }] of MODELS_IN_ORDER.entries()) {
    const t0 = performance.now();
    try {
      if (i === 0 && chaos("stt_down")) throw new SttError(`${model}: simulated outage (chaos)`);
      const out = await callWhisper(audio, filename, model, timeoutMs, signal);
      const { text, filtered } = cleanTranscript(out);
      return { text, model, ms: Math.round(performance.now() - t0), filtered, failovers };
    } catch (err) {
      if (signal?.aborted) throw err;
      failovers.push((err as Error).message);
    }
  }
  throw new SttError(failovers.join("; "));
}

async function callWhisper(audio: Blob, filename: string, model: string, timeoutMs: number, signal?: AbortSignal) {
  const form = new FormData();
  form.append("file", audio, filename);
  form.append("model", model);
  form.append("response_format", "verbose_json");
  form.append("temperature", "0");
  let res: Response;
  try {
    res = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${env().GROQ_API_KEY}` },
      body: form,
      signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]),
    });
  } catch (err) {
    throw new SttError(`${model}: ${(err as Error).name === "TimeoutError" ? `timed out after ${timeoutMs} ms` : "network error"}`);
  }
  if (!res.ok) throw new SttError(`${model}: HTTP ${res.status}`);
  return (await res.json()) as VerboseTranscript;
}

export function cleanTranscript(t: VerboseTranscript): { text: string; filtered?: string } {
  const text = t.text.trim();
  const bare = text.toLowerCase().replace(/[^a-z\s]/g, "").replace(/\s+/g, " ").trim();
  if (!bare) return { text: "", filtered: text || undefined };
  const segs = t.segments ?? [];
  const logprob = segs.length ? Math.min(...segs.map((s) => s.avg_logprob)) : 0;
  if (HALLUCINATIONS.has(bare) && logprob < LOW_CONFIDENCE_LOGPROB) return { text: "", filtered: text };
  return { text };
}
