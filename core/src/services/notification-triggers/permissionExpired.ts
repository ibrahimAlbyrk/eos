import type { NotificationTrigger } from "../NotificationService.ts";

export const permissionExpiredTrigger: NotificationTrigger = {
  id: "permission_expired",
  topic: "pending:ttl_expired",
  shouldFire(msg, workers) {
    const { id, workerId } = msg.payload as any;
    const w = workerId ? workers.findById(workerId) : null;
    return {
      id: id ?? `${Date.now()}`,
      trigger: "permission_expired",
      title: "Permission Expired",
      body: w?.name ?? workerId ?? "Agent",
      workerId: workerId ?? null,
      ts: Date.now(),
    };
  },
};
