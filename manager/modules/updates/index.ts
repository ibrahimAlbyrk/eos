// In-app updates (docs/updates/00-UPDATES-PLAN.md): only a packaged release
// build updates itself, from the signed feed, through ~/.eos/updates
// (regenerable — not listed in shared/user-data.ts).

import { join } from "node:path";

import type { DaemonModule } from "../types.ts";
import type { Clock } from "../../../core/src/ports/Clock.ts";
import type { EventBus } from "../../../core/src/ports/EventBus.ts";
import type { Logger } from "../../../core/src/ports/Logger.ts";
import type { WorkerRepo } from "../../../core/src/ports/WorkerRepo.ts";
import type { DaemonConfig } from "../../shared/config.ts";
import { hostPlatform } from "../../../infra/src/platform/index.ts";
import { UPDATE_FEED_URL, UPDATE_PUBLIC_KEYS } from "../../../contracts/src/update.ts";
import { checkForUpdate } from "../../../core/src/use-cases/update/CheckForUpdate.ts";
import { downloadUpdate } from "../../../core/src/use-cases/update/DownloadUpdate.ts";
import { Ed25519UpdateSignature } from "../../../infra/src/update/ed25519.ts";
import { FsBundleIndexer } from "../../../infra/src/update/FsBundleIndexer.ts";
import { FsUpdateWorkspace } from "../../../infra/src/update/FsUpdateWorkspace.ts";
import { HttpUpdateFeed } from "../../../infra/src/update/HttpUpdateFeed.ts";
import { UpdateService } from "./UpdateService.ts";
import { resolveInstall } from "./install.ts";
import { registerUpdateRoutes } from "./routes.ts";
import { updateJobs } from "./jobs.ts";
import type { JobRegistry } from "../../services/jobs/JobRegistry.ts";
import type { UpdateState } from "../../../contracts/src/update.ts";

export interface UpdatesModuleDeps {
  readonly home: string;
  // The app's resources folder when packaged (where its version is read from).
  readonly resourcesDir: string;
  readonly packaged: boolean;
  readonly config: () => DaemonConfig["updates"];
  // Writes one config.json block and reloads the config (throws when it can't).
  readonly patchConfig: (key: string, patch: Record<string, unknown>) => void;
  readonly workers: Pick<WorkerRepo, "listActive">;
  readonly bus: EventBus;
  readonly clock: Clock;
  readonly log: Logger;
  readonly jobs: JobRegistry;
  readonly uiToken: string;
}

export function createUpdatesModule(deps: UpdatesModuleDeps): DaemonModule {
  const appUpdates = hostPlatform.appUpdates;
  const workspace = new FsUpdateWorkspace(join(deps.home, "updates"), { fileModes: appUpdates?.fileModes ?? true });
  const feedUrl = (): string => deps.config().feedUrl ?? UPDATE_FEED_URL;
  const feed = new HttpUpdateFeed({ baseUrl: feedUrl });
  const signature = new Ed25519UpdateSignature(UPDATE_PUBLIC_KEYS);
  const log = deps.log.child({ svc: "update" });
  const updates = new UpdateService({
    ...resolveInstall({ packaged: deps.packaged, resourcesDir: deps.resourcesDir, execPath: process.execPath, platform: appUpdates }),
    check: async (install) => {
      const pointer = await checkForUpdate({ feed, signature }, { platform: install.platform, current: install.version });
      // The feed may move; the signed pointer says where to look next time.
      if (pointer?.feedUrl && pointer.feedUrl !== feedUrl()) deps.patchConfig("updates", { feedUrl: pointer.feedUrl });
      return pointer;
    },
    download: (input, signal) => downloadUpdate({
      feed, indexer: new FsBundleIndexer(), workspace, bundleCheck: appUpdates!.bundleCheck,
    }, input, signal),
    verifyStaged: (staged, installed) => appUpdates!.bundleCheck.verify(staged, installed),
    workspace,
    autoDownload: () => deps.config().autoDownload,
    workingAgents: () => deps.workers.listActive().filter((w) => !w.parent_id && w.state === "WORKING").length,
    bus: deps.bus,
    clock: deps.clock,
    log,
  });
  return {
    id: "updates",
    registerRoutes: (router) => registerUpdateRoutes(router, { updates, uiToken: deps.uiToken, patchConfig: deps.patchConfig }),
    start: () => {
      // A top-level agent starting or ending a turn may be what a "restart when
      // they finish" waits for.
      deps.bus.subscribe("worker:change", () => updates.agentsChanged());
      // A download in progress shows in the Jobs list.
      const asJob = updateJobs(deps.jobs);
      deps.bus.subscribe("update:change", (m) => asJob.onUpdate(m.payload as UpdateState));
      void updates.start().catch((e: unknown) => log.warn("update service failed to start", { error: e instanceof Error ? e.message : String(e) }));
    },
    stop: () => updates.stop(),
  };
}
