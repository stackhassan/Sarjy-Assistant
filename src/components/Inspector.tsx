import type { TurnEvent } from "@/lib/events";
import type { Turn } from "./VoiceAssistant";

const VERDICT_STYLES: Record<string, string> = {
  pass: "bg-emerald-500/10 text-emerald-300 ring-emerald-500/25",
  repair: "bg-amber-500/10 text-amber-300 ring-amber-500/25",
  degraded: "bg-amber-500/10 text-amber-300 ring-amber-500/25",
  block: "bg-rose-500/15 text-rose-300 ring-rose-500/30",
};

const SHORT_LAYER: Record<string, string> = {
  L1_input: "L1",
  L2_topic: "L2",
  L3_grounding: "L3",
  L4_output: "L4",
  L5_memory: "L5",
};

/** Worst verdict per layer for a turn, in layer order: the one-line summary. */
function layerSummary(events: TurnEvent[]) {
  const rank = { pass: 0, degraded: 1, repair: 2, block: 3 } as const;
  const worst = new Map<string, keyof typeof rank>();
  for (const e of events) {
    if (e.type !== "guard") continue;
    const cur = worst.get(e.layer);
    if (!cur || rank[e.verdict] > rank[cur]) worst.set(e.layer, e.verdict);
  }
  return Object.keys(SHORT_LAYER)
    .filter((l) => worst.has(l))
    .map((l) => ({ layer: l, verdict: worst.get(l)! }));
}

/** Guardrail Inspector: what each layer decided on each turn, and how long it took. */
export function Inspector({ turns, onClose }: { turns: Turn[]; onClose: () => void }) {
  const ordered = [...turns].reverse();
  return (
    <aside className="flex h-full flex-col" aria-label="Guardrail Inspector">
      <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
        <div>
          <h2 className="text-sm font-medium text-slate-100">Guardrails</h2>
          <p className="text-xs text-slate-500">What each layer decided, per turn</p>
        </div>
        <button type="button" onClick={onClose} className="rounded-md px-2 py-1 text-slate-400 hover:bg-white/5 hover:text-slate-200" aria-label="Close guardrails">
          ✕
        </button>
      </div>
      <div className="flex-1 space-y-2 overflow-y-auto p-3">
        {ordered.length === 0 && <p className="p-2 text-sm text-slate-500">Each turn&apos;s guardrail decisions will appear here.</p>}
        {ordered.map((t, i) => (
          <TurnCard key={t.id} turn={t} open={i === 0} />
        ))}
      </div>
      <Legend />
    </aside>
  );
}

function TurnCard({ turn, open }: { turn: Turn; open: boolean }) {
  const summary = layerSummary(turn.events);
  const recoveries = turn.events.filter((e) => e.type === "recovery");
  const blocked = summary.some((s) => s.verdict === "block");
  return (
    <details open={open} className={`group rounded-lg ring-1 ${blocked ? "bg-rose-500/[0.04] ring-rose-500/20" : "bg-white/[0.02] ring-white/10"}`}>
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2">
        <span className="min-w-0 flex-1 truncate text-sm text-slate-200" title={turn.user}>
          {turn.user}
        </span>
        <span className="flex shrink-0 gap-1">
          {summary.map((s) => (
            <span key={s.layer} className={`rounded px-1.5 py-0.5 font-mono text-[10px] ring-1 ${VERDICT_STYLES[s.verdict]}`} title={`${s.layer}: ${s.verdict}`}>
              {SHORT_LAYER[s.layer]}
            </span>
          ))}
          {recoveries.length > 0 && (
            <span className="rounded bg-sky-500/10 px-1.5 py-0.5 font-mono text-[10px] text-sky-300 ring-1 ring-sky-500/25" title="recoveries">
              ↻{recoveries.length}
            </span>
          )}
        </span>
      </summary>
      <ul className="space-y-1 border-t border-white/5 px-3 py-2">
        {turn.events.map((e, i) => (
          <EventRow key={i} e={e} />
        ))}
      </ul>
      <Timings turn={turn} />
    </details>
  );
}

function EventRow({ e }: { e: TurnEvent }) {
  switch (e.type) {
    case "guard":
      return (
        <li className="flex items-baseline gap-2 text-xs">
          <span className={`w-7 shrink-0 rounded px-1 text-center font-mono text-[10px] ring-1 ${VERDICT_STYLES[e.verdict]}`}>{SHORT_LAYER[e.layer]}</span>
          <span className="min-w-0 flex-1 text-slate-400">
            <span className="text-slate-300">{e.verdict}</span> · {e.reason}
          </span>
          <span className="shrink-0 font-mono text-[10px] text-slate-600">{Math.round(e.ms)}ms</span>
        </li>
      );
    case "tool_result":
      return (
        <li className="text-xs">
          <details>
            <summary className={`cursor-pointer font-mono text-[11px] ${e.ok ? "text-sky-300" : "text-rose-300"}`}>
              {e.name} {e.ok ? "✓" : "✗"} · {e.ms}ms
            </summary>
            <pre className="mt-1 max-h-48 overflow-auto rounded bg-black/40 p-2 text-[10px] leading-snug text-slate-400">{JSON.stringify(e.data, null, 2)}</pre>
          </details>
        </li>
      );
    case "recovery":
      return (
        <li className="flex items-baseline gap-2 text-xs">
          <span className="w-7 shrink-0 rounded bg-sky-500/10 px-1 text-center font-mono text-[10px] text-sky-300 ring-1 ring-sky-500/25">↻</span>
          <span className="min-w-0 flex-1 text-slate-400">
            <span className="text-slate-300">
              {e.stage} {e.action}
            </span>{" "}
            · {e.detail}
          </span>
        </li>
      );
    case "error":
      return <li className="text-xs text-rose-300">error ({e.stage}): {e.message}</li>;
    default:
      return null;
  }
}

function Timings({ turn }: { turn: Turn }) {
  const done = turn.events.find((e) => e.type === "done");
  const t = done?.type === "done" ? done.timings : {};
  const key = [
    ["first audio", turn.ttfaMs],
    ["first sentence", t.firstSentence],
    ["guard wait", t.guardWait],
    ["stt", turn.sttMs],
  ].filter(([, v]) => v !== undefined) as [string, number][];
  if (key.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-0.5 border-t border-white/5 px-3 py-1.5 font-mono text-[10px] text-slate-500">
      {key.map(([k, v]) => (
        <span key={k}>
          {k} <span className="text-slate-300">{v}ms</span>
        </span>
      ))}
      {done?.type === "done" && done.provider && <span>{done.provider.replace("groq/", "")}</span>}
    </div>
  );
}

function Legend() {
  return (
    <p className="border-t border-white/10 px-4 py-2 text-[10px] leading-relaxed text-slate-500">
      L1 jailbreak · L2 topic · L3 grounding · L4 output · L5 memory ·{" "}
      <span className="text-emerald-300">pass</span> <span className="text-amber-300">repair</span>{" "}
      <span className="text-rose-300">block</span> <span className="text-sky-300">↻ recovery</span>
    </p>
  );
}
