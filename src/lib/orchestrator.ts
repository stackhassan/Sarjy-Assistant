import type { HistoryMessage, TurnEvent } from "@/lib/events";
import { checkGrounding, sanitizeForSpeech, screenInput, screenOutput, type InputScreen } from "@/lib/guardrails";
import type { GuardResult } from "@/lib/guardrails/types";
import { MidStreamError, streamChat } from "@/lib/llm/providers";
import type { ChatMessage, ToolCall } from "@/lib/llm/types";
import { factsBlock, systemPrompt } from "@/lib/prompts";
import { MemoryError, type Fact, type MemoryStore } from "@/lib/memory/store";
import { MEMORY_TOOL_NAMES, memoryToolSpecs, runMemoryTool } from "@/lib/tools/memory";
import { context } from "@/lib/reliability/context";
import { splitLong } from "@/lib/text/batch";
import { SentenceSplitter } from "@/lib/text/sentences";
import { runTool, toolSpecs } from "@/lib/tools";
import { summarizeWeather, type WeatherResult } from "@/lib/tools/weather";
import { signAssistantTurn, signSentence, verifyHistory } from "@/lib/tts/sign";
import { fitScreeningBudget } from "@/lib/guardrails/l2-topic";
import { degradedPolicy } from "@/lib/guardrails/policy";

export type TurnInput = {
  text: string;
  history: HistoryMessage[];
  timeZone: string;
  /** The signed-in user's memory; null when not signed in or not configured. */
  memory?: MemoryStore | null;
};

const MAX_TOOL_ROUNDS = 3;
const MAX_HISTORY = 12;
/** Attempts per LLM round when a stream dies before anything was spoken. */
const MAX_STREAM_ATTEMPTS = 2;

const FALLBACK_LINE = "Sorry, I'm having trouble thinking right now. Could you try again in a moment?";
const LOST_TRAIN_LINE = "Sorry, I lost my train of thought there. Could you ask me that again?";
const EMPTY_LINE = "Sorry, I didn't quite get that. Could you say it another way?";
const SAFE_MODE_LINE =
  "Sorry, my safety checks are having a moment, so I'm keeping things simple. I can still check the weather for you, or try me again shortly.";
const NO_TOOL_WEATHER_LINE =
  "Let me not guess at that. I'd need to check the live forecast, so which city should I look up?";

/**
 * Runs one conversational turn and streams events to `emit`.
 *
 *  input ──┬─ L1 jailbreak ─┐
 *          ├─ L2 topic ─────┴─ gate ──┐   (in parallel with the LLM; nothing is
 *          └─ LLM stream ── sentences ┴─ L3 grounding → L4 output → sign → emit
 *                            └─ tool calls (only after the gate opens)
 */
