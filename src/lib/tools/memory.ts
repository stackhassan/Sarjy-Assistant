import { z } from "zod";
import type { ToolSpec } from "@/lib/llm/types";
import { screenMemoryWrite } from "@/lib/guardrails/l5-memory";
import type { GuardResult } from "@/lib/guardrails/types";
import { MemoryError, type MemoryStore } from "@/lib/memory/store";

/**
 * Facts one save can carry. A list, because with one fact per call the model saved only
 * one fact from "I'm a software engineer and my sister is Ayesha" (measured: 1 of 2 in
 * 9 of 10 multi-fact messages, even when told to call once per fact).
 */
const MAX_FACTS_PER_CALL = 6;

export const MEMORY_TOOL_NAMES = new Set(["remember_fact", "forget_fact", "forget_everything"]);

export const memoryToolSpecs: ToolSpec[] = [
  {
    type: "function",
    function: {
      name: "remember_fact",
      description:
        "Save lasting facts or preferences the user just told you about themselves (name, job, favourite things, home " +
        "city, diet, pets...), so you remember them in future conversations. Put EVERY fact from the message in `facts`, " +
        "one item each (\"I'm a nurse and I live in Lahore\" is two items). Only facts the user stated; never passwords, " +
        "ID numbers or payment details. Saving an existing key replaces it.",
      parameters: {
        type: "object",
        properties: {
          facts: {
            type: "array",
            minItems: 1,
            maxItems: MAX_FACTS_PER_CALL,
            items: {
              type: "object",
              properties: {
                key: { type: "string", description: "short snake_case label, e.g. favorite_color, home_city, occupation" },
                value: { type: "string", description: "the fact, in the user's words, e.g. 'teal'" },
                category: { type: "string", enum: ["preference", "personal", "location", "other"] },
              },
              required: ["key", "value", "category"],
            },
          },
        },
        required: ["facts"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "forget_fact",
      description: "Delete one remembered fact when the user asks you to forget it.",
      parameters: { type: "object", properties: { key: { type: "string" } }, required: ["key"] },
    },
  },
  {
    type: "function",
    function: {
      name: "forget_everything",
      description: "Delete everything remembered about the user, only when they clearly ask to forget everything.",
      parameters: { type: "object", properties: {} },
    },
  },
];

export type MemoryToolContext = {
  store: MemoryStore;
  userTexts: string[];
  latestUserText: string;
  emitGuard: (r: GuardResult) => void;
  signal?: AbortSignal;
};

/** Runs a memory tool. Writes go through L5 first; storage failures are reported, not thrown. */
export async function runMemoryTool(name: string, rawArgs: string, ctx: MemoryToolContext) {
  let args: unknown;
  try {
    args = rawArgs ? JSON.parse(rawArgs) : {};
  } catch {
    return { ok: false, error: "invalid_args", message: "Tool arguments were not valid JSON" };
  }
  try {
    if (name === "remember_fact") {
      // `{facts: [...]}`; a bare single fact is accepted too (some models flatten one-item lists).
      const list = (args as { facts?: unknown })?.facts;
      const items = (Array.isArray(list) ? list : [args]).slice(0, MAX_FACTS_PER_CALL);
      // Every fact is screened by L5 on its own; one bad item doesn't block the others.
      const checks = await Promise.all(
        items.map((item) => screenMemoryWrite(item, { userTexts: ctx.userTexts, latestUserText: ctx.latestUserText, signal: ctx.signal })),
      );
      const saved: { key: string; value: string }[] = [];
      const notSaved: { key: string; reason: string }[] = [];
      for (const [i, check] of checks.entries()) {
        ctx.emitGuard(check);
        if (check.verdict !== "pass" || !check.fact) {
          const key = (items[i] as { key?: unknown })?.key;
          notSaved.push({ key: typeof key === "string" ? key.slice(0, 64) : "?", reason: check.reason });
          continue;
        }
        await ctx.store.upsert(check.fact);
        saved.push({ key: check.fact.key, value: check.fact.value });
      }
      if (!saved.length) {
        return { ok: false, error: "not_saved", message: `Not saved: ${notSaved.map((n) => n.reason).join("; ")}. Tell the user briefly that you won't store that.` };
      }
      return notSaved.length
        ? { ok: true, saved, not_saved: notSaved, message: "Some facts were saved; tell the user briefly which ones you won't store." }
        : { ok: true, saved };
    }
    if (name === "forget_fact") {
      const key = z.object({ key: z.string().min(1).max(64) }).safeParse(args);
      if (!key.success) return { ok: false, error: "invalid_args", message: "Which fact should I forget?" };
      const k = key.data.key.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_");
      const removed = await ctx.store.remove(k);
      return removed ? { ok: true, forgotten: k } : { ok: false, error: "not_found", message: `Nothing saved under "${k}".` };
    }
    if (name === "forget_everything") {
      return { ok: true, forgotten_count: await ctx.store.removeAll() };
    }
  } catch (err) {
    if (err instanceof MemoryError) {
      return { ok: false, error: "memory_unavailable", message: "Memory is unavailable right now. Tell the user you couldn't save or change it this time." };
    }
    throw err;
  }
  return { ok: false, error: "unknown_tool", message: name };
}
