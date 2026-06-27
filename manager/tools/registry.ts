import type { ToolDefinition } from "./types.ts";
import { spawnWorkerDef } from "./defs/spawn_worker.ts";
import { listActiveWorkersDef } from "./defs/list_active_workers.ts";
import { getWorkerDef } from "./defs/get_worker.ts";
import { killWorkerDef } from "./defs/kill_worker.ts";
import { messageWorkerDef } from "./defs/message_worker.ts";
import { listPendingPermissionsDef } from "./defs/list_pending_permissions.ts";
import { notifyUserDef } from "./defs/notify_user.ts";
import { askUserDef } from "./defs/ask_user.ts";
import { sendMessageToParentDef } from "./defs/send_message_to_parent.ts";
import { listPeersDef } from "./defs/list_peers.ts";
import { askPeerDef } from "./defs/ask_peer.ts";
import { respondToPeerDef } from "./defs/respond_to_peer.ts";
import { listAvailableWorkersDef } from "./defs/list_available_workers.ts";
import { createWorkerDef } from "./defs/create_worker.ts";
import { integrateWorkersDef } from "./defs/integrate_workers.ts";
import { dynamicLoopDef } from "./defs/dynamic_loop.ts";
import { currentDatetimeDef } from "./defs/current_datetime.ts";
import { workflowDef } from "./defs/workflow.ts";
import { workflowStepOutputDef } from "./defs/workflow_step_output.ts";

// Order matches the legacy tool-registry arrays exactly — registration order is
// part of the byte-identical contract (see tools/__tests__/registration.test.ts).
export const orchestratorDefs: ToolDefinition[] = [
  spawnWorkerDef,
  listActiveWorkersDef,
  getWorkerDef,
  killWorkerDef,
  messageWorkerDef,
  listPendingPermissionsDef,
  notifyUserDef,
  askUserDef,
  listAvailableWorkersDef,
  createWorkerDef,
  integrateWorkersDef,
  dynamicLoopDef,
  currentDatetimeDef,
  workflowDef,
];

// Always registered on a worker.
export const workerDefs: ToolDefinition[] = [sendMessageToParentDef, currentDatetimeDef];

// Registered only when the worker was spawned with collaborate=true (the
// worker-mcp entrypoint composes them in).
export const peerDefs: ToolDefinition[] = [listPeersDef, askPeerDef, respondToPeerDef];

// The ONLY tools a workflow-worker node sees (Part B / D1+D4): its typed output
// emitter + the clock. No send_message_to_parent (it never reports to a parent),
// no peers, no sub-spawn — a deterministic graph node, nothing else.
export const workflowWorkerDefs: ToolDefinition[] = [workflowStepOutputDef, currentDatetimeDef];
