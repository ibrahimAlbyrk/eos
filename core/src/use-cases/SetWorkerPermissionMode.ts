// SetWorkerPermissionMode — persist per-worker accept-edits mode and try to
// apply it to the live PTY. Persistence is authoritative; runtime apply is
// best-effort: a /permissions slash command is written to claude's stdin.
// If the worker is dead or has no port, we still persist (so the value is
// honored on the next session) but report runtimeApplied=false.

import type { WorkerRepo } from "../ports/WorkerRepo.ts";
import type { EventRepo } from "../ports/EventRepo.ts";
import type { EventBus } from "../ports/EventBus.ts";
import type { Clock } from "../ports/Clock.ts";
import type { WorkerClient } from "../ports/WorkerClient.ts";
import type { Logger } from "../ports/Logger.ts";
import { NotFoundError } from "../errors/index.ts";

export type PermissionMode = "default" | "acceptEdits" | "plan" | "bypassPermissions";

export interface SetWorkerPermissionModeDeps {
  workers: WorkerRepo;
  events: EventRepo;
  bus: EventBus;
  clock: Clock;
  client: WorkerClient;
  log: Logger;
}

export interface SetWorkerPermissionModeInput {
  workerId: string;
  mode: PermissionMode;
}

export async function setWorkerPermissionMode(
  deps: SetWorkerPermissionModeDeps,
  input: SetWorkerPermissionModeInput,
): Promise<{ mode: PermissionMode; runtimeApplied: boolean }> {
  const w = deps.workers.findById(input.workerId);
  if (!w) throw new NotFoundError("worker", input.workerId);

  deps.workers.updatePermissionMode(input.workerId, input.mode);

  let runtimeApplied = false;
  if (w.port) {
    try {
      const slash = `/permissions ${input.mode}`;
      const r = await deps.client.sendMessage(w.port, slash);
      runtimeApplied = r.ok;
    } catch (e) {
      deps.log.warn("permission-mode runtime apply failed", {
        worker: input.workerId, error: (e as Error).message,
      });
    }
  }

  deps.events.append(input.workerId, deps.clock.now(), "lifecycle", {
    kind: "permission_mode_set",
    mode: input.mode,
    runtimeApplied,
  });
  deps.bus.publish("worker:change", { workerId: input.workerId });

  return { mode: input.mode, runtimeApplied };
}
