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
import { getWorkerMessagesDef } from "./defs/get_worker_messages.ts";
import { browserNavigateDef } from "./defs/browser_navigate.ts";
import { browserSnapshotDef } from "./defs/browser_snapshot.ts";
import { browserFindDef } from "./defs/browser_find.ts";
import { browserActDef } from "./defs/browser_act.ts";
import { browserTypeDef } from "./defs/browser_type.ts";
import { browserFillFormDef } from "./defs/browser_fill_form.ts";
import { browserPressDef } from "./defs/browser_press.ts";
import { browserScrollDef } from "./defs/browser_scroll.ts";
import { browserWaitDef } from "./defs/browser_wait.ts";
import { browserGetDef } from "./defs/browser_get.ts";
import { browserScreenshotDef } from "./defs/browser_screenshot.ts";
import { browserTabsDef } from "./defs/browser_tabs.ts";
import { browserNewTabDef } from "./defs/browser_new_tab.ts";
import { browserCloseTabDef } from "./defs/browser_close_tab.ts";
import { browserMuteDef } from "./defs/browser_mute.ts";
import { browserShowDef } from "./defs/browser_show.ts";

// Browser verbs (Phase 3) — appended to BOTH the worker and orchestrator
// surfaces, in this order. They stay on the control-plane MCP servers (so the
// subagent-deny guard holds) while remaining fenceable per worker definition:
// isBrowserTool lifts the control-tool scope exemption, and permission-mode
// gates them as browserRead/browserWrite.
const browserDefs: ToolDefinition[] = [
  browserNavigateDef,
  browserSnapshotDef,
  browserFindDef,
  browserActDef,
  browserTypeDef,
  browserFillFormDef,
  browserPressDef,
  browserScrollDef,
  browserWaitDef,
  browserGetDef,
  browserScreenshotDef,
  browserTabsDef,
  browserNewTabDef,
  browserCloseTabDef,
  browserMuteDef,
  browserShowDef,
];

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
  getWorkerMessagesDef,
  ...browserDefs,
];

// Always registered on a worker.
export const workerDefs: ToolDefinition[] = [sendMessageToParentDef, currentDatetimeDef, ...browserDefs];

// Registered only when the worker was spawned with collaborate=true (the
// worker-mcp entrypoint composes them in).
export const peerDefs: ToolDefinition[] = [listPeersDef, askPeerDef, respondToPeerDef];

// A Home session (Claude-web-style single agent) gets NO Eos control tools — only
// the standard built-ins are offered (assembled separately from the tool registry).
export const homeDefs: ToolDefinition[] = [];
