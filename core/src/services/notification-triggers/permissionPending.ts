import type { NotificationTrigger } from "../NotificationService.ts";

export const permissionPendingTrigger: NotificationTrigger = {
  id: "permission_pending",
  topic: "pending:created",
  shouldFire(msg, workers, clock) {
    const { id, tool, workerId } = msg.payload as { id?: string; tool: string; workerId?: string };
    const w = workerId ? workers.findById(workerId) : null;
    const now = clock.now();
    return {
      id: id ?? `${now}`,
      trigger: "permission_pending",
      title: "Permission Required",
      body: `${w?.name ?? workerId ?? "Agent"}: ${tool}`,
      workerId: workerId ?? null,
      ts: now,
    };
  },
};
