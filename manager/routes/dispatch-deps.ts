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
    isLive: (id: string) => {
      if (c.supervisor.has(id)) return true;
      // In-process backends (claude-sdk / anthropic-api / …) have no supervised
      // PTY child; liveness is the backend session's own aliveness.
      const kind = c.workers.findById(id)?.backend_kind;
      if (kind && c.backends.has(kind) && c.backends.get(kind).descriptor.processModel === "in-process") {
        return c.backends.get(kind).attach(id, { kind: "inproc", ref: id }).isAlive();
      }
      return false;
    },
    // Cleared inside the use-case ONLY when the message actually dispatches —
    // an enqueue must leave the settle window alone (see DispatchMessageDeps).
    clearTurnSettle: (id: string) => c.turnSettle.clear(id),
    ...(opts.requireOrchestrator ? { requireOrchestrator: true } : {}),
    excerptLimit: opts.excerptLimit ?? 200,
  };
}
