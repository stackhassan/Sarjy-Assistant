/**
 * Fault injection from the page URL, e.g. `/?chaos=llm_primary_down,tts_down`.
 * Forwarded to every API call as `x-sarjy-chaos`; only affects this browser's requests.
 */
export function chaosFlags(): string[] {
  if (typeof window === "undefined") return [];
  const raw = new URLSearchParams(window.location.search).get("chaos") ?? "";
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

export function chaosHeaders(): Record<string, string> {
  const flags = chaosFlags();
  return flags.length ? { "x-sarjy-chaos": flags.join(",") } : {};
}
