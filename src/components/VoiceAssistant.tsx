"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Recorder } from "@/lib/client/recorder";
import { authHeaders } from "@/lib/client/auth";
import { chaosFlags, chaosHeaders } from "@/lib/client/chaos";
import { ThinkingEarcon } from "@/lib/client/earcon";
import { Speaker, type VoiceSource } from "@/lib/client/speaker";
import { APP_LINES, type AppLineId } from "@/lib/lines";
import { demoMode } from "@/lib/guardrails/policy";
import { TTS_VOICE } from "@/lib/llm/models";
import { readEvents } from "@/lib/client/sse";
import type { HistoryMessage, TurnEvent } from "@/lib/events";
import { Inspector } from "./Inspector";
import { MemoryDrawer } from "./MemoryDrawer";
import { Orb, type AssistantStatus } from "./Orb";

export type Turn = {
  id: string;
  user: string;
  assistant: string;
  events: TurnEvent[];
  /** Server chain signature over `assistant`, from the turn's `done` event. */
  assistantSig?: string;
  assistantPrev?: string;
  sttMs?: number;
  /** User stopped speaking (or hit send) → first audio from Sarjy. */
  ttfaMs?: number;
};

const noopSubscribe = () => () => {};
/** Build-time: the Inspector (guard internals) only exists in demo mode. */
const DEMO = demoMode();

