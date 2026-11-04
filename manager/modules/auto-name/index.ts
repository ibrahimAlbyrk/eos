// Auto-name: names a fresh orchestrator or focused chat from its first request
// (a micro-task the kernel's MicroTaskRunner runs), and stays out of the way of
// a human rename — paused while the rename editor is open, cancelled by a
// rename.

import type { DaemonModule } from "../types.ts";
import type { EventBus } from "../../../core/src/ports/EventBus.ts";
import type { MicroTask } from "../../../core/src/ports/MicroTask.ts";
import type { MicroTaskRunner } from "../../services/MicroTaskRunner.ts";
import { makeAutoNameTask, type AutoNameDeps } from "./autoName.ts";
import { registerRenameIntentRoutes } from "./routes.ts";

export const AUTO_NAME_TASK = "auto-name";

export interface AutoNameModuleDeps extends AutoNameDeps {
  readonly bus: Pick<EventBus, "publish" | "subscribe">;
  // The runner that runs the task (built after it, from it).
  readonly runner: () => Pick<MicroTaskRunner, "cancel" | "pause" | "resume">;
}

export interface AutoNameModule extends DaemonModule {
  readonly microTasks: readonly MicroTask[];
}

export function createAutoNameModule(deps: AutoNameModuleDeps): AutoNameModule {
  // A human rename (worker:change with renamedBy "user") kills a pending run: a
  // rename during the wait would otherwise spend a model call the gate re-check
  // just discards.
  deps.bus.subscribe("worker:change", (msg) => {
    const p = msg.payload as { workerId?: string; renamedBy?: string } | null;
    if (p?.renamedBy === "user" && p.workerId) deps.runner().cancel(AUTO_NAME_TASK, p.workerId, "user-renamed");
  });
  return {
    id: "auto-name",
    microTasks: [makeAutoNameTask(deps)],
    registerRoutes: (router) => registerRenameIntentRoutes(router, {
      pause: (workerId) => deps.runner().pause(AUTO_NAME_TASK, workerId),
      resume: (workerId) => deps.runner().resume(AUTO_NAME_TASK, workerId),
    }),
  };
}
