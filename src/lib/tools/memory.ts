import { z } from "zod";
import type { ToolSpec } from "@/lib/llm/types";
import { screenMemoryWrite } from "@/lib/guardrails/l5-memory";
import type { GuardResult } from "@/lib/guardrails/types";
import { MemoryError, type MemoryStore } from "@/lib/memory/store";

export const MEMORY_TOOL_NAMES = new Set(["remember_fact", "forget_fact", "forget_everything"]);

export const memoryToolSpecs: ToolSpec[] = [
  {
    type: "function",
    function: {
      name: "remember_fact",
      description:
        "Save a lasting fact or preference the user just told you about themselves (name, favourite things, home city, " +
        "diet, pets...), so you remember it in future conversations. Only facts the user stated; never passwords, ID " +
        "numbers or payment details. Saving an existing key replaces it.",
      parameters: {
        type: "object",
        properties: {
          key: { type: "string", description: "short snake_case label, e.g. favorite_color, home_city, dog_name" },
          value: { type: "string", description: "the fact, in the user's words, e.g. 'teal'" },
          category: { type: "string", enum: ["preference", "personal", "location", "other"] },
        },
        required: ["key", "value", "category"],
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
      const check = await screenMemoryWrite(args, { userTexts: ctx.userTexts, latestUserText: ctx.latestUserText, signal: ctx.signal });
      ctx.emitGuard(check);
      if (check.verdict !== "pass" || !check.fact) {
        return { ok: false, error: "not_saved", message: `Not saved: ${check.reason}. Tell the user briefly that you won't store that.` };
      }
      await ctx.store.upsert(check.fact);
      return { ok: true, saved: { key: check.fact.key, value: check.fact.value } };
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
