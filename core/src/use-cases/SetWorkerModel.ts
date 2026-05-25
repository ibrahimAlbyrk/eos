// SetWorkerModel — persist per-worker model + effort and try to apply to the
// live PTY via a /model slash command. Claude's runtime /model switch is the
// official channel; if the worker is dead we still persist (used at next
// session) but report runtimeApplied=false.

import type { WorkerRepo } from "../ports/WorkerRepo.ts";
import type { EventRepo } from "../ports/EventRepo.ts";
import type { EventBus } from "../ports/EventBus.ts";
import type { Clock } from "../ports/Clock.ts";
import type { WorkerClient } from "../ports/WorkerClient.ts";
import type { Logger } from "../ports/Logger.ts";
import { NotFoundError } from "../errors/index.ts";

export interface SetWorkerModelDeps {
  workers: WorkerRepo;
  events: EventRepo;
  bus: EventBus;
  clock: Clock;
  client: WorkerClient;
  log: Logger;
}

export interface SetWorkerModelInput {
  workerId: string;
  model: string;
  effort?: string;
}

export async function setWorkerModel(
  deps: SetWorkerModelDeps,
  input: SetWorkerModelInput,
): Promise<{ model: string; effort: string | null; runtimeApplied: boolean }> {
  const w = deps.workers.findById(input.workerId);
  if (!w) throw new NotFoundError("worker", input.workerId);

  const effort = input.effort ?? null;
  deps.workers.updateModel(input.workerId, input.model, effort);

  let runtimeApplied = false;
  if (w.port) {
    try {
      const modelSlash = `/model ${input.model}`;
      const r = await deps.client.sendMessage(w.port, modelSlash);
      runtimeApplied = r.ok;
      if (effort) {
        const effortSlash = `/effort ${effort}`;
        const er = await deps.client.sendMessage(w.port, effortSlash);
        runtimeApplied = runtimeApplied && er.ok;
      }
    } catch (e) {
      deps.log.warn("model/effort runtime apply failed", {
        worker: input.workerId, error: (e as Error).message,
      });
    }
  }

  deps.events.append(input.workerId, deps.clock.now(), "lifecycle", {
    kind: "model_set",
    model: input.model,
    effort,
    runtimeApplied,
  });
  deps.bus.publish("worker:change", { workerId: input.workerId });

  return { model: input.model, effort, runtimeApplied };
}
