const ABBREVIATIONS = new Set(["mr", "mrs", "ms", "dr", "st", "vs", "etc", "e.g", "i.e", "approx", "min", "max"]);

/**
 * Incrementally splits streamed LLM text into sentences so each one can be
 * screened (L4) and spoken as soon as it is complete.
 */
export class SentenceSplitter {
  private buf = "";

  /** Feed a chunk; returns any sentences completed by it. */
  push(chunk: string): string[] {
    this.buf += chunk;
    const out: string[] = [];
    // Terminator, optional closing quote/bracket, then whitespace. Requiring the
    // whitespace keeps decimals like "21.5" intact.
    const re = /[.!?…]+["'”’)\]]?\s+/g;
    let start = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(this.buf))) {
      const end = m.index + m[0].length;
      const candidate = this.buf.slice(start, end).trim();
      if (isAbbreviation(candidate)) continue;
      if (candidate) out.push(candidate);
      start = end;
    }
    this.buf = this.buf.slice(start);
    return out;
  }

  /** Returns whatever is left once the stream ends. */
  flush(): string | null {
    const rest = this.buf.trim();
    this.buf = "";
    return rest || null;
  }
}

function isAbbreviation(sentence: string): boolean {
  const lastWord = sentence.replace(/[.!?…"'”’)\]]+$/, "").split(/\s+/).pop()?.toLowerCase() ?? "";
  return ABBREVIATIONS.has(lastWord);
}
