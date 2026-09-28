/** Groq sends `retry-after` in seconds, or reset hints like "1h12m0s" / "12.2s". */
export function retryAfterSeconds(h: Headers): number {
  const direct = Number(h.get("retry-after"));
  if (Number.isFinite(direct) && direct > 0) return Math.ceil(direct);
  const reset = h.get("x-ratelimit-reset-requests") ?? h.get("x-ratelimit-reset-tokens") ?? "";
  const m = reset.match(/(?:(\d+)h)?(?:(\d+)m(?!s))?(?:([\d.]+)s)?/);
  const secs = m ? Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0) : 0;
  return secs > 0 ? Math.ceil(secs) : 60;
}
