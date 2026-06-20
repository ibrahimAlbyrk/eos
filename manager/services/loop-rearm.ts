// Boot re-arm — a self-clocking loop has no external trigger, so after a daemon
// restart each active loop must be revived: resume its (possibly suspended)
// worker, then kick the goal gate. The held_report column carried the report
// across the restart. The eager loopTickFor is best-effort (a just-resumed worker
// is SPAWNING, so the gate self-guards on IDLE and the real tick fires on the
// worker's natural boot→IDLE transition); the reliable re-arm is resume + the
// armed gate. Extracted from the daemon wiring so it's unit-testable.

import type { LoopStateRepo } from "../../core/src/ports/LoopStateRepo.ts";
import type { WorkerRepo } from "../../core/src/ports/WorkerRepo.ts";
import type { WorkerRow } from "../../contracts/src/worker.ts";
import type { EventBus } from "../../core/src/ports/EventBus.ts";
import type { Logger } from "../../core/src/ports/Logger.ts";

export interface ReArmLoopsDeps {
  loops: Pick<LoopStateRepo, "listActive">;
  workers: Pick<WorkerRepo, "findById">;
  resume(worker: WorkerRow): Promise<void>;
  loopTickFor(workerId: string): void;
  log: Logger;
}

export async function reArmLoops(deps: ReArmLoopsDeps): Promise<void> {
  for (const loop of deps.loops.listActive()) {
    const worker = deps.workers.findById(loop.workerId);
    if (!worker) continue;
    try {
      await deps.resume(worker);
      deps.loopTickFor(loop.workerId);
    } catch (e) {
      deps.log.warn("loop re-arm failed", { workerId: loop.workerId, error: e instanceof Error ? e.message : String(e) });
    }
  }
}

// On worker exit/death, stop its active loop — otherwise it lingers active-but-
// dead (loopTickFor's isLive guard would no-op it forever). Called from the
// daemon's worker:exit handler.
export function stopLoopForExitedWorker(
  deps: { loops: Pick<LoopStateRepo, "findActiveByWorker" | "setStatus">; bus: Pick<EventBus, "publish"> },
  workerId: string,
): void {
  const loop = deps.loops.findActiveByWorker(workerId);
  if (!loop) return;
  deps.loops.setStatus(loop.id, "stopped");
  deps.bus.publish("loop:change", { workerId, status: "stopped" });
}
