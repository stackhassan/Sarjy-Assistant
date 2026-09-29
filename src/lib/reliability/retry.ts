import { sleep } from "./context";

/** A transient failure worth retrying (network error, timeout, 429, 5xx). */
export class TransientError extends Error {}

export type RetryOptions = {
  /** Total attempts including the first. */
  attempts: number;
  baseDelayMs: number;
  /** Stop retrying if the next attempt would start after this deadline (epoch ms). */
  deadline?: number;
  signal?: AbortSignal;
};

/**
 * Retries `fn` on TransientError with full-jitter exponential backoff, within a
 * deadline so retries can never blow the turn's latency budget.
 */
export async function retry<T>(fn: (attempt: number) => Promise<T>, opts: RetryOptions): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < opts.attempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      if (!(err instanceof TransientError) || opts.signal?.aborted) throw err;
      if (attempt === opts.attempts - 1) break;
      const delay = Math.random() * opts.baseDelayMs * 2 ** attempt;
      if (opts.deadline && Date.now() + delay >= opts.deadline) break;
      await sleep(delay, opts.signal);
    }
  }
  throw lastErr;
}
