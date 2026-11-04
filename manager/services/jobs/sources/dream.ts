// Dreaming over past chats (dream:change); a skipped dream leaves nothing.

import type { BackgroundJobStatus } from "../../../../contracts/src/background-job.ts";
import type { DreamChangeEvent, DreamStatus } from "../../../../contracts/src/dream.ts";
import type { JobHandle, JobRegistry } from "../JobRegistry.ts";

export function dreamJobs(jobs: JobRegistry, deps: { stop(): boolean }) {
  let current: JobHandle | null = null;
  let seq = 0;
  return {
    onDream(change: DreamChangeEvent, status: DreamStatus): void {
      const progress = status.progress;
      if (status.running) {
        if (!current || current.job.status !== "running") {
          current = jobs.start({
            kind: "dream", workerId: null, ref: `run-${++seq}`, title: "Dreaming",
            stop: () => (deps.stop() ? { ok: true } : { ok: false, status: 409, error: "no dream to stop" }),
          });
        }
        const total = progress?.total ?? 0;
        current.update({
          title: total ? `Dreaming over ${total} chat${total === 1 ? "" : "s"}` : "Dreaming",
          detail: progress ? `Read ${progress.done} of ${progress.total}` : null,
          progress: progress && progress.total ? { done: progress.done, total: progress.total } : null,
        });
        return;
      }
      const h = current;
      current = null;
      if (!h) return;
      if (change.status === "skipped") { h.drop(); return; }
      const end: BackgroundJobStatus = change.status === "failed" ? "failed" : change.status === "stopped" ? "stopped" : "completed";
      h.finish(end, { progress: null });
    },
  };
}