export async function runTurn(rawInput: TurnInput, emit: (e: TurnEvent) => void, signal: AbortSignal) {
  const { bypassGuards } = context();
  // History comes from the client. Keep only the verified chain: forged, re-used or
  // re-ordered assistant turns, and anything after them, are dropped.
  const { trusted, dropped } = verifyHistory(rawInput.history);
  // Then trim to what L2 can screen in full, so the guards see exactly what the model sees
  // (round 3: padding pushed an ask out of L2's chunks while the model still read it).
  const window = trusted.slice(-MAX_HISTORY).map(({ role, content }) => ({ role, content }));
  const { history, trimmed } = fitScreeningBudget(window);
  const input: TurnInput = { ...rawInput, history };
  const lastSig = [...trusted].reverse().find((m) => m.role === "assistant")?.sig ?? "";
  const turnId = crypto.randomUUID();
  const t0 = performance.now();
  const timings: Record<string, number> = {};
  const mark = (k: string) => (timings[k] ??= Math.round(performance.now() - t0));

  const llmAbort = new AbortController();
  const llmSignal = AbortSignal.any([signal, llmAbort.signal]);
  // ---- memory: load this user's facts before the model starts (cached server-side) ----
  let facts: Fact[] = [];
  let memoryState: "available" | "unavailable" | "off" = rawInput.memory ? "available" : "off";
  if (rawInput.memory) {
    const tm = performance.now();
    try {
      facts = await rawInput.memory.list();
    } catch (err) {
      if (!(err instanceof MemoryError)) throw err;
      memoryState = "unavailable";
      emit({ type: "recovery", stage: "tool", action: "memory unavailable", detail: `${err.message}; continuing without memory` });
    }
    timings.memoryLoad = Math.round(performance.now() - tm);
  }
  // Leak checks compare against the instructions only: repeating your own facts back isn't a leak.
  const prompt = systemPrompt({ now: new Date(), timeZone: input.timeZone, memory: memoryState });
  const modelPrompt = memoryState === "available" ? prompt + factsBlock(facts) : prompt;
  const tools = memoryState === "available" ? [...toolSpecs, ...memoryToolSpecs] : toolSpecs;
  const toolResults: unknown[] = [];
  let lastWeather: WeatherResult | null = null;
  let stopped = false;
  let provider: string | undefined;
  let idx = 0;
  const spoken: string[] = [];

  /** Emits approved text as signed, TTS-sized sentence events. */
  const emitSentence = (text: string) => {
    for (const piece of splitLong(text)) {
      spoken.push(piece);
      emit({ type: "sentence", idx: idx++, text: piece, sig: signSentence(piece) });
    }
  };
  const emitGuard = (r: GuardResult) =>
    emit({ type: "guard", layer: r.layer, verdict: r.verdict, reason: r.reason, ms: r.ms });
  /** Stops the turn and says `line` instead of whatever the model was going to say. */
  const takeOver = (line: string) => {
    stopped = true;
    llmAbort.abort();
    emitSentence(line);
  };

  if (dropped && !bypassGuards) {
    emit({ type: "guard", layer: "L1_input", verdict: "repair", reason: `dropped ${dropped} unverified history message(s)`, ms: 0 });
  }
  if (trimmed) {
    emit({ type: "guard", layer: "L2_topic", verdict: "repair", reason: `trimmed ${trimmed} old message(s) beyond the screening budget`, ms: 0 });
  }

  // Fail-closed safe mode: set when an input guard couldn't run (see guardrails/policy.ts).
  let safeMode = false;

  // ---- input guards (L1 + L2), started in parallel with the LLM ----
  const gate: Promise<InputScreen | null> = bypassGuards
    ? Promise.resolve(null)
    : screenInput({ text: input.text, history: input.history, signal }).then(
        (screen) => {
          screen.results.forEach(emitGuard);
          for (const r of screen.results) {
            if (r.verdict === "degraded") emit({ type: "recovery", stage: "guard", action: "degraded mode", detail: `${r.layer}: ${r.reason}` });
          }
          mark("inputGuards");
          if (screen.blocked) takeOver(screen.blocked.replacement ?? "Let's talk about something else.");
          else if (screen.risk.degraded && degradedPolicy() === "fail_closed") {
            safeMode = true;
            emit({ type: "recovery", stage: "guard", action: "safe mode", detail: "input guards unavailable: no free-form model output this turn" });
          }
          return screen;
        },
        (err) => {
          // Unexpected guard bug (not a classifier outage, which the layers handle): fail closed.
          emit({ type: "guard", layer: "L1_input", verdict: "block", reason: `guard error: ${(err as Error).message}`, ms: 0 });
          takeOver("Sorry, something went wrong on my side. Could you try that again?");
          return null;
        },
      );

  // ---- per-sentence output path: L3 → L4 → sign → emit, strictly in order ----
  let speechChain = Promise.resolve();
  let firstReadyAt: number | null = null;
  const speak = (raw: string) => {
    firstReadyAt ??= performance.now();
    speechChain = speechChain.then(async () => {
      const screen = await gate;
      if (stopped || safeMode) return; // safe mode: the model's own words are never spoken
      const sentence = sanitizeForSpeech(raw);
      if (!sentence) return;

      if (!bypassGuards) {
        const l3 = checkGrounding({ sentence, userText: input.text, toolResults });
        if (l3.reason !== "no figures") emitGuard(l3);
        if (l3.verdict === "repair") {
          takeOver(lastWeather ? summarizeWeather(lastWeather, input.text) : NO_TOOL_WEATHER_LINE);
          return;
        }
        const l4 = await screenOutput({
          sentence,
          userText: input.text,
          systemPrompt: prompt,
          risk: screen?.risk ?? { reasons: [] },
          // Cheap leak tripwires also run over the whole turn and earlier replies, so a
          // leak spread one piece per sentence (or per reply) is seen whole (round 4 review).
          spokenSoFar: spoken.join(" "),
          priorReplies: input.history.filter((m) => m.role === "assistant").map((m) => m.content).join(" "),
          signal,
        });
        emitGuard(l4);
        if (stopped) return;
        if (l4.verdict === "block") {
          takeOver(l4.replacement ?? "Let's leave it there.");
          return;
        }
      }
      mark("firstSentence");
      emitSentence(sentence);
    });
  };

  const messages: ChatMessage[] = [
    { role: "system", content: modelPrompt },
    ...input.history,
    { role: "user", content: input.text },
  ];

  try {
    for (let round = 0; round < MAX_TOOL_ROUNDS && !stopped; round++) {
      const exclude: string[] = [];
      let calls = new Map<number, ToolCall>();
      let text = "";

      for (let attempt = 0; attempt < MAX_STREAM_ATTEMPTS; attempt++) {
        const splitter = new SentenceSplitter();
        let spoke = false;
        calls = new Map();
        text = "";
        try {
          for await (const d of streamChat({
            messages,
            tools,
            signal: llmSignal,
            exclude,
            onDemote: (slow, ms) =>
              emit({ type: "recovery", stage: "llm", action: "slow provider set aside", detail: `${slow} first content ${ms} ms on consecutive turns; using the next provider for a minute` }),
            onFailover: (failed, err) =>
              emit({ type: "recovery", stage: "llm", action: "failover", detail: `${failed} → next provider (${err.message.slice(0, 120)})` }),
          })) {
            provider = d.provider;
            if (d.type === "text") {
              mark("firstToken");
              text += d.text;
              for (const s of splitter.push(d.text)) {
                spoke = true;
                speak(s);
              }
            } else if (d.type === "tool_call") {
              const c = calls.get(d.index) ?? { id: "", type: "function", function: { name: "", arguments: "" } };
              if (d.id) c.id = d.id;
              if (d.name) c.function.name += d.name;
              if (d.args) c.function.arguments += d.args;
              if (d.extra !== undefined) c.extra_content = d.extra;
              calls.set(d.index, c);
            }
          }
          const rest = splitter.flush();
          if (rest) speak(rest);
          break;
        } catch (err) {
          // A stream that died before we spoke anything can be retried invisibly on the next provider.
          if (err instanceof MidStreamError && !spoke && attempt + 1 < MAX_STREAM_ATTEMPTS) {
            exclude.push(err.provider);
            emit({ type: "recovery", stage: "llm", action: "retry", detail: `${err.message.slice(0, 140)}; nothing spoken yet, retrying on next provider` });
            continue;
          }
          throw err;
        }
      }

      if (calls.size === 0) break;
      // Tools can have side effects (e.g. memory writes), so never run them on blocked input.
      await gate;
      if (stopped) break;

      const toolCalls = [...calls.values()];
      messages.push({ role: "assistant", content: text || null, tool_calls: toolCalls });
      for (const call of toolCalls) {
        emit({ type: "tool_call", id: call.id, name: call.function.name, args: call.function.arguments });
        const ts = performance.now();
        const result =
          MEMORY_TOOL_NAMES.has(call.function.name) && rawInput.memory && memoryState === "available"
            ? await runMemoryTool(call.function.name, call.function.arguments, {
                store: rawInput.memory,
                userTexts: [input.text, ...input.history.filter((m) => m.role === "user").map((m) => m.content)],
                latestUserText: input.text,
                emitGuard,
                signal,
              })
            : await runToolGrounded(call, input, bypassGuards, emitGuard, signal, facts);
        timings[`tool:${call.function.name}`] = Math.round(performance.now() - ts);
        emit({ type: "tool_result", id: call.id, name: call.function.name, ok: result.ok, data: result, ms: timings[`tool:${call.function.name}`] });
        reportToolRecovery(call.function.name, result, emit);
        toolResults.push(result);
        if (call.function.name === "get_weather") {
          lastWeather = result as WeatherResult;
          // Honesty about stale data is too important to leave to the model (the eval caught it
          // skipping the instruction), so the server says it, in order, before the answer.
          if (lastWeather.ok && lastWeather.stale) {
            const line = staleDisclaimer(lastWeather.stale.minutesOld);
            speechChain = speechChain.then(() => {
              if (!stopped) emitSentence(line);
            });
          }
        }
        // Tool output is data for the model, never instructions.
        messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
      }
      // Safe mode speaks only the template built from tool data, so skip the model's wording round.
      if (safeMode) break;
    }
  } catch (err) {
    if (!stopped && !signal.aborted) {
      await speechChain; // let already-approved sentences go out first, in order
      if (err instanceof MidStreamError && idx > 0) {
        emit({ type: "recovery", stage: "llm", action: "graceful stop", detail: err.message.slice(0, 160) });
        emitSentence(LOST_TRAIN_LINE);
      } else {
        spoken.push(FALLBACK_LINE);
        emit({ type: "error", stage: "llm", message: (err as Error).message, spokenFallback: FALLBACK_LINE, sig: signSentence(FALLBACK_LINE) });
      }
    }
  }

  await gate;
  await speechChain;
  if (firstReadyAt !== null && timings.firstSentence !== undefined) {
    // How long the first finished sentence waited on guards before it could be spoken.
    timings.guardWait = Math.max(0, Math.round(t0 + timings.firstSentence - firstReadyAt));
  }
  if (safeMode && !stopped && !signal.aborted) {
    emitSentence(lastWeather ? summarizeWeather(lastWeather, input.text) : SAFE_MODE_LINE);
  }
  // Never end a turn in silence (the red-team saw an empty completion under load).
  if (spoken.length === 0 && !signal.aborted) {
    emit({ type: "recovery", stage: "llm", action: "empty reply", detail: "model returned no text; spoke a fallback line" });
    emitSentence(EMPTY_LINE);
  }
  timings.total = Math.round(performance.now() - t0);
  const text = spoken.join(" ");
  // Chain: previous verified assistant sig + the user turns since it + this reply.
  const lastAssistantIdx = trusted.map((m) => m.role).lastIndexOf("assistant");
  const userTurns = [...trusted.slice(lastAssistantIdx + 1).map((m) => m.content), rawInput.text];
  const sig = signAssistantTurn(lastSig, userTurns, text);
  emit({ type: "done", turnId, provider, timings, guardsBypassed: bypassGuards || undefined, assistant: { text, sig, prev: lastSig } });
}

