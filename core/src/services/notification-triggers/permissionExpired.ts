import type { NotificationTrigger } from "../NotificationService.ts";

export const permissionExpiredTrigger: NotificationTrigger = {
  id: "permission_expired",
  topic: "pending:ttl_expired",
  shouldFire(msg, workers, clock) {
    const { id, workerId } = msg.payload as { id?: string; workerId?: string };
    const w = workerId ? workers.findById(workerId) : null;
    const now = clock.now();
    return {
      id: id ?? `${now}`,
      trigger: "permission_expired",
      title: "Permission Expired",
      body: w?.name ?? workerId ?? "Agent",
      workerId: workerId ?? null,
      ts: now,
    };
  },
};
