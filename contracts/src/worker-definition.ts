// SSOT shape for a worker definition (an "available worker"). Parsed from
// .eos/workers/*.md frontmatter, shipped as built-ins, AND posted as a runtime
// create — one shape, three origins (Claude Code --agents ≡ frontmatter). It
// deliberately depends on NO ToolDefinition (manager-only): the tool surface is
// string globs, the decisive ISP boundary.

import { z } from "zod";
import { EFFORT_LEVELS } from "./shared.ts";
import { PermissionModeSchema } from "./worker.ts";

export const WorkerDefinitionSchema = z.object({
  // Identity — kebab-case, unique within a source. Filename/path is NOT identity
  // (mirrors Claude Code: identity is `name`, recursive scan, nearest-wins).
  name: z.string().min(1),
  // Human-facing label (UI, catalog display).
  description: z.string().default(""),
  // Machine-facing routing signal — "when should the orchestrator dispatch this
  // worker". Separated from `description` (Roo whenToUse).
  whenToUse: z.string().default(""),

  // --- per-axis defaults (applied where the spawn request left a field unset) ---
  model: z.string().optional(),                    // "high"|"medium"|"low"|concrete id; omit ⇒ inherit
  effort: z.enum(EFFORT_LEVELS).optional(),
  permissionMode: PermissionModeSchema.optional(), // "acceptEdits"|"bypassPermissions"
  backendKind: z.string().optional(),              // "claude-cli"|"claude-sdk"; omit ⇒ resolver default
  backendProfile: z.string().optional(),           // pin a config `backends` profile (provider+model) on any scope; omit ⇒ resolver default
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
  extends: z.string().optional(),                  // explicit base worker name (cross-source); the ONLY reuse path

  // --- the instructions body ---
  // For file definitions this is the markdown body after the frontmatter; for
  // runtime creates it is supplied as a JSON field; for built-ins it is the body.
  body: z.string().default(""),
});
export type WorkerDefinition = z.infer<typeof WorkerDefinitionSchema>;

// The available worker every spawn falls back to when `from` is omitted/empty.
// A spawn ALWAYS resolves to a definition — there is no definition-less worker.
export const DEFAULT_WORKER_DEFINITION = "general-purpose";

// The materialized tool surface, carried on the spec + persisted on the worker
// row (JSON). The gate reads this per tool call — never re-resolves the definition.
// allow empty ⇒ inherit-all (no allow restriction); deny always subtracts.
export const ToolScopeSchema = z.object({
  allow: z.array(z.string()).default([]),
  deny: z.array(z.string()).default([]),
  editRegex: z.string().nullable().default(null),
});
export type ToolScope = z.infer<typeof ToolScopeSchema>;

// Provenance — for introspection ("where did this come from") and precedence.
export const WORKER_DEFINITION_SOURCES = ["builtin", "user", "project", "runtime"] as const;
export const WorkerDefinitionSourceSchema = z.enum(WORKER_DEFINITION_SOURCES);
export type WorkerDefinitionSource = z.infer<typeof WorkerDefinitionSourceSchema>;

// What a source.list() yields: the definition + where it came from.
export const WorkerDefinitionRecordSchema = WorkerDefinitionSchema.extend({
  source: WorkerDefinitionSourceSchema,
});
export type WorkerDefinitionRecord = z.infer<typeof WorkerDefinitionRecordSchema>;
