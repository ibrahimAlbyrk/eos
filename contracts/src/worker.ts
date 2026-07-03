// Worker entity — single canonical row shape, replacing the three drifting
// copies that lived in DB DDL, cli.ts, and tui.tsx (now deleted).
// Used by daemon HTTP responses, CLI consumers, and the web data layer.

import { z } from "zod";
import { WorkerStateSchema } from "./events.ts";
import { BackgroundActivityEntrySchema } from "./background-activity.ts";
import { LoopStatusSchema } from "./loop.ts";

// Provenance of a worker's name. "default" = the random default assigned at
// creation (the ONLY value eligible for auto-naming); "user" = an explicit
// creation name or a human rename (never auto-renamed); "auto" = set by the
// auto-name micro-task. Legacy rows (pre-migration) are NULL ⇒ ineligible.
export const NameSourceSchema = z.enum(["default", "auto", "user"]);
export type NameSource = z.infer<typeof NameSourceSchema>;

// Server-computed context-window occupancy for a worker: `used` tokens against
// the model's `limit` window, and the `pct` in use. limit/pct are null when the
// model window is unknown (fail open). Route-enriched (see WorkerRowSchema
// below), never persisted.
export const WorkerContextSchema = z.object({
  used: z.number(),
  limit: z.number().nullable(),
  pct: z.number().nullable(),
});
export type WorkerContext = z.infer<typeof WorkerContextSchema>;

