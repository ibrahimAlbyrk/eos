// MCP tool registry — every tool implements McpToolModule and is registered
// here. Adding a new tool is one new file + one line in toolModules.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { OrchestratorSession } from "./SessionContext.ts";

import { spawnWorkerTool } from "./tools/spawn_worker.ts";
import { listWorkersTool } from "./tools/list_workers.ts";
import { getWorkerTool } from "./tools/get_worker.ts";
import { killWorkerTool } from "./tools/kill_worker.ts";
import { messageWorkerTool } from "./tools/message_worker.ts";
import { listPendingPermissionsTool } from "./tools/list_pending_permissions.ts";

export interface McpToolModule {
  readonly name: string;
  register(server: McpServer, session: OrchestratorSession): void;
}

export const toolModules: McpToolModule[] = [
  spawnWorkerTool,
  listWorkersTool,
  getWorkerTool,
  killWorkerTool,
  messageWorkerTool,
  listPendingPermissionsTool,
];

// Helper for tools — wraps the call in a try/catch and produces the standard
// MCP "text" content shape. Keeps each tool body focused on its logic.
export async function safeText<T>(
  fn: () => Promise<T>,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    const res = await fn();
    return { content: [{ type: "text" as const, text: typeof res === "string" ? res : JSON.stringify(res, null, 2) }] };
  } catch (e) {
    return {
      content: [{ type: "text" as const, text: `error: ${(e as Error).message}` }],
      isError: true,
    };
  }
}
