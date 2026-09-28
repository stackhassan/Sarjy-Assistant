/**
 * Pinned model IDs. Free-tier catalogs change often; verified against
 * https://console.groq.com/docs/models on 2026-09-28.
 */
export const MODELS = {
  /** Main conversational model with tool calling. */
  chat: "llama-3.3-70b-versatile",
  /** Small, fast model for classification (topic policy, memory-write checks). */
  fast: "llama-3.1-8b-instant",
  /** L1: jailbreak / prompt-injection classifier. */
  promptGuard: "meta-llama/llama-prompt-guard-2-86m",
  /** L2/L4: policy-following safety model (takes our written policy as input). */
  safeguard: "openai/gpt-oss-safeguard-20b",
  /** Speech-to-text. */
  stt: "whisper-large-v3-turbo",
  /** Fallback chat model on Gemini's OpenAI-compatible endpoint. */
  fallbackChat: "gemini-2.5-flash",
} as const;
