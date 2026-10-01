// Permission-ask notification. A worker parked on a policy `ask` rule stays
// blocked until the operator decides in the dashboard, so tell the operator:
// publish `notification:fire`, which the desktop app turns into a macOS banner
// while it is in the background. Fires for every asker, top-level workers
// included (the parent nudge in permission-ask-push.ts skips those).

import type { WorkerRow, PendingPermissionRow } from "../../contracts/src/worker.ts";
import { summarizePendingInput } from "./permission-ask-push.ts";

export interface NotificationFire {
  title: string;
  body: string;
  workerId: string;
  ts: number;
}

export interface PermissionAskNotifyDeps {
  findWorker(id: string): WorkerRow | null;
  findPending(id: string): PendingPermissionRow | null;
  fire(notification: NotificationFire): void;
  now(): number;
}

// The bus handler for "pending:created" ({ id, workerId }). A pending row that
// is already gone (resolved between publish and here) is a silent skip.
export function makePermissionAskNotify(
  deps: PermissionAskNotifyDeps,
): (payload: { id?: string; workerId?: string }) => void {
  return (payload) => {
    if (!payload?.id || !payload.workerId) return;
    const row = deps.findPending(payload.id);
    if (!row) return;
    const name = deps.findWorker(payload.workerId)?.name ?? payload.workerId;
    const summary = summarizePendingInput(row.input);
    deps.fire({
      title: "Approval needed",
      body: `${name} wants to run ${row.tool_name}${summary ? `: ${summary}` : ""}`,
      workerId: payload.workerId,
      ts: deps.now(),
    });
  };
}
