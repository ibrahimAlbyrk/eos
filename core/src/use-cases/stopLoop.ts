// stopLoop — the orchestrator stops a loop it owns. Resolves the loop by id, or
// the target's (else the caller's own) active loop, then transitions it to
// "stopped" through the loop-status FSM. Held-report release is P4; for now this
// just transitions and returns. Ownership is scoped like attachLoop.

import { assertOwnedBy } from "../services/WorkerOwnership.ts";
import { NotFoundError } from "../errors/index.ts";
import { canLoopTransition } from "../domain/loop-status.ts";
import type { WorkerRepo } from "../ports/WorkerRepo.ts";
import type { LoopStateRepo } from "../ports/LoopStateRepo.ts";
import type { LoopStatus } from "../../../contracts/src/loop.ts";

export interface StopLoopDeps {
  loops: LoopStateRepo;
  workers: Pick<WorkerRepo, "findById">;
}

export interface StopLoopInput {
  callerId: string;
  target?: string;
  loopId?: string;
}

export function stopLoop(deps: StopLoopDeps, input: StopLoopInput): { loopId: string; status: LoopStatus } {
  const loop = input.loopId
    ? deps.loops.findById(input.loopId)
    : deps.loops.findActiveByWorker(input.target ?? input.callerId);
  if (!loop) throw new NotFoundError("loop", input.loopId ?? input.target ?? input.callerId);

  assertOwnedBy(deps.workers, input.callerId, loop.workerId, { allowSelf: true });

  if (canLoopTransition(loop.status, "stopped") && loop.status !== "stopped") {
    deps.loops.setStatus(loop.id, "stopped");
    return { loopId: loop.id, status: "stopped" };
  }
  return { loopId: loop.id, status: loop.status };
}
