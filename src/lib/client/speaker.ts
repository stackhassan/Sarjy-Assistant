/**
 * Ordered TTS queue. Uses the browser's speechSynthesis for now; the in-browser
 * Kokoro voice will implement the same interface (PRD §6.4).
 */
export class Speaker {
  private pending = 0;
  private onFirstAudio?: () => void;

  constructor(private readonly events: { onStart?: () => void; onIdle?: () => void } = {}) {}

  /** Calls `cb` once, when the next utterance actually starts playing. */
  onNextAudioStart(cb: () => void) {
    this.onFirstAudio = cb;
  }

  enqueue(text: string) {
    const u = new SpeechSynthesisUtterance(text);
    u.voice = pickVoice();
    u.rate = 1.05;
    u.onstart = () => {
      this.onFirstAudio?.();
      this.onFirstAudio = undefined;
      this.events.onStart?.();
    };
    u.onend = u.onerror = () => {
      this.pending = Math.max(0, this.pending - 1);
      if (this.pending === 0) this.events.onIdle?.();
    };
    this.pending++;
    speechSynthesis.speak(u);
  }

  /** Barge-in: stop speaking immediately and drop anything queued. */
  cancel() {
    this.pending = 0;
    this.onFirstAudio = undefined;
    speechSynthesis.cancel();
  }

  get speaking(): boolean {
    return this.pending > 0;
  }
}

let cachedVoice: SpeechSynthesisVoice | null | undefined;

function pickVoice(): SpeechSynthesisVoice | null {
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
