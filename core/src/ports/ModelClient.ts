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
  // Opaque per-message escape hatch, carried across tool turns and re-emitted
  // unmodified by the dialect mapper that understands it. For reasoningRoundTrip:
  // "preserve-signed" (Anthropic) the assistant tool-call message stashes its
  // signed `thinking` block(s) here so the next request re-sends them verbatim
  // (Anthropic 400s otherwise); the OpenAI mapper ignores it (reasoning is dropped
  // from history — DeepSeek 400s if echoed back). Dialect-neutral: the core loop
  // just copies turn.providerMetadata onto the message it pushes.
  providerMetadata?: Record<string, unknown>;
}

export interface ModelTurn {
  text?: string;
  reasoning?: string;
  toolCalls: ModelToolCall[];
  stopReason: "end_turn" | "tool_use" | "max_tokens" | "error";
  usage?: { inputTokens: number; outputTokens: number; cacheReadTokens?: number };
  error?: string;
  // Native escape hatch — lets an adapter stash the provider's native stop reason,
  // signed thinking blocks, or cache fields without bloating the neutral contract
  // (e.g. carrying an Anthropic signed `thinking` block for reasoningRoundTrip:
  // "preserve-signed"). Consumed by the M4 round-trip work; neutral here.
  providerMetadata?: Record<string, unknown>;
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
