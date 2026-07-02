// PurgeWorker — the destructive half of the archive split: the exact kill
// cascade (worktree-removal intent, row deletes, adopted leak cleanups,
// `worker:removed`) gated on the row being archived, so the Archive view's
// delete button can never hit a live worker. No process concerns — archive
// already stopped everything (archived ⇒ DONE/SUSPENDED).

import type { WorkerRepo } from "../ports/WorkerRepo.ts";
import type { EventBus } from "../ports/EventBus.ts";
import { NotFoundError, ConflictError } from "../errors/index.ts";
import { cascadeWorkerRemoval, type CascadeWorkerRemovalDeps } from "./worker-teardown.ts";

export interface PurgeWorkerDeps extends CascadeWorkerRemovalDeps {
  workers: Pick<WorkerRepo, "findById" | "findChildrenIds" | "delete">;
  bus: EventBus;
}

export interface PurgeWorkerResult {
  id: string;
  removed: true;
  name: string | null;
}

export function purgeWorker(deps: PurgeWorkerDeps, id: string): PurgeWorkerResult {
  const w = deps.workers.findById(id);
  if (!w) throw new NotFoundError("worker", id);
  if (w.archived_at == null) {
    throw new ConflictError(`worker ${id} is not archived — only archived workers can be purged`);
  }

  purgeOne(deps, id);
  return { id, removed: true, name: w.name ?? null };
}

function purgeOne(deps: PurgeWorkerDeps, id: string): void {
  const w = deps.workers.findById(id);
  if (!w) return; // child may already be gone

  // Depth-first, mirroring the kill recursion.
  for (const childId of deps.workers.findChildrenIds(id)) purgeOne(deps, childId);

  cascadeWorkerRemoval(deps, w);
}
