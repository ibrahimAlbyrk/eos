// Visual answers (docs/genui/00-GENUI-PLAN.md): present / present_app store
// through PresentView; media, map tiles, geocoding, place search and the app's
// location answer the dashboard and the find_places / current_location tools.
// The user's switches (Settings › General) are its own settings, and the level
// reaches the prompt as GENUI_LEVEL / GENUI_OFF.

import type { DatabaseSync } from "node:sqlite";

import type { DaemonModule } from "../types.ts";
import type { Clock } from "../../../core/src/ports/Clock.ts";
import type { EventBus } from "../../../core/src/ports/EventBus.ts";
import type { Logger } from "../../../core/src/ports/Logger.ts";
import type { WorkerRepo } from "../../../core/src/ports/WorkerRepo.ts";
import type { PresentViewDeps } from "../../../core/src/use-cases/PresentView.ts";
import type { UserSettings } from "../../../contracts/src/http.ts";
import type { DaemonConfig } from "../../shared/config.ts";
import { validateView } from "../../../contracts/src/genui/catalog.ts";
import { GENUI_SETTING_KEYS, newViewId, validateApp, type GenuiSettings } from "../../../contracts/src/genui/spec.ts";
import { ROUTES } from "../../../contracts/src/http.ts";
import { SqliteGenuiViewRepo } from "../../../infra/src/persistence/SqliteGenuiViewRepo.ts";
import { genuiSettingsOf } from "./settings.ts";
import { buildGenuiMedia, type GenuiMediaDeps } from "./media.ts";
import { genuiPromptVariables } from "./prompt.ts";
import { registerGenuiRoutes } from "./routes.ts";
import { registerGenuiMediaRoutes } from "./media-routes.ts";
import { LOCATION_ROUTE_ACCESS, registerLocationRoutes } from "./location-routes.ts";
import { registerGenuiSettingsRoutes } from "./settings-routes.ts";

declare module "../../../core/src/ports/EventBus.ts" {
  interface EventBusTopics {
    // A visual answer's tool input while the model writes it (claude SDK lane;
    // payload GenuiDelta: workerId, callId, name, phase, text). Its own topic so
    // agent:delta consumers (LiveText, phones) never see tool JSON. Ephemeral.
    "genui:delta": true;
    // A view's UI state was replaced (payload GenuiChange { viewId, state }).
    "genui:change": true;
  }
}

export interface GenuiModuleDeps {
  readonly db: DatabaseSync;
  readonly home: string;
  readonly config: () => DaemonConfig;
  readonly patchConfig: (key: string, patch: Record<string, unknown>) => void;
  readonly userSettings: { read(): UserSettings; patch(p: UserSettings): unknown };
  readonly appHost: GenuiMediaDeps["appHost"];
  readonly workers: Pick<WorkerRepo, "findById">;
  readonly bus: Pick<EventBus, "publish" | "subscribe">;
  readonly clock: Clock;
  readonly log: Logger;
  readonly uiToken: string;
}

export interface GenuiModule extends DaemonModule {
  readonly settings: () => GenuiSettings;
}

export function createGenuiModule(deps: GenuiModuleDeps): GenuiModule {
  const views = new SqliteGenuiViewRepo(deps.db);
  const settings = (): GenuiSettings => genuiSettingsOf(deps.userSettings.read(), deps.config());
  const present: PresentViewDeps = {
    views,
    clock: deps.clock,
    newId: () => newViewId(),
    validateView,
    validateApp,
    settings: () => {
      const s = settings();
      return { level: s.level, apps: s.apps };
    },
  };
  const media = buildGenuiMedia({ home: deps.home, clock: deps.clock, log: deps.log, appHost: deps.appHost, userSettings: deps.userSettings });
  // A purged/deleted chat's visual answers go with it.
  deps.bus.subscribe("worker:removed", (msg) => {
    const id = (msg.payload as { workerId?: string })?.workerId;
    if (id) views.removeByWorker(id);
  });
  return {
    id: "genui",
    routeAccess: LOCATION_ROUTE_ACCESS,
    settings,
    promptVariables: () => genuiPromptVariables(settings().level),
    protectedSettings: { keys: Object.values(GENUI_SETTING_KEYS), via: ROUTES.settingsGenui },
    registerRoutes: (router) => {
      registerGenuiRoutes(router, { present, views, workers: deps.workers, bus: deps.bus, clock: deps.clock, uiToken: deps.uiToken });
      registerGenuiMediaRoutes(router, { genuiMedia: media, uiToken: deps.uiToken });
      registerLocationRoutes(router, { genuiMedia: media, uiToken: deps.uiToken, workers: deps.workers });
      registerGenuiSettingsRoutes(router, { settings, userSettings: deps.userSettings, patchConfig: deps.patchConfig, uiToken: deps.uiToken });
    },
  };
}
