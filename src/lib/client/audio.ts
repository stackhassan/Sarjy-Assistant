/** One AudioContext for the whole app: the thinking chime and Sarjy's voice share it. */
let ctx: AudioContext | undefined;

export function audioContext(): AudioContext | undefined {
  if (typeof window === "undefined" || !("AudioContext" in window)) return undefined;
  ctx ??= new AudioContext();
  return ctx;
}

/** Call from a user gesture (tap, send) so the browser lets us play audio later. */
export function primeAudio() {
  const c = audioContext();
  if (c?.state === "suspended") c.resume().catch(() => {});
}
