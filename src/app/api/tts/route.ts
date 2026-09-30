import { z } from "zod";
import { env } from "@/lib/env";
import { MODELS, TTS_VOICE } from "@/lib/llm/models";
import { TTS_MAX_CHARS } from "@/lib/text/batch";
import { retryAfterSeconds } from "@/lib/tts/retryAfter";
import { verifySentence } from "@/lib/tts/sign";
import { chaosFromRequest } from "@/lib/reliability/context";
import { APP_LINES, isAppLineId } from "@/lib/lines";

export const maxDuration = 15;

const body = z.union([
  z.object({ sentences: z.array(z.object({ text: z.string().min(1), sig: z.string().min(1) })).min(1).max(10) }),
  /** A fixed app line by id: the text is the server's own, so no signature is needed. */
  z.object({ line: z.string().refine(isAppLineId) }),
]);

const TIMEOUT_MS = 6000;

/**
 * Voices one batch of screened sentences with Groq Orpheus and streams back WAV.
 * Rejects any sentence without a valid signature from /api/turn.
 */
export async function POST(request: Request) {
  const parsed = body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid request" }, { status: 400 });

  let input: string;
  if ("line" in parsed.data) {
    input = APP_LINES[parsed.data.line as keyof typeof APP_LINES];
  } else {
    const { sentences } = parsed.data;
    if (!sentences.every((s) => verifySentence(s.text, s.sig))) {
      return Response.json({ error: "Unsigned text" }, { status: 403 });
    }
    input = sentences.map((s) => s.text).join(" ");
  }
  if (input.length > TTS_MAX_CHARS) return Response.json({ error: "Batch too long" }, { status: 413 });

  if (chaosFromRequest(request).has("tts_down")) {
    return Response.json({ error: "TTS unavailable (chaos)" }, { status: 503 });
  }

  let res: Response;
  try {
    res = await fetch("https://api.groq.com/openai/v1/audio/speech", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${env().GROQ_API_KEY}` },
      body: JSON.stringify({ model: MODELS.tts, voice: TTS_VOICE, input, response_format: "wav" }),
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(TIMEOUT_MS)]),
    });
  } catch {
    return Response.json({ error: "TTS unavailable" }, { status: 504 });
  }

  if (res.status === 429) {
    return Response.json(
      { error: "TTS rate limited" },
      { status: 429, headers: { "Retry-After": String(retryAfterSeconds(res.headers)) } },
    );
  }
  if (!res.ok || !res.body) return Response.json({ error: `TTS failed (${res.status})` }, { status: 502 });

  return new Response(res.body, { headers: { "Content-Type": "audio/wav", "Cache-Control": "no-store" } });
}
