// In-process lane tool-surface assembly — the merge point where control tools
// (prefixed mcp__…), the bare-named built-ins, and the Task subagent item come
// together. Extracted from the container so the merge + filtering logic is
// unit-testable without standing up the full daemon.
//
// Built-ins use BARE canonical names + canonical input fields, so the policy stack
// (classifyTool / permission-mode / worker-definition allow-deny / editRegex) gates
// them unchanged. The worker-definition allow/deny pre-filter here only avoids
// OFFERING a denied tool; the gate remains the real enforcement.

import { matchesAny } from "../../core/src/domain/tool-glob.ts";
import { disallowedBuiltinToolsFor } from "../../contracts/src/tool-scope.ts";
import { bindBuiltinTool, type BuiltinToolRegistry, type BuiltinToolContext } from "../../core/src/ports/BuiltinToolRegistry.ts";
import type { RuntimeTool } from "../../core/src/use-cases/ToolRuntime.ts";
import type { ToolScope } from "../../contracts/src/worker-definition.ts";

export interface LaneToolItem {
  name: string;
  description: string;
  schema: Record<string, unknown>;
}

export interface LaneTooling {
  items: LaneToolItem[];
  tools: Map<string, RuntimeTool>;
}

export interface LaneSurfaceSpec {
  cwd: string;
  isOrchestrator: boolean;
  scope?: ToolScope;
}

// The Task subagent's model-facing schema item. Task itself is a per-session closure
// (its executor needs resolved creds + the session emit/signal), bound in the env
// factory; only this static item lives on the surface.
export const TASK_TOOL_ITEM: LaneToolItem = {
  name: "Task",
  description: "Launch a subagent (e.g. general-purpose) to handle a multi-step task autonomously and return its final report. Use for focused, self-contained sub-investigations.",
  schema: {
    type: "object",
    properties: {
      description: { type: "string", description: "A short (3-5 word) description of the task." },
      prompt: { type: "string", description: "The full task for the subagent to perform." },
      subagent_type: { type: "string", description: "The subagent definition to run (e.g. general-purpose)." },
    },
    required: ["description", "prompt", "subagent_type"],
  },
};

// A plain-name deny strips the whole tool; a command-scoped deny ("Bash(rm:*)")
// does not (left to the gate). A command-scoped allow ("Bash(git:*)") still offers
// the tool name, so allow is matched on the pattern's NAME part only.
export function surfaceAllowsBuiltin(name: string, scope: ToolScope | undefined): boolean {
  if (!scope) return true;
  if (matchesAny(name, scope.deny)) return false;
  if (scope.allow.length === 0) return true;
  return scope.allow.some((p) => matchesAny(name, [p.includes("(") ? p.slice(0, p.indexOf("(")) : p]));
}

// The built-in-only surface (NO control tools): cwd-scoped, filtered by the
// platform/orchestrator disallow list AND the worker-definition allow/deny globs.
// Used directly for the Task child surface and merged into the lane surface.
export function buildBuiltinSurface(registry: BuiltinToolRegistry, spec: LaneSurfaceSpec): LaneTooling {
  const ctx: BuiltinToolContext = { cwd: spec.cwd };
  const disallowed = new Set<string>(disallowedBuiltinToolsFor(spec.isOrchestrator));
  const items: LaneToolItem[] = [];
  const tools = new Map<string, RuntimeTool>();
  for (const t of registry.list()) {
    if (disallowed.has(t.name)) continue;
    if (!surfaceAllowsBuiltin(t.name, spec.scope)) continue;
    items.push({ name: t.name, description: t.description, schema: t.schema });
    tools.set(t.name, bindBuiltinTool(t, ctx));
  }
  return { items, tools };
}

// The full lane surface: control tools ⊕ built-ins ⊕ (non-orchestrators) the Task
// item. The Task EXECUTOR is bound separately in the env factory (after creds).
export function buildLaneSurface(registry: BuiltinToolRegistry, control: LaneTooling, spec: LaneSurfaceSpec): LaneTooling {
  const builtin = buildBuiltinSurface(registry, spec);
  const items: LaneToolItem[] = [...control.items, ...builtin.items];
  const tools = new Map<string, RuntimeTool>([...control.tools, ...builtin.tools]);
  if (!spec.isOrchestrator) items.push(TASK_TOOL_ITEM);
  return { items, tools };
}
