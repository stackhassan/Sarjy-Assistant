import { env } from "@/lib/env";
import { MODELS } from "@/lib/llm/models";

export const maxDuration = 15;

/** Vercel caps request bodies at 4.5 MB; a push-to-talk clip is far smaller. */
const MAX_BYTES = 4 * 1024 * 1024;
const TIMEOUT_MS = 5000;

/** Transcribes one recorded utterance with Groq Whisper. */
export async function POST(request: Request) {
  const form = await request.formData().catch(() => null);
  const audio = form?.get("audio");
  if (!(audio instanceof Blob) || audio.size === 0) {
    return Response.json({ error: "Missing audio" }, { status: 400 });
  }
  if (audio.size > MAX_BYTES) return Response.json({ error: "Audio too large" }, { status: 413 });

  const upstream = new FormData();
  upstream.append("file", audio, (audio as File).name || "utterance.webm");
  upstream.append("model", MODELS.stt);
  upstream.append("response_format", "json");
  upstream.append("temperature", "0");

  const t0 = performance.now();
  try {
    const res = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${env().GROQ_API_KEY}` },
      body: upstream,
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(TIMEOUT_MS)]),
    });
    if (!res.ok) {
      return Response.json({ error: `Transcription failed (${res.status})` }, { status: 502 });
    }
    const { text } = (await res.json()) as { text: string };
    return Response.json({ text: text.trim(), ms: Math.round(performance.now() - t0) });
  } catch (err) {
    const timedOut = (err as Error).name === "TimeoutError";
    return Response.json({ error: timedOut ? "Transcription timed out" : "Transcription failed" }, { status: 504 });
  }
}
