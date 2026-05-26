import type { NotificationTrigger } from "../NotificationService.ts";

export const agentFinishedTrigger: NotificationTrigger = {
  id: "agent_finished",
  topic: "worker:change",
  shouldFire(msg, workers, clock) {
    const { workerId, from, state } = msg.payload as { workerId: string; from: string; state: string };
    if (from !== "WORKING") return null;
    if (state !== "IDLE" && state !== "DONE") return null;
    const w = workers.findById(workerId);
    const now = clock.now();
    return {
      id: `${now}`,
      trigger: "agent_finished",
      title: "Agent Finished",
      body: w?.name ?? workerId,
      workerId,
      ts: now,
    };
  },
};
