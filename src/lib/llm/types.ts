/** OpenAI-compatible chat types — both Groq and Gemini speak this format. */

export type ToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
  /**
   * Provider-specific data that must be sent back with the call (Gemini returns a
   * `thought_signature` here and rejects the follow-up request without it).
   */
  extra_content?: unknown;
};

export type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export type ToolSpec = {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
};

export type ToolChoice = "auto" | "none" | "required" | { type: "function"; function: { name: string } };

export type ChatDelta =
  | { type: "text"; text: string }
  | { type: "tool_call"; index: number; id?: string; name?: string; args?: string; extra?: unknown }
  | { type: "finish"; reason: string | null };
