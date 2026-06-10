// Shared dispatchMessage dependency wiring — the worker message, worker
// action, orchestrator message routes and the queue drain all dispatch with
// the same container deps; one builder keeps them from drifting.

import type { Container } from "../container.ts";
import type { DispatchMessageDeps } from "../../core/src/use-cases/DispatchMessage.ts";

export function dispatchDeps(
  c: Container,
  opts: { requireOrchestrator?: boolean; excerptLimit?: number } = {},
): DispatchMessageDeps {
  return {
    workers: c.workers,
    events: c.events,
    bus: c.bus,
    clock: c.clock,
    queue: c.messageQueue,
    client: c.httpWorkerClient,
    backends: c.backends,
    log: c.log,
    isLive: (id: string) => c.supervisor.has(id),
    ...(opts.requireOrchestrator ? { requireOrchestrator: true } : {}),
    excerptLimit: opts.excerptLimit ?? 200,
  };
}
