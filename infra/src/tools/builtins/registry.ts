// The in-process BuiltinToolRegistry — the Open/Closed assembly point for the
// bare-named built-in tools. Adding a tool is one line here (+ its file); the merge
// point (buildLaneTooling) and the loop never change. Task is NOT here: it is a
// closure over the env-factory's resolved creds + dialect builder (§5e), built per
// session in manager, not a static registry entry.
//
// Deps are the DIP seams (ToolFileSystem / ProcessRunner) so a test can hand a fake
// registry real-but-temp adapters or pure fakes.

import type { BuiltinTool, BuiltinToolRegistry } from "../../../../core/src/ports/BuiltinToolRegistry.ts";
import type { ToolFileSystem } from "../../../../core/src/ports/ToolFileSystem.ts";
import type { ProcessRunner } from "../../../../core/src/ports/ProcessRunner.ts";

import { createReadTool } from "./read.ts";
import { createWriteTool } from "./write.ts";
import { createEditTool } from "./edit.ts";
import { createMultiEditTool } from "./multi-edit.ts";
import { createNotebookEditTool } from "./notebook-edit.ts";
import { createBashTool } from "./bash.ts";
import { createBashOutputTool } from "./bash-output.ts";
import { createKillShellTool } from "./kill-shell.ts";
import { createGlobTool } from "./glob.ts";
import { createGrepTool } from "./grep.ts";
import { createLsTool } from "./ls.ts";
import { createWebFetchTool } from "./web-fetch.ts";
import { createWebSearchTool } from "./web-search.ts";
import { createTodoWriteTool } from "./todo-write.ts";
import { createExitPlanModeTool } from "./exit-plan-mode.ts";

export interface BuiltinToolDeps {
  fs: ToolFileSystem;
  proc: ProcessRunner;
}

export function createBuiltinToolRegistry(deps: BuiltinToolDeps): BuiltinToolRegistry {
  const tools: BuiltinTool[] = [
    createReadTool(deps.fs),
    createWriteTool(deps.fs),
    createEditTool(deps.fs),
    createMultiEditTool(deps.fs),
    createNotebookEditTool(deps.fs),
    createBashTool(deps.proc),
    createBashOutputTool(deps.proc),
    createKillShellTool(deps.proc),
    createGlobTool(deps.fs),
    createGrepTool(deps.proc),
    createLsTool(deps.fs),
    createWebFetchTool(),
    createWebSearchTool(),
    createTodoWriteTool(),
    createExitPlanModeTool(),
  ];
  const byName = new Map(tools.map((t) => [t.name, t]));
  return {
    list: () => tools.slice(),
    get: (name) => byName.get(name),
  };
}