/**
 * Grounds tool *inputs*: the weather tool may only be called for a place the
 * user actually mentioned. Stops the model inventing a city for "will it rain?".
 */
async function runToolGrounded(
  call: ToolCall,
  input: TurnInput,
  bypass: boolean,
  emitGuard: (r: GuardResult) => void,
  signal: AbortSignal,
  facts: Fact[] = [],
) {
  if (!bypass && call.function.name === "get_weather") {
    const location = safeJson(call.function.arguments)?.location;
    // A place the user told Sarjy before (e.g. home_city in memory) counts as named.
    const said = [input.text, ...input.history.filter((m) => m.role === "user").map((m) => m.content), ...facts.map((f) => f.value)];
    if (typeof location === "string" && !mentioned(location, said)) {
      emitGuard({ layer: "L3_grounding", verdict: "repair", reason: `tool input "${location}" was never said by the user`, ms: 0 });
      return {
        ok: false as const,
        error: "location_unconfirmed" as const,
        message: `The user has not named "${location}". Ask them which city they mean; do not assume.`,
      };
    }
  }
  return runTool(call.function.name, call.function.arguments, signal);
}

export function staleDisclaimer(minutesOld: number): string {
  const age = minutesOld < 1 ? "from just now" : minutesOld === 1 ? "from a minute ago" : `from ${minutesOld} minutes ago`;
  return `Heads up: the live weather service is down, so this forecast is ${age}.`;
}

function fold(s: string) {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

/** Whole-word match: "Paris" is mentioned in "how about paris?", not in "comparison". */
export function mentioned(location: string, said: string[]): boolean {
  const place = fold(location.split(",")[0].trim());
  if (!place) return false;
  const re = new RegExp(`(^|[^\\p{L}])${place.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^\\p{L}])`, "u");
  return said.some((t) => re.test(fold(t)));
}

function safeJson(s: string): Record<string, unknown> | null {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function reportToolRecovery(name: string, result: { ok: boolean } & Record<string, unknown>, emit: (e: TurnEvent) => void) {
  if (name !== "get_weather") return;
  const r = result as WeatherResult;
  if (r.ok && r.stale) {
    emit({ type: "recovery", stage: "tool", action: "stale cache", detail: `all weather sources down; using forecast from ${r.stale.minutesOld} min ago` });
  } else if (r.ok && r.source !== "open-meteo") {
    emit({ type: "recovery", stage: "tool", action: "fallback source", detail: `Open-Meteo failed; forecast from ${r.source}` });
  } else if (!r.ok && r.error === "unavailable") {
    emit({ type: "recovery", stage: "tool", action: "honest failure", detail: r.message.slice(0, 160) });
  }
}
