/** Orpheus accepts at most 200 characters per request. */
export const TTS_MAX_CHARS = 200;

export type Signed = { text: string; sig?: string };

/**
 * Takes as many queued sentences as fit in one TTS request, preserving order.
 * Always takes at least one; callers must pre-split any sentence that is too
 * long on its own (sentences are signed, so we can't split them here).
 */
export function takeBatch<T extends Signed>(queue: T[], max = TTS_MAX_CHARS): T[] {
  const batch: T[] = [];
  let len = 0;
  for (const s of queue) {
    const added = (batch.length ? 1 : 0) + s.text.length;
    if (batch.length && len + added > max) break;
    batch.push(s);
    len += added;
  }
  queue.splice(0, batch.length);
  return batch;
}

/** Splits text into pieces of at most `max` chars, preferring clause then word boundaries. */
export function splitLong(text: string, max = TTS_MAX_CHARS): string[] {
  const out: string[] = [];
  let rest = text.trim();
  while (rest.length > max) {
    const window = rest.slice(0, max + 1);
    let cut = Math.max(window.lastIndexOf(", "), window.lastIndexOf("; "), window.lastIndexOf(" — "));
    if (cut < max / 2) cut = window.lastIndexOf(" ");
    if (cut <= 0) cut = max;
    out.push(rest.slice(0, cut + 1).trim());
    rest = rest.slice(cut + 1).trim();
  }
  if (rest) out.push(rest);
  return out;
}
