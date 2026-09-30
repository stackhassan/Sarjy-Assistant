/**
 * A soft "thinking" chime, played when an answer is slow to start (failover, a slow
 * weather API). Silence on a voice call reads as "it broke"; Alexa's progressive
 * responses solve the same problem. It's synthesised, so it needs no network, no TTS
 * quota, and works even when both voices are down.
 */
export class ThinkingEarcon {
  private ctx?: AudioContext;
  private timer?: ReturnType<typeof setTimeout>;
  private interval?: ReturnType<typeof setInterval>;

  /** Call from a user gesture (tap, send) so the browser allows audio later. */
  prime() {
    if (typeof window === "undefined") return;
    this.ctx ??= new AudioContext();
    if (this.ctx.state === "suspended") this.ctx.resume().catch(() => {});
  }

  /** Start chiming if nothing has been heard after `delayMs`; repeats gently until stopped. */
  armAfter(delayMs: number) {
    this.stop();
    this.timer = setTimeout(() => {
      this.chime();
      this.interval = setInterval(() => this.chime(), 2600);
    }, delayMs);
  }

  stop() {
    clearTimeout(this.timer);
    clearInterval(this.interval);
    this.timer = this.interval = undefined;
  }

  private chime() {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== "running") return;
    const now = ctx.currentTime;
    // Two soft, rising sine notes (E5 → A5), quick fade: noticeable but unobtrusive.
    for (const [i, freq] of [659.25, 880].entries()) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      const t = now + i * 0.14;
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(0.06, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.32);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t);
      osc.stop(t + 0.34);
    }
  }
}
