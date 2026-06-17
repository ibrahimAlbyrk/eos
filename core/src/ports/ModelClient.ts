// ModelClient — the minimal backend-agnostic model interface the Eos-hosted
// ToolRuntime drives. A claude-api / openai / codex adapter implements this; the
// runtime (core/use-cases/ToolRuntime.ts) calls createTurn in a loop, executing
// any returned tool calls and feeding results back. No Node imports.

export interface ModelToolCall {
  callId: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ModelMessage {
  role: "user" | "assistant" | "tool";
  content: unknown; // text or structured blocks/tool-results, backend-shaped
}

export interface ModelTurn {
  text?: string;
  reasoning?: string;
  toolCalls: ModelToolCall[];
  stopReason: "end_turn" | "tool_use" | "max_tokens" | "error";
  usage?: { inputTokens: number; outputTokens: number; cacheReadTokens?: number };
  error?: string;
}

// Streaming callbacks — reasoning/text arrive incrementally so the in-process
// lane (DeepSeek/Kimi/OpenAI) streams live thinking through the SAME canonical
// delta pipeline as the claude-sdk lane (R4: no forked thinking pipeline).
export interface ModelStreamCallbacks {
  onTextDelta?(text: string): void;
  onReasoningDelta?(text: string): void;
  /** Cooperative cancellation — checked while draining the stream (interrupt). */
  signal?: { aborted: boolean };
}

export interface ModelClient {
  /** One model round-trip: send the conversation, get back text + any tool calls. */
  createTurn(messages: ModelMessage[]): Promise<ModelTurn>;
  /** Streaming variant: resolves to the SAME aggregate ModelTurn, but emits
   *  reasoning/text deltas via callbacks as they arrive. Optional — ToolRuntime
   *  prefers it when present and falls back to createTurn otherwise (ISP). */
  streamTurn?(messages: ModelMessage[], cb: ModelStreamCallbacks): Promise<ModelTurn>;
}
