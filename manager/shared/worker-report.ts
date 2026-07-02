// The worker_report envelope a parent reads. The worker's report BODY stays
// clean payload — the sender identity (name/id) and the branch/worktree merge
// handle ride as tag ATTRIBUTES, rendered into the <agent_message>/<system_message>
// wrapper at the dispatch chokepoint (never baked into the body). Shared by the
// report route (direct delivery) and the loop-release path (held-then-released)
// so a held report is byte-identical to a direct one. `provenance` distinguishes
// the worker's own report ("agent") from a message the daemon synthesized on its
// behalf ("system" — a loop that just stopped).

import type { WorkerRow } from "../../contracts/src/worker.ts";
import type { DispatchEnvelope } from "../../core/src/domain/message-envelope.ts";

export function workerReportEnvelope(
  worker: WorkerRow,
  provenance: "agent" | "system",
): Extract<DispatchEnvelope, { kind: "worker_report" }> {
  return {
    kind: "worker_report",
    provenance,
    fromWorker: worker.id,
    workerName: worker.name ?? worker.id,
    ...(worker.branch ? { branch: worker.branch } : {}),
    ...(worker.worktree_dir ? { worktreeDir: worker.worktree_dir } : {}),
  };
}
