// The plugin system's daemon side: plugin folders in ~/.eos/plugins, what they
// keep in ~/.eos/plugin-data, their builds and routes, and installing one from
// npm, git or a folder (the user only). Part of the kernel —
// features and plugins build on it, it depends on none of them.

import { join } from "node:path";
import type { EventBus } from "../../core/src/ports/EventBus.ts";
import type { Logger } from "../../core/src/ports/Logger.ts";
import type { Router } from "../routes/Router.ts";
import { PluginService } from "../../core/src/services/PluginService.ts";
import { FsPluginWorkspace } from "../../infra/src/plugins/FsPluginWorkspace.ts";
import { FsPluginDataStore, FsPluginInstallStore } from "../../infra/src/plugins/FsPluginDataStore.ts";
import { EsbuildPluginBuilder } from "../../infra/src/plugins/EsbuildPluginBuilder.ts";
import { FsPluginStaging } from "../../infra/src/plugins/FsPluginStaging.ts";
import { createPluginFetcher } from "../../infra/src/plugins/PluginFetchers.ts";
import { PluginInstaller } from "../../core/src/services/PluginInstaller.ts";
import { registerPluginBundleRoutes, registerPluginRoutes } from "./routes.ts";
import { BUILTIN_PLUGIN_MANIFESTS } from "../../contracts/src/builtin-plugins.ts";
import { GuardedRouter } from "../routes/Router.ts";
import { writeJson } from "../middleware/errorHandler.ts";
import type { MicroTask } from "../../core/src/ports/MicroTask.ts";

export interface PluginHostDeps {
  readonly home: string;
  readonly bus: Pick<EventBus, "publish">;
  readonly log: Logger;
  readonly uiToken: string;
}

export interface PluginHost {
  readonly plugins: PluginService;
  readonly installer: PluginInstaller;
  // Builds every plugin and follows changes on disk.
  start(): Promise<void>;
  registerBundleRoutes(router: Router): void;
  registerRoutes(router: Router): void;
  // A router whose routes answer only while built-in plugin `id` is on.
  routerFor(router: Router, id: string): Router;
  // A micro-task that only runs while built-in plugin `id` is on.
  gateTask(task: MicroTask, id: string): MicroTask;
}

export function createPluginHost(deps: PluginHostDeps): PluginHost {
  const dir = join(deps.home, "plugins");
  const dataDir = join(deps.home, "plugin-data");
  const builder = new EsbuildPluginBuilder();
  const plugins = new PluginService({
    workspace: new FsPluginWorkspace(dir),
    builder,
    data: new FsPluginDataStore(dataDir),
    bus: deps.bus,
    builtins: BUILTIN_PLUGIN_MANIFESTS,
    log: deps.log,
  });
  const nameOf = (id: string) => BUILTIN_PLUGIN_MANIFESTS.find((m) => m.id === id)?.name ?? id;
  const installer = new PluginInstaller({
    fetcher: createPluginFetcher(),
    staging: new FsPluginStaging(dir),
    records: new FsPluginInstallStore(dataDir),
    builder,
    plugins,
    now: Date.now,
  });
  const routeDeps = { plugins, installer, uiToken: deps.uiToken, dir };
  return {
    plugins,
    installer,
    start: () => {
      installer.start();
      return plugins.start();
    },
    registerBundleRoutes: (router) => registerPluginBundleRoutes(router, routeDeps),
    registerRoutes: (router) => registerPluginRoutes(router, routeDeps),
    routerFor: (router, id) => new GuardedRouter(router, () => plugins.isEnabled(id), ({ res }) => {
      writeJson(res, 404, { error: `${nameOf(id)} is turned off (Settings › Plugins)`, code: "plugin_off" });
    }),
    gateTask: (task, id) => ({ ...task, gate: (ctx) => plugins.isEnabled(id) && task.gate(ctx) }),
  };
}
