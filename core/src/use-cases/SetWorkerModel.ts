// SetWorkerModel — persist per-worker model + effort and try to apply it to the
// LIVE session through the backend port (each adapter knows its own switch
// mechanism: claude-cli → /model slash, claude-sdk → query.setModel). Gated on
// the session's runtimeModelSwitch capability, never on a kind/port proxy. If the
// worker is dead or the backend can't switch live, we still persist (used at the
// next session) and report runtimeApplied=false.

import type { WorkerRepo } from "../ports/WorkerRepo.ts";
import type { EventRepo } from "../ports/EventRepo.ts";
import type { EventBus } from "../ports/EventBus.ts";
import type { Clock } from "../ports/Clock.ts";
import type { AgentBackend } from "../ports/AgentBackend.ts";
import type { Logger } from "../ports/Logger.ts";
import type { ModelCapabilities } from "../ports/ModelCapabilities.ts";
import { resolveEffort } from "../domain/effort.ts";
import { checkModelForProvider } from "../domain/model-provider.ts";
import { NotFoundError, ValidationError } from "../errors/index.ts";

export interface SetWorkerModelDeps {
  workers: WorkerRepo;
  events: EventRepo;
  bus: EventBus;
  clock: Clock;
  /** The worker's resolved backend (route picks it by backend_kind). Absent →
   *  persist-only, no live apply. */
  backend?: AgentBackend;
  log: Logger;
  /** Capability lookup for effort normalization. Absent → pass through. */
  caps?: ModelCapabilities;
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

  // Provider is immutable mid-session — reject a model that doesn't belong to the
  // resolved backend's catalog BEFORE persisting anything (a bad value would be
  // written and then blindly handed to session.setModel). Fails open when no
  // backend/catalog is known.
  if (deps.backend) {
    const check = checkModelForProvider(deps.backend.descriptor, input.model);
    if (!check.ok) throw new ValidationError(check.reason);
  }

  const requested = input.effort ?? null;
  const effort =
    requested && deps.caps
      ? (resolveEffort(requested, await deps.caps.effortLevelsFor(input.model)) ?? null)
      : requested;
  if (effort !== requested) {
    deps.log.info("effort adjusted to model capability", {
      worker: input.workerId, model: input.model, requested, applied: effort,
    });
  }
  deps.workers.updateModel(input.workerId, input.model, effort);

  let runtimeApplied = false;
  if (deps.backend) {
    try {
      const handle = deps.backend.descriptor.processModel === "out-of-process"
        ? { kind: "http" as const, port: w.port ?? 0, pid: w.pid ?? null }
        : { kind: "inproc" as const, ref: w.id };
      const session = deps.backend.attach(w.id, handle);
      if (session.isAlive() && session.capabilities.runtimeModelSwitch) {
        const r = await session.setModel(input.model, effort);
        runtimeApplied = r.ok;
      }
    } catch (e) {
      deps.log.warn("model/effort runtime apply failed", {
        worker: input.workerId, error: e instanceof Error ? e.message : String(e),
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
