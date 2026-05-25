import type { NotificationTrigger } from "../NotificationService.ts";

export const agentFinishedTrigger: NotificationTrigger = {
  id: "agent_finished",
  topic: "worker:change",
  shouldFire(msg, workers) {
    const { workerId, from, state } = msg.payload as any;
    if (from !== "WORKING") return null;
    if (state !== "IDLE" && state !== "DONE") return null;
    const w = workers.findById(workerId);
    return {
      id: `${Date.now()}`,
      trigger: "agent_finished",
      title: "Agent Finished",
      body: w?.name ?? workerId,
      workerId,
      ts: Date.now(),
    };
  },
};
