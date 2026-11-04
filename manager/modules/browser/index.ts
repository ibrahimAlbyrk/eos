// Browser panel — one persistent Chrome per session (parent-chain root worker),
// opt-in via config.browser.enabled (routes and service refuse while off).
// Engines launch lazily on a session's first browser use; each has its own
// on-disk profile dir (~/.eos/browser/<sessionKey>, the global session keeps
// ~/.eos/browser/profile) so logins survive daemon restarts. persistProfile=false
// → throwaway per-boot profiles in the OS temp dir. perSession=false collapses
// everything onto the one global engine.
//
// When the Electron app registers as the browser host (over /browser/host), an
// engine RPCs the real WebContentsView in the app; with no host (headless
// daemon, CI, cron) it drives Chrome over CDP. The choice is per engine launch,
// and a host disconnect drops the dead remote engines so the next launch falls
// back to headless.

import type { DaemonModule } from "../types.ts";
import { BUILTIN_PLUGINS } from "../../../contracts/src/builtin-plugins.ts";
import type { Clock } from "../../../core/src/ports/Clock.ts";
import type { EventBus } from "../../../core/src/ports/EventBus.ts";
import type { EventRepo } from "../../../core/src/ports/EventRepo.ts";
import type { Logger } from "../../../core/src/ports/Logger.ts";
import type { WorkerRepo } from "../../../core/src/ports/WorkerRepo.ts";
import type { DaemonConfig } from "../../shared/config.ts";
import type { AppBrowserHost } from "../../browser-host.ts";
import { CdpBrowserAdapter } from "../../../infra/src/browser/CdpBrowserAdapter.ts";
import { RemoteBrowserEngine } from "../../../infra/src/browser/RemoteBrowserEngine.ts";
import { BrowserService, browserProfileDirFor } from "./BrowserService.ts";
import { registerBrowserRoutes } from "./routes.ts";

export interface BrowserModuleDeps {
  readonly home: string;
  readonly config: () => DaemonConfig["browser"];
  readonly appHost: AppBrowserHost;
  readonly bus: EventBus;
  readonly log: Logger;
  readonly workers: Pick<WorkerRepo, "findById">;
  readonly events: Pick<EventRepo, "append">;
  readonly clock: Clock;
  readonly uiToken: string;
}

export interface BrowserModule extends DaemonModule {
  readonly browser: BrowserService;
}

export function createBrowserModule(deps: BrowserModuleDeps): BrowserModule {
  const browser = new BrowserService({
    engineFactory: (sessionKey) =>
      deps.appHost.isRegistered()
        ? new RemoteBrowserEngine(deps.appHost.channelFor(sessionKey))
        : new CdpBrowserAdapter({
            chromePath: deps.config().chromePath,
            profileDir: browserProfileDirFor(deps.home, deps.config().persistProfile, sessionKey),
            notify: (msg, meta) => deps.log.warn(msg, meta),
          }),
    getConfig: deps.config,
    bus: deps.bus,
    log: deps.log,
  });
  deps.appHost.onDeregister(() => browser.resetEngines());
  return {
    id: "browser",
    plugin: BUILTIN_PLUGINS.browser,
    browser,
    registerRoutes: (router) => registerBrowserRoutes(router, {
      browser,
      workers: deps.workers,
      events: deps.events,
      clock: deps.clock,
      log: deps.log,
      uiToken: deps.uiToken,
      perSession: () => deps.config().perSession,
    }),
    onSessionEnded: (sessionKey) => browser.disposeSession(sessionKey),
    stop: () => browser.dispose(),
  };
}
