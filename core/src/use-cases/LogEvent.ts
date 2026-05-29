// Append a single event and publish a change. Used by every code path that
// needs to record something against a worker (lifecycle, spawn, exit, etc.)
// that ISN'T a state transition.

import type { EventRepo } from "../ports/EventRepo.ts";
import type { EventBus } from "../ports/EventBus.ts";
import type { Clock } from "../ports/Clock.ts";
import type { WorkerEventType } from "../../../contracts/src/events.ts";

export interface LogEventDeps {
  events: EventRepo;
  bus: EventBus;
  clock: Clock;
}

export function logEvent(
  deps: LogEventDeps,
  workerId: string,
  type: WorkerEventType,
  payload?: unknown,
): number {
  const rowId = deps.events.append(workerId, deps.clock.now(), type, payload);
  deps.bus.publish("worker:change", { workerId, rowId, type });
  return rowId;
}
