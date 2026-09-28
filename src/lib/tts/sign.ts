import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { env } from "@/lib/env";

/**
 * Sentences are signed after they pass output screening (L4), and /api/tts only
 * voices signed text. That enforces "nothing unscreened is ever spoken" on the
 * server, and stops the TTS endpoint being used as an open proxy for our quota.
 */
function key(): Buffer {
  const e = env();
  return createHash("sha256")
    .update(e.TTS_SIGNING_SECRET ?? `sarjy-tts:${e.GROQ_API_KEY}`)
    .digest();
}

export function signSentence(text: string): string {
  return createHmac("sha256", key()).update(text).digest("base64url");
}

export function verifySentence(text: string, sig: string): boolean {
  const expected = Buffer.from(signSentence(text));
  const given = Buffer.from(sig);
  return expected.length === given.length && timingSafeEqual(expected, given);
}
