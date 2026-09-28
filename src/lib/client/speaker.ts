import { takeBatch, type Signed } from "@/lib/text/batch";

/** What actually gets played for one batch: Orpheus audio, or the browser voice. */
type Clip = { kind: "audio"; url: string } | { kind: "browser"; text: string };

export type VoiceSource = "orpheus" | "browser";

type Events = {
  onStart?: () => void;
  onIdle?: () => void;
  /** Fired when the voice actually used changes (e.g. falling back after a rate limit). */
  onVoice?: (source: VoiceSource, reason?: string) => void;
};

/**
 * Ordered TTS queue.
 *
 * The first sentence is fetched on its own for the lowest time-to-first-audio;
 * sentences that arrive while a fetch is in flight are batched into the next
 * request (Orpheus allows 200 chars), which keeps us inside the free-tier quota.
 * Any failure falls back to the browser voice for that clip; a 429 keeps us on
 * the browser voice until the rate-limit window resets.
 */
export class Speaker {
  private pending: Signed[] = [];
  private clips: Promise<Clip>[] = [];
  private fetching = false;
  private playing = false;
  private audio?: HTMLAudioElement;
  private abort = new AbortController();
  private generation = 0;
  private onFirstAudio?: () => void;
  private orpheusBlockedUntil = 0;

  constructor(private readonly events: Events = {}) {}

  /** Calls `cb` once, when the next clip actually starts playing. */
  onNextAudioStart(cb: () => void) {
    this.onFirstAudio = cb;
  }

  enqueue(sentence: Signed) {
    this.pending.push(sentence);
    this.pump();
  }

  /** Barge-in: stop immediately and drop everything queued or in flight. */
  cancel() {
    this.generation++;
    this.abort.abort();
    this.abort = new AbortController();
    this.pending = [];
    this.clips = [];
    this.fetching = false;
    this.playing = false;
    this.onFirstAudio = undefined;
    if (this.audio) {
      this.audio.pause();
      this.audio.src = "";
    }
    speechSynthesis.cancel();
  }

  get speaking(): boolean {
    return this.playing || this.fetching || this.pending.length > 0 || this.clips.length > 0;
  }

  private pump() {
    if (this.fetching || this.pending.length === 0) return;
    const batch = takeBatch(this.pending);
    this.fetching = true;
    const gen = this.generation;
    const clip = this.fetchClip(batch).finally(() => {
      if (gen !== this.generation) return;
      this.fetching = false;
      this.pump();
    });
    this.clips.push(clip);
    this.playNext();
  }

  private async fetchClip(batch: Signed[]): Promise<Clip> {
    const text = batch.map((s) => s.text).join(" ");
    const unsigned = batch.some((s) => !s.sig);
    if (unsigned || Date.now() < this.orpheusBlockedUntil) return { kind: "browser", text };

    try {
      const res = await fetch("/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sentences: batch }),
        signal: this.abort.signal,
      });
      if (res.status === 429) {
        const wait = Number(res.headers.get("Retry-After")) || 60;
        this.orpheusBlockedUntil = Date.now() + wait * 1000;
        this.events.onVoice?.("browser", `Orpheus rate limited for ${formatWait(wait)}`);
        return { kind: "browser", text };
      }
      if (!res.ok) throw new Error(`TTS ${res.status}`);
      const url = URL.createObjectURL(await res.blob());
      this.events.onVoice?.("orpheus");
      return { kind: "audio", url };
    } catch (err) {
      // After a barge-in the clip is discarded by the generation check in playNext.
      if (!this.abort.signal.aborted) this.events.onVoice?.("browser", (err as Error).message);
      return { kind: "browser", text };
    }
  }

  private async playNext() {
    if (this.playing || this.clips.length === 0) return;
    this.playing = true;
    const gen = this.generation;
    const clip = await this.clips[0];
    if (gen !== this.generation) return; // cancelled while fetching
    this.clips.shift();

    await this.play(clip);
    if (gen !== this.generation) return;
    this.playing = false;
    if (this.speaking) this.playNext();
    else this.events.onIdle?.();
  }

  private play(clip: Clip): Promise<void> {
    return new Promise((resolve) => {
      const started = () => {
        this.onFirstAudio?.();
        this.onFirstAudio = undefined;
        this.events.onStart?.();
      };

      if (clip.kind === "audio") {
        this.audio ??= new Audio();
        const a = this.audio;
        const done = () => {
          URL.revokeObjectURL(clip.url);
          resolve();
        };
        a.onplaying = started;
        a.onended = done;
        a.onerror = done;
        a.src = clip.url;
        a.play().catch(done);
        return;
      }

      const u = new SpeechSynthesisUtterance(clip.text);
      u.voice = pickBrowserVoice();
      u.rate = 1.05;
      u.onstart = started;
      u.onend = u.onerror = () => resolve();
      speechSynthesis.speak(u);
    });
  }
}

function formatWait(seconds: number): string {
  return seconds >= 3600 ? `${Math.round(seconds / 3600)}h` : seconds >= 60 ? `${Math.round(seconds / 60)}m` : `${seconds}s`;
}

let cachedVoice: SpeechSynthesisVoice | null | undefined;

function pickBrowserVoice(): SpeechSynthesisVoice | null {
  if (cachedVoice !== undefined) return cachedVoice;
  const voices = speechSynthesis.getVoices();
  if (voices.length === 0) return null; // not loaded yet; try again next time
  const preferred = ["Samantha", "Google US English", "Microsoft Aria", "Karen", "Daniel"];
  cachedVoice =
    preferred.map((n) => voices.find((v) => v.name.includes(n))).find(Boolean) ??
    voices.find((v) => v.lang.startsWith("en")) ??
    null;
  return cachedVoice;
}
