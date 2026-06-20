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
  // A dynamic-loop automated re-trigger delivered into the looped worker's chat —
  // rendered as a "Dynamic loop" system message, not a user bubble.
  "loop_continuation",
  "question_pending",
  "question_answered",
  // Peer consultation: peer_consult marks the asker's timeline when it consults
  // a peer; peer_request is the question delivered into the target peer's chat.
  "peer_consult",
  "peer_request",
  "conversation_rewound",
  "conversation_cleared",
  "try_applied",
  "try_kept",
  "try_discarded",
  "git_push",
  "git_pull",
  "workers_integrated",
  "conflict_resolved",
  "terminal",
  // Canonical agent-event row (in-process / claude-sdk backends): the payload is
  // the full AgentEvent (contracts/src/canonical.ts). Daemon-synthesized via
  // processAgentSignal's logEvent; the row type is stored free-form so logging
  // already works, but the enum lists it so consumers are type-complete.
  "agent_event",
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

// fs:change — a bus-only live topic (like terminal:chunk), NOT a per-worker
// timeline event, so it is deliberately absent from WorkerEventTypeSchema. The
// chokidar watcher publishes coalesced batches; the SSE broadcaster relays them
// as {reason:"fs:change", payload}; the Files explorer re-lists the affected dir.
export const FsChangeKindSchema = z.enum(["add", "change", "unlink", "addDir", "unlinkDir"]);
export type FsChangeKind = z.infer<typeof FsChangeKindSchema>;

export const FsChangeEventSchema = z.object({
  changes: z.array(
    z.object({
      kind: FsChangeKindSchema,
      path: z.string(),
      dir: z.string(),
      ts: z.number(),
    }),
  ),
});
export type FsChangeEvent = z.infer<typeof FsChangeEventSchema>;

// git:change — a bus-only live topic (like fs:change), NOT a per-worker timeline
// event, so it is deliberately absent from WorkerEventTypeSchema. The GitWatcher
// observes a repo's .git internals + working tree and publishes one coalesced
// event per affected dir; the SSE broadcaster relays it as {reason:"git:change",
// payload}; the web's dir-keyed git stores revalidate only the slice each `kind`
// touches. `dir` is the working-tree root the watcher was asked to watch — the
// same path the web keys its git state on, so events and stores line up.
export const GitChangeKindSchema = z.enum(["head", "index", "refs", "stash", "worktree", "conflict"]);
export type GitChangeKind = z.infer<typeof GitChangeKindSchema>;

export const GitChangeEventSchema = z.object({
  dir: z.string(),
  kinds: z.array(GitChangeKindSchema),
  ts: z.number(),
});
export type GitChangeEvent = z.infer<typeof GitChangeEventSchema>;
