// The plugin system's daemon side: plugin folders in ~/.eos/plugins, what they
// keep in ~/.eos/plugin-data, their builds and routes. Part of the kernel —
// features and plugins build on it, it depends on none of them.

import { join } from "node:path";
import type { EventBus } from "../../core/src/ports/EventBus.ts";
import type { Logger } from "../../core/src/ports/Logger.ts";
import type { Router } from "../routes/Router.ts";
import { PluginService } from "../../core/src/services/PluginService.ts";
import { FsPluginWorkspace } from "../../infra/src/plugins/FsPluginWorkspace.ts";
import { FsPluginDataStore } from "../../infra/src/plugins/FsPluginDataStore.ts";
import { EsbuildPluginBuilder } from "../../infra/src/plugins/EsbuildPluginBuilder.ts";
import { registerPluginBundleRoutes, registerPluginRoutes } from "./routes.ts";

export interface PluginHostDeps {
  readonly home: string;
  readonly bus: Pick<EventBus, "publish">;
  readonly log: Logger;
  readonly uiToken: string;
}

export interface PluginHost {
  readonly plugins: PluginService;
  registerBundleRoutes(router: Router): void;
  registerRoutes(router: Router): void;
}

export function createPluginHost(deps: PluginHostDeps): PluginHost {
  const dir = join(deps.home, "plugins");
  const plugins = new PluginService({
    workspace: new FsPluginWorkspace(dir),
    builder: new EsbuildPluginBuilder(),
    data: new FsPluginDataStore(join(deps.home, "plugin-data")),
    bus: deps.bus,
    log: deps.log,
  });
  const routeDeps = { plugins, uiToken: deps.uiToken, dir };
  return {
    plugins,
    registerBundleRoutes: (router) => registerPluginBundleRoutes(router, routeDeps),
    registerRoutes: (router) => registerPluginRoutes(router, routeDeps),
  };
}
