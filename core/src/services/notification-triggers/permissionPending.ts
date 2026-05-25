import type { NotificationTrigger } from "../NotificationService.ts";

export const permissionPendingTrigger: NotificationTrigger = {
  id: "permission_pending",
  topic: "pending:created",
  shouldFire(msg, workers) {
    const { id, tool, workerId } = msg.payload as any;
    const w = workerId ? workers.findById(workerId) : null;
    return {
      id: id ?? `${Date.now()}`,
      trigger: "permission_pending",
      title: "Permission Required",
      body: `${w?.name ?? workerId ?? "Agent"}: ${tool}`,
      workerId: workerId ?? null,
      ts: Date.now(),
    };
  },
};
