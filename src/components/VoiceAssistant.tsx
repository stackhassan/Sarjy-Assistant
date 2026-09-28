"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Recorder } from "@/lib/client/recorder";
import { Speaker } from "@/lib/client/speaker";
import { readEvents } from "@/lib/client/sse";
import type { HistoryMessage, TurnEvent } from "@/lib/events";
import { Inspector } from "./Inspector";
import { Orb, type AssistantStatus } from "./Orb";

export type Turn = {
  id: string;
  user: string;
  assistant: string;
  events: TurnEvent[];
  sttMs?: number;
  /** User stopped speaking (or hit send) → first audio from Sarjy. */
  ttfaMs?: number;
};

export function VoiceAssistant() {
  const [status, setStatus] = useState<AssistantStatus>("idle");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState("");
  const [notice, setNotice] = useState<string | null>(null);

  const recorder = useRef<Recorder | null>(null);
  const speaker = useRef<Speaker | null>(null);
  const inflight = useRef<AbortController | null>(null);
  const turnsRef = useRef<Turn[]>([]);

  useEffect(() => {
    turnsRef.current = turns;
  }, [turns]);

  useEffect(() => {
    recorder.current = new Recorder();
    speaker.current = new Speaker({
      onStart: () => setStatus("speaking"),
      onIdle: () => setStatus((s) => (s === "speaking" ? "idle" : s)),
    });
    return () => speaker.current?.cancel();
  }, []);

  const patchTurn = (id: string, fn: (t: Turn) => Turn) =>
    setTurns((ts) => ts.map((t) => (t.id === id ? fn(t) : t)));

  /** Stop whatever Sarjy is doing: in-flight request and speech. */
  const interrupt = () => {
    inflight.current?.abort();
    speaker.current?.cancel();
  };

  const runTurn = useCallback(async (text: string, startedAt: number, sttMs?: number) => {
    const id = crypto.randomUUID();
    const history: HistoryMessage[] = turnsRef.current.flatMap((t) => [
      { role: "user", content: t.user },
      ...(t.assistant ? [{ role: "assistant" as const, content: t.assistant }] : []),
    ]);
    setTurns((ts) => [...ts, { id, user: text, assistant: "", events: [], sttMs }]);
    setStatus("thinking");

    speaker.current?.onNextAudioStart(() =>
      patchTurn(id, (t) => ({ ...t, ttfaMs: Math.round(performance.now() - startedAt) })),
    );

    const ac = new AbortController();
    inflight.current = ac;
    try {
      const res = await fetch("/api/turn", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, history, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }),
        signal: ac.signal,
      });
      if (!res.ok) throw new Error(`Server error ${res.status}`);

      for await (const e of readEvents(res)) {
        patchTurn(id, (t) => ({
          ...t,
          events: [...t.events, e],
          assistant:
            e.type === "sentence"
              ? `${t.assistant} ${e.text}`.trim()
              : e.type === "error"
                ? `${t.assistant} ${e.spokenFallback}`.trim()
                : t.assistant,
        }));
        if (e.type === "sentence") speaker.current?.enqueue(e.text);
        if (e.type === "error") speaker.current?.enqueue(e.spokenFallback);
      }
    } catch (err) {
      if (ac.signal.aborted) return;
      setNotice((err as Error).message);
      speaker.current?.enqueue("Sorry, I couldn't reach my brain just now.");
    } finally {
      if (inflight.current === ac) inflight.current = null;
      setStatus((s) => (s === "thinking" && !speaker.current?.speaking ? "idle" : s));
    }
  }, []);

  const onOrb = async () => {
    setNotice(null);
    const rec = recorder.current!;
    if (rec.recording) {
      const stoppedAt = performance.now();
      setStatus("transcribing");
      try {
        const clip = await rec.stop();
        const form = new FormData();
        form.append("audio", clip);
        const res = await fetch("/api/stt", { method: "POST", body: form });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? "Transcription failed");
        if (!data.text) {
          setNotice("I didn't catch that — try again?");
          setStatus("idle");
          return;
        }
        await runTurn(data.text, stoppedAt, data.ms);
      } catch (err) {
        setNotice((err as Error).message);
        setStatus("idle");
      }
      return;
    }

    interrupt(); // barge-in
    try {
      await rec.start();
      setStatus("listening");
    } catch {
      setNotice("Microphone access is needed to talk to Sarjy. You can also type below.");
      setStatus("idle");
    }
  };

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const text = draft.trim();
    if (!text) return;
    interrupt();
    setDraft("");
    runTurn(text, performance.now());
  };

  const busy = status === "transcribing";

  return (
    <div className="grid min-h-dvh grid-cols-1 lg:grid-cols-[1fr_380px]">
      <main className="flex min-h-dvh flex-col items-center px-4 py-10">
        <header className="mb-8 text-center">
          <h1 className="text-2xl font-semibold tracking-tight text-slate-100">Sarjy</h1>
          <p className="text-sm text-slate-400">A voice assistant with guardrails you can watch.</p>
        </header>

        <Orb status={status} onClick={onOrb} disabled={busy} />

        {notice && <p className="mt-4 text-sm text-amber-300">{notice}</p>}

        <ol className="mt-10 flex w-full max-w-xl flex-1 flex-col gap-4">
          {turns.map((t) => (
            <li key={t.id} className="flex flex-col gap-2">
              <p className="self-end rounded-2xl rounded-br-sm bg-sky-500/15 px-4 py-2 text-slate-100">{t.user}</p>
              {t.assistant && (
                <p className="self-start rounded-2xl rounded-bl-sm bg-white/5 px-4 py-2 text-slate-200">
                  {t.assistant}
                </p>
              )}
            </li>
          ))}
        </ol>

        <form onSubmit={onSubmit} className="sticky bottom-4 mt-6 flex w-full max-w-xl gap-2">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Or type a message…"
            aria-label="Message Sarjy"
            className="flex-1 rounded-full bg-white/5 px-4 py-2.5 text-slate-100 ring-1 ring-white/10 outline-none placeholder:text-slate-500 focus:ring-sky-400/50"
          />
          <button
            type="submit"
            className="rounded-full bg-sky-500 px-5 py-2.5 font-medium text-slate-950 hover:bg-sky-400 disabled:opacity-40"
            disabled={!draft.trim()}
          >
            Send
          </button>
        </form>
      </main>

      <div className="border-t border-white/10 bg-black/20 lg:h-dvh lg:border-t-0 lg:border-l">
        <Inspector turns={turns} />
      </div>
    </div>
  );
}
