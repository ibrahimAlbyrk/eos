import type { NotificationTrigger } from "../NotificationService.ts";

export const limitExceededTrigger: NotificationTrigger = {
  id: "limit_exceeded",
  topic: "limit:exceeded",
  shouldFire(msg, workers) {
    const { workerId, kind, value, limit } = msg.payload as any;
    const w = workerId ? workers.findById(workerId) : null;
    const detail = kind === "cost"
      ? `$${Number(value).toFixed(2)} / $${Number(limit).toFixed(2)}`
      : `${Math.round(value / 1000)}s / ${Math.round(limit / 1000)}s`;
    return {
      id: `${Date.now()}`,
      trigger: "limit_exceeded",
      title: "Limit Exceeded",
      body: `${w?.name ?? workerId}: ${detail}`,
      workerId: workerId ?? null,
      ts: Date.now(),
    };
  },
};
