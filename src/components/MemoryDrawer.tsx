"use client";

import { useCallback, useEffect, useState } from "react";
import { authHeaders } from "@/lib/client/auth";

type Fact = { key: string; value: string; category: string };

/** What Sarjy remembers about you, with delete. `refreshKey` changes after each turn. */
export function MemoryDrawer({ refreshKey }: { refreshKey: number }) {
  const [open, setOpen] = useState(false);
  const [facts, setFacts] = useState<Fact[]>([]);
  const [available, setAvailable] = useState(true);

  const [rev, setRev] = useState(0);
  const reload = useCallback(() => setRev((r) => r + 1), []);

  // Loading on mount also signs in anonymously and warms the server's fact cache.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch("/api/memory", { headers: await authHeaders() });
        const data = await res.json();
        if (!alive) return;
        setFacts(data.facts ?? []);
        setAvailable(data.available !== false);
      } catch {
        if (alive) setAvailable(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [refreshKey, rev]);

  const forget = async (key?: string) => {
    if (!key && !confirm("Forget everything Sarjy remembers about you?")) return;
    await fetch(`/api/memory${key ? `?key=${encodeURIComponent(key)}` : ""}`, { method: "DELETE", headers: await authHeaders() });
    reload();
  };

  return (
    <div className="fixed top-4 right-4 z-10 lg:right-[396px]">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="rounded-full bg-white/5 px-3 py-1.5 text-xs text-slate-300 ring-1 ring-white/10 hover:bg-white/10"
        aria-expanded={open}
      >
        Memory{available ? ` · ${facts.length}` : " · off"}
      </button>
      {open && (
        <div className="mt-2 w-72 rounded-xl bg-slate-900/95 p-3 text-sm shadow-xl ring-1 ring-white/10">
          {!available && <p className="text-slate-400">Memory is unavailable right now.</p>}
          {available && facts.length === 0 && (
            <p className="text-slate-400">Nothing yet. Tell Sarjy something like “my favourite colour is teal”.</p>
          )}
          <ul className="flex flex-col gap-1.5">
            {facts.map((f) => (
              <li key={f.key} className="flex items-start gap-2">
                <span className="flex-1 text-slate-200">
                  <span className="text-slate-500">{f.key.replace(/_/g, " ")}:</span> {f.value}
                </span>
                <button type="button" onClick={() => forget(f.key)} className="text-slate-500 hover:text-rose-300" aria-label={`Forget ${f.key}`}>
                  ×
                </button>
              </li>
            ))}
          </ul>
          {facts.length > 0 && (
            <button type="button" onClick={() => forget()} className="mt-3 text-xs text-rose-300/80 hover:text-rose-300">
              Forget everything
            </button>
          )}
        </div>
      )}
    </div>
  );
}
