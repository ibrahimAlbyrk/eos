// RestoreWorker — inverts ArchiveWorker and nothing else: clears `archived_at`
// over the subtree so the rows re-enter the live list at rest
// (DONE/SUSPENDED). Process revival stays ResumeWorker's job. By construction
// there is no process/fs/worktree dependency here — restore succeeds even when
// the workspace was reaped (the first resume then fails cleanly).

import type { WorkerRepo } from "../ports/WorkerRepo.ts";
import type { EventBus } from "../ports/EventBus.ts";
import { NotFoundError, ConflictError } from "../errors/index.ts";

export interface RestoreWorkerDeps {
  workers: Pick<WorkerRepo, "findById" | "findChildrenIds" | "setArchived">;
  bus: EventBus;
}

export interface RestoreWorkerResult {
  id: string;
  restored: string[];
}

export function restoreWorker(deps: RestoreWorkerDeps, id: string): RestoreWorkerResult {
  const w = deps.workers.findById(id);
  if (!w) throw new NotFoundError("worker", id);
  if (w.archived_at == null) throw new ConflictError(`worker ${id} is not archived`);

  // Restoring under a still-archived ancestor would re-create a live row whose
  // parent is hidden (ADR-7's dangling-parent problem in reverse).
  for (let p = w.parent_id ?? null; p != null; ) {
    const parent = deps.workers.findById(p);
    if (!parent) break;
    if (parent.archived_at != null) {
      throw new ConflictError(
        `worker ${id} is inside an archived subtree — restore the topmost archived ancestor instead`,
      );
    }
    p = parent.parent_id ?? null;
  }

  const restored: string[] = [];
  restoreOne(deps, id, restored);
  return { id, restored };
}

function restoreOne(deps: RestoreWorkerDeps, id: string, restored: string[]): void {
  if (!deps.workers.findById(id)) return; // child may already be gone

  // Depth-first, mirroring the archive recursion.
  for (const childId of deps.workers.findChildrenIds(id)) restoreOne(deps, childId, restored);

  deps.workers.setArchived(id, null);
  restored.push(id);
  deps.bus.publish("worker:change", { workerId: id, reason: "restored" });
}
