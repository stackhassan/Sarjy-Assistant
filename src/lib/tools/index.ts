import type { ToolSpec } from "@/lib/llm/types";
import { getWeather, weatherToolSpec } from "./weather";

type ToolImpl = (args: unknown, signal?: AbortSignal) => Promise<{ ok: boolean }>;

const registry: Record<string, { spec: ToolSpec; run: ToolImpl }> = {
  get_weather: { spec: weatherToolSpec, run: getWeather },
};

export const toolSpecs: ToolSpec[] = Object.values(registry).map((t) => t.spec);

export async function runTool(name: string, rawArgs: string, signal?: AbortSignal) {
  const tool = registry[name];
  if (!tool) return { ok: false, error: "unknown_tool", message: `No tool named ${name}` };
  let args: unknown;
  try {
    args = rawArgs ? JSON.parse(rawArgs) : {};
  } catch {
    return { ok: false, error: "invalid_args", message: "Tool arguments were not valid JSON" };
  }
  return tool.run(args, signal);
}
