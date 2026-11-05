// An agent's context being compacted — shown only while it runs.

import type { JobRegistry } from "../../services/jobs/JobRegistry.ts";

export function compactionJobs(jobs: JobRegistry) {
  return {
    onCompaction(workerId: string, running: boolean): void {
      if (!running) { jobs.get("compaction", workerId, "context")?.drop(); return; }
      jobs.start({ kind: "compaction", workerId, ref: "context", title: "Compacting context", ambient: true }).update({}, true);
    },
  };
}
