import { APP_LINES } from "@/lib/lines";
import { takeBatch, type Signed } from "@/lib/text/batch";
import { toSpeech } from "@/lib/text/speech";
import { chaosHeaders } from "./chaos";

/** What actually gets played for one batch: Orpheus audio, the browser voice, or nothing. */
type Clip = { kind: "audio"; url: string } | { kind: "browser"; text: string } | { kind: "silent" };

export type VoiceSource = "orpheus" | "browser" | "none";

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
 *
 * When Orpheus fails, the fallback is handled the way a person would notice it:
 * - the switch is announced once ("my voice might sound a bit different"), not silently;
 * - the rest of that answer stays on the fallback voice, so it never flips mid-answer;
 * - the next answer tries Orpheus again (unless it's rate-limited: then we wait it out);
 * - the closest-sounding browser voice is used (Sarjy's voice, Diana, is female, en-US);
 * - if no voice works at all, the text still shows and the UI says voice is unavailable.
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
  /** This answer already fell back: keep it on the browser voice. */
  private turnFellBack = false;
  /** The voice-change notice was said for the current outage. */
  private noticeGiven = false;

  constructor(private readonly events: Events = {}) {}

  /** Call at the start of each answer: lets it try Orpheus again. */
  beginTurn() {
    this.turnFellBack = false;
  }

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
    if (hasBrowserVoice()) speechSynthesis.cancel();
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

  /** Falls back to the browser voice for this clip, announcing the switch once per outage. */
  private fallback(text: string, reason: string): Clip {
    if (!hasBrowserVoice()) {
      this.events.onVoice?.("none", reason);
      return { kind: "silent" };
    }
    this.turnFellBack = true;
    this.events.onVoice?.("browser", reason);
    if (!this.noticeGiven) {
      this.noticeGiven = true;
      return { kind: "browser", text: `${APP_LINES.voiceChange} ${text}` };
    }
    return { kind: "browser", text };
  }

  private async fetchClip(batch: Signed[]): Promise<Clip> {
    const text = batch.map((s) => s.text).join(" ");
    const voiceable = batch.every((s) => s.sig || s.line);
    if (!voiceable) return this.fallback(text, "unsigned local text");
    if (Date.now() < this.orpheusBlockedUntil) return this.fallback(text, "Orpheus rate limited");
    if (this.turnFellBack) return this.fallback(text, "staying on one voice for this answer");

    try {
      const line = batch.length === 1 ? batch[0].line : undefined;
      const res = await fetch("/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...chaosHeaders() },
        body: JSON.stringify(line ? { line } : { sentences: batch.map(({ text, sig }) => ({ text, sig })) }),
        signal: this.abort.signal,
      });
      if (res.status === 429) {
        const wait = Number(res.headers.get("Retry-After")) || 60;
        this.orpheusBlockedUntil = Date.now() + wait * 1000;
        return this.fallback(text, `Orpheus rate limited for ${formatWait(wait)}`);
      }
      if (!res.ok) throw new Error(`TTS ${res.status}`);
      const url = URL.createObjectURL(await res.blob());
      this.noticeGiven = false; // recovered: a future outage gets its own notice
      this.events.onVoice?.("orpheus");
      return { kind: "audio", url };
    } catch (err) {
      // After a barge-in the clip is discarded by the generation check in playNext.
      if (this.abort.signal.aborted) return { kind: "silent" };
      return this.fallback(text, (err as Error).message);
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

      if (clip.kind === "silent") return resolve();

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

      const u = new SpeechSynthesisUtterance(toSpeech(clip.text));
      u.voice = pickBrowserVoice();
      u.rate = 1.05;
      u.onstart = started;
      u.onend = u.onerror = () => resolve();
      speechSynthesis.speak(u);
    });
  }
}

function hasBrowserVoice(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window;
}

function formatWait(seconds: number): string {
  return seconds >= 3600 ? `${Math.round(seconds / 3600)}h` : seconds >= 60 ? `${Math.round(seconds / 60)}m` : `${seconds}s`;
}

let cachedVoice: SpeechSynthesisVoice | null | undefined;

/** Closest match to Sarjy's own voice (Diana: female, US English), best-sounding first. */
function pickBrowserVoice(): SpeechSynthesisVoice | null {
  if (cachedVoice !== undefined) return cachedVoice;
  const voices = speechSynthesis.getVoices();
  if (voices.length === 0) return null; // not loaded yet; try again next time
  const preferred = ["Samantha", "Google US English", "Microsoft Aria", "Microsoft Jenny", "Ava", "Allison", "Karen", "Moira", "Tessa"];
  cachedVoice =
    preferred.map((n) => voices.find((v) => v.name.includes(n))).find(Boolean) ??
    voices.find((v) => v.lang === "en-US") ??
    voices.find((v) => v.lang.startsWith("en")) ??
    null;
  return cachedVoice;
}
