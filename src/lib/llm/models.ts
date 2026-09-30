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
  /** Text-to-speech (requires one-time terms acceptance in the Groq console). */
  tts: "canopylabs/orpheus-v1-english",
  /**
   * Gemini's OpenAI-compatible endpoint. gemini-2.5-flash is closed to new keys and the
   * full flash models returned 503 "high demand" (up to 97 s) when tested on 2026-09-30;
   * flash-lite answered classification correctly in ~1.2 s.
   */
  fallbackChat: "gemini-flash-lite-latest",
  /** SambaNova runs the same model as our primary, on a different provider. */
  sambanovaChat: "gpt-oss-120b",
  /** Mistral's small model: backup chat and backup policy classifier. */
  mistralChat: "mistral-small-latest",
} as const;

/** Orpheus voices: autumn, diana, hannah (female); austin, daniel, troy (male). */
export const TTS_VOICE = "diana";
