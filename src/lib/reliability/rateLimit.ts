/**
 * Sliding-window rate limit per client. In memory, so per server instance: on
 * serverless it's a speed bump rather than a hard limit (a shared store such as
 * Upstash Redis would make it global). Its job is to stop one client from burning
 * the free-tier quotas and pushing the guards into degraded mode (red-team R3-8, F6).
 */
const hits = new Map<string, number[]>();

export function rateLimit(key: string, limit: number, windowMs: number, now = Date.now()): { ok: boolean; retryAfterS: number } {
  const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
  if (recent.length >= limit) {
    hits.set(key, recent);
    return { ok: false, retryAfterS: Math.ceil((windowMs - (now - recent[0])) / 1000) };
  }
  recent.push(now);
  hits.set(key, recent);
  if (hits.size > 10_000) hits.delete(hits.keys().next().value!); // bound memory
  return { ok: true, retryAfterS: 0 };
}

export function clientKey(request: Request): string {
  return (request.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || request.headers.get("x-real-ip") || "local";
}
