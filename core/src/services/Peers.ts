// Peer scope + discovery for collaborate-enabled workers. Two workers are
// peers iff they are siblings (same non-null parent) and both opted into
// collaboration. Like assertOwnedBy, the asker's id is declared by the caller,
// not authenticated — this scopes which siblings a worker may consult; it is
// confused-deputy protection, not an auth boundary.

import { NotFoundError, PermissionDeniedError } from "../errors/index.ts";
import type { WorkerRepo } from "../ports/WorkerRepo.ts";
import type { WorkerRow } from "../../../contracts/src/worker.ts";
import type { PeerRef } from "../../../contracts/src/http.ts";

// A live peer (SPAWNING/WORKING/IDLE) is always reachable. ENDING (shutting
// down) and DONE (gone) never are. SUSPENDED is normally dead too, but a worker
// whose backend revives into a live in-process session on demand (canLazyResume)
// stays reachable: the peer-request route resumes it before delivering, exactly
// as the orchestrator message route already does via resumeIfDead.
const LIVE_STATES = new Set(["SPAWNING", "WORKING", "IDLE"]);

export function isConsultable(w: Pick<WorkerRow, "state">, canLazyResume = false): boolean {
  return LIVE_STATES.has(w.state) || (w.state === "SUSPENDED" && canLazyResume);
}

// Resolves whether a SUSPENDED worker's backend can be lazily revived to a live
// session on demand. Supplied by the manager (which holds the backend registry);
// core has none, so it defaults to "no" — preserving the historical behavior
// that a SUSPENDED peer is not consultable.
export type LazyResumeCheck = (w: WorkerRow) => boolean;

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
  canLazyResume: LazyResumeCheck = () => false,
): WorkerRow[] {
  const self = workers.findById(selfId);
  if (!self || !self.collaborate || self.parent_id == null) return [];
  return workers
    .listByParent(self.parent_id)
    .filter((w) => w.id !== selfId && !!w.collaborate && isConsultable(w, canLazyResume(w)));
}

// Classifies a peer reference (id or name) relative to the asker, WITHOUT
// throwing — the await-on-demand path needs to tell "not here yet" apart from
// "never allowed". Pure: only reads worker rows. Three outcomes:
//   resolved — a live, consultable sibling matches → consult it now
//   absent   — the asker is in a valid mesh but no current sibling matches the
//              ref; a peer that arrives later may match, so the consult can wait
//   denied   — terminal: self-consult, asker not in a mesh, or an ambiguous name
// Subsumes assertPeers's scope on the peer-request path: a `denied` here is the
// same rejection assertPeers raised, just returned instead of thrown.
export type PeerResolution =
  | { kind: "resolved"; target: WorkerRow }
  | { kind: "absent" }
  | { kind: "denied"; reason: string };

export function resolvePeerRef(
  workers: Pick<WorkerRepo, "findById" | "listByParent">,
  askerId: string,
  ref: PeerRef,
  canLazyResume: LazyResumeCheck = () => false,
): PeerResolution {
  const asker = workers.findById(askerId);
  if (!asker || !asker.collaborate || asker.parent_id == null) {
    return { kind: "denied", reason: "you are not in a collaboration group" };
  }
  const siblings = workers
    .listByParent(asker.parent_id)
    .filter((w) => w.id !== askerId && !!w.collaborate);

  if (ref.id != null) {
    if (ref.id === askerId) return { kind: "denied", reason: "a worker cannot consult itself" };
    const target = siblings.find((w) => w.id === ref.id);
    if (!target) return { kind: "absent" };
    if (!isConsultable(target, canLazyResume(target))) {
      return { kind: "denied", reason: `peer ${target.name ?? target.id} is not available to consult right now` };
    }
    return { kind: "resolved", target };
  }

  const name = ref.name as string;
  const matches = siblings.filter((w) => (w.name ?? null) === name && isConsultable(w, canLazyResume(w)));
  if (matches.length === 0) {
    // A name that matches only the asker is a self-consult, not an awaitable peer.
    if ((asker.name ?? null) === name) return { kind: "denied", reason: "a worker cannot consult itself" };
    return { kind: "absent" };
  }
  if (matches.length > 1) {
    return { kind: "denied", reason: `more than one peer is named "${name}" — use an id from list_peers` };
  }
  return { kind: "resolved", target: matches[0] };
}
