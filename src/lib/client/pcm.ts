/**
 * Streaming WAV → PCM for gapless playback.
 *
 * Orpheus streams 16-bit mono WAV about 6× faster than real time, but each clip
 * carries 0.25-0.6 s of silence at both ends (measured). Played back to back as
 * whole files, that silence plus fetch and decode time was a 0.6-1.1 s dead gap
 * between sentences. These two pieces let the speaker start on the first chunk
 * and join clips with a natural pause instead.
 */

/** Parses a streamed WAV (PCM16) into Float32 samples as bytes arrive. */
export class WavStreamDecoder {
  private header = new Uint8Array(0);
  private inData = false;
  private carry: number | null = null;
  sampleRate = 0;
  channels = 1;

  /** Feed bytes; returns decoded mono samples (possibly empty). Throws on a format we can't stream. */
  push(bytes: Uint8Array): Float32Array {
    if (!this.inData) {
      const buf = new Uint8Array(this.header.length + bytes.length);
      buf.set(this.header);
      buf.set(bytes, this.header.length);
      const start = this.findData(buf);
      if (start === null) {
        this.header = buf;
        return new Float32Array(0);
      }
      this.inData = true;
      this.header = new Uint8Array(0);
      bytes = buf.subarray(start);
    }
    return this.samples(bytes);
  }

  /** Returns the byte offset where sample data starts, or null if the header isn't complete yet. */
  private findData(buf: Uint8Array): number | null {
    if (buf.length < 12) return null;
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    if (ascii(buf, 0) !== "RIFF" || ascii(buf, 8) !== "WAVE") throw new Error("not a WAV stream");
    let off = 12;
    while (off + 8 <= buf.length) {
      const id = ascii(buf, off);
      const size = view.getUint32(off + 4, true);
      if (id === "data") return off + 8; // streamed WAVs often carry a placeholder size: ignore it
      if (off + 8 + size > buf.length) return null;
      if (id === "fmt ") {
        const format = view.getUint16(off + 8, true);
        this.channels = view.getUint16(off + 10, true);
        this.sampleRate = view.getUint32(off + 12, true);
        const bits = view.getUint16(off + 22, true);
        if (format !== 1 || bits !== 16) throw new Error(`unsupported WAV format ${format}/${bits}-bit`);
      }
      off += 8 + size + (size % 2);
    }
    return null;
  }

  private samples(bytes: Uint8Array): Float32Array {
    // Chunks can split a sample across two reads: carry the odd byte over.
    let src = bytes;
    if (this.carry !== null) {
      src = new Uint8Array(bytes.length + 1);
      src[0] = this.carry;
      src.set(bytes, 1);
      this.carry = null;
    }
    const frameBytes = 2 * this.channels;
    const usable = src.length - (src.length % frameBytes);
    if (usable < src.length) {
      if (src.length - usable > 1 || this.channels > 1) throw new Error("unaligned multi-channel WAV stream");
      this.carry = src[src.length - 1];
    }
    const view = new DataView(src.buffer, src.byteOffset, usable);
    const out = new Float32Array(usable / frameBytes);
    for (let i = 0; i < out.length; i++) out[i] = view.getInt16(i * frameBytes, true) / 32768;
    return out;
  }
}

function ascii(buf: Uint8Array, off: number): string {
  return String.fromCharCode(buf[off], buf[off + 1], buf[off + 2], buf[off + 3]);
}

export type TrimOptions = {
  sampleRate: number;
  /** Silence kept before the first sound (protects soft onsets like "f" and "h"). */
  keepLeadS?: number;
  /** Silence kept after the last sound: this *is* the pause between sentences. */
  keepTailS?: number;
  /** Longest pause kept inside a clip. */
  maxPauseS?: number;
  /** Peak level below which a 10 ms frame counts as silence. */
  threshold?: number;
};

/**
 * Trims leading/trailing silence from a stream of samples without waiting for the
 * end: quiet frames are held back and only released once sound follows them.
 */
export class SilenceTrimmer {
  private started = false;
  private held: Float32Array[] = [];
  private heldLen = 0;
  private partial = new Float32Array(0);
  private readonly frame: number;
  private readonly keepLead: number;
  private readonly keepTail: number;
  private readonly maxPause: number;
  private readonly threshold: number;

  constructor(opts: TrimOptions) {
    const r = opts.sampleRate;
    this.frame = Math.max(1, Math.round(r * 0.01));
    this.keepLead = Math.round(r * (opts.keepLeadS ?? 0.08));
    this.keepTail = Math.round(r * (opts.keepTailS ?? 0.2));
    this.maxPause = Math.round(r * (opts.maxPauseS ?? 0.6));
    this.threshold = opts.threshold ?? 0.015;
  }

  /** Feed samples; returns samples that are safe to play now. */
  push(samples: Float32Array): Float32Array {
    const all = concat([this.partial, samples]);
    const whole = all.length - (all.length % this.frame);
    this.partial = all.slice(whole);
    const out: Float32Array[] = [];
    for (let i = 0; i < whole; i += this.frame) {
      const f = all.subarray(i, i + this.frame);
      if (peak(f) < this.threshold) {
        this.held.push(f);
        this.heldLen += f.length;
        continue;
      }
      if (this.heldLen) {
        const keep = this.started ? Math.min(this.heldLen, this.maxPause) : Math.min(this.heldLen, this.keepLead);
        out.push(tail(concat(this.held), keep));
        this.held = [];
        this.heldLen = 0;
      }
      this.started = true;
      out.push(f);
    }
    return concat(out);
  }

  /** Call when the stream ends; returns the final samples (with a natural tail pause). */
  end(): Float32Array {
    if (!this.started) return new Float32Array(0); // all silence
    const rest = concat([...this.held, this.partial]);
    this.held = [];
    this.heldLen = 0;
    this.partial = new Float32Array(0);
    return rest.slice(0, this.keepTail);
  }
}

function peak(f: Float32Array): number {
  let m = 0;
  for (let i = 0; i < f.length; i++) {
    const v = Math.abs(f[i]);
    if (v > m) m = v;
  }
  return m;
}

function tail(a: Float32Array, n: number): Float32Array {
  return a.subarray(a.length - n);
}

function concat(parts: Float32Array[]): Float32Array {
  if (parts.length === 1) return parts[0];
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}
