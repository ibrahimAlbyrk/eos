// amendLoop — the orchestrator renegotiates an ACTIVE loop's goal in place,
// instead of stopping and re-attaching. Scoping mirrors attachLoop: the caller
// must be an orchestrator and must own the target (confused-deputy guard). Each
// of goal/strategy/limit that is provided replaces the current value wholesale;
// absent fields keep theirs. Amending the goal clears the progress ring (its
// outcomeHashes reference criterion ids that no longer exist). awaitingInput is
// deliberately NOT touched — a paused loop stays paused until the orchestrator's
// reply reaches the worker (resumeLoopOnInput), amend or not.

import { assertOwnedBy } from "../services/WorkerOwnership.ts";
import { lintGoalCriteria } from "../domain/loop-criteria-lint.ts";
import { ConflictError, NotFoundError, PermissionDeniedError, ValidationError } from "../errors/index.ts";
import type { WorkerRepo } from "../ports/WorkerRepo.ts";
import type { LoopStateRepo, LoopAmendPatch } from "../ports/LoopStateRepo.ts";
import type { GoalSpec, LoopStrategy, LoopStatus } from "../../../contracts/src/loop.ts";

export interface AmendLoopDeps {
  loops: LoopStateRepo;
  workers: Pick<WorkerRepo, "findById">;
}

export interface AmendLoopInput {
  callerId: string;
  target?: string;
  loopId?: string;
  goal?: GoalSpec;
  strategy?: LoopStrategy;
  // present (incl. null = unbounded) → replace the bound; absent → keep it.
  limit?: number | null;
  // The kill-switch (config.loop.enabled), passed in by the manager — mirrors
  // attachLoop; amend is a goal-authoring action and rides the same opt-in.
  enabled: boolean;
}

export function amendLoop(deps: AmendLoopDeps, input: AmendLoopInput): { loopId: string; status: LoopStatus; warnings?: string[] } {
  if (!input.enabled) {
    throw new ValidationError("dynamic loop is disabled — set config.loop.enabled");
  }

  const caller = deps.workers.findById(input.callerId);
  if (!caller) throw new NotFoundError("worker", input.callerId);
  if (!caller.is_orchestrator) {
    throw new PermissionDeniedError(`worker ${input.callerId} is not an orchestrator`);
  }

  const loop = input.loopId
    ? deps.loops.findById(input.loopId)
    : deps.loops.findActiveByWorker(input.target ?? input.callerId);
  if (!loop) throw new NotFoundError("loop", input.loopId ?? input.target ?? input.callerId);

  assertOwnedBy(deps.workers, input.callerId, loop.workerId, { allowSelf: true });

  if (loop.status !== "active") {
    throw new ConflictError(`loop ${loop.id} is ${loop.status}, not active — cannot amend`);
  }

  // Lint the effective (goal, strategy) whenever either is being changed — the
  // same structural check attach applies, so an amend can't smuggle in a
  // command-strategy verify-less criterion attach would have rejected. Rejects
  // (throws) on a structurally-unpassable goal; warnings ride the response.
  let warnings: string[] = [];
  if (input.goal !== undefined || input.strategy !== undefined) {
    warnings = lintGoalCriteria(input.strategy ?? loop.strategy, input.goal ?? loop.goal);
  }

  const patch: LoopAmendPatch = {};
  if (input.goal !== undefined) patch.goal = input.goal;
  if (input.strategy !== undefined) patch.strategy = input.strategy;
  if (input.limit !== undefined) patch.maxAttempts = input.limit;

  deps.loops.amend(loop.id, patch);
  if (input.goal !== undefined) deps.loops.resetProgress(loop.id);

  return warnings.length > 0 ? { loopId: loop.id, status: "active", warnings } : { loopId: loop.id, status: "active" };
}
