// `!` commands run from the composer (terminal:start/chunk/done); their output
// is their chunks, and stopping kills the run.

import type { BackgroundJobStatus } from "../../../../contracts/src/background-job.ts";
import { firstLine } from "../../../../core/src/domain/background-jobs.ts";
import type { JobHandle, JobRegistry } from "../JobRegistry.ts";

export function terminalJobs(jobs: JobRegistry, deps: { kill(runId: string): boolean }) {
  const byRun = new Map<string, JobHandle>();
  return {
    onStart(p: { workerId: string | null; runId: string; command: string; startedAt: number }): void {
      const h = jobs.start({
        kind: "shell", workerId: p.workerId, ref: `run-${p.runId}`, title: p.command, command: p.command,
        startedAt: p.startedAt, memoryOutput: true,
        stop: () => (deps.kill(p.runId) ? { ok: true } : { ok: false, status: 409, error: "the command already ended" }),
      });
      byRun.set(p.runId, h);
      h.update({}, true);
    },
    onChunk(p: { runId: string; data: string }): void {
      const h = byRun.get(p.runId);
      if (!h) return;
      h.appendOutput(p.data);
      const last = p.data.split("\n").map((l) => l.trim()).filter(Boolean).pop();
      if (last) h.update({ detail: firstLine(last) });
    },
    onDone(p: { runId: string; exitCode: number; note: string | null }): void {
      const h = byRun.get(p.runId);
      if (!h) return;
      byRun.delete(p.runId);
      const status: BackgroundJobStatus = p.note === "stopped by user" ? "stopped" : p.exitCode === 0 ? "completed" : "failed";
      h.finish(status, { detail: p.note ?? `exit ${p.exitCode}`, exitCode: p.exitCode });
    },
  };
}
