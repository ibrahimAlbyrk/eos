// BuiltinToolRegistry — the Open/Closed assembler of the bare-named built-in tool
// surface (Read/Write/Edit/Bash/Glob/Grep/…). Mirrors the AgentBackendRegistry /
// slash-command registry shape: adding a tool is one entry, with no edit to the
// merge point (buildLaneTooling) or the loop (ToolRuntime). The Node infra registry
// constructs each tool with its FileSystem/ProcessRunner deps; the cwd is the only
// per-spawn variable, so it is passed per-call via BuiltinToolContext rather than
// rebuilding the registry per worker.

import type { RuntimeTool } from "../use-cases/ToolRuntime.ts";

// Per-call context. Only the cwd varies per spawn (tool deps are bound at registry
// construction); signal lets the Task-subagent path share the parent's abort flag.
export interface BuiltinToolContext {
  cwd: string;
  signal?: { aborted: boolean };
  /** The session/worker id, tagged onto a background shell (Bash run_in_background)
   *  so it is reaped when the session stops (MJ2). Absent in tests / contexts with
   *  no owning session. */
  owner?: string;
}

export interface BuiltinTool {
  name: string;
  // Provider-neutral JSON schema for the model-facing input (the lane item schema).
  // The model-facing DESCRIPTION is NOT here: it is overlaid at the manager layer
  // from the prompt library (manager/prompts/tool/<Name>), so this layer never
  // imports prompt text and keeps only the bare canonical name + schema + behavior.
  schema: Record<string, unknown>;
  execute(input: Record<string, unknown>, ctx: BuiltinToolContext): Promise<string>;
}

export interface BuiltinToolRegistry {
  list(): BuiltinTool[];
  get(name: string): BuiltinTool | undefined;
}

// Bind a registry tool to a cwd-scoped context, yielding the bare RuntimeTool the
// loop dispatches. (Shared by buildLaneTooling and the Task child surface.)
export function bindBuiltinTool(tool: BuiltinTool, ctx: BuiltinToolContext): RuntimeTool {
  return { name: tool.name, execute: (input) => tool.execute(input, ctx) };
}
