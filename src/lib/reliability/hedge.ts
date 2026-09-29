/**
 * Hedged request: start `primary`; if it hasn't settled after `delayMs` (or it
 * fails sooner), start `backup` too, and take whichever succeeds first.
 *
 * Tail latency on free public APIs is the real enemy (we measured Open-Meteo
 * geocoding at 0.9 s typical, 11 s worst). Waiting for a timeout before failing
 * over makes users pay the whole timeout; hedging caps them near `delayMs`.
 * Only for idempotent reads with no quota cost.
 */
export async function hedge<T>(
  primary: (signal: AbortSignal) => Promise<T>,
  backup: (signal: AbortSignal) => Promise<T>,
  opts: { delayMs: number; signal: AbortSignal; onHedge?: (reason: "slow" | "failed") => void },
): Promise<{ value: T; winner: "primary" | "backup" }> {
  const losers = new AbortController();
  const sig = AbortSignal.any([opts.signal, losers.signal]);

  return new Promise((resolve, reject) => {
    const errors: unknown[] = [];
    let started = 1;
    let settled = false;

    const win = (value: T, winner: "primary" | "backup") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      losers.abort(); // cancel whichever request is still in flight
      resolve({ value, winner });
    };
    const lose = (err: unknown) => {
      errors.push(err);
      if (!settled && errors.length === started && (started === 2 || opts.signal.aborted)) {
        settled = true;
        clearTimeout(timer);
        reject(errors.length === 1 ? errors[0] : new AggregateError(errors, errors.map((e) => (e as Error).message).join("; ")));
      }
    };
    const startBackup = (reason: "slow" | "failed") => {
      if (settled || started === 2) return;
      started = 2;
      clearTimeout(timer);
      opts.onHedge?.(reason);
      backup(sig).then((v) => win(v, "backup"), lose);
    };

    primary(sig).then(
      (v) => win(v, "primary"),
      (err) => {
        lose(err);
        startBackup("failed");
      },
    );
    // Callbacks above only run asynchronously, after this is initialised.
    const timer = setTimeout(() => startBackup("slow"), opts.delayMs);
  });
}
