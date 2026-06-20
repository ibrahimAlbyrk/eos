// Arm-at-spawn — attach a dynamic loop to a just-spawned worker BEFORE its first
// turn, reusing attachLoop (the parent orchestrator is the caller). Extracted from
// the spawn handler so the arg-mapping (target = new worker, config defaults) is
// unit-testable without standing up the whole spawn pipeline. The worker is
// SPAWNING (not IDLE) here, so no tick is needed — loop:change{active} just
// notifies the UI; the first idle edge ticks it.

import { attachLoop } from "../../core/src/use-cases/attachLoop.ts";
import type { LoopStateRepo } from "../../core/src/ports/LoopStateRepo.ts";
import type { WorkerRepo } from "../../core/src/ports/WorkerRepo.ts";
import type { IdGenerator } from "../../core/src/ports/IdGenerator.ts";
import type { Clock } from "../../core/src/ports/Clock.ts";
import type { EventBus } from "../../core/src/ports/EventBus.ts";
import type { SpawnLoop, LoopStrategy } from "../../contracts/src/loop.ts";

export interface ArmLoopAtSpawnDeps {
  loops: LoopStateRepo;
  workers: Pick<WorkerRepo, "findById">;
  ids: Pick<IdGenerator, "newLoopId">;
  clock: Clock;
  bus: Pick<EventBus, "publish">;
  loopConfig: { enabled: boolean; strategy: string; maxAttempts: number | null };
}

export function armLoopAtSpawn(
  deps: ArmLoopAtSpawnDeps,
  args: { parentId: string; workerId: string; loop: SpawnLoop },
): void {
  attachLoop(
    { loops: deps.loops, workers: deps.workers, ids: deps.ids, clock: deps.clock },
    {
      callerId: args.parentId,
      target: args.workerId,
      goal: args.loop.goal,
      strategy: args.loop.strategy ?? (deps.loopConfig.strategy as LoopStrategy),
      // An omitted limit takes the config default (null = unbounded); an explicit
      // value (including null) wins.
      limit: args.loop.limit === undefined ? deps.loopConfig.maxAttempts : args.loop.limit,
      enabled: deps.loopConfig.enabled,
    },
  );
  deps.bus.publish("loop:change", { workerId: args.workerId, status: "active" });
}
