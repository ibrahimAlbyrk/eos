// File transfer between paired Macs (the Transfer tab, a focused agent's
// send_to_machine). This Mac's disk is the local endpoint and what /transfer/*
// serves to a paired Mac; a host's is reached over its link. Plan:
// docs/transfer/00-TRANSFER-PLAN.md.

import { randomBytes } from "node:crypto";

import type { DaemonModule } from "../types.ts";
import type { HostView } from "../../../contracts/src/peer.ts";
import type { TransferChangeEvent } from "../../../contracts/src/transfer.ts";
import type { Clock } from "../../../core/src/ports/Clock.ts";
import type { EventBus } from "../../../core/src/ports/EventBus.ts";
import type { Logger } from "../../../core/src/ports/Logger.ts";
import type { TransferRepo } from "../../../core/src/ports/TransferRepo.ts";
import type { WorkerRepo } from "../../../core/src/ports/WorkerRepo.ts";
import { FsTransferEndpoint, type FsTransferEndpointDeps } from "../../../infra/src/transfer/FsTransferEndpoint.ts";
import type { HostLink } from "../../peer/HostLink.ts";
import type { JobRegistry } from "../../services/jobs/JobRegistry.ts";
import { PeerEndpoint } from "./PeerEndpoint.ts";
import { TransferService, type NotificationFire } from "./TransferService.ts";
import { transferJobs } from "./jobs.ts";
import { TRANSFER_ROUTE_ACCESS, registerTransferRoutes } from "./routes.ts";

declare module "../../../core/src/ports/EventBus.ts" {
  interface EventBusTopics {
    // A file transfer between Macs moved on, or finished ones were cleared
    // (payload TransferChangeEvent) — the Transfer tab renders the payload.
    "transfer:change": true;
  }
}

export interface TransferModuleDeps {
  readonly home: string;
  // Where nothing may land — Eos's own data.
  readonly forbidden: readonly string[];
  readonly trash: (path: string) => Promise<void>;
  readonly projects: FsTransferEndpointDeps["projects"];
  readonly repo: TransferRepo;
  readonly hosts: {
    list(): HostView[];
    get(id: string): HostView | null;
    link(id: string): HostLink | null;
  };
  readonly localName: () => string;
  readonly workers: Pick<WorkerRepo, "findById">;
  readonly jobs: JobRegistry;
  readonly bus: EventBus;
  readonly clock: Clock;
  readonly log: Logger;
  readonly uiToken: string;
}

export function createTransferModule(deps: TransferModuleDeps): DaemonModule {
  const endpoint = new FsTransferEndpoint({ home: deps.home, forbidden: deps.forbidden, trash: deps.trash, projects: deps.projects });
  const peerEndpoints = new Map<string, PeerEndpoint>();
  const transfers = new TransferService({
    repo: deps.repo,
    local: endpoint,
    peer: (hostId) => {
      let ep = peerEndpoints.get(hostId);
      if (!ep) {
        ep = new PeerEndpoint({ link: () => deps.hosts.link(hostId), home: () => deps.hosts.get(hostId)?.info?.home ?? null });
        peerEndpoints.set(hostId, ep);
      }
      return ep;
    },
    hosts: deps.hosts,
    localName: deps.localName,
    bus: deps.bus,
    clock: deps.clock,
    log: deps.log.child({ svc: "transfer" }),
    newId: () => `tr-${randomBytes(6).toString("hex")}`,
    notify: (n: NotificationFire) => deps.bus.publish("notification:fire", n),
  });
  transfers.boot();

  const machineName = (ref: string): string => {
    if (ref === "local") return deps.localName();
    const host = deps.hosts.get(ref);
    return host?.alias ?? host?.name ?? "another Mac";
  };

  return {
    id: "transfer",
    routeAccess: TRANSFER_ROUTE_ACCESS,
    registerRoutes: (router) => registerTransferRoutes(router, { endpoint, transfers, workers: deps.workers, uiToken: deps.uiToken }),
    start: () => {
      // A transfer in progress shows in the Jobs list.
      const asJob = transferJobs(deps.jobs, { cancel: (id) => { transfers.cancel(id); }, machineName });
      for (const t of transfers.list()) asJob.onTransfer({ transfer: t });
      deps.bus.subscribe("transfer:change", (m) => asJob.onTransfer(m.payload as TransferChangeEvent));
    },
    stop: () => transfers.stop(),
  };
}
