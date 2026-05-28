// SetWorkerPermissionMode — persist the mode and (optionally) cascade it
// through the entire subtree rooted at this worker. Runtime apply for the
// primary target is still attempted via the `/permissions` slash command;
// children pick up the new mode at their next tool-call (the hook reads
// from the DB through the resolver).
//
// Persistence is authoritative. If the worker is dead, we still persist
// (so the next session honors it) and report runtimeApplied=false.

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
  cascade?: boolean;
}

export interface SetWorkerPermissionModeResult {
  mode: PermissionMode;
  runtimeApplied: boolean;
  affected: string[];
}

export async function setWorkerPermissionMode(
  deps: SetWorkerPermissionModeDeps,
  input: SetWorkerPermissionModeInput,
): Promise<SetWorkerPermissionModeResult> {
  const root = deps.workers.findById(input.workerId);
  if (!root) throw new NotFoundError("worker", input.workerId);

  const cascade = input.cascade !== false;
  const affected = cascade ? collectSubtree(deps.workers, input.workerId) : [input.workerId];

  for (const id of affected) {
    deps.workers.updatePermissionMode(id, input.mode);
  }

  let runtimeApplied = false;
  if (root.port) {
    try {
      const slash = `/permissions ${input.mode}`;
      const r = await deps.client.sendMessage(root.port, slash);
      runtimeApplied = r.ok;
    } catch (e) {
      deps.log.warn("permission-mode runtime apply failed", {
        worker: input.workerId, error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  const now = deps.clock.now();
  for (const id of affected) {
    deps.events.append(id, now, "lifecycle", {
      kind: "permission_mode_set",
      mode: input.mode,
      runtimeApplied: id === input.workerId ? runtimeApplied : false,
      via: id === input.workerId ? "direct" : "cascade",
    });
    deps.bus.publish("worker:change", { workerId: id });
  }

  return { mode: input.mode, runtimeApplied, affected };
}

function collectSubtree(workers: WorkerRepo, rootId: string): string[] {
  const out: string[] = [rootId];
  const queue: string[] = [rootId];
  const seen = new Set<string>([rootId]);
  while (queue.length > 0) {
    const next = queue.shift() as string;
    for (const childId of workers.findChildrenIds(next)) {
      if (seen.has(childId)) continue;
      seen.add(childId);
      out.push(childId);
      queue.push(childId);
    }
  }
  return out;
}
