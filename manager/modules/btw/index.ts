// The /btw side question: the pane's agent answers a read-only question from
// its live conversation, without adding to it (POST /workers/:id/btw).

import type { DaemonModule } from "../types.ts";
import { BUILTIN_PLUGINS } from "../../../contracts/src/builtin-plugins.ts";
import { registerSideQuestionRoutes, type SideQuestionRouteDeps } from "./routes.ts";

export function createBtwModule(deps: SideQuestionRouteDeps): DaemonModule {
  return {
    id: "btw",
    plugin: BUILTIN_PLUGINS.btw,
    registerRoutes: (router) => registerSideQuestionRoutes(router, deps),
  };
}
