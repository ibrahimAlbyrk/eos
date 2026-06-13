// Peer scope + discovery for collaborate-enabled workers. Two workers are
// peers iff they are siblings (same non-null parent) and both opted into
// collaboration. Like assertOwnedBy, the asker's id is declared by the caller,
// not authenticated — this scopes which siblings a worker may consult; it is
// confused-deputy protection, not an auth boundary.

import { NotFoundError, PermissionDeniedError } from "../errors/index.ts";
import type { WorkerRepo } from "../ports/WorkerRepo.ts";
import type { WorkerRow } from "../../../contracts/src/worker.ts";

// A peer is reachable for consultation only while its process is alive. ENDING
// (shutting down) and DONE/SUSPENDED (dead) drop out — a request to them would
// never be answered.
const CONSULTABLE_STATES = new Set(["SPAWNING", "WORKING", "IDLE"]);

export function isConsultable(w: Pick<WorkerRow, "state">): boolean {
  return CONSULTABLE_STATES.has(w.state);
}

function arePeers(asker: WorkerRow, target: WorkerRow): boolean {
  const parent = asker.parent_id ?? null;
  return (
    parent !== null &&
    parent === (target.parent_id ?? null) &&
    !!asker.collaborate &&
    !!target.collaborate
  );
}

// Throws unless askerId may consult targetId. Used by the peer-request route to
// reject cross-orchestrator or non-collaborating traffic before registering.
export function assertPeers(
  workers: Pick<WorkerRepo, "findById">,
  askerId: string,
  targetId: string,
): void {
  if (askerId === targetId) throw new PermissionDeniedError("a worker cannot consult itself");
  const asker = workers.findById(askerId);
  if (!asker) throw new NotFoundError("worker", askerId);
  const target = workers.findById(targetId);
  if (!target) throw new NotFoundError("worker", targetId);
  if (!arePeers(asker, target)) {
    throw new PermissionDeniedError(`worker ${targetId} is not a collaboration peer of ${askerId}`);
  }
}

// The collaborate-enabled, still-alive siblings selfId may consult. Powers the
// list_peers tool; empty when the worker has no parent or isn't collaborating.
export function listPeersOf(
  workers: Pick<WorkerRepo, "findById" | "listByParent">,
  selfId: string,
): WorkerRow[] {
  const self = workers.findById(selfId);
  if (!self || !self.collaborate || self.parent_id == null) return [];
  return workers
    .listByParent(self.parent_id)
    .filter((w) => w.id !== selfId && !!w.collaborate && isConsultable(w));
}
