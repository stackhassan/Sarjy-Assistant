import { APP_LINES } from "@/lib/lines";
import { takeBatch, type Signed } from "@/lib/text/batch";
import { toSpeech } from "@/lib/text/speech";
import { audioContext } from "./audio";
import { chaosHeaders } from "./chaos";
import { SilenceTrimmer, WavStreamDecoder } from "./pcm";

/**
 * What actually gets played for one batch: Orpheus audio streamed through Web Audio,
 * a whole Orpheus file (when Web Audio isn't available), the browser voice, or nothing.
 */
type Clip =
  | { kind: "stream"; stream: StreamedClip; text: string }
  | { kind: "audio"; url: string }
  | { kind: "browser"; text: string }
  | { kind: "silent" };

/** Seconds of lead time when scheduling the first piece of audio, so it never starts late. */
const SCHEDULE_AHEAD_S = 0.03;

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
 * Audio is played as it streams in (Orpheus runs ~6× faster than real time), with
 * Orpheus's 0.25-0.6 s of padding trimmed, and each clip is scheduled to start
 * exactly where the previous one ends. So the first sound comes after the first
 * chunk, not the whole file, and sentences join with a natural ~0.25 s pause.
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
  /** AudioContext time at which everything scheduled so far finishes. */
  private playhead = 0;
  private sources = new Set<AudioBufferSourceNode>();
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
    for (const src of this.sources) {
      src.onended = null;
      try {
        src.stop();
      } catch {}
    }
    this.sources.clear();
    this.playhead = 0;
    if (this.audio) {
      this.audio.pause();
      this.audio.src = "";
    }
    if (hasBrowserVoice()) speechSynthesis.cancel();
  }

  get speaking(): boolean {
    return this.playing || this.fetching || this.pending.length > 0 || this.clips.length > 0 || this.audioAhead() > 0;
  }

  /** Seconds of scheduled Web Audio still to play. */
  private audioAhead(): number {
    const ctx = audioContext();
    return ctx ? Math.max(0, this.playhead - ctx.currentTime - 0.01) : 0;
  }

  /** Resolves once scheduled Web Audio has finished (browser voice and files must wait for it). */
  private untilScheduledEnds(): Promise<void> {
    const ahead = this.audioAhead();
    return ahead > 0 ? new Promise((r) => setTimeout(r, ahead * 1000 + 30)) : Promise.resolve();
  }

  private pump() {
    if (this.fetching || this.pending.length === 0) return;
    const batch = takeBatch(this.pending);
    this.fetching = true;
    const gen = this.generation;
    const clip = this.fetchClip(batch);
    // A streamed clip resolves as soon as audio starts arriving; the next request waits
    // for this one to finish downloading, so more sentences batch into it (quota).
    clip
      .then((c) => (c.kind === "stream" ? c.stream.done : undefined))
      .catch(() => {})
      .finally(() => {
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
      this.noticeGiven = false; // recovered: a future outage gets its own notice
      this.events.onVoice?.("orpheus");
      if (res.body && audioContext()?.state === "running") return { kind: "stream", stream: new StreamedClip(res.body), text };
      const url = URL.createObjectURL(await res.blob());
      return { kind: "audio", url };
    } catch (err) {
      // After a barge-in the clip is discarded by the generation check in playNext.
      if (this.abort.signal.aborted) return { kind: "silent" };
      return this.fallback(text, (err as Error).message);
    }
  }

  private async playNext(): Promise<void> {
    if (this.playing || this.clips.length === 0) return;
    this.playing = true;
    const gen = this.generation;
    const clip = await this.clips[0];
    if (gen !== this.generation) return; // cancelled while fetching
    this.clips.shift();

    await this.play(clip, gen);
    if (gen !== this.generation) return;
    this.playing = false;
    if (this.clips.length) return this.playNext();
    // Streamed audio is scheduled ahead; "idle" only once it has actually been heard.
    await this.untilScheduledEnds();
    if (gen !== this.generation || this.playing) return;
    if (!this.speaking) this.events.onIdle?.();
  }

  private started = () => {
    this.onFirstAudio?.();
    this.onFirstAudio = undefined;
    this.events.onStart?.();
  };

  /** Schedules a streamed clip right after whatever is already scheduled; resolves once all of it is scheduled. */
  private playStream(clip: Extract<Clip, { kind: "stream" }>, gen: number): Promise<void> {
    const ctx = audioContext()!;
    const { stream } = clip;
    return new Promise((resolve) => {
      let scheduled = false;
      const drain = () => {
        if (gen !== this.generation) return resolve();
        for (const seg of stream.take()) {
          const buf = ctx.createBuffer(1, seg.length, stream.sampleRate);
          buf.getChannelData(0).set(seg);
          const src = ctx.createBufferSource();
          src.buffer = buf;
          src.connect(ctx.destination);
          const at = Math.max(this.playhead, ctx.currentTime + SCHEDULE_AHEAD_S);
          src.start(at);
          this.playhead = at + buf.duration;
          this.sources.add(src);
          src.onended = () => this.sources.delete(src);
          if (!scheduled) {
            scheduled = true;
            setTimeout(this.started, Math.max(0, (at - ctx.currentTime) * 1000));
          }
        }
        if (!stream.finished) return;
        stream.onData = undefined;
        // Failed before any audio (bad format, dropped connection): say it with the fallback voice.
        if (!scheduled && stream.error && gen === this.generation) {
          this.play(this.fallback(clip.text, stream.error), gen).then(resolve);
        } else resolve();
      };
      stream.onData = drain;
      drain();
    });
  }

  private async play(clip: Clip, gen: number): Promise<void> {
    if (clip.kind === "silent") return;
    if (clip.kind === "stream") return this.playStream(clip, gen);
    await this.untilScheduledEnds();
    if (gen !== this.generation) return;
    const started = this.started;
    return new Promise((resolve) => {
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

/**
 * One Orpheus response, decoded and silence-trimmed as it downloads. Audio is handed
 * out in pieces of at least ~100 ms so playback isn't a flood of tiny buffers.
 */
class StreamedClip {
  readonly done: Promise<void>;
  sampleRate = 24000;
  finished = false;
  error?: string;
  onData?: () => void;
  private ready: Float32Array[] = [];
  private pending: Float32Array[] = [];
  private pendingLen = 0;

  constructor(body: ReadableStream<Uint8Array>) {
    this.done = this.read(body);
  }

  /** Audio ready to schedule since the last call. */
  take(): Float32Array[] {
    const out = this.ready;
    this.ready = [];
    return out;
  }

  private async read(body: ReadableStream<Uint8Array>) {
    const reader = body.getReader();
    const decoder = new WavStreamDecoder();
    let trimmer: SilenceTrimmer | undefined;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        const samples = decoder.push(value);
        if (!samples.length) continue;
        this.sampleRate = decoder.sampleRate;
        trimmer ??= new SilenceTrimmer({ sampleRate: decoder.sampleRate });
        this.add(trimmer.push(samples), false);
      }
      if (trimmer) this.add(trimmer.end(), true);
    } catch (err) {
      this.error = (err as Error).message;
      this.add(new Float32Array(0), true);
    } finally {
      this.finished = true;
      this.onData?.();
    }
  }

  private add(samples: Float32Array, flush: boolean) {
    if (samples.length) {
      this.pending.push(samples);
      this.pendingLen += samples.length;
    }
    if (this.pendingLen && (flush || this.pendingLen >= this.sampleRate / 10)) {
      const joined = new Float32Array(this.pendingLen);
      let off = 0;
      for (const p of this.pending) {
        joined.set(p, off);
        off += p.length;
      }
      this.ready.push(joined);
      this.pending = [];
      this.pendingLen = 0;
      this.onData?.();
    }
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
