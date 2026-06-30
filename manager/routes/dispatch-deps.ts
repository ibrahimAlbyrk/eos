// Shared dispatchMessage dependency wiring — the worker message, worker
// action, orchestrator message routes and the queue drain all dispatch with
// the same container deps; one builder keeps them from drifting.

import type { Container } from "../container.ts";
import type { DispatchMessageDeps } from "../../core/src/use-cases/DispatchMessage.ts";
import { appendSynthesized } from "../shared/synthesized-events.ts";
import { isWorkerLive } from "./worker-liveness.ts";

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
    slashCommands: c.slashCommands,
    // Prompt-template (.md slash-command) expansion (§5c) — applied only on lanes
    // that don't expand natively (the in-process lane); DispatchMessage gates on the
    // backend capability, never on kind.
    expandTemplate: c.expandSlashTemplate,
    // The daemon-side seams a slash command may touch — sourced from the same
    // services the SessionEnd(clear) hook uses, so the command and the (now
    // idempotent) hook fallback stay in sync.
    slashEffects: {
      clearPendingQueue: (id: string) => c.messageQueue.clearPending(id),
      cancelPeerRequests: (id: string) => c.pendingPeerRequests.cancelByWorker(id),
      appendConversationCleared: (id: string, payload: Record<string, unknown>) =>
        appendSynthesized(c, id, "conversation_cleared", payload),
    },
    log: c.log,
    isLive: (id: string) => isWorkerLive(c, id),
    // Cleared inside the use-case ONLY when the message actually dispatches —
    // an enqueue must leave the settle window alone (see DispatchMessageDeps).
    clearTurnSettle: (id: string) => c.turnSettle.clear(id),
    // Scope the recall window from each genuine dispatch push (see DispatchMessageDeps).
    turnOutput: c.turnOutput,
    ...(opts.requireOrchestrator ? { requireOrchestrator: true } : {}),
    excerptLimit: opts.excerptLimit ?? 200,
  };
}
