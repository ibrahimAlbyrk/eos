// Tool-name variables injected into role prompts as static globals. Each value
// reads the tool module's own `name`, so renaming a tool there updates every
// prompt that interpolates the variable — prompts never hardcode a tool name
// (the {{*_TOOL}} convention mirrors Claude Code's own ${X_TOOL_NAME} pattern).

import type { VariableScope } from "../core/src/domain/prompt.ts";
import { spawnWorkerTool } from "./orchestrator-mcp/tools/spawn_worker.ts";
import { listWorkersTool } from "./orchestrator-mcp/tools/list_workers.ts";
import { getWorkerTool } from "./orchestrator-mcp/tools/get_worker.ts";
import { killWorkerTool } from "./orchestrator-mcp/tools/kill_worker.ts";
import { messageWorkerTool } from "./orchestrator-mcp/tools/message_worker.ts";
import { listPendingPermissionsTool } from "./orchestrator-mcp/tools/list_pending_permissions.ts";
import { notifyUserTool } from "./orchestrator-mcp/tools/notify_user.ts";
import { askUserTool } from "./orchestrator-mcp/tools/ask_user.ts";
import { sendMessageToParentTool } from "./worker-mcp/tools/send_message_to_parent.ts";

export const TOOL_NAME_VARS: VariableScope = {
  SPAWN_WORKER_TOOL: spawnWorkerTool.name,
  LIST_WORKERS_TOOL: listWorkersTool.name,
  GET_WORKER_TOOL: getWorkerTool.name,
  KILL_WORKER_TOOL: killWorkerTool.name,
  MESSAGE_WORKER_TOOL: messageWorkerTool.name,
  LIST_PENDING_PERMISSIONS_TOOL: listPendingPermissionsTool.name,
  NOTIFY_USER_TOOL: notifyUserTool.name,
  ASK_USER_TOOL: askUserTool.name,
  SEND_MESSAGE_TO_PARENT_TOOL: sendMessageToParentTool.name,
};
