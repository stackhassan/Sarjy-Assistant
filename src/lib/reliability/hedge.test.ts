import { describe, expect, it } from "vitest";
import { sleep } from "./context";
import { hedge } from "./hedge";

const after = <T>(ms: number, v: T) => (s: AbortSignal) => sleep(ms, s).then(() => v);
const failAfter = (ms: number, msg: string) => (s: AbortSignal) =>
  sleep(ms, s).then(() => {
    throw new Error(msg);
  });

describe("hedge", () => {
  const signal = new AbortController().signal;

  it("uses the primary when it is fast, without starting the backup", async () => {
    let backupStarted = false;
    const r = await hedge(after(10, "p"), async () => ((backupStarted = true), "b"), { delayMs: 50, signal });
    expect(r).toEqual({ value: "p", winner: "primary" });
    expect(backupStarted).toBe(false);
  });

  it("starts the backup when the primary is slow and takes the first success", async () => {
    const t0 = Date.now();
    const r = await hedge(after(500, "p"), after(20, "b"), { delayMs: 50, signal });
    expect(r.winner).toBe("backup");
    expect(Date.now() - t0).toBeLessThan(200);
  });

  it("starts the backup immediately when the primary fails fast", async () => {
    const t0 = Date.now();
    const reasons: string[] = [];
    const r = await hedge(failAfter(5, "503"), after(10, "b"), { delayMs: 1000, signal, onHedge: (x) => reasons.push(x) });
    expect(r.winner).toBe("backup");
    expect(reasons).toEqual(["failed"]);
    expect(Date.now() - t0).toBeLessThan(200);
  });

  it("still accepts a slow primary that beats a slower backup", async () => {
    const r = await hedge(after(80, "p"), after(300, "b"), { delayMs: 20, signal });
    expect(r.winner).toBe("primary");
  });

  it("rejects with both errors when both fail", async () => {
    await expect(hedge(failAfter(5, "a down"), failAfter(5, "b down"), { delayMs: 10, signal })).rejects.toThrow(/a down; b down/);
  });

  it("aborts the losing request", async () => {
    let aborted = false;
    await hedge(
      (s) => new Promise((_, rej) => s.addEventListener("abort", () => ((aborted = true), rej(new Error("x"))))),
      after(5, "b"),
      { delayMs: 1, signal },
    );
    expect(aborted).toBe(true);
  });
});
