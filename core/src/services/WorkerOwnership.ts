// Caller-scope guard for actor-declared requests (orchestrator MCP traffic).
// The actor id is declared by the caller, not authenticated — this scopes the
// LLM-visible tool surface to the orchestrator's own children (confused-deputy
// protection), it is not an auth boundary. Ownership = direct parent link;
// if a deeper hierarchy ever exists, the subtree semantics change here only.

import { NotFoundError, PermissionDeniedError } from "../errors/index.ts";
import type { WorkerRepo } from "../ports/WorkerRepo.ts";

export function assertOwnedBy(
  workers: Pick<WorkerRepo, "findById">,
  actorId: string,
  targetId: string,
  opts?: { allowSelf?: boolean },
): void {
  if (opts?.allowSelf && targetId === actorId) return;
  const target = workers.findById(targetId);
  if (!target) throw new NotFoundError("worker", targetId);
  if ((target.parent_id ?? null) !== actorId) {
    throw new PermissionDeniedError(`worker ${targetId} is not managed by ${actorId}`);
  }
}
