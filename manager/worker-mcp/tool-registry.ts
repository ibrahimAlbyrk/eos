import type { WorkerSession } from "./SessionContext.ts";
import { safeText, type McpToolModule as McpToolModuleBase } from "../shared/mcp-tool.ts";

import { sendMessageToParentTool } from "./tools/send_message_to_parent.ts";

export { safeText };
export type McpToolModule = McpToolModuleBase<WorkerSession>;

export const toolModules: McpToolModuleBase<WorkerSession>[] = [
  sendMessageToParentTool,
];
