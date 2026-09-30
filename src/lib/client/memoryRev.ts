/**
 * A version for this browser's memory, bumped whenever memory changes (a delete in the
 * drawer, or a turn that remembered or forgot something). The server's fact cache is
 * keyed by it, so a change made through one serverless instance can't leave another
 * serving the old list. Kept in localStorage so every tab sees the same version.
 */
const KEY = "sarjy.memoryRev";
let fallback = "0";

export function memoryRev(): string {
  try {
    return localStorage.getItem(KEY) ?? fallback;
  } catch {
    return fallback;
  }
}

export function bumpMemoryRev() {
  const next = Date.now().toString(36);
  fallback = next;
  try {
    localStorage.setItem(KEY, next);
  } catch {}
}
