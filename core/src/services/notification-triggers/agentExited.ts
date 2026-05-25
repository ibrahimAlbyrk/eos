import type { NotificationTrigger } from "../NotificationService.ts";

export const agentExitedTrigger: NotificationTrigger = {
  id: "agent_exited",
  topic: "worker:exit",
  shouldFire(msg, workers) {
    const { workerId, code } = msg.payload as any;
    const isSuccess = code === 0 || code === 129;
    const w = workers.findById(workerId);
    return {
      id: `${Date.now()}`,
      trigger: "agent_exited",
      title: isSuccess ? "Agent Exited" : "Agent Failed",
      body: w?.name ?? workerId,
      workerId,
      ts: Date.now(),
    };
  },
};
