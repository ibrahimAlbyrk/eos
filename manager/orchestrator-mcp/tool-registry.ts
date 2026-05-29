// MCP tool registry — every tool implements McpToolModule and is registered
// here. Adding a new tool is one new file + one line in toolModules.

import type { OrchestratorSession } from "./SessionContext.ts";
import { safeText, type McpToolModule as McpToolModuleBase } from "../shared/mcp-tool.ts";

import { spawnWorkerTool } from "./tools/spawn_worker.ts";
import { listWorkersTool } from "./tools/list_workers.ts";
import { getWorkerTool } from "./tools/get_worker.ts";
import { killWorkerTool } from "./tools/kill_worker.ts";
import { messageWorkerTool } from "./tools/message_worker.ts";
import { listPendingPermissionsTool } from "./tools/list_pending_permissions.ts";

export { safeText };
export type McpToolModule = McpToolModuleBase<OrchestratorSession>;

export const toolModules: McpToolModuleBase<OrchestratorSession>[] = [
  spawnWorkerTool,
  listWorkersTool,
  getWorkerTool,
  killWorkerTool,
  messageWorkerTool,
  listPendingPermissionsTool,
];
