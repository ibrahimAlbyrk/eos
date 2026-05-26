import type { NotificationTrigger } from "../NotificationService.ts";

export const agentExitedTrigger: NotificationTrigger = {
  id: "agent_exited",
  topic: "worker:exit",
  shouldFire(msg, workers, clock) {
    const { workerId, code } = msg.payload as { workerId: string; code: number };
    const isSuccess = code === 0 || code === 129;
    const w = workers.findById(workerId);
    const now = clock.now();
    return {
      id: `${now}`,
      trigger: "agent_exited",
      title: isSuccess ? "Agent Exited" : "Agent Failed",
      body: w?.name ?? workerId,
      workerId,
      ts: now,
    };
  },
};
