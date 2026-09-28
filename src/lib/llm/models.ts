/**
 * Pinned model IDs. Free-tier catalogs change often, and the docs page can list
 * models a given key can't use — verified against GET /openai/v1/models on 2026-09-28.
 */
export const MODELS = {
  /** Main conversational model with tool calling. */
  chat: "openai/gpt-oss-120b",
  /** Small, fast model for classification (topic policy, memory-write checks). */
  fast: "openai/gpt-oss-20b",
  /** L1: jailbreak / prompt-injection classifier. */
  promptGuard: "meta-llama/llama-prompt-guard-2-86m",
  /** L2/L4: policy-following safety model (takes our written policy as input). */
  safeguard: "openai/gpt-oss-safeguard-20b",
  /** Speech-to-text. */
  stt: "whisper-large-v3-turbo",
  /** Fallback chat model on Gemini's OpenAI-compatible endpoint. */
  fallbackChat: "gemini-2.5-flash",
} as const;
