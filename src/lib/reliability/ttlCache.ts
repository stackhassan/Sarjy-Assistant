/**
 * Small in-memory LRU with expiry. Per server instance, so on serverless it is a
 * best-effort cache: a cold instance simply starts empty.
 */
export class TtlCache<V> {
  private map = new Map<string, { value: V; expires: number }>();

  constructor(
    private readonly maxEntries: number,
    private readonly ttlMs: number,
  ) {}

  get(key: string): V | undefined {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (hit.expires < Date.now()) {
      this.map.delete(key);
      return undefined;
    }
    // Refresh recency.
    this.map.delete(key);
    this.map.set(key, hit);
    return hit.value;
  }

  set(key: string, value: V) {
    this.map.delete(key);
    this.map.set(key, { value, expires: Date.now() + this.ttlMs });
    while (this.map.size > this.maxEntries) this.map.delete(this.map.keys().next().value!);
  }

  clear() {
    this.map.clear();
  }
}
