// Sync (Settings › Sync): what the features contribute (profile, memories,
// pages, templates, worker definitions, …) follows the user to every Mac holding
// the same sync key, through an end-to-end encrypted vault on the relay. Only
// the daemon that won its endpoint syncs — never two writers on one home.

import { join } from "node:path";

import type { DaemonModule, SyncContribution } from "../types.ts";
import type { EventBus } from "../../../core/src/ports/EventBus.ts";
import type { Logger } from "../../../core/src/ports/Logger.ts";
import type { SyncStatusResponse } from "../../../contracts/src/sync.ts";
import { FileSyncIdentityStore, FileSyncStateStore } from "../../../infra/src/sync/stores.ts";
import type { JobRegistry } from "../../services/jobs/JobRegistry.ts";
import { SyncService } from "./SyncService.ts";
import { syncJobs } from "./jobs.ts";
import { SYNC_ROUTE_ACCESS, registerSyncRoutes } from "./routes.ts";

declare module "../../../core/src/ports/EventBus.ts" {
  interface EventBusTopics {
    // Sync's status changed (payload SyncStatusResponse) — Settings › Sync renders the payload.
    "sync:change": true;
  }
}

export interface SyncModuleDeps {
  readonly home: string;
  readonly contributions: readonly SyncContribution[];
  // The relay a new account is created on.
  readonly relayUrl: () => string | null;
  readonly device: string;
  readonly jobs: JobRegistry;
  readonly bus: EventBus;
  readonly log: Logger;
  readonly uiToken: string;
}

export function createSyncModule(deps: SyncModuleDeps): DaemonModule {
  const dir = join(deps.home, "sync");
  const sync = new SyncService({
    identities: new FileSyncIdentityStore(dir),
    state: new FileSyncStateStore(dir),
    domains: deps.contributions.map((c) => c.domain),
    relayUrl: deps.relayUrl,
    device: deps.device,
    bus: deps.bus,
    log: deps.log,
    now: () => Date.now(),
  });
  // Sync pushes local edits once a burst settles; what sync itself applied isn't one.
  for (const c of deps.contributions) {
    if (!c.changeTopic) continue;
    deps.bus.subscribe(c.changeTopic, (msg) => {
      if (!c.isLocal || c.isLocal(msg)) sync.noteLocalChange();
    });
  }
  // A sync pass that outlasts a moment shows in the Jobs list.
  const asJob = syncJobs(deps.jobs);
  asJob.onSync(sync.status());
  deps.bus.subscribe("sync:change", (m) => asJob.onSync(m.payload as SyncStatusResponse));
  return {
    id: "sync",
    routeAccess: SYNC_ROUTE_ACCESS,
    registerRoutes: (router) => registerSyncRoutes(router, { sync, uiToken: deps.uiToken }),
    afterListen: () => sync.start(),
    stop: () => {
      sync.stop();
      asJob.dispose();
    },
  };
}
