// The routing wrapper a parent reads for a worker's report. Shared by the report
// route (direct delivery) and the loop release path (held-then-released), so a
// held report is byte-identical to a direct one. The header carries the branch +
// worktree as a merge handle even when the worker omitted its Handover line.

import type { WorkerRow } from "../../contracts/src/worker.ts";

export function formatWorkerReport(worker: WorkerRow, text: string): string {
  const label = worker.name ?? worker.id;
  const where = worker.branch
    ? worker.worktree_dir
      ? ` (branch ${worker.branch}, worktree ${worker.worktree_dir})`
      : ` (branch ${worker.branch})`
    : "";
  return `[worker ${label} (${worker.id})] reported${where}:\n${text}`;
}
