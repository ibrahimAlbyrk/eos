// SSOT shape for a worker type. Parsed from .eos/workers/*.md frontmatter,
// shipped as built-ins, AND posted as a runtime mint — one shape, three origins
// (Claude Code --agents ≡ frontmatter). It deliberately depends on NO
// ToolDefinition (manager-only): the tool surface is string globs, the decisive
// ISP boundary.

import { z } from "zod";
import { EFFORT_LEVELS } from "./shared.ts";
import { PermissionModeSchema } from "./worker.ts";

export const WorkerTypeSchema = z.object({
  // Identity — kebab-case, unique within a source. Filename/path is NOT identity
  // (mirrors Claude Code: identity is `name`, recursive scan, nearest-wins).
  name: z.string().min(1),
  // Human-facing label (UI, catalog display).
  description: z.string().default(""),
  // Machine-facing routing signal — "when should the orchestrator dispatch this
  // type". Separated from `description` (Roo whenToUse).
  whenToUse: z.string().default(""),

  // --- per-axis defaults (applied where the spawn request left a field unset) ---
  model: z.string().optional(),                    // "opus"|"sonnet"|"haiku"|"fable"|full id; omit ⇒ inherit
  effort: z.enum(EFFORT_LEVELS).optional(),
  permissionMode: PermissionModeSchema.optional(), // "acceptEdits"|"bypassPermissions"
  backendKind: z.string().optional(),              // "claude-cli"|"claude-sdk"; omit ⇒ resolver default
  persistent: z.boolean().optional(),
  collaborate: z.boolean().optional(),
  isolation: z.enum(["worktree", "cwd"]).optional(),

  // --- tool surface (string globs; bound to ToolDefinition ONLY in manager) ---
  // Allowlist semantics: empty/omitted ⇒ inherit-all (no allow restriction).
  // Denylist always subtracts. Globs support "*" (e.g. "mcp__*", "Bash").
  toolsAllow: z.array(z.string()).optional(),
  toolsDeny: z.array(z.string()).optional(),
  editRegex: z.string().optional(),                // restrict fileEdit targets to this path regex

  // --- composition ---
  extends: z.string().optional(),                  // explicit base type name (cross-source); the ONLY reuse path

  // --- the instructions body ---
  // For file types this is the markdown body after the frontmatter; for runtime
  // mints it is supplied as a JSON field; for built-ins it is the file body.
  body: z.string().default(""),
});
export type WorkerType = z.infer<typeof WorkerTypeSchema>;

// The materialized tool surface, carried on the spec + persisted on the worker
// row (JSON). The gate reads this per tool call — never re-resolves the type.
// allow empty ⇒ inherit-all (no allow restriction); deny always subtracts.
export const ToolScopeSchema = z.object({
  allow: z.array(z.string()).default([]),
  deny: z.array(z.string()).default([]),
  editRegex: z.string().nullable().default(null),
});
export type ToolScope = z.infer<typeof ToolScopeSchema>;

// Provenance — for introspection ("where did this type come from") and precedence.
export const WORKER_TYPE_SOURCES = ["builtin", "user", "project", "runtime"] as const;
export const WorkerTypeSourceSchema = z.enum(WORKER_TYPE_SOURCES);
export type WorkerTypeSource = z.infer<typeof WorkerTypeSourceSchema>;

// What a source.list() yields: the definition + where it came from.
export const WorkerTypeRecordSchema = WorkerTypeSchema.extend({
  source: WorkerTypeSourceSchema,
});
export type WorkerTypeRecord = z.infer<typeof WorkerTypeRecordSchema>;