export function VoiceAssistant() {
  const [status, setStatus] = useState<AssistantStatus>("idle");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [voice, setVoice] = useState<{ source: VoiceSource; reason?: string }>({ source: "orpheus" });

  const recorder = useRef<Recorder | null>(null);
  const speaker = useRef<Speaker | null>(null);
  const inflight = useRef<AbortController | null>(null);
  const turnsRef = useRef<Turn[]>([]);
  const currentTurn = useRef<string | null>(null);
  const earcon = useRef(new ThinkingEarcon());
  /** Consecutive "didn't catch that" turns, for escalating reprompts. */
  const misses = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);
  /** Bumped after each turn so the memory drawer refreshes. */
  const [memoryRev, setMemoryRev] = useState(0);
  // Read from the URL on the client only; the server render has no flags.
  const chaosKey = useSyncExternalStore(noopSubscribe, () => chaosFlags().join(","), () => "");
  const chaos = chaosKey ? chaosKey.split(",") : [];

  useEffect(() => {
    turnsRef.current = turns;
  }, [turns]);

  useEffect(() => {
    recorder.current = new Recorder();
    speaker.current = new Speaker({
      onStart: () => {
        earcon.current.stop();
        setStatus("speaking");
      },
      onIdle: () => setStatus((s) => (s === "speaking" ? "idle" : s)),
      onVoice: (source, reason) => {
        setVoice({ source, reason });
        if (source === "none") setNotice("Voice isn't available right now, so I'll show my replies here. Try again later for voice.");
        const id = currentTurn.current;
        if (source === "browser" && reason && id) {
          const e: TurnEvent = { type: "recovery", stage: "tts", action: "browser voice", detail: reason };
          setTurns((ts) => ts.map((t) => (t.id === id ? { ...t, events: [...t.events, e] } : t)));
        }
      },
    });
    const thinking = earcon.current;
    return () => {
      speaker.current?.cancel();
      thinking.stop();
    };
  }, []);

  /** Say a fixed app line in Sarjy's normal voice. */
  const say = (line: AppLineId) => {
    speaker.current?.beginTurn();
    speaker.current?.enqueue({ text: APP_LINES[line], line });
  };

  /**
   * Didn't catch that: 1st time, ask again briefly; 2nd time in a row, add help and offer
   * typing (Google's conversation-design pattern for no-match / no-input).
   */
  const missed = () => {
    misses.current += 1;
    const line = misses.current === 1 ? "reprompt1" : "reprompt2";
    setNotice(APP_LINES[line]);
    say(line);
    if (misses.current >= 2) inputRef.current?.focus();
    setStatus("idle");
  };

  const patchTurn = (id: string, fn: (t: Turn) => Turn) =>
    setTurns((ts) => ts.map((t) => (t.id === id ? fn(t) : t)));

  /** Stop whatever Sarjy is doing: in-flight request and speech. */
  const interrupt = () => {
    inflight.current?.abort();
    speaker.current?.cancel();
    earcon.current.stop();
  };

  const runTurn = useCallback(async (text: string, startedAt: number, sttMs?: number, clientEvents: TurnEvent[] = []) => {
    const id = crypto.randomUUID();
    currentTurn.current = id;
    // Only completed, server-signed turns, most recent 6: the server verifies the chain.
    const history: HistoryMessage[] = turnsRef.current
      .filter((t) => t.assistantSig)
      .slice(-6)
      .flatMap((t) => [
        { role: "user" as const, content: t.user },
        { role: "assistant" as const, content: t.assistant, sig: t.assistantSig, prev: t.assistantPrev },
      ]);
    setTurns((ts) => [...ts, { id, user: text, assistant: "", events: clientEvents, sttMs }]);
    setStatus("thinking");
    speaker.current?.beginTurn();
    // Silence reads as "it broke": if nothing is heard within ~2 s, play a soft thinking chime.
    earcon.current.armAfter(2000);

    speaker.current?.onNextAudioStart(() =>
      patchTurn(id, (t) => ({ ...t, ttfaMs: Math.round(performance.now() - startedAt) })),
    );

    const ac = new AbortController();
    inflight.current = ac;
    try {
      const res = await fetch("/api/turn", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...chaosHeaders(), ...(await authHeaders()) },
        body: JSON.stringify({ text, history, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }),
        signal: ac.signal,
      });
      if (!res.ok) throw new Error(`Server error ${res.status}`);

      for await (const e of readEvents(res)) {
        patchTurn(id, (t) => ({
          ...t,
          events: [...t.events, e],
          assistant:
            e.type === "done"
              ? e.assistant.text // authoritative, and what the signature covers
              : e.type === "sentence"
                ? `${t.assistant} ${e.text}`.trim()
                : e.type === "error"
                  ? `${t.assistant} ${e.spokenFallback}`.trim()
                  : t.assistant,
          assistantSig: e.type === "done" ? e.assistant.sig : t.assistantSig,
          assistantPrev: e.type === "done" ? e.assistant.prev : t.assistantPrev,
        }));
        if (e.type === "sentence") speaker.current?.enqueue(e);
        if (e.type === "error") speaker.current?.enqueue({ text: e.spokenFallback, sig: e.sig });
      }
    } catch (err) {
      if (ac.signal.aborted) return;
      setNotice((err as Error).message);
      say("unreachable");
    } finally {
      if (inflight.current === ac) inflight.current = null;
      setMemoryRev((r) => r + 1);
      if (!speaker.current?.speaking) earcon.current.stop();
      setStatus((s) => (s === "thinking" && !speaker.current?.speaking ? "idle" : s));
    }
  }, []);

  const onOrb = async () => {
    setNotice(null);
    earcon.current.prime(); // user gesture: lets the browser play the chime later
    const rec = recorder.current!;
    if (rec.recording) {
      const stoppedAt = performance.now();
      setStatus("transcribing");
      try {
        const clip = await rec.stop();
        if (clip.size < 2000) return missed();
        const form = new FormData();
        form.append("audio", clip);
        const res = await fetch("/api/stt", { method: "POST", body: form, headers: chaosHeaders() });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? "Transcription failed");
        if (!data.text) return missed();
        misses.current = 0;
        const sttEvents: TurnEvent[] = (data.failovers ?? []).map((detail: string) => ({
          type: "recovery",
          stage: "stt",
          action: "failover",
          detail: `${detail} → ${data.model}`,
        }));
        await runTurn(data.text, stoppedAt, data.ms, sttEvents);
      } catch {
        // Both STT models failed: treat it like a miss (ask again, then offer typing).
        missed();
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
    earcon.current.prime();
    misses.current = 0;
    setDraft("");
    runTurn(text, performance.now());
  };

  const busy = status === "transcribing";

  return (
    <div className={`grid min-h-dvh grid-cols-1 ${DEMO ? "lg:grid-cols-[1fr_380px]" : ""}`}>
      <main className="flex min-h-dvh flex-col items-center px-4 py-10">
        <MemoryDrawer refreshKey={memoryRev} />
        <header className="mb-8 text-center">
          <h1 className="text-2xl font-semibold tracking-tight text-slate-100">Sarjy</h1>
          <p className="text-sm text-slate-400">{DEMO ? "A voice assistant with guardrails you can watch." : "Your friendly voice assistant."}</p>
          {chaos.length > 0 && (
            <p className="mt-2 rounded-full bg-amber-500/10 px-3 py-1 text-xs text-amber-300 ring-1 ring-amber-500/30">
              Fault injection on: {chaos.join(", ")}
            </p>
          )}
          <p className="mt-1 text-xs text-slate-500" title={voice.reason}>
            Voice:{" "}
            {voice.source === "orpheus"
              ? `Orpheus · ${TTS_VOICE[0].toUpperCase()}${TTS_VOICE.slice(1)}`
              : voice.source === "none"
                ? "unavailable (text only)"
                : `browser fallback${DEMO && voice.reason ? ` (${voice.reason})` : ""}`}
          </p>
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
            ref={inputRef}
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

      {DEMO && (
        <div className="border-t border-white/10 bg-black/20 lg:h-dvh lg:border-t-0 lg:border-l">
          <Inspector turns={turns} />
        </div>
      )}
    </div>
  );
}
