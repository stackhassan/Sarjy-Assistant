import type { HistoryMessage, TurnEvent } from "@/lib/events";
import { screenInput, screenSentence } from "@/lib/guardrails";
import type { GuardResult } from "@/lib/guardrails/types";
import { streamChat } from "@/lib/llm/providers";
import type { ChatMessage, ToolCall } from "@/lib/llm/types";
import { systemPrompt } from "@/lib/prompts";
import { SentenceSplitter } from "@/lib/text/sentences";
import { runTool, toolSpecs } from "@/lib/tools";

export type TurnInput = {
  text: string;
  history: HistoryMessage[];
  timeZone: string;
};

const MAX_TOOL_ROUNDS = 3;
const MAX_HISTORY = 12;

const FALLBACK_LINE = "Sorry, I'm having trouble thinking right now. Could you try again in a moment?";

/**
 * Runs one conversational turn and streams events to `emit`.
 *
 * Input guards (L1/L2) run in parallel with the LLM call to hide their latency,
 * but nothing is spoken and no tool is executed until they pass. Each sentence
 * then goes through L4 before being emitted, pipelined with token streaming.
 */
export async function runTurn(input: TurnInput, emit: (e: TurnEvent) => void, signal: AbortSignal) {
  const turnId = crypto.randomUUID();
  const t0 = performance.now();
  const timings: Record<string, number> = {};
  const mark = (k: string) => (timings[k] ??= Math.round(performance.now() - t0));

  const llmAbort = new AbortController();
  const llmSignal = AbortSignal.any([signal, llmAbort.signal]);
  let stopped = false;
  let provider: string | undefined;
  let idx = 0;

  const emitGuard = (r: GuardResult) =>
    emit({ type: "guard", layer: r.layer, verdict: r.verdict, reason: r.reason, ms: r.ms });

  // Resolves to the blocking result, or null if the input is allowed.
  const gate: Promise<GuardResult | null> = screenInput({ text: input.text, history: input.history, signal })
    .catch((err): GuardResult[] => [
      { layer: "L1_input", verdict: "degraded", reason: `input guards failed: ${(err as Error).message}`, ms: 0 },
    ])
    .then((results) => {
      results.forEach(emitGuard);
      mark("inputGuards");
      const blocked = results.find((r) => r.verdict === "block") ?? null;
      if (blocked) {
        stopped = true;
        llmAbort.abort();
        emit({ type: "sentence", idx: idx++, text: blocked.replacement ?? "Let's talk about something else." });
      }
      return blocked;
    });

  // Sentences are screened and emitted strictly in order, while tokens keep streaming.
  let speechChain = Promise.resolve();
  const speak = (sentence: string) => {
    speechChain = speechChain.then(async () => {
      if ((await gate) || stopped) return;
      const r = await screenSentence({ sentence, userText: input.text, signal });
      emitGuard(r);
      if (stopped) return;
      if (r.verdict === "block") {
        stopped = true;
        llmAbort.abort();
        emit({ type: "sentence", idx: idx++, text: r.replacement ?? "Let's leave it there." });
        return;
      }
      mark("firstSentence");
      emit({ type: "sentence", idx: idx++, text: sentence });
    });
  };

  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt({ now: new Date(), timeZone: input.timeZone }) },
    ...input.history.slice(-MAX_HISTORY),
    { role: "user", content: input.text },
  ];

  try {
    for (let round = 0; round < MAX_TOOL_ROUNDS && !stopped; round++) {
      const splitter = new SentenceSplitter();
      const calls = new Map<number, ToolCall>();
      let text = "";

      for await (const d of streamChat({ messages, tools: toolSpecs, signal: llmSignal })) {
        provider = d.provider;
        if (d.type === "text") {
          mark("firstToken");
          text += d.text;
          splitter.push(d.text).forEach(speak);
        } else if (d.type === "tool_call") {
          const c = calls.get(d.index) ?? { id: "", type: "function", function: { name: "", arguments: "" } };
          if (d.id) c.id = d.id;
          if (d.name) c.function.name += d.name;
          if (d.args) c.function.arguments += d.args;
          calls.set(d.index, c);
        }
      }
      const rest = splitter.flush();
      if (rest) speak(rest);
      if (calls.size === 0) break;

      // Tools can have side effects (e.g. memory writes), so never run them on blocked input.
      if (await gate) break;

      const toolCalls = [...calls.values()];
      messages.push({ role: "assistant", content: text || null, tool_calls: toolCalls });
      for (const call of toolCalls) {
        emit({ type: "tool_call", id: call.id, name: call.function.name, args: call.function.arguments });
        const ts = performance.now();
        const result = await runTool(call.function.name, call.function.arguments, signal);
        mark(`tool:${call.function.name}`);
        emit({
          type: "tool_result",
          id: call.id,
          name: call.function.name,
          ok: result.ok,
          data: result,
          ms: Math.round(performance.now() - ts),
        });
        // Tool output is data for the model, never instructions.
        messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
      }
    }
  } catch (err) {
    if (!stopped && !signal.aborted) {
      emit({ type: "error", stage: "llm", message: (err as Error).message, spokenFallback: FALLBACK_LINE });
    }
  }

  await gate;
  await speechChain;
  timings.total = Math.round(performance.now() - t0);
  emit({ type: "done", turnId, provider, timings });
}
