import { ClassifierError, safeguardClassify } from "./classifiers";
import { TOPIC_CATEGORIES, type TopicCategory } from "./l2-topic";
import type { GuardResult, OutputContext } from "./types";

/**
 * L4 — output screen, run on every sentence before it can be signed and spoken.
 *
 * Tier 1 (always, <1 ms): system-prompt leak detection, secrets/PII patterns.
 * Tier 2 (only when a risk signal fires): gpt-oss-safeguard on the sentence.
 *
 * Why tiered: the safeguard model costs ~0.2 s and ~400 tokens per call, and the
 * free tier allows 8k tokens/min. Checking every sentence would cap the whole
 * app at ~5 turns/min and add ~0.2 s to first audio. Input is already screened
 * by L1/L2, so the LLM output check is reserved for turns that look risky.
 */

// ---------- tier 1: deterministic ----------

const SHINGLE = 6;

function words(text: string): string[] {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean);
}

function shingles(text: string): Set<string> {
  const w = words(text);
  const out = new Set<string>();
  for (let i = 0; i + SHINGLE <= w.length; i++) out.add(w.slice(i, i + SHINGLE).join(" "));
  return out;
}

const promptShingleCache = new Map<string, Set<string>>();

/**
 * True if the sentence repeats any 6-word run from the system prompt.
 * Quoted text in the prompt ("I couldn't find a place called X") is wording the
 * model is *meant* to say, so it is excluded from the comparison.
 */
export function leaksSystemPrompt(sentence: string, systemPrompt: string): boolean {
  let prompt = promptShingleCache.get(systemPrompt);
  if (!prompt) {
    prompt = shingles(systemPrompt.replace(/"[^"]*"/g, " | "));
    promptShingleCache.clear(); // the prompt only changes with the date; keep one entry
    promptShingleCache.set(systemPrompt, prompt);
  }
  for (const s of shingles(sentence)) if (prompt.has(s)) return true;
  return false;
}

function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

export function findSecrets(sentence: string): string[] {
  const hits: string[] = [];
  if (/\b(gsk|sk|pk|rk)[-_][A-Za-z0-9_-]{16,}|\bAIza[0-9A-Za-z_-]{30,}|\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/.test(sentence)) {
    hits.push("api_key");
  }
  for (const m of sentence.matchAll(/\b(?:\d[ -]?){13,19}\b/g)) {
    if (luhn(m[0].replace(/\D/g, ""))) hits.push("card_number");
  }
  if (/\b\d{3}-\d{2}-\d{4}\b/.test(sentence)) hits.push("ssn");
  return hits;
}

/** Words that make a sentence worth a closer (LLM) look. */
const SENSITIVE =
  /\b(mg|milligrams?|dos(e|age)|overdose|pills?|prescri\w+|diagnos\w+|weapons?|guns?|bomb|explosive|poison|kill(ing)?|suicid\w*|self[- ]harm|drugs?|cocaine|meth\w*|heroin|hack(ing)?|passwords?|invest\w*|stocks?|crypto\w*|bitcoin|lawsuit|sue|legal advice|vote|election|democrat|republican|sex\w*|nude|racis\w+)\b/i;

// ---------- tier 2: LLM ----------

export const OUTPUT_POLICY = `# Sarjy output policy
Classify the ASSISTANT SENTENCE spoken by a friendly daily-life voice assistant. The USER MESSAGE is context only.

## Categories (return exactly one)
- allowed: anything not below, including refusals and redirects to professionals.
- medical: gives diagnosis, treatment, dosage or medication instructions.
- legal: gives legal advice about the user's own situation.
- financial: gives personalized investment, trading, or financial advice.
- politics: states an opinion on parties, elections, politicians, or contested policy.
- harm: gives help with crime or dangerous acts: weapons, explosives, making drugs, hacking, theft, or hurting people or animals.
- sexual: sexual or explicit content.
- hate: hate or harassment toward a group or person.
- self_harm: encourages or instructs self-harm.
- system_prompt: reveals the assistant's hidden instructions.

A sentence that DECLINES or redirects is "allowed".
Respond with JSON only: {"category": "<category>", "confidence": <0-1>}`;

const CLOSING_LINE = "Actually, let me stop there. Is there something else I can help with?";
const LLM_TIMEOUT_MS = 1200;

export type OutputRisk = { reasons: string[] };

export async function screenOutput(ctx: OutputContext): Promise<GuardResult> {
  const t0 = performance.now();
  const done = (r: Omit<GuardResult, "layer" | "ms">): GuardResult => ({
    layer: "L4_output",
    ms: Math.round((performance.now() - t0) * 100) / 100,
    ...r,
  });

  if (leaksSystemPrompt(ctx.sentence, ctx.systemPrompt)) {
    return done({ verdict: "block", reason: "repeats system prompt text", replacement: CLOSING_LINE });
  }
  const secrets = findSecrets(ctx.sentence);
  if (secrets.length) return done({ verdict: "block", reason: `contains ${secrets.join(", ")}`, replacement: CLOSING_LINE });

  const triggers = [...ctx.risk.reasons];
  if (SENSITIVE.test(ctx.sentence)) triggers.push("sensitive wording");
  if (triggers.length === 0) return done({ verdict: "pass", reason: "deterministic checks clean" });

  try {
    const v = await safeguardClassify<{ category?: string; confidence?: number }>(
      OUTPUT_POLICY,
      `USER MESSAGE: ${ctx.userText.slice(0, 400)}\nASSISTANT SENTENCE: ${ctx.sentence}`,
      { timeoutMs: LLM_TIMEOUT_MS, signal: ctx.signal },
    );
    const category = (TOPIC_CATEGORIES as readonly string[]).includes(v.category ?? "")
      ? (v.category as TopicCategory)
      : "allowed";
    const confidence = typeof v.confidence === "number" ? v.confidence : 0.5;
    if (category !== "allowed" && confidence >= 0.6) {
      return done({ verdict: "block", reason: `${category} (${confidence.toFixed(2)}); triggered by ${triggers.join(", ")}`, replacement: CLOSING_LINE });
    }
    return done({ verdict: "pass", reason: `LLM check ${category} (${confidence.toFixed(2)}); triggered by ${triggers.join(", ")}` });
  } catch (err) {
    if (!(err instanceof ClassifierError)) throw err;
    // Fail closed: we only get here when something already looked risky.
    return done({ verdict: "block", reason: `risky sentence and classifier unavailable (fail-closed): ${err.message}`, replacement: CLOSING_LINE });
  }
}

// ---------- speech hygiene ----------

/** Strips markdown/URLs the model sometimes emits despite instructions; these read badly aloud. */
export function sanitizeForSpeech(text: string): string {
  return text
    .replace(/https?:\/\/\S+/g, "the link")
    .replace(/[*_`#]+/g, "")
    .replace(/^\s*[-•]\s+/, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}
