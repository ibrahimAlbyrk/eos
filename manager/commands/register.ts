// Mount the command catalog onto the daemon Router. Each handler's def carries
// its own method + pattern, so registration is uniform. Registered before the
// hand-written worker routes in daemon.ts so a migrated path resolves here
// first (first-match router); the remaining hand-written routes keep their slot.

import type { Router } from "../routes/Router.ts";
import type { Container } from "../container.ts";
import { toRouteHandler, type CommandHandler } from "./pipeline.ts";
import { killWorkerHandler } from "./handlers/kill-worker.ts";
import { spawnWorkerHandler } from "./handlers/spawn-worker.ts";
import { interruptWorkerHandler } from "./handlers/interrupt-worker.ts";

export function registerCommandCatalog(r: Router, c: Container): void {
  const mount = <A, D, O>(h: CommandHandler<A, D, O>): void => {
    r.on(h.def.method, h.def.pattern, toRouteHandler(h, c));
  };
  mount(spawnWorkerHandler);
  mount(killWorkerHandler);
  mount(interruptWorkerHandler);
}
