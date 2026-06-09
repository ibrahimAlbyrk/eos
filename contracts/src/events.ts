// Event types — daemon ↔ worker ↔ web/SSE.
// Every event the worker POSTs to /workers/:id/events lands here, plus the
// events the daemon synthesizes itself (spawn, exit, policy, permission_*,
// user_message, state_reject).

import { z } from "zod";
import { UnknownRecordSchema } from "./shared.ts";

export const HookEventNameSchema = z.enum([
  "SessionStart",
  "SessionEnd",
  "Stop",
  "Notification",
  "PostToolUse",
]);
export type HookEventName = z.infer<typeof HookEventNameSchema>;

export const WorkerStateSchema = z.enum([
  "SPAWNING",
  "WORKING",
  "IDLE",
  "ENDING",
  "DONE",
  "KILLING",
  // Process dead (daemon restart/crash) but the conversation is resumable —
  // session_id + cwd survived. Set by boot reconciliation, left by resume.
  "SUSPENDED",
]);
export type WorkerState = z.infer<typeof WorkerStateSchema>;

export const JsonlKindSchema = z.enum([
  "assistant_text",
  "tool_use",
  "tool_result",
  "thinking",
]);
export type JsonlKind = z.infer<typeof JsonlKindSchema>;

export const WorkerEventTypeSchema = z.enum([
  // Pushed by the worker:
  "state",
  "hook",
  "jsonl",
  "heartbeat",
  "usage",
  "lifecycle",
  "warning",
  "worktree",
  "tool_running",
  "tool_done",
  // Synthesized by the daemon:
  "spawn",
  "exit",
  "policy",
  "permission_pending",
  "permission_ttl_deny",
  "user_message",
  "state_reject",
  "worker_report",
  "orchestrator_message",
  "question_pending",
  "question_answered",
  "conversation_rewound",
  "conversation_cleared",
  "try_applied",
  "try_kept",
  "try_discarded",
  "git_push",
]);
export type WorkerEventType = z.infer<typeof WorkerEventTypeSchema>;

export const UsagePayloadSchema = z.object({
  in: z.number().nonnegative().default(0),
  out: z.number().nonnegative().default(0),
  cacheRead: z.number().nonnegative().default(0),
  cacheCreate: z.number().nonnegative().default(0),
  // 1-hour ephemeral cache writes — billed at 2× input vs 1.25× for 5-min.
  // Anthropic surfaces the split under usage.cache_creation; absent value → 0.
  cacheCreate1h: z.number().nonnegative().default(0),
  model: z.string().optional(),
  // Added by the daemon after computing cost; never set by the worker.
  deltaCost: z.number().nonnegative().optional(),
});
export type UsagePayload = z.infer<typeof UsagePayloadSchema>;

export const ToolRunningPayloadSchema = z.object({
  toolName: z.string(),
  toolUseId: z.string().nullable(),
  input: UnknownRecordSchema.default({}),
  parentAgentToolUseId: z.string().optional(),
});
export type ToolRunningPayload = z.infer<typeof ToolRunningPayloadSchema>;

export const ToolDonePayloadSchema = z.object({
  toolName: z.string(),
  toolUseId: z.string().nullable(),
  result: z.string().default(""),
  parentAgentToolUseId: z.string().optional(),
});
export type ToolDonePayload = z.infer<typeof ToolDonePayloadSchema>;

export const JsonlAssistantTextSchema = z.object({
  kind: z.literal("assistant_text"),
  text: z.string(),
});
export const JsonlToolUseSchema = z.object({
  kind: z.literal("tool_use"),
  id: z.string().optional(),
  name: z.string(),
  input: UnknownRecordSchema.default({}),
});
export const JsonlToolResultSchema = z.object({
  kind: z.literal("tool_result"),
  toolUseId: z.string().optional(),
  isError: z.boolean().default(false),
  text: z.string().default(""),
});
export const JsonlThinkingSchema = z.object({
  kind: z.literal("thinking"),
  text: z.string(),
});
export const JsonlPayloadSchema = z.discriminatedUnion("kind", [
  JsonlAssistantTextSchema,
  JsonlToolUseSchema,
  JsonlToolResultSchema,
  JsonlThinkingSchema,
]);
export type JsonlPayload = z.infer<typeof JsonlPayloadSchema>;

export const HookPayloadSchema = z.object({
  event: HookEventNameSchema,
  body: UnknownRecordSchema.default({}),
});
export type HookPayload = z.infer<typeof HookPayloadSchema>;

export const StatePayloadSchema = z.object({
  state: WorkerStateSchema,
  from: WorkerStateSchema.optional(),
  reason: z.string().optional(),
});
export type StatePayload = z.infer<typeof StatePayloadSchema>;

export const HeartbeatPayloadSchema = z.object({
  elapsedMs: z.number().nonnegative(),
  quietMs: z.number().nonnegative(),
});
export type HeartbeatPayload = z.infer<typeof HeartbeatPayloadSchema>;

export const LifecyclePhaseSchema = z.enum([
  "claude_spawning",
  "prompt_sent",
  "ready_no_prompt",
  "ready_timeout",
  "message_received",
  "interrupted",
  "session_captured",   // worker captured/swapped the claude session id — daemon persists it
  // Delivery pipeline (spawner/delivery.ts) verification outcomes:
  "echo_timeout",        // text never echoed in the composer before fallback CR
  "delivery_retry",      // a retry attempt (re-CR or re-paste) was issued
  "prompt_delivered",    // turn-ACK confirmed: user message landed in the transcript
  "delivery_unverified", // echo OK but no turn-ACK (mid-turn queue or slow disk) — informational
  "delivery_failed",     // neither echo nor ACK after all attempts — input is lost
  "pty_exit",
  "uncaught_exception",
  "unhandled_rejection",
]);

// Lifecycle payloads are open phase-tagged records — some phases carry extra
// fields (e.g. pty_exit carries code), so we passthrough.
export const LifecyclePayloadSchema = z.object({
  phase: LifecyclePhaseSchema,
}).passthrough();
export type LifecyclePayload = z.infer<typeof LifecyclePayloadSchema>;

// Body the worker POSTs to /workers/:id/events.
export const WorkerEventPostBodySchema = z.object({
  type: WorkerEventTypeSchema,
  payload: z.unknown().optional(),
  // Worker-side monotonic emission counter. The event client serializes sends,
  // so arrival order matches seq; the daemon stores it for gap diagnostics.
  seq: z.number().int().nonnegative().optional(),
});
export type WorkerEventPostBody = z.infer<typeof WorkerEventPostBodySchema>;

// Row format returned by GET /workers/:id/events. payload is the raw JSON
// string as stored in SQLite — callers parse it lazily.
export const WorkerEventRowSchema = z.object({
  id: z.number(),
  worker_id: z.string(),
  ts: z.number(),
  type: z.string(),
  payload: z.string().nullable(),
});
export type WorkerEventRow = z.infer<typeof WorkerEventRowSchema>;
