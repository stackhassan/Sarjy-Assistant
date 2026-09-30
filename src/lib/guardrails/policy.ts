/**
 * What Sarjy does when an input guard can't run (classifier outage, rate limit).
 *
 * - `fail_closed` (default, and what production should use): no free-form model text
 *   is spoken while the guards are blind. Weather is still answered, but only from the
 *   grounded template built from tool data; anything else gets a "try again shortly".
 * - `restricted` (development only): the old behaviour. Rule-based backups screen the
 *   input and only sentences that look risky are blocked. Red-team round 3 showed this
 *   can be forced (by exhausting the classifier's rate limit) and then bypassed with
 *   trigger-free answers, so it must not be used for a public deployment.
 */
export type DegradedPolicy = "fail_closed" | "restricted";

export function degradedPolicy(): DegradedPolicy {
  return process.env.GUARD_DEGRADED_POLICY === "restricted" ? "restricted" : "fail_closed";
}

/**
 * Demo mode shows guard internals (layers, verdicts, reasons, timings, tool data) to the
 * browser for the Guardrail Inspector. Off in production unless explicitly enabled:
 * those details tell an attacker exactly which layer stopped them and why.
 */
export function demoMode(): boolean {
  const v = process.env.NEXT_PUBLIC_SARJY_DEMO_MODE;
  if (v === "1" || v === "true") return true;
  if (v === "0" || v === "false") return false;
  return process.env.NODE_ENV !== "production";
}
