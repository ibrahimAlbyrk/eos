// Canonical, backend-agnostic agent event model. Every AgentBackend adapter
// (claude-cli today; anthropic-api / claude-sdk / codex later) emits these, so
// the daemon, state machine, event log and web UI can stay backend-neutral.
//
// The primitives are universal: assistant text, reasoning, tool calls, tool
// results, token usage, turn boundaries, session lifecycle, and human prompts.
// Claude's hook/jsonl events become an optional raw debug sidecar (see the ADR
// docs/adr/0001-backend-agnostic-agent-platform.md §6.2).

import { z } from "zod";
import { UnknownRecordSchema } from "./shared.ts";

// Which agent runtime produced an event. Kept here because the envelope needs
// it; a later contracts/src/backend.ts re-exports rather than redefines it.
export const BackendKindSchema = z.enum([
  "claude-cli",
  "claude-sdk",
  "anthropic-api",
  "openai",
  "codex",
]);
export type BackendKind = z.infer<typeof BackendKindSchema>;

// --- content blocks: the universal primitives every backend can express -----

export const TextBlockSchema = z.object({
  type: z.literal("text"),
  text: z.string(),
  // Synthesized live-stream id (claude-sdk: `${assistantMsgUuid}:${index}`) so a
  // durable block reconciles with its live delta buffer; absent for non-streaming
  // backends (claude-cli).
  blockId: z.string().optional(),
});

// Was Claude's "thinking". `redacted` covers the API's redacted_thinking; absent
// for backends with no reasoning channel (never synthesize an empty one).
export const ReasoningBlockSchema = z.object({
  type: z.literal("reasoning"),
  text: z.string(),
  redacted: z.boolean().optional(),
  blockId: z.string().optional(), // see TextBlockSchema.blockId
});

export const ToolCallBlockSchema = z.object({
  type: z.literal("tool_call"),
  callId: z.string(), // canonical id (was toolUseId / Anthropic block.id)
  name: z.string(),
  input: UnknownRecordSchema.default({}),
  parentCallId: z.string().nullable().optional(), // subagent attribution
});

export const ToolResultBlockSchema = z.object({
  type: z.literal("tool_result"),
  callId: z.string(),
  isError: z.boolean().default(false),
  content: z.string().default(""),
});

export const ContentBlockSchema = z.discriminatedUnion("type", [
  TextBlockSchema,
  ReasoningBlockSchema,
  ToolCallBlockSchema,
  ToolResultBlockSchema,
]);
export type ContentBlock = z.infer<typeof ContentBlockSchema>;

// --- normalized usage (cache fields optional for non-Anthropic backends) ----

export const CanonicalUsageSchema = z.object({
  inputTokens: z.number().nonnegative().default(0),
  outputTokens: z.number().nonnegative().default(0),
  cacheReadTokens: z.number().nonnegative().default(0),
  // Open per-tier write map ("5m" | "1h" | …) so new cache tiers need no schema
  // change; backends without caching leave it empty.
  cacheWriteTokens: z.record(z.string(), z.number().nonnegative()).default({}),
  model: z.string().nullable().optional(),
});
export type CanonicalUsage = z.infer<typeof CanonicalUsageSchema>;

// --- the AgentEvent union (discriminated on `type`) -------------------------

export const AgentMessageEventSchema = z.object({
  type: z.literal("message"),
  role: z.enum(["assistant", "user", "tool"]),
  blocks: z.array(ContentBlockSchema),
  model: z.string().nullable().optional(),
});

// Turn boundary — replaces Claude's Stop hook + the prompt/interrupt lifecycle.
export const TurnEventSchema = z.object({
  type: z.literal("turn"),
  phase: z.enum(["started", "ended", "aborted", "error"]),
  reason: z.string().optional(),
});

// Liveness / tool pulse — replaces tool_running / tool_done / heartbeat.
export const ActivityEventSchema = z.object({
  type: z.literal("activity"),
  kind: z.enum(["tool_started", "tool_finished", "alive"]),
  callId: z.string().nullable().optional(),
  toolName: z.string().optional(),
});

export const UsageEventSchema = z.object({
  type: z.literal("usage"),
  usage: CanonicalUsageSchema,
});

// Session lifecycle — distinct from turn boundaries (boot / ready / exit).
// "cleared" = the conversation was wiped in-place (Claude's /clear): the
// process lives on with a fresh context, unlike "ended" which precedes exit.
export const SessionEventSchema = z.object({
  type: z.literal("session"),
  phase: z.enum(["started", "ready", "ended", "cleared"]),
  outcome: z.enum(["success", "killed", "crashed"]).optional(),
});

export const PermissionRequestEventSchema = z.object({
  type: z.literal("permission_request"),
  callId: z.string().nullable(), // null where the backend can't supply one
  toolName: z.string(),
  input: UnknownRecordSchema.default({}),
});

export const QuestionRequestEventSchema = z.object({
  type: z.literal("question_request"),
  callId: z.string().nullable(),
  questions: z.array(UnknownRecordSchema),
});

// Live streaming delta — interim reasoning/text tokens for backends that stream
// (claude-sdk, in-process). NEVER persisted per-token: the daemon filters these
// at the onAgentEvent sink and relays them on the ephemeral `agent:delta` bus
// topic; the durable record stays the final `message` event. `blockId` matches
// the durable block's blockId so the UI swaps the live buffer for the persisted
// block with no flash or double-render.
export const DeltaEventSchema = z.object({
  type: z.literal("delta"),
  channel: z.enum(["reasoning", "text"]),
  phase: z.enum(["start", "append", "stop"]),
  blockId: z.string(),
  text: z.string().default(""),
});

export const AgentEventSchema = z.discriminatedUnion("type", [
  AgentMessageEventSchema,
  DeltaEventSchema,
  TurnEventSchema,
  ActivityEventSchema,
  UsageEventSchema,
  SessionEventSchema,
  PermissionRequestEventSchema,
  QuestionRequestEventSchema,
]);
export type AgentEvent = z.infer<typeof AgentEventSchema>;

// --- envelope: how an AgentEvent rides the wire / is logged -----------------

export const AgentEventEnvelopeSchema = z.object({
  backend: BackendKindSchema,
  workerId: z.string(),
  turnId: z.string().nullable().default(null),
  seq: z.number().int().nonnegative().optional(),
  ts: z.number(),
  event: AgentEventSchema,
});
export type AgentEventEnvelope = z.infer<typeof AgentEventEnvelopeSchema>;
