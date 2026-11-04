// An agent's own background work: shells, Monitors and Workflow runs. Stopped
// through the session that runs them.

import type { AgentEvent } from "../../../../contracts/src/canonical.ts";
import type { WorkflowRunProgress } from "../../../../contracts/src/workflow-run.ts";
import { firstLine, workflowProgressOf } from "../../../../core/src/domain/background-jobs.ts";
import type { BackgroundTaskUpdate } from "../../../backends/sdk/SdkEventMapper.ts";
import type { JobHandle, JobRegistry, JobSpec } from "../JobRegistry.ts";

export interface StopCapable {
  isAlive(): boolean;
  stopTask?(taskId: string): Promise<{ ok: boolean; reason?: string }>;
}

export function agentTaskJobs(jobs: JobRegistry, deps: { session(workerId: string): StopCapable | null }) {
  // `${workerId}\0${taskId}` → the job, for updates that name only the task.
  const byTask = new Map<string, JobHandle>();
  const events = new Map<string, number>();

  const stopVia = (workerId: string, taskId: string): Pick<JobSpec, "stop" | "canStop"> => ({
    canStop: () => {
      const s = deps.session(workerId);
      return s?.stopTask !== undefined && s.isAlive();
    },
    stop: async () => {
      const s = deps.session(workerId);
      if (!s?.stopTask || !s.isAlive()) return { ok: false, status: 409, error: "this session can't stop that job" };
      const r = await s.stopTask(taskId);
      return r.ok ? { ok: true } : { ok: false, status: 409, error: r.reason ?? "stop failed" };
    },
  });

  const open = (spec: JobSpec, workerId: string, taskId: string): JobHandle => {
    const h = jobs.start(spec);
    byTask.set(`${workerId}\0${taskId}`, h);
    return h;
  };

  return {
    onBackgroundTask(workerId: string, u: BackgroundTaskUpdate): void {
      if (u.phase === "started") {
        const h = open({
          kind: u.kind, workerId, ref: u.taskId, title: u.title, command: u.command, callId: u.callId,
          memoryOutput: u.kind === "monitor", ...stopVia(workerId, u.taskId),
        }, workerId, u.taskId);
        h.setOutputFile(u.outputFile);
        events.set(h.id, 0);
        h.update({}, true);
        return;
      }
      const h = byTask.get(`${workerId}\0${u.taskId}`);
      if (!h) return;
      if (u.phase === "output") {
        h.setOutputFile(u.outputFile);
        h.update({}, true);
      } else if (u.phase === "event") {
        const n = (events.get(h.id) ?? 0) + 1;
        events.set(h.id, n);
        h.appendOutput(`${u.text}\n`);
        const last = firstLine(u.text);
        h.update({ detail: `${n} event${n === 1 ? "" : "s"}${last ? ` · ${last}` : ""}` });
      } else {
        if (u.outputFile) h.setOutputFile(u.outputFile);
        // A shell can report "completed" for a command that exited non-zero.
        const status = u.status === "completed" && u.exitCode !== null && u.exitCode !== 0 ? "failed" : u.status;
        h.finish(status, { detail: firstLine(u.summary) ?? h.job.detail, exitCode: u.exitCode });
      }
    },

    // A worker's agent events: Workflow runs start and end here.
    observe(workerId: string, event: AgentEvent): void {
      if (event.type === "workflow_started") {
        open({
          kind: "workflow", workerId, ref: event.callId, title: event.name ?? event.description ?? "Workflow",
          callId: event.callId, ...stopVia(workerId, event.taskId),
        }, workerId, event.taskId).update({}, true);
      } else if (event.type === "workflow_completed") {
        const h = jobs.get("workflow", workerId, event.callId);
        if (!h) return;
        const fromSnapshot = event.snapshot ? workflowProgressOf(event.snapshot).detail : null;
        h.finish(event.status, { detail: firstLine(event.summary) ?? fromSnapshot ?? h.job.detail });
      }
    },

    onWorkflowProgress(p: WorkflowRunProgress): void {
      const h = jobs.get("workflow", p.workerId, p.callId);
      if (h?.job.status === "running") h.update(workflowProgressOf(p.snapshot));
    },
  };
}
