import { z } from "zod";
import { FACT_CATEGORIES, type Fact } from "@/lib/memory/store";
import { ClassifierError, promptGuardScore } from "./classifiers";
import { decodeVariants, heuristicHits, normalize } from "./l1-input";
import { findSecrets } from "./l4-output";
import type { GuardResult } from "./types";

/**
 * L5 — memory writes. A stored fact is injected into every future conversation, so a
 * bad write is persistent: it has to be checked harder than a single reply.
 */

export const factArgs = z.object({
  key: z
    .string()
    .transform((k) => k.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, ""))
    .pipe(z.string().regex(/^[a-z][a-z0-9_]{0,63}$/)),
  value: z.string().trim().min(1).max(280),
  category: z.enum(FACT_CATEGORIES).default("other"),
});

/** Things Sarjy must never keep, even if the user asks. */
const NEVER_STORE: [string, RegExp][] = [
  ["a password or PIN", /\b(pass ?words?|passcodes?|pin (code|number)|(bank|card|atm|phone) pin|security (code|answer)|2fa|otp)\b/i],
  ["an ID number", /\b(ssn|social security|passport|national id|cnic|driver'?s licen[cs]e|tax id)\b/i],
  ["bank details", /\b(iban|account number|routing number|sort code|cvv|cvc)\b/i],
];

const INJECTION_THRESHOLD = 0.5;

function words(text: string): string[] {
  return normalize(text)
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 3);
}

/** Share of the value's meaningful words that the user actually said this conversation. */
export function groundedInUser(value: string, userTexts: string[]): number {
  const said = new Set(userTexts.flatMap(words));
  const w = words(value);
  if (w.length === 0) return userTexts.some((t) => t.toLowerCase().includes(value.toLowerCase())) ? 1 : 0;
  return w.filter((x) => said.has(x)).length / w.length;
}

export type MemoryWriteCheck = GuardResult & { fact?: Fact };

export async function screenMemoryWrite(
  rawArgs: unknown,
  ctx: { userTexts: string[]; latestUserText: string; signal?: AbortSignal },
): Promise<MemoryWriteCheck> {
  const t0 = performance.now();
  const done = (r: Omit<MemoryWriteCheck, "layer" | "ms">): MemoryWriteCheck => ({
    layer: "L5_memory",
    ms: Math.round(performance.now() - t0),
    ...r,
  });

  const parsed = factArgs.safeParse(rawArgs);
  if (!parsed.success) return done({ verdict: "block", reason: "malformed fact" });
  const { key, value, category } = parsed.data;
  const text = `${key.replace(/_/g, " ")}: ${value}`;

  // 1. Secrets and identifiers are never stored.
  const secret = findSecrets(value);
  if (secret.length) return done({ verdict: "block", reason: `would store ${secret.join(", ")}` });
  const sensitive = NEVER_STORE.find(([, re]) => re.test(text));
  if (sensitive) return done({ verdict: "block", reason: `would store ${sensitive[0]}` });

  // 2. Memory poisoning: a "fact" that is really an instruction to the assistant.
  const variants = [text, ...decodeVariants(normalize(text))];
  const hits = heuristicHits(variants);
  if (hits.length) return done({ verdict: "block", reason: `instruction, not a fact (${hits.join(", ")})` });
  if (/\b(you|sarjy|assistant)\b.{0,30}\b(must|should|will|always|never|are now|have to)\b/i.test(value)) {
    return done({ verdict: "block", reason: "tells the assistant what to do, not a fact about the user" });
  }
  try {
    const score = await promptGuardScore(variants.join("\n"), ctx.signal);
    if (score >= INJECTION_THRESHOLD) return done({ verdict: "block", reason: `prompt-guard ${score.toFixed(2)} on the fact` });
  } catch (err) {
    if (!(err instanceof ClassifierError)) throw err;
    // Classifier down: heuristics already ran; the grounding check below still applies.
  }

  // 3. Grounding: the fact must come from the user's own words, not the model's imagination
  //    or text from a tool result.
  const grounded = groundedInUser(value, ctx.userTexts);
  if (grounded < 0.5) {
    return done({ verdict: "block", reason: `value isn't something the user said (${Math.round(grounded * 100)}% of its words)` });
  }

  return done({
    verdict: "pass",
    reason: `ok: ${key} (${category})`,
    fact: { key, value, category, source_turn: ctx.latestUserText.slice(0, 500) },
  });
}
