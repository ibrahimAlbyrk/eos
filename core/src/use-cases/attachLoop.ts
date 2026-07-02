// attachLoop — the orchestrator arms a dynamic loop on itself or one of its
// workers. P1 only persists the (inert) loop row; the daemon goal-gate that
// drives it lands in a later phase. The caller must be an orchestrator, and the
// target must be itself or a worker it directly owns (confused-deputy scope,
// mirroring WorkerOwnership.assertOwnedBy). Refuses a second active loop on a
// target — one goal at a time.

import { assertOwnedBy } from "../services/WorkerOwnership.ts";
import { lintGoalCriteria } from "../domain/loop-criteria-lint.ts";
import { ConflictError, NotFoundError, PermissionDeniedError, ValidationError } from "../errors/index.ts";
import type { WorkerRepo } from "../ports/WorkerRepo.ts";
import type { LoopStateRepo } from "../ports/LoopStateRepo.ts";
import type { IdGenerator } from "../ports/IdGenerator.ts";
import type { Clock } from "../ports/Clock.ts";
import type { GoalSpec, LoopStrategy } from "../../../contracts/src/loop.ts";

export interface AttachLoopDeps {
  loops: LoopStateRepo;
  workers: Pick<WorkerRepo, "findById">;
  ids: Pick<IdGenerator, "newLoopId">;
  clock: Clock;
}

export interface AttachLoopInput {
  callerId: string;
  target?: string;
  goal: GoalSpec;
  strategy?: LoopStrategy;
  limit?: number | null;
  // The kill-switch (config.loop.enabled), passed in by the manager — core never
  // reads config. The feature ships behind this explicit opt-in (default off).
  enabled: boolean;
}

export function attachLoop(deps: AttachLoopDeps, input: AttachLoopInput): { loopId: string; warnings?: string[] } {
  if (!input.enabled) {
    throw new ValidationError("dynamic loop is disabled — set config.loop.enabled");
  }

  const caller = deps.workers.findById(input.callerId);
  if (!caller) throw new NotFoundError("worker", input.callerId);
  if (!caller.is_orchestrator) {
    throw new PermissionDeniedError(`worker ${input.callerId} is not an orchestrator`);
  }

  const targetId = input.target ?? input.callerId;
  assertOwnedBy(deps.workers, input.callerId, targetId, { allowSelf: true });

  if (deps.loops.findActiveByWorker(targetId)) {
    throw new ConflictError(`an active loop already exists on ${targetId}`);
  }

  const strategy = input.strategy ?? "hybrid";
  const warnings = lintGoalCriteria(strategy, input.goal);

  const parentId = targetId === input.callerId
    ? null
    : (deps.workers.findById(targetId)?.parent_id ?? null);

  const now = deps.clock.now();
  const loopId = deps.ids.newLoopId();
  deps.loops.insert({
    id: loopId,
    workerId: targetId,
    parentId,
    goal: input.goal,
    strategy,
    maxAttempts: input.limit ?? null,
    startedAt: now,
    updatedAt: now,
  });
  return warnings.length > 0 ? { loopId, warnings } : { loopId };
}
