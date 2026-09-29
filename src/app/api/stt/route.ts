import { chaosFromRequest, withContext } from "@/lib/reliability/context";
import { SttError, transcribe } from "@/lib/stt/transcribe";

export const maxDuration = 15;

/** Vercel caps request bodies at 4.5 MB; a push-to-talk clip is far smaller. */
const MAX_BYTES = 4 * 1024 * 1024;

/** Transcribes one recorded utterance: Whisper turbo, falling back to Whisper large. */
export async function POST(request: Request) {
  const form = await request.formData().catch(() => null);
  const audio = form?.get("audio");
  if (!(audio instanceof Blob) || audio.size === 0) {
    return Response.json({ error: "Missing audio" }, { status: 400 });
  }
  if (audio.size > MAX_BYTES) return Response.json({ error: "Audio too large" }, { status: 413 });

  return withContext({ chaos: chaosFromRequest(request) }, async () => {
    try {
      const t = await transcribe(audio, (audio as File).name || "utterance.webm", request.signal);
      return Response.json(t);
    } catch (err) {
      if (err instanceof SttError) {
        return Response.json({ error: "Transcription failed", detail: err.message }, { status: 502 });
      }
      throw err;
    }
  });
}
