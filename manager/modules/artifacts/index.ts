// Every claude.ai Artifact of every Eos Claude sign-in, read with that sign-in's
// own token through the frame API Claude Code's Artifact tool uses.

import type { DaemonModule } from "../types.ts";
import { BUILTIN_PLUGINS } from "../../../contracts/src/builtin-plugins.ts";
import type { Clock } from "../../../core/src/ports/Clock.ts";
import type { EventBus } from "../../../core/src/ports/EventBus.ts";
import type { AgentEvent } from "../../../contracts/src/canonical.ts";
import { ARTIFACTS_TOPIC } from "../../../contracts/src/artifacts.ts";
import { announcesArtifact } from "../../../core/src/domain/artifact-catalog.ts";
import { ArtifactCatalogService, type ArtifactLogin } from "../../../core/src/services/ArtifactCatalogService.ts";
import { createFrameApiArtifactSource, type FrameApiArtifactSourceDeps } from "../../../infra/src/artifacts/FrameApiArtifactSource.ts";
import { ARTIFACT_ROUTE_ACCESS, registerArtifactRoutes } from "./routes.ts";

declare module "../../../core/src/ports/EventBus.ts" {
  interface EventBusTopics {
    // The artifact catalog changed or started/stopped re-reading (payload only
    // { refreshing }; the catalog is read from GET /api/artifacts — contracts ARTIFACTS_TOPIC).
    "artifacts:change": true;
  }
}

export interface ArtifactsModuleDeps {
  // The Claude sign-ins, and per sign-in the token (and its renewal) to read with.
  readonly logins: () => readonly ArtifactLogin[];
  readonly token: FrameApiArtifactSourceDeps["token"];
  readonly renew?: FrameApiArtifactSourceDeps["renew"];
  // The sign-in a worker runs on, when known.
  readonly loginOfWorker: (workerId: string) => string | undefined;
  readonly clock: Clock;
  readonly bus: Pick<EventBus, "publish">;
  readonly uiToken: string;
}

export interface ArtifactsModule extends DaemonModule {
  readonly artifacts: ArtifactCatalogService;
}

export function createArtifactsModule(deps: ArtifactsModuleDeps): ArtifactsModule {
  const artifacts = new ArtifactCatalogService({
    source: createFrameApiArtifactSource({ token: deps.token, ...(deps.renew ? { renew: deps.renew } : {}) }),
    logins: deps.logins,
    clock: deps.clock,
    // A bare signal: the stream reaches paired computers, the catalog only this Mac's route.
    publish: (catalog) => deps.bus.publish(ARTIFACTS_TOPIC, { refreshing: catalog.refreshing }),
  });
  return {
    id: "artifacts",
    routeAccess: ARTIFACT_ROUTE_ACCESS,
    plugin: BUILTIN_PLUGINS.artifacts,
    artifacts,
    // An agent published a claude.ai Artifact: re-read the sign-in it runs on
    // (every one when that's unknown).
    onAgentEvent: (workerId: string, event: AgentEvent) => {
      if (announcesArtifact(event)) artifacts.invalidate(deps.loginOfWorker(workerId));
    },
    registerRoutes: (router) => registerArtifactRoutes(router, { artifacts, uiToken: deps.uiToken }),
  };
}
