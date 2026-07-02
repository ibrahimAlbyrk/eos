// ArchiveWorker — reversible Cmd+W: stops each process in the subtree and
// stamps `archived_at`, keeping rows/events/worktree/branch for restore. The
// invariant it enforces: archived ⇒ state ∈ {DONE, SUSPENDED}. Deliberately
// never enqueues worktree removal and never publishes `worker:removed` —
// runtime definitions owned by an archived orchestrator must survive.

import type { WorkerRepo } from "../ports/WorkerRepo.ts";
import type { PendingRepo } from "../ports/PendingRepo.ts";
import type { EventBus } from "../ports/EventBus.ts";
import type { Clock } from "../ports/Clock.ts";
import { NotFoundError, ConflictError } from "../errors/index.ts";
import { stopWorkerProcess, type StopWorkerProcessDeps } from "./worker-teardown.ts";

// Archived rows sit at rest underneath the flag; anything else settles to DONE.
const AT_REST = new Set(["DONE", "SUSPENDED"]);

export interface ArchiveWorkerDeps extends StopWorkerProcessDeps {
  workers: Pick<
    WorkerRepo,
    "findById" | "findChildrenIds" | "setArchived" | "clearRuntime" | "markDone"
  >;
  // pending_permissions address a dead turn — deleted. queued_messages are
  // deliberately NOT a dep: undelivered user text survives archive and
  // delivers after restore+resume.
  pending: Pick<PendingRepo, "deleteByWorker">;
  bus: EventBus;
  clock: Clock;
}

export interface ArchiveWorkerResult {
  id: string;
  // Subtree ids stamped, depth-first order (children before their parent).
  archived: string[];
  wasState: string;
}

export function archiveWorker(deps: ArchiveWorkerDeps, id: string): ArchiveWorkerResult {
  const w = deps.workers.findById(id);
  if (!w) throw new NotFoundError("worker", id);
  if (w.archived_at != null) throw new ConflictError(`worker ${id} is already archived`);

  // Captured before the recursion settles the row to DONE.
  const wasState = w.state;
  const archived: string[] = [];
  archiveOne(deps, id, archived);
  return { id, archived, wasState };
}

function archiveOne(deps: ArchiveWorkerDeps, id: string, archived: string[]): void {
  const w = deps.workers.findById(id);
  if (!w) return; // child may already be gone

  // Depth-first, mirroring the kill recursion.
  for (const childId of deps.workers.findChildrenIds(id)) archiveOne(deps, childId, archived);

  // Stamp BEFORE stopping: everything here is synchronous, so the backend's
  // async onExit (which calls markDone — benign, DONE is the target state) can
  // only ever observe an already-archived row. No archived-but-busy window.
  deps.workers.setArchived(id, deps.clock.now());
  stopWorkerProcess(deps, w);
  deps.workers.clearRuntime(id);
  if (!AT_REST.has(w.state)) deps.workers.markDone(id, deps.clock.now(), null);
  deps.pending.deleteByWorker(id);
  archived.push(id);
  deps.bus.publish("worker:change", { workerId: id, reason: "archived" });
}
