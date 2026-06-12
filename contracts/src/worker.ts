// Worker entity — single canonical row shape, replacing the three drifting
// copies that lived in DB DDL, cli.ts, and tui.tsx (now deleted).
// Used by daemon HTTP responses, CLI consumers, and the web data layer.

import { z } from "zod";
import { WorkerStateSchema } from "./events.ts";

export const WorkerRowSchema = z.object({
  id: z.string(),
  state: WorkerStateSchema,
  cwd: z.string().nullable(),
  worktree_from: z.string().nullable(),
  branch: z.string().nullable(),
  prompt: z.string(),
  name: z.string().nullable(),
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
  is_orchestrator: z.number().nullable().optional(),
  tool_calls: z.number().nullable().optional(),
  permission_mode: z.string().nullable().optional(),
  effort: z.string().nullable().optional(),
  backend_kind: z.string().nullable().optional(),
  backend_profile: z.string().nullable().optional(),
  agent_role: z.string().nullable().optional(),
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
});

export const PermissionModeSchema = z.enum([
  "default",
  "acceptEdits",
  "plan",
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
