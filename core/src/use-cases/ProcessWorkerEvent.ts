// ProcessWorkerEvent — dispatches the 5-way POST /workers/:id/events switch
// (state, hook, jsonl, heartbeat, usage) onto specific handlers. Each event
// type implements WorkerEventHandler and is registered on construction.
// Adding a new event type means a new handler — no edits to the daemon
// route or to this dispatcher.

import type { WorkerEventType } from "../../../contracts/src/events.ts";
import type { WorkerRepo } from "../ports/WorkerRepo.ts";
import type { EventRepo } from "../ports/EventRepo.ts";
import type { EventBus } from "../ports/EventBus.ts";
import type { Clock } from "../ports/Clock.ts";
import type { ModelCatalog } from "../ports/ModelCatalog.ts";
import type { Logger } from "../ports/Logger.ts";
import { transitionState } from "./TransitionState.ts";
import { logEvent } from "./LogEvent.ts";
import { computeCostUsd } from "../domain/value-objects.ts";

export interface ProcessWorkerEventDeps {
  workers: WorkerRepo;
  events: EventRepo;
  bus: EventBus;
  clock: Clock;
  models: ModelCatalog;
  log: Logger;
  /** Called after a usage event is recorded; lets the limits enforcer check
   * the new cumulative cost right away. */
  onUsageRecorded?(workerId: string): void;
}

export interface WorkerEventInput {
  workerId: string;
  type: string;
  payload: unknown;
}

export type WorkerEventHandler = (
  deps: ProcessWorkerEventDeps,
  input: WorkerEventInput,
  rowId: number,
) => void;

const HANDLERS: Partial<Record<WorkerEventType, WorkerEventHandler>> = {
  state(deps, input) {
    const payload = input.payload as { state?: string } | null;
    const next = payload?.state;
    if (typeof next === "string") {
      transitionState(deps, {
        workerId: input.workerId,
        next: next.toUpperCase() as Parameters<typeof transitionState>[1]["next"],
        reason: "worker_pushed",
      });
    }
  },
  hook(deps, input) {
    const evt = (input.payload as { event?: string })?.event;
    // Hook → state mapping. Static rules; future hook event names go here.
    if (evt === "PostToolUse") {
      transitionState(deps, { workerId: input.workerId, next: "WORKING", reason: "hook:PostToolUse" });
    } else if (evt === "Stop") {
      transitionState(deps, { workerId: input.workerId, next: "IDLE", reason: "hook:Stop" });
    } else if (evt === "SessionEnd") {
      transitionState(deps, { workerId: input.workerId, next: "ENDING", reason: "hook:SessionEnd" });
    }
  },
  jsonl(deps, input) {
    // Lift SPAWNING → WORKING when the model emits anything substantive,
    // even before the first tool runs.
    const kind = (input.payload as { kind?: string })?.kind;
    if (kind === "assistant_text" || kind === "thinking" || kind === "tool_use") {
      const cur = deps.workers.findById(input.workerId);
      if (cur && cur.state === "SPAWNING") {
        transitionState(deps, { workerId: input.workerId, next: "WORKING", reason: `jsonl:${kind}` });
      }
    }
    if (kind === "tool_use") {
      deps.workers.incrementToolCalls(input.workerId);
    }
  },
  heartbeat(deps, input) {
    const cur = deps.workers.findById(input.workerId);
    if (cur && (cur.state === "SPAWNING" || cur.state === "IDLE")) {
      transitionState(deps, { workerId: input.workerId, next: "WORKING", reason: "heartbeat" });
    }
  },
  usage(deps, input, rowId) {
    const u = (input.payload as {
      in?: number;
      out?: number;
      cacheRead?: number;
      cacheCreate?: number;
      model?: string;
    }) ?? {};
    const tIn = u.in ?? 0;
    const tOut = u.out ?? 0;
    const cRead = u.cacheRead ?? 0;
    const cCreate = u.cacheCreate ?? 0;

    const row = deps.workers.findById(input.workerId);
    const model = u.model ?? row?.model ?? "opus";
    const deltaCost = computeCostUsd(deps.models, model, { in: tIn, out: tOut, cacheRead: cRead, cacheCreate: cCreate });

    deps.workers.addUsage(input.workerId, {
      in: tIn, out: tOut, cacheRead: cRead, cacheCreate: cCreate, costUsd: deltaCost,
    });
    // Back-fill deltaCost into the just-inserted payload so /session can
    // sum it without re-computing per model.
    deps.events.patchPayload(rowId, { ...u, deltaCost });
    deps.bus.publish("usage:recorded", { workerId: input.workerId, deltaCost });

    deps.onUsageRecorded?.(input.workerId);
  },
};

export function processWorkerEvent(
  deps: ProcessWorkerEventDeps,
  input: WorkerEventInput,
): void {
  const rowId = logEvent(deps, input.workerId, input.type, input.payload);
  const handler = HANDLERS[input.type as WorkerEventType];
  if (handler) handler(deps, input, rowId);
}
