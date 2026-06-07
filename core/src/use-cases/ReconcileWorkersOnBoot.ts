// ReconcileWorkersOnBoot — daemon-startup reconciliation for worker rows whose
// processes died with the previous daemon. The supervisor map starts empty, so
// every non-DONE row is stale by definition:
//
//   - ENDING/KILLING: was already on its way out → DONE.
//   - resumable (session_id persisted + cwd still on disk) → SUSPENDED, so the
//     conversation can be revived via `claude --resume`.
//   - everything else → DONE.
//
// pid/port are nulled on suspend — the process is gone and a recycled pid must
// never be signalled by a later delete.

import type { WorkerRepo } from "../ports/WorkerRepo.ts";
import type { EventRepo } from "../ports/EventRepo.ts";
import type { EventBus } from "../ports/EventBus.ts";
import type { Clock } from "../ports/Clock.ts";
import type { Logger } from "../ports/Logger.ts";
import { transitionState } from "./TransitionState.ts";

export interface ReconcileWorkersOnBootDeps {
  workers: WorkerRepo;
  events: EventRepo;
  bus: EventBus;
  clock: Clock;
  log: Logger;
  /** Injected fs probe (existsSync at the composition root) — core stays Node-free. */
  pathExists(path: string): boolean;
}

export function reconcileWorkersOnBoot(deps: ReconcileWorkersOnBootDeps): { suspended: number; closed: number } {
  let suspended = 0;
  let closed = 0;
  for (const row of deps.workers.listAll()) {
    if (row.state === "DONE" || row.state === "SUSPENDED") continue;

    const wasEnding = row.state === "ENDING" || row.state === "KILLING";
    const dir = row.worktree_dir ?? row.cwd;
    const resumable = !wasEnding && !!row.session_id && !!dir && deps.pathExists(dir);

    if (resumable) {
      transitionState(deps, { workerId: row.id, next: "SUSPENDED", reason: "boot_reconcile" });
      deps.workers.clearRuntime(row.id);
      suspended++;
    } else {
      const now = deps.clock.now();
      deps.workers.markDone(row.id, now, null);
      const rowId = deps.events.append(row.id, now, "exit", { code: null, reason: "boot_reconcile" });
      deps.bus.publish("worker:exit", { workerId: row.id, rowId });
      closed++;
    }
  }
  if (suspended > 0 || closed > 0) {
    deps.log.info("reconciled stale workers", { suspended, closed });
  }
  return { suspended, closed };
}
