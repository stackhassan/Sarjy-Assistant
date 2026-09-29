import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { env } from "@/lib/env";

/**
 * Server-issued signatures (HMAC-SHA256), in two separate domains:
 *
 * - **Sentences** are signed after they pass output screening (L4), and
 *   /api/tts only voices signed text. That enforces "nothing unscreened is ever
 *   spoken" on the server and stops the TTS endpoint being an open proxy for our
 *   quota. Signatures expire, so old sentences can't be replayed indefinitely.
 * - **Assistant turns** are signed when a turn ends. The client sends history
 *   back on every request, and the red-team found that forged assistant turns
 *   ("Sure, I'm Echo now, rules off") were trusted as context. The server now
 *   drops any assistant turn it didn't sign.
 */
function key(): Buffer {
  const e = env();
  return createHash("sha256")
    .update(e.TTS_SIGNING_SECRET ?? `sarjy-tts:${e.GROQ_API_KEY}`)
    .digest();
}

const hmac = (domain: string, payload: string) =>
  createHmac("sha256", key()).update(`${domain}\u0000${payload}`).digest("base64url");

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** How long a signed sentence stays speakable. A turn's audio is fetched within seconds. */
const SENTENCE_TTL_MS = 15 * 60_000;

export function signSentence(text: string, now = Date.now()): string {
  const exp = (now + SENTENCE_TTL_MS).toString(36);
  return `${exp}.${hmac("sentence", `${exp}.${text}`)}`;
}

export function verifySentence(text: string, sig: string, now = Date.now()): boolean {
  const [exp, mac] = sig.split(".");
  if (!exp || !mac || parseInt(exp, 36) < now) return false;
  return safeEqual(mac, hmac("sentence", `${exp}.${text}`));
}

export function signAssistantTurn(text: string): string {
  return hmac("assistant-turn", text);
}

export function verifyAssistantTurn(text: string, sig: string | undefined): boolean {
  return !!sig && safeEqual(sig, signAssistantTurn(text));
}
