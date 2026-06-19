import type { ToolDefinition } from "./types.ts";
import { spawnWorkerDef } from "./defs/spawn_worker.ts";
import { listWorkersDef } from "./defs/list_workers.ts";
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
import { listWorkerTypesDef } from "./defs/list_worker_types.ts";
import { mintWorkerTypeDef } from "./defs/mint_worker_type.ts";

// Order matches the legacy tool-registry arrays exactly — registration order is
// part of the byte-identical contract (see tools/__tests__/registration.test.ts).
export const orchestratorDefs: ToolDefinition[] = [
  spawnWorkerDef,
  listWorkersDef,
  getWorkerDef,
  killWorkerDef,
  messageWorkerDef,
  listPendingPermissionsDef,
  notifyUserDef,
  askUserDef,
  listWorkerTypesDef,
  mintWorkerTypeDef,
];

// Always registered on a worker.
export const workerDefs: ToolDefinition[] = [sendMessageToParentDef];

// Registered only when the worker was spawned with collaborate=true (the
// worker-mcp entrypoint composes them in).
export const peerDefs: ToolDefinition[] = [listPeersDef, askPeerDef, respondToPeerDef];
