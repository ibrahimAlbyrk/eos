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

export interface ModelClient {
  /** One model round-trip: send the conversation, get back text + any tool calls. */
  createTurn(messages: ModelMessage[]): Promise<ModelTurn>;
}
