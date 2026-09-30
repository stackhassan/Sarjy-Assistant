import { ClassifierError, promptGuardScore } from "./classifiers";
import { timed, type GuardResult, type InputContext } from "./types";

/** Prompt Guard score at or above which input is blocked outright. */
export const BLOCK_THRESHOLD = 0.9;
/** Lower bar when a heuristic also matched (two independent signals agree). */
export const HEURISTIC_ASSIST_THRESHOLD = 0.3;
/**
 * Previous user turns are scored together with the latest one, catching multi-turn
 * ("crescendo") attacks. The red-team placed a payload just outside a 3-turn window,
 * so this covers every user turn the model will see (history is trimmed upstream).
 */
const WINDOW_TURNS = 12;

// ---------- normalization & de-obfuscation ----------

const ZERO_WIDTH = /[​-‏⁠-⁤﻿]/g;
const LEET: Record<string, string> = { "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "@": "a", $: "s" };

export function normalize(text: string): string {
  return text.normalize("NFKC").replace(ZERO_WIDTH, "").replace(/\s+/g, " ").trim();
}

function isMostlyPrintable(s: string): boolean {
  if (s.length < 8) return false;
  const printable = s.replace(/[^\x20-\x7E]/g, "").length;
  return printable / s.length > 0.9 && /[a-z]{3,}/i.test(s);
}

function rot13(s: string): string {
  return s.replace(/[a-z]/gi, (c) => {
    const base = c <= "Z" ? 65 : 97;
    return String.fromCharCode(((c.charCodeAt(0) - base + 13) % 26) + base);
  });
}

/** Common English words: if reversing the text turns gibberish into these, it was reversed. */
const COMMON = new Set("the a an and or is are was be to of in on for with you your i my me it that this what who which how should would could do does can will give tell best better name dose take how many much pick vote party leader".split(" "));

function commonShare(s: string): number {
  const w = s.toLowerCase().match(/[a-z']+/g) ?? [];
  return w.length ? w.filter((x) => COMMON.has(x)).length / w.length : 0;
}

/** The whole string reversed, if that reads as English much better than the original. */
export function reverseVariant(text: string): string | null {
  if (text.length < 12) return null;
  const announced = /\b(other way round|backwards?|reversed?|from the end|right to left)\b/i.test(text);
  // The payload is often only the part after "…backwards:" or inside quotes.
  const tail = text.split(/[:"“”]/).filter((x) => x.trim()).pop() ?? text;
  const rev = (s: string) => [...s].reverse().join("");
  const perWord = (s: string) => s.split(/(\s+)/).map(rev).join("");
  const best = [rev(text), perWord(text), rev(tail), perWord(tail)].map((x) => x.trim()).sort((a, b) => commonShare(b) - commonShare(a))[0];
  return (announced && commonShare(best) > commonShare(text)) || (commonShare(best) >= 0.3 && commonShare(text) < 0.1) ? best : null;
}

/**
 * Returns decoded variants of any obfuscated payloads (base64, hex, rot13, leetspeak)
 * so the same checks run on what the attacker actually meant.
 */
export function decodeVariants(text: string): string[] {
  const out = new Set<string>();

  for (const token of text.match(/[A-Za-z0-9+/_-]{16,}={0,2}/g) ?? []) {
    try {
      const decoded = Buffer.from(token.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
      if (isMostlyPrintable(decoded)) out.add(decoded);
    } catch {
      /* not base64 */
    }
  }
  for (const token of text.match(/\b(?:[0-9a-f]{2}\s?){8,}\b/gi) ?? []) {
    const decoded = Buffer.from(token.replace(/\s/g, ""), "hex").toString("utf8");
    if (isMostlyPrintable(decoded)) out.add(decoded);
  }
  if (/\brot-?13\b/i.test(text)) out.add(rot13(text));
  // Reversed text (round 6: L2 read a reversed political ask as gibberish and allowed it).
  const reversed = reverseVariant(text);
  if (reversed) out.add(reversed);
  if (/[a-z][013457@$][a-z]/i.test(text)) {
    const unleet = text.replace(/[013457@$]/g, (c) => LEET[c] ?? c);
    if (unleet !== text) out.add(unleet);
  }
  out.delete(text);
  return [...out];
}

// ---------- heuristics ----------

const PATTERNS: { name: string; re: RegExp }[] = [
  {
    name: "instruction_override",
    re: /\b(ignore|disregard|forget|override|bypass)\b.{0,40}\b(previous|prior|above|earlier|all|your|the|system)\b.{0,30}\b(instructions?|rules|prompts?|guidelines|directives|programming|restrictions)\b/i,
  },
  {
    name: "persona_hijack",
    re: /\b(you are now|from now on,? you are|act as|pretend (to be|you are)|roleplay as)\b.{0,60}\b(dan|unfiltered|uncensored|jailbroken|evil|no (rules|limits|restrictions|filters))\b|\bdo anything now\b|\b(developer|god|jailbreak|dan) mode\b/i,
  },
  {
    name: "prompt_extraction",
    re: /\b(reveal|show|print|repeat|output|tell me|what (is|are|were)|give me|recite|leak)\b.{0,30}\b(your|initial|original|hidden|secret)\b.{0,20}\b(system prompt|instructions|prompt|rules|guidelines|configuration)\b|\bsystem prompt\b/i,
  },
  {
    name: "fictional_bypass",
    re: /\b(hypothetically|in a (story|novel|fictional world)|for a (novel|movie|screenplay)|my (late )?grand(ma|mother|pa|father) used to)\b.{0,120}\b(how to|steps to|instructions for|recipe for|make|build)\b/i,
  },
  { name: "encoded_payload", re: /\b(decode|decrypt|translate) (this|the following)\b.{0,40}\b(and|then)\b.{0,20}\b(follow|do|execute|obey)\b/i },
];

export function heuristicHits(texts: string[]): string[] {
  const hits = new Set<string>();
  for (const t of texts) for (const p of PATTERNS) if (p.re.test(t)) hits.add(p.name);
  return [...hits];
}

// ---------- the guard ----------

const REFUSAL =
  "Nice try! I'm staying plain old Sarjy, rules and all. What can I actually help you with?";

export type L1Result = GuardResult & { score: number | null };

export async function screenJailbreak(ctx: InputContext): Promise<L1Result> {
  let score: number | null = null;
  const result = await timed("L1_input", async () => {
    const text = normalize(ctx.text);
    const variants = ctx.decoded ?? decodeVariants(text);
    const recentUser = ctx.history
      .filter((m) => m.role === "user")
      .slice(-WINDOW_TURNS)
      .map((m) => m.content);
    const window = recentUser.length ? [...recentUser, text].join("\n") : null;

    const hits = heuristicHits([text, ...variants]);

    try {
      const scored = await Promise.all(
        [text, ...variants, ...(window ? [window] : [])].map((t) => promptGuardScore(t, ctx.signal)),
      );
      score = Math.max(...scored);
    } catch (err) {
      if (!(err instanceof ClassifierError)) throw err;
      // Degraded: classifier unavailable, so heuristics decide on their own.
      return hits.length
        ? { verdict: "block", reason: `heuristics: ${hits.join(", ")} (classifier down)`, replacement: REFUSAL }
        : { verdict: "degraded", reason: `classifier unavailable, heuristics clean: ${err.message}` };
    }

    const decoded = variants.length ? ` · decoded ${variants.length} payload(s)` : "";
    if (score >= BLOCK_THRESHOLD) {
      return {
        verdict: "block",
        reason: `prompt-guard ${score.toFixed(3)}${hits.length ? ` + ${hits.join(", ")}` : ""}${decoded}`,
        replacement: REFUSAL,
      };
    }
    if (hits.length && score >= HEURISTIC_ASSIST_THRESHOLD) {
      return { verdict: "block", reason: `${hits.join(", ")} + prompt-guard ${score.toFixed(3)}${decoded}`, replacement: REFUSAL };
    }
    return {
      verdict: "pass",
      reason: `prompt-guard ${score.toFixed(3)}${hits.length ? ` (heuristic ${hits.join(", ")} not confirmed)` : ""}${decoded}`,
    };
  });
  return { ...result, score };
}