export const WorkerRowSchema = z.object({
  id: z.string(),
  state: WorkerStateSchema,
  cwd: z.string().nullable(),
  worktree_from: z.string().nullable(),
  branch: z.string().nullable(),
  prompt: z.string(),
  name: z.string().nullable(),
  // Name provenance — gates the auto-name micro-task (only 'default' is eligible).
  name_source: NameSourceSchema.nullable(),
  pid: z.number().nullable(),
  port: z.number().nullable(),
  started_at: z.number(),
  ended_at: z.number().nullable(),
  exit_code: z.number().nullable(),
  // Added in later migrations — keep optional/nullable for backward compat
  // with rows persisted before each migration ran.
  parent_id: z.string().nullable().optional(),
  model: z.string().nullable().optional(),
  tokens_in: z.number().nullable().optional(),
  tokens_out: z.number().nullable().optional(),
  tokens_cache_read: z.number().nullable().optional(),
  tokens_cache_create: z.number().nullable().optional(),
  tokens_cache_create_1h: z.number().nullable().optional(),
  cost_usd: z.number().nullable().optional(),
  // Context-window occupancy: the prompt footprint (in + cacheRead + cacheWrite)
  // of the LAST API request, stamped by the daemon from per-message `context`
  // events (SET, latest wins — never the summed billing usage, which would
  // balloon past the window on backends that report a per-turn aggregate). The
  // web context ring reads this directly.
  last_context_tokens: z.number().nullable().optional(),
  // JSON snapshot of the agent's task list (Claude's TodoWrite), stamped by the
  // daemon on every TodoWrite tool call and nulled on /clear. A JSON string of
  // Task[] (see task.ts); the web parses it. Null/absent → no task list yet.
  tasks: z.string().nullable().optional(),
  // Live background processes the agent has spawned (Monitor tool / `Bash
  // run_in_background`), surfaced by the corner activity widget. NOT a DB
  // column — route-enriched from the in-memory BackgroundActivityService
  // (they die with the worker process, so persisting would resurrect dead
  // entries on restart). Absent on rows that weren't HTTP-enriched.
  backgroundActivity: z.array(BackgroundActivityEntrySchema).optional(),
  // The worker's active dynamic loop, if any. NOT a DB column — route-enriched
  // from the loops repo (findActiveByWorker) on the worker list/detail reads, so
  // the dashboard can show "looping (attempt N/M)". Surfaced regardless of worker
  // state (a loop sits IDLE between iterations). Absent when no active loop / on
  // rows that weren't HTTP-enriched.
  loop: z.object({
    status: LoopStatusSchema,
    attempt: z.number(),
    maxAttempts: z.number().nullable(),
    lastReason: z.string().nullable(),
    // The goal's one-line summary (from the loop's GoalSpec) so the live loop
    // card/badge shows what the loop is driving toward, not just the last reason.
    goalSummary: z.string().nullable(),
  }).optional(),
  // Context-window occupancy { used, limit, pct }. NOT a DB column —
  // route-enriched from last_context_tokens + the model catalog window
  // (ModelCatalogService.contextWindowFor) on worker list/detail reads, so
  // get_worker / list_active_workers can surface remaining budget. Absent on
  // rows that weren't HTTP-enriched.
  context: WorkerContextSchema.optional(),
  is_orchestrator: z.number().nullable().optional(),
  tool_calls: z.number().nullable().optional(),
  permission_mode: z.string().nullable().optional(),
  effort: z.string().nullable().optional(),
  backend_kind: z.string().nullable().optional(),
  backend_profile: z.string().nullable().optional(),
  agent_role: z.string().nullable().optional(),
  // Resolved worker-definition name (built-in / file / runtime), set once at spawn.
  // Drives the DPI workerDefinition fact + the body fragment on resume.
  worker_definition: z.string().nullable().optional(),
  // Materialized tool scope (JSON ToolScope) baked at spawn — the gate reads it
  // per tool call. Null ⇒ no tool restriction (untyped or an unrestricted definition).
  tool_scope: z.string().nullable().optional(),
  // Resolved (realpath'd) worktree directory, persisted post-spawn so the
  // daemon can remove the worktree on delete even after the worker is gone.
  worktree_dir: z.string().nullable().optional(),
  // Authoritative turn clock — set by TransitionState on every entry into the
  // busy set (SPAWNING/WORKING) from a non-busy state. UI elapsed timers read
  // this instead of inferring turn start from transcript blocks.
  turn_started_at: z.number().nullable().optional(),
  // Claude session id, reported by the worker on capture/swap. The key for
  // resuming a dead worker's conversation via `claude --resume`.
  session_id: z.string().nullable().optional(),
  // Fork commit stamped at worktree creation — the stable diff base. The old
  // merge-base fallback drifts when the source checkout moves to an older
  // commit, making a clean worktree look dirty.
  fork_base_sha: z.string().nullable().optional(),
  with_gateway: z.number().nullable().optional(),
  // 1 when spawned with collaborate=true: this worker has the peer MCP tools
  // and can consult / be consulted by its collaborate-enabled siblings.
  collaborate: z.number().nullable().optional(),
  // Set when this agent was spawned INTO another worker's worktree
  // (workspaceOf): it shares that workspace rather than owning one, so the
  // worktree is only removed when no row references its branch anymore.
  workspace_owner_id: z.string().nullable().optional(),
  // 0 until the worker reports its workspace materialized on disk (the
  // claude_spawning lifecycle event, emitted after worktree creation +
  // hydration). worktree_dir is precomputed at insert for delete safety, but
  // reading it before the tree exists is wrong: `git -C` against a
  // half-created worktree walks UP to the source repo and misattributes the
  // user's checkout diff to this worker. Git reads gate on this flag.
  workspace_ready: z.number().nullable().optional(),
  // Epoch ms when the worker was archived; NULL/absent = not archived. An
  // orthogonal flag, not a state — an archived row always sits at rest
  // (DONE/SUSPENDED) underneath. Archived rows are invisible to agents: they
  // leave GET /workers unconditionally and only the dashboard-only
  // /workers/archived route lists them.
  archived_at: z.number().nullable().optional(),
});

export const PermissionModeSchema = z.enum([
  "acceptEdits",
  "bypassPermissions",
]);
export type PermissionMode = z.infer<typeof PermissionModeSchema>;
export type WorkerRow = z.infer<typeof WorkerRowSchema>;

// Pending permission row as returned by GET /pending.
export const PendingPermissionRowSchema = z.object({
  id: z.string(),
  worker_id: z.string(),
  tool_name: z.string(),
  input: z.string(),
  created_at: z.number(),
  expires_at: z.number(),
  resolved: z.number(),
  decision: z.string().nullable().optional(),
  reason: z.string().nullable().optional(),
  tool_use_id: z.string().nullable().optional(),
  updated_input: z.string().nullable().optional(),
});
export type PendingPermissionRow = z.infer<typeof PendingPermissionRowSchema>;
