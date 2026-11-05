// Pages: markdown notes shared by the user and agents (~/.eos/pages). A page
// linked to a chat outlives it — removing the agent just unlinks the page.

import { join } from "node:path";
import { randomBytes } from "node:crypto";

import type { DaemonModule } from "../types.ts";
import { BUILTIN_PLUGINS } from "../../../contracts/src/builtin-plugins.ts";
import type { Clock } from "../../../core/src/ports/Clock.ts";
import type { EventBus } from "../../../core/src/ports/EventBus.ts";
import type { WorkerRepo } from "../../../core/src/ports/WorkerRepo.ts";
import { PageService } from "../../../core/src/services/PageService.ts";
import { FilePageStore } from "../../../infra/src/persistence/FilePageStore.ts";
import { registerPageRoutes } from "./routes.ts";
import { pageDomain } from "./syncDomain.ts";
import type { ProjectKeys } from "../../services/project-keys.ts";

export interface PagesModuleDeps {
  readonly home: string;
  readonly clock: Clock;
  readonly bus: Pick<EventBus, "publish" | "subscribe">;
  readonly workers: Pick<WorkerRepo, "findById">;
  readonly projectKeys: ProjectKeys;
  readonly uiToken: string;
}

export interface PagesModule extends DaemonModule {
  readonly pages: PageService;
}

export function createPagesModule(deps: PagesModuleDeps): PagesModule {
  const pages = new PageService({
    store: new FilePageStore(join(deps.home, "pages")),
    clock: deps.clock,
    bus: deps.bus,
    newId: () => `pg-${randomBytes(6).toString("hex")}`,
  });
  deps.bus.subscribe("worker:removed", (msg) => pages.unlinkAgent((msg.payload as { workerId: string }).workerId));
  return {
    id: "pages",
    plugin: BUILTIN_PLUGINS.pages,
    pages,
    registerRoutes: (router) => registerPageRoutes(router, { pages, workers: deps.workers, uiToken: deps.uiToken }),
    sync: [{ domain: pageDomain(pages, deps.projectKeys), changeTopic: "pages:change" }],
  };
}
