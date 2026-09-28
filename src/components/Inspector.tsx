import type { TurnEvent } from "@/lib/events";
import type { Turn } from "./VoiceAssistant";

const VERDICT_STYLES: Record<string, string> = {
  pass: "bg-emerald-500/15 text-emerald-300 ring-emerald-500/30",
  repair: "bg-amber-500/15 text-amber-300 ring-amber-500/30",
  degraded: "bg-amber-500/15 text-amber-300 ring-amber-500/30",
  block: "bg-rose-500/15 text-rose-300 ring-rose-500/30",
};

/** Guardrail Inspector: what each layer decided on each turn, and how long it took. */
export function Inspector({ turns }: { turns: Turn[] }) {
  return (
    <aside className="flex h-full flex-col gap-3 overflow-y-auto p-4">
      <h2 className="text-xs font-semibold uppercase tracking-widest text-slate-400">Guardrail Inspector</h2>
      {turns.length === 0 && <p className="text-sm text-slate-500">Each turn&apos;s guardrail decisions appear here.</p>}
      {[...turns].reverse().map((t) => (
        <section key={t.id} className="rounded-xl bg-white/[0.03] p-3 ring-1 ring-white/10">
          <p className="mb-2 truncate text-sm text-slate-200" title={t.user}>
            “{t.user}”
          </p>
          <ul className="flex flex-col gap-1.5">
            {t.events.map((e, i) => (
              <EventRow key={i} e={e} />
            ))}
          </ul>
          <Timings turn={t} />
        </section>
      ))}
    </aside>
  );
}

function EventRow({ e }: { e: TurnEvent }) {
  switch (e.type) {
    case "guard":
      return (
        <li className="flex items-center gap-2 text-xs">
          <span className={`rounded-md px-1.5 py-0.5 font-mono ring-1 ${VERDICT_STYLES[e.verdict]}`}>{e.layer}</span>
          <span className="flex-1 truncate text-slate-400" title={e.reason}>
            {e.verdict} · {e.reason}
          </span>
          <span className="font-mono text-slate-500">{e.ms}ms</span>
        </li>
      );
    case "tool_call":
      return (
        <li className="text-xs text-sky-300">
          <span className="font-mono">→ {e.name}</span> <span className="font-mono text-slate-400">{e.args}</span>
        </li>
      );
    case "tool_result":
      return (
        <li className="text-xs">
          <details>
            <summary className={`cursor-pointer font-mono ${e.ok ? "text-sky-300" : "text-rose-300"}`}>
              ← {e.name} {e.ok ? "ok" : "error"} · {e.ms}ms
            </summary>
            <pre className="mt-1 max-h-48 overflow-auto rounded bg-black/40 p-2 text-[10px] leading-snug text-slate-300">
              {JSON.stringify(e.data, null, 2)}
            </pre>
          </details>
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
  const parts: string[] = [];
  if (turn.sttMs != null) parts.push(`stt ${turn.sttMs}ms`);
  if (done?.type === "done") {
    for (const [k, v] of Object.entries(done.timings)) parts.push(`${k} ${v}ms`);
    if (done.provider) parts.push(done.provider);
  }
  if (turn.ttfaMs != null) parts.push(`time-to-first-audio ${turn.ttfaMs}ms`);
  if (parts.length === 0) return null;
  return <p className="mt-2 font-mono text-[10px] leading-relaxed text-slate-500">{parts.join(" · ")}</p>;
}
