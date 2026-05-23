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
  cost_usd: z.number().nullable().optional(),
  is_orchestrator: z.number().nullable().optional(),
  tool_calls: z.number().nullable().optional(),
  permission_mode: z.string().nullable().optional(),
  effort: z.string().nullable().optional(),
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
