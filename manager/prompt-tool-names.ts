// Tool-name variables injected into role prompts as static globals. Each value
// reads the tool definition's own `name`, so renaming a tool there updates every
// prompt that interpolates the variable — prompts never hardcode a tool name
// (the {{*_TOOL}} convention mirrors Claude Code's own ${X_TOOL_NAME} pattern).

import type { VariableScope } from "../core/src/domain/prompt.ts";
import { spawnWorkerDef } from "./tools/defs/spawn_worker.ts";
import { listActiveWorkersDef } from "./tools/defs/list_active_workers.ts";
import { getWorkerDef } from "./tools/defs/get_worker.ts";
import { killWorkerDef } from "./tools/defs/kill_worker.ts";
import { messageWorkerDef } from "./tools/defs/message_worker.ts";
import { listPendingPermissionsDef } from "./tools/defs/list_pending_permissions.ts";
import { notifyUserDef } from "./tools/defs/notify_user.ts";
import { askUserDef } from "./tools/defs/ask_user.ts";
import { sendMessageToParentDef } from "./tools/defs/send_message_to_parent.ts";
import { listPeersDef } from "./tools/defs/list_peers.ts";
import { askPeerDef } from "./tools/defs/ask_peer.ts";
import { respondToPeerDef } from "./tools/defs/respond_to_peer.ts";
import { listAvailableWorkersDef } from "./tools/defs/list_available_workers.ts";
import { createWorkerDef } from "./tools/defs/create_worker.ts";
import { integrateWorkersDef } from "./tools/defs/integrate_workers.ts";

export const TOOL_NAME_VARS: VariableScope = {
  SPAWN_WORKER_TOOL: spawnWorkerDef.name,
  LIST_ACTIVE_WORKERS_TOOL: listActiveWorkersDef.name,
  GET_WORKER_TOOL: getWorkerDef.name,
  KILL_WORKER_TOOL: killWorkerDef.name,
  MESSAGE_WORKER_TOOL: messageWorkerDef.name,
  LIST_PENDING_PERMISSIONS_TOOL: listPendingPermissionsDef.name,
  NOTIFY_USER_TOOL: notifyUserDef.name,
  ASK_USER_TOOL: askUserDef.name,
  SEND_MESSAGE_TO_PARENT_TOOL: sendMessageToParentDef.name,
  LIST_PEERS_TOOL: listPeersDef.name,
  ASK_PEER_TOOL: askPeerDef.name,
  RESPOND_TO_PEER_TOOL: respondToPeerDef.name,
  LIST_AVAILABLE_WORKERS_TOOL: listAvailableWorkersDef.name,
  CREATE_WORKER_TOOL: createWorkerDef.name,
  INTEGRATE_WORKERS_TOOL: integrateWorkersDef.name,
};
