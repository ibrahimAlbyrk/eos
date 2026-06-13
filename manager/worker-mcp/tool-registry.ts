import type { WorkerSession } from "./SessionContext.ts";
import { safeText, type McpToolModule as McpToolModuleBase } from "../shared/mcp-tool.ts";

import { sendMessageToParentTool } from "./tools/send_message_to_parent.ts";
import { listPeersTool } from "./tools/list_peers.ts";
import { askPeerTool } from "./tools/ask_peer.ts";
import { respondToPeerTool } from "./tools/respond_to_peer.ts";

export { safeText };
export type McpToolModule = McpToolModuleBase<WorkerSession>;

export const toolModules: McpToolModuleBase<WorkerSession>[] = [
  sendMessageToParentTool,
];

// Registered only when the worker was spawned with collaborate=true (the
// worker-mcp entrypoint composes them in). Absent from the model's tool list
// otherwise — no peer surface, no peer prompt.
export const peerToolModules: McpToolModuleBase<WorkerSession>[] = [
  listPeersTool,
  askPeerTool,
  respondToPeerTool,
];
