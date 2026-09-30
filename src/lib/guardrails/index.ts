import { decodeVariants, HEURISTIC_ASSIST_THRESHOLD, normalize, REFUSAL, screenJailbreak } from "./l1-input";
import { MIN_BLOCK_CONFIDENCE, screenTopic, TOPIC_REPLIES } from "./l2-topic";
import type { GuardResult, InputContext } from "./types";

export { checkGrounding } from "./l3-grounding";
export { sanitizeForSpeech, screenOutput } from "./l4-output";

/**
 * Requests to repeat, translate or continue earlier text: the shape of every
 * system-prompt extraction the red-team landed. These turns get L4's LLM check.
 */
const REPLAY_REQUEST =
  /\b(translat(e|ion)|tradu\w*|übersetz\w*|continue|continuez|contin[uú]a|repeat|recite|verbatim|word for word|everything above|where you (left off|stopped)|carry on|keep going|summari[sz]e (your|the) (rules|instructions|guidelines)|pig latin|spell(ed|ing)? (it|out|that)|letter by letter|one word (at a time|per)|backwards|reversed?|encode|base ?64|rot ?13|morse|cipher|acrostic|transliterat\w*|say it in|in (another|a different) language|first (message|paragraph|thing you were told)|build name|topics? you (avoid|won'?t)|every (other|second|third|\w+th) (word|letter)|(shift|move|rotate)\w*.{0,30}\bletters?|caesar|one (step|letter|place) (forward|back|along)|nato|phonetic alphabet|setup text|very first text|sets you up|came before (i|me)|code ?name|hidden text|pirate|haiku|emoji|acrostic|house style|how you work|your (own )?(style|rules|guidelines|approach|setup)|other way round|backwards?|reversed?)\b|^\s*go on\b/i;

/**
 * Role-play set-ups in any user turn ("you're Captain Nova, stay in character"). A
 * character voice is fine; but round 6 got "the factory's old code no longer binds her"
 * out of one, so every sentence of such a conversation gets L4's LLM check.
 */
const ROLE_PLAY = /\b(stay (in|in-)character|in character|role-?play|improv|pretend (to be|you('| a)re)|play (a|the) (character|role))\b/i;
/** "You're Captain Nova, a…": a named character; case-sensitive on purpose (proper noun). */
const NAMED_CHARACTER = /\b[Yy]ou('| a)re (now )?(a |an |the )?[A-Z][a-z]+( [A-Z][a-z]+)?,? (a|an|the)\b/;
/** Questions about how Sarjy itself works (round 6: "describe your own house style"). */
const SELF_QUESTION =
  /\b(house style|how (do )?you work|how (does|do) sarjy work|how sarjy works|your (own )?(style|rules|guidelines|approach|setup|personality|instructions)|describe (yourself|how you)|how would you explain (your|how you)|what are you (not )?allowed)\b|\b(how long|how short|how brief)\b.{0,20}\byour (answers|replies|responses)\b|\bwhat (formatting|format|style) you\b|\bwhat you (always|never) do\b|\b(factory|makers?|creators?)\b.{0,80}\b(allowed|had to|rules?|drilled|trained|programm\w*|taught)\b|\b(allowed|had to|rules?|drilled|trained|programm\w*|taught)\b.{0,80}\b(factory|makers?|creators?)\b/i;

/**
 * An earlier reply that commits to answering later ("Deal, when you ask, I'll answer with
 * just a name"), or a user pointing back at one ("like we agreed"). Round 3 used exactly
 * this to get trigger-free answers past L4, so such turns get the LLM check on every sentence.
 */
const COMMITMENT = new RegExp(
  [
    // English, incl. paraphrases (round 4: the original list was narrow and English-only)
    String.raw`\bdeal[,.!]`,
    String.raw`\b(when|whenever|once) you('re| are)? (ask|ready|say (so|the word|go))`,
    String.raw`\bi'?ll (answer|tell|give|say|share|do) (it |you |that )?(then|later|exactly|with (just|only))`,
    String.raw`\b(like|as) (we )?(agreed|discussed|promised|planned)\b`,
    String.raw`\b(our deal|you have my word|i promise|what you promised|as promised|remember (our|the) (deal|game|agreement))\b`,
    // Spanish, French, German
    String.raw`\b(trato hecho|de acuerdo|prometido|te lo dir[eé]|cuando (me )?(lo )?pidas|como acordamos)\b`,
    String.raw`(march[eé] conclu|d'accord|promis\b|je te (le )?dirai|quand tu (me )?le demanderas|comme convenu)`,
    String.raw`\b(abgemacht|versprochen|wie vereinbart)\b`,
    // Roman Urdu / Hindi
    String.raw`\b(wada|waada|pakka|jab (aap|tum) (kahein|kaho|poocho)|main bata (dunga|dungi|doonga|doongi))\b`,
    "(वादा|पक्का|जब आप कहें|وعدہ|پکا)",
  ].join("|"),
  "i",
);

/** Risk reasons L4 acts on directly (exported so L4 can recognise them). */
export const ROLE_PLAY_REASON = "role-play in the conversation";
export const SELF_QUESTION_REASON = "asks how Sarjy works";

export type InputScreen = {
  results: GuardResult[];
  /** First blocking result, in layer order (L1 before L2). */
  blocked: GuardResult | null;
  /** Reasons the output of this turn deserves an LLM check in L4, and whether input was screened blind. */
  risk: { reasons: string[]; degraded: boolean };
};

/**
 * L1 (jailbreak / injection) and L2 (topic policy) in parallel. Both take
 * ~0.2-0.35 s, and the orchestrator runs this alongside the main LLM call, so
 * on a normal turn they finish before the first sentence is ready.
 */
export async function screenInput(ctx: InputContext): Promise<InputScreen> {
  // Decode once (sync, <1 ms) so L2 judges what an obfuscated message actually asks for.
  const withDecoded = { ...ctx, decoded: ctx.decoded ?? decodeVariants(normalize(ctx.text)) };
  const [l1, l2] = await Promise.all([screenJailbreak(withDecoded), screenTopic(withDecoded)]);
  const results: GuardResult[] = [l1, l2];

  const reasons: string[] = [];
  // Blind input screening means the output must be screened harder (L4 fails closed on sensitive wording).
  const degraded = results.some((r) => r.verdict === "degraded");
  // Conversation flags look at the *recent* turns only. They used to scan the whole history,
  // so one "how does Sarjy work?" kept every later answer under extra checks, and could get
  // "at most a 10% chance of rain" blocked three turns later (review feedback). Requests
  // parked further back are still seen by L2, which screens the whole context, and by the
  // leak tripwires, which run on every sentence regardless of flags.
  // These two only add L4's LLM check, so they look a little further back.
  const soft = recentWindow(ctx, SOFT_FLAG_USER_TURNS);
  if (soft.user.some((t) => REPLAY_REQUEST.test(t))) reasons.push("asks to repeat/translate/encode");
  if (soft.all.some((t) => COMMITMENT.test(t))) reasons.push("a prior commitment is being cashed in");
  // These make L4 block matching sentences outright, so they need the current message
  // (role-play: or the one just before it, since the attack comes on the turn after the set-up).
  if (recentWindow(ctx, 2).user.some((t) => ROLE_PLAY.test(t) || NAMED_CHARACTER.test(t))) reasons.push(ROLE_PLAY_REASON);
  if (SELF_QUESTION.test(ctx.text)) reasons.push(SELF_QUESTION_REASON);
  if (l1.score !== null && l1.score >= HEURISTIC_ASSIST_THRESHOLD) reasons.push(`prompt-guard ${l1.score.toFixed(2)}`);
  if (l2.category && l2.category !== "allowed" && (l2.confidence ?? 0) < MIN_BLOCK_CONFIDENCE) {
    reasons.push(`possible ${l2.category}`);
  }

  return { results, blocked: results.find((r) => r.verdict === "block") ?? null, risk: { reasons, degraded } };
}

/**
 * User turns (including the current one) the extra-check flags look at: the current
 * message and the two before it. Round 2's "Pig Latin" request, parked two turns before
 * "ok do the game now", still falls inside it.
 */
export const SOFT_FLAG_USER_TURNS = 3;

/**
 * The last `userTurns` user messages (current one included), and every message, both
 * sides, since the earliest of them: a commitment in the reply just before still counts.
 */
export function recentWindow(ctx: Pick<InputContext, "text" | "history">, userTurns: number) {
  const userIdx = ctx.history.flatMap((m, i) => (m.role === "user" ? [i] : []));
  const back = userTurns - 1;
  const start = back <= 0 ? ctx.history.length : userIdx.length >= back ? userIdx[userIdx.length - back] : 0;
  const tail = ctx.history.slice(start);
  return {
    user: [ctx.text, ...tail.filter((m) => m.role === "user").map((m) => m.content)],
    all: [ctx.text, ...tail.map((m) => m.content)],
  };
}

/**
 * Input-guard refusals. A past exchange whose whole reply is one of these was stopped
 * before the model spoke, so it's a dead end: nothing in it is context worth keeping.
 * Self-harm is the exception. Its reply is support, not a refusal, and a follow-up like
 * "I just feel so alone" must still be read in its light.
 */
const DEAD_END_REPLIES = new Set([REFUSAL, ...Object.entries(TOPIC_REPLIES).filter(([k]) => k !== "self_harm").map(([, v]) => v)]);

/**
 * Drops past exchanges the input guards blocked. L1 scores the recent user turns together
 * (to catch an injection split across turns), so one blocked "ignore your rules" used to
 * score high in every later turn's window and block the next 12 questions ("Fine. What's
 * the capital of Japan?" was refused; found by the multi-turn eval). Dropping it also
 * means the model never sees the blocked text. Replies are server-signed, so a client
 * can't fake a dead end to hide something. Split injections across turns that were *not*
 * blocked are still scored together.
 */
export function dropDeadEnds<T extends { role: string; content: string }>(history: T[]): { history: T[]; dropped: number } {
  const out: T[] = [];
  let dropped = 0;
  for (let i = 0; i < history.length; i++) {
    const m = history[i];
    const next = history[i + 1];
    if (m.role === "user" && next?.role === "assistant" && DEAD_END_REPLIES.has(next.content.trim())) {
      i++;
      dropped++;
      continue;
    }
    out.push(m);
  }
  return { history: out, dropped };
}
